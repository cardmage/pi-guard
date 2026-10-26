/**
 * pi-guard: verifies URLs in the agent's final answer.
 *
 * HTTP check first (404/410/NXDOMAIN = hallucinated), LLM judgement only for URLs the
 * HTTP check cannot decide. Hallucinated URLs trigger a rewrite request (mode "rewrite",
 * up to maxRewrites per user prompt) or a warning (mode "warn").
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { defaultConfig, getConfigPath, loadConfig } from "./config.ts";
import { closeDispatcher, createDispatcher, type DispatcherBuild } from "./dispatcher.ts";
import {
	assistantText,
	CUSTOM_TYPE,
	type ExtractedUrl,
	extractUrls,
	type LooseMessage,
	lastAssistantIndex,
	snippetAround,
} from "./extractor.ts";
import { skipReason } from "./filter.ts";
import { checkUrls } from "./http-check.ts";
import type { HttpCheckResult, PiGuardConfig, UrlFinding } from "./types.ts";
import { resolveVerifierModel, type VerifyItem, verifyWithLlm } from "./verifier.ts";

export const STATUS_KEY = "pi-guard";

interface GuardState {
	config: PiGuardConfig;
	net: DispatcherBuild | undefined;
	/** Session cache of HTTP check results, by canonical URL key. */
	httpCache: Map<string, HttpCheckResult>;
	/** Session cache of decisive findings, by canonical URL key. */
	cache: Map<string, UrlFinding>;
	rewriteCount: number;
	networkWarned: boolean;
	warned: Set<string>;
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "warning"): void {
	if (!ctx.hasUI) return;
	try {
		ctx.ui.notify(message, type);
	} catch {
		// UI unavailable
	}
}

function setStatus(ctx: ExtensionContext, text: string | undefined): void {
	if (!ctx.hasUI) return;
	try {
		ctx.ui.setStatus(STATUS_KEY, text);
	} catch {
		// UI unavailable
	}
}

function describeHttp(r: HttpCheckResult | undefined): string {
	if (!r) return "";
	if (r.status !== undefined && !r.error) return `HTTP ${r.status}`;
	if (r.status !== undefined) return `HTTP ${r.status}, ${r.error}`;
	return r.error ?? r.verdict;
}

/** Feedback sent to the agent when hallucinated or unsupported URLs are found. */
export function buildRewriteMessage(failed: readonly UrlFinding[]): string {
	const lines = failed.map((f) => `- ${f.url} — ${f.reason}`);
	return [
		"[pi-guard] Your last answer cites URLs that appear not to exist or do not support the cited claim:",
		...lines,
		"",
		"Rewrite your answer. Remove these URLs, fix the inaccurate claims, or replace them with real URLs whose content you have verified with a tool (for example a web search or by fetching the page). Do not guess or construct URLs. Keep the rest of the answer the same, and do not mention this check.",
	].join("\n");
}

/** Warning shown to the user when hallucinated or unsupported URLs remain. */
export function buildWarning(failed: readonly UrlFinding[]): string {
	const lines = failed.map((f) => `• ${f.url} (${f.reason})`);
	return [`pi-guard: ${failed.length} URL(s) in the answer failed verification:`, ...lines].join("\n");
}

export default function piGuard(pi: ExtensionAPI): void {
	const state: GuardState = {
		config: defaultConfig(),
		net: undefined,
		httpCache: new Map(),
		cache: new Map(),
		rewriteCount: 0,
		networkWarned: false,
		warned: new Set(),
	};

	const warnOnce = (ctx: ExtensionContext, message: string) => {
		if (state.warned.has(message)) return;
		state.warned.add(message);
		notify(ctx, message, "warning");
	};

	pi.on("session_start", async (_event, ctx) => {
		await closeDispatcher(state.net?.dispatcher);
		state.net = undefined;
		state.httpCache.clear();
		state.cache.clear();
		state.rewriteCount = 0;
		state.networkWarned = false;
		state.warned.clear();

		const path = getConfigPath(getAgentDir());
		const loaded = await loadConfig(path);
		state.config = loaded.config;
		if (loaded.warnings.length > 0) {
			notify(ctx, `pi-guard: problems in ${path}:\n${loaded.warnings.map((w) => `• ${w}`).join("\n")}`, "warning");
		}
		if (state.config.enabled && state.config.http.enabled) {
			try {
				state.net = createDispatcher(state.config.http);
				for (const w of state.net.warnings) notify(ctx, `pi-guard: ${w}`, "warning");
			} catch (err) {
				notify(ctx, `pi-guard: cannot create HTTP client (${err instanceof Error ? err.message : String(err)}); using LLM-only checks`, "warning");
			}
		}
	});

	pi.on("session_shutdown", async () => {
		const net = state.net;
		state.net = undefined;
		await closeDispatcher(net?.dispatcher);
	});

	pi.on("before_agent_start", (event) => {
		// A new user prompt starts a new rewrite budget. Rewrite continuations never pass here.
		if (event.messageType === "user") state.rewriteCount = 0;
	});

	async function evaluate(
		candidates: readonly ExtractedUrl[],
		answer: string,
		ctx: ExtensionContext,
		signal: AbortSignal,
	): Promise<UrlFinding[]> {
		const cfg = state.config;
		const findings = new Map<string, UrlFinding>();
		const pending: ExtractedUrl[] = [];
		for (const c of candidates) {
			const hit = state.cache.get(c.key);
			// When verifyContent is enabled, HTTP 200 URLs with pageContent must be checked against the current answer's context.
			if (hit && !(cfg.verifyContent && hit.http?.verdict === "OK")) {
				findings.set(c.key, { ...hit, url: c.url });
			} else {
				pending.push(c);
			}
		}
		if (pending.length === 0) return candidates.map((c) => findings.get(c.key)!);

		// 1. HTTP (use httpCache when available)
		const httpByKey = new Map<string, HttpCheckResult>();
		const httpPending: ExtractedUrl[] = [];
		for (const p of pending) {
			const cachedHttp = state.httpCache.get(p.key);
			if (cachedHttp) httpByKey.set(p.key, { ...cachedHttp, url: p.url });
			else httpPending.push(p);
		}

		let freshHttpResults: HttpCheckResult[] = [];
		if (httpPending.length > 0) {
			if (cfg.http.enabled && state.net) {
				freshHttpResults = await checkUrls(
					httpPending.map((p) => p.url),
					{
						dispatcher: state.net.dispatcher,
						timeoutMs: cfg.http.timeoutMs,
						concurrency: cfg.http.concurrency,
						userAgent: cfg.http.userAgent,
						signal,
						proxyConfigured: state.net.proxyConfigured,
						fetchContent: cfg.verifyContent,
					},
				);
			} else {
				freshHttpResults = httpPending.map((p) => ({ url: p.url, verdict: "UNCERTAIN", error: "HTTP check disabled", errorKind: "disabled" }));
			}
			if (signal.aborted) return [];
			httpPending.forEach((p, i) => {
				const r = freshHttpResults[i]!;
				httpByKey.set(p.key, r);
				if (r.verdict === "OK" || r.verdict === "NOT_FOUND") {
					state.httpCache.set(p.key, r);
				}
			});
		}

		const httpResults = pending.map((p) => httpByKey.get(p.key)!);

		if (!state.networkWarned && freshHttpResults.length > 0) {
			const netFailures = freshHttpResults.filter((r) => r.errorKind === "proxy" || r.errorKind === "tls");
			const allNetwork =
				freshHttpResults.length >= 3 && freshHttpResults.every((r) => r.errorKind === "network" || r.errorKind === "timeout");
			if (netFailures.length > 0 || allNetwork) {
				state.networkWarned = true;
				const sample = netFailures[0]?.error ?? freshHttpResults[0]?.error ?? "";
				notify(
					ctx,
					`pi-guard: HTTP checks are failing (${state.net?.description ?? "no HTTP client"}): ${sample}\nCheck proxy/certificate settings (HTTPS_PROXY / http.proxy / http.useSystemCa). Falling back to LLM judgement.`,
					"warning",
				);
			}
		}

		// 2. LLM for UNCERTAIN or content verification (when verifyContent is enabled and pageContent was extracted)
		const needsLlm: { p: ExtractedUrl; http: HttpCheckResult }[] = [];
		pending.forEach((p, i) => {
			const http = httpResults[i]!;
			if (http.verdict === "OK") {
				if (cfg.verifyContent && http.pageContent) {
					needsLlm.push({ p, http });
				} else {
					const f: UrlFinding = { url: p.url, http, failed: false, reason: describeHttp(http) };
					findings.set(p.key, f);
					state.cache.set(p.key, f);
				}
			} else if (http.verdict === "NOT_FOUND") {
				const f: UrlFinding = { url: p.url, http, failed: true, reason: describeHttp(http) };
				findings.set(p.key, f);
				state.cache.set(p.key, f);
			} else {
				needsLlm.push({ p, http });
			}
		});

		if (needsLlm.length > 0) {
			const resolved = resolveVerifierModel(cfg.verifier, ctx.modelRegistry, ctx.model);
			if (resolved.warning) warnOnce(ctx, `pi-guard: ${resolved.warning}`);
			const items: VerifyItem[] = needsLlm.map(({ p, http }) => ({
				url: p.url,
				httpStatus: http.status,
				httpError: http.error,
				...(http.pageContent ? { pageContent: http.pageContent } : {}),
				context: snippetAround(answer, p.index, p.length),
			}));
			setStatus(ctx, `pi-guard: asking verifier about ${items.length} URL(s)…`);
			const outcome = await verifyWithLlm(items, {
				model: resolved.model,
				registry: ctx.modelRegistry,
				config: cfg.verifier,
				signal,
			});
			if (signal.aborted) return [];
			if (outcome.error && !/aborted/.test(outcome.error)) warnOnce(ctx, `pi-guard: ${outcome.error} (URLs passed unchecked)`);
			for (const { p, http } of needsLlm) {
				const llm = outcome.results.get(p.url) ?? { url: p.url, verdict: "UNKNOWN" as const, reason: "no verdict" };
				const httpPart = describeHttp(http);
				const failed = llm.verdict === "NOT_EXISTS" || llm.verdict === "CONTRADICTED";
				const f: UrlFinding = {
					url: p.url,
					http,
					llm,
					failed,
					reason: `verifier: ${llm.reason || llm.verdict}${httpPart ? ` (${httpPart})` : ""}`,
				};
				findings.set(p.key, f);
				// Cache existence verdicts (when no pageContent was checked) if decisive.
				if (llm.verdict !== "UNKNOWN" && !http.pageContent) state.cache.set(p.key, f);
			}
		}
		return candidates.map((c) => findings.get(c.key)).filter((f): f is UrlFinding => !!f);
	}

	pi.on("agent_before_settle", async (event, ctx) => {
		const cfg = state.config;
		if (!cfg.enabled || event.outcome !== "completed") return undefined;

		const messages = event.context.contextMessages as unknown as LooseMessage[];
		const idx = lastAssistantIndex(messages);
		if (idx < 0) return undefined;
		const answer = assistantText(messages[idx]);
		if (!answer.trim()) return undefined;

		const extracted = extractUrls(answer, { skipCodeBlocks: cfg.skipCodeBlocks });
		if (extracted.length === 0) return undefined;

		const candidates = extracted
			.filter((u) => skipReason(u.url, cfg.bypassDomains) === undefined)
			.slice(0, cfg.maxUrls);
		if (candidates.length === 0) return undefined;

		// Abort handling: the run's signal (if any) and Esc in the TUI. The agent run has
		// already finished here, so ctx.signal is usually undefined.
		const controller = new AbortController();
		const onAbort = () => controller.abort();
		ctx.signal?.addEventListener("abort", onAbort, { once: true });
		if (ctx.signal?.aborted) controller.abort();
		let unsubscribeInput: (() => void) | undefined;
		if (ctx.mode === "tui" && ctx.hasUI) {
			try {
				unsubscribeInput = ctx.ui.onTerminalInput((data) => {
					if (matchesKey(data, "escape")) controller.abort();
					return undefined;
				});
			} catch {
				unsubscribeInput = undefined;
			}
		}

		setStatus(ctx, `pi-guard: checking ${candidates.length} URL(s)…`);
		try {
			const findings = await evaluate(candidates, answer, ctx, controller.signal);
			if (controller.signal.aborted) return undefined;
			const failed = findings.filter((f) => f.failed);
			if (failed.length === 0) return undefined;

			if (cfg.mode === "rewrite" && state.rewriteCount < cfg.maxRewrites) {
				state.rewriteCount++;
				return {
					entries: [
						...event.entries,
						{
							type: "custom_message" as const,
							customType: CUSTOM_TYPE,
							display: true,
							content: buildRewriteMessage(failed),
							details: { failed, attempt: state.rewriteCount },
						},
					],
					continue: true,
				};
			}

			notify(ctx, buildWarning(failed), "warning");
			return {
				entries: [
					...event.entries,
					{ type: "custom" as const, customType: CUSTOM_TYPE, data: { failed, rewrites: state.rewriteCount } },
				],
			};
		} finally {
			ctx.signal?.removeEventListener("abort", onAbort);
			unsubscribeInput?.();
			setStatus(ctx, undefined);
		}
	});
}
