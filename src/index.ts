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
import { evaluateWithDecider, resolveDeciderModel } from "./decider.ts";
import { closeDispatcher, createDispatcher, type DispatcherBuild } from "./dispatcher.ts";
import {
	assistantText,
	CUSTOM_TYPE,
	type ExtractedUrl,
	extractTurnContext,
	extractUrls,
	type LooseMessage,
	lastAssistantIndex,
	snippetAround,
} from "./extractor.ts";
import { skipReason } from "./filter.ts";
import { checkUrls } from "./http-check.ts";
import type { DeciderFinding, HttpCheckResult, PiGuardConfig, UrlFinding } from "./types.ts";
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
	deciderRewriteCount: number;
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

/** Feedback sent to the agent when the decider model flags the answer as wrong. */
export function buildDeciderRewriteMessage(finding: DeciderFinding): string {
	const pct = Math.round(finding.probability * 100);
	const thr = Math.round(finding.threshold * 100);
	const flaggedDims = (finding.breakdown ?? [])
		.filter((b) => b.risk >= 0.5)
		.sort((a, b) => b.risk - a.risk)
		.map((b) => `- ${b.id}: ${Math.round(b.risk * 100)}% risk`);
	return [
		`[pi-guard] Your last answer was flagged as likely incorrect by the answer verifier (${finding.provider}/${finding.model}: ${pct}% >= ${thr}% threshold).`,
		...(flaggedDims.length > 0 ? ["", "Flagged dimensions:", ...flaggedDims] : []),
		"",
		"Review your answer against the user prompt and the tool outputs from this turn. Fix any factual errors, logical contradictions, or claims not supported by the evidence. Do not mention this check.",
	].join("\n");
}

/** Warning shown to the user when the decider model flags the answer as wrong. */
export function buildDeciderWarning(finding: DeciderFinding): string {
	const pct = Math.round(finding.probability * 100);
	const thr = Math.round(finding.threshold * 100);
	return `pi-guard: answer flagged as potentially incorrect (${pct}% >= ${thr}%, model: ${finding.provider}/${finding.model})`;
}

export default function piGuard(pi: ExtensionAPI): void {
	const state: GuardState = {
		config: defaultConfig(),
		net: undefined,
		httpCache: new Map(),
		cache: new Map(),
		rewriteCount: 0,
		deciderRewriteCount: 0,
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
		state.deciderRewriteCount = 0;
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
		if (event.messageType === "user") {
			state.rewriteCount = 0;
			state.deciderRewriteCount = 0;
		}
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
			const statusSuffix = cfg.decider.enabled ? " & answer…" : "…";
			setStatus(ctx, `pi-guard: asking verifier about ${items.length} URL(s)${statusSuffix}`);
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

	async function evaluateAnswer(
		messages: readonly LooseMessage[],
		assistantIdx: number,
		ctx: ExtensionContext,
		signal: AbortSignal,
	): Promise<DeciderFinding | undefined> {
		const decCfg = state.config.decider;
		const resolved = resolveDeciderModel(decCfg, ctx.modelRegistry);
		if (resolved.warning) warnOnce(ctx, `pi-guard: ${resolved.warning}`);
		if (!resolved.model) return undefined;

		const turn = extractTurnContext(messages, assistantIdx);
		const outcome = await evaluateWithDecider(turn, {
			model: resolved.model,
			registry: ctx.modelRegistry,
			config: decCfg,
			signal,
		});
		if (signal.aborted) return undefined;
		if (outcome.error && !/aborted/.test(outcome.error)) {
			warnOnce(ctx, `pi-guard: ${outcome.error} (answer passed unchecked)`);
		}
		return outcome.finding;
	}

	pi.on("agent_before_settle", async (event, ctx) => {
		const cfg = state.config;
		if ((!cfg.enabled && !cfg.decider.enabled) || event.outcome !== "completed") return undefined;

		const messages = event.context.contextMessages as unknown as LooseMessage[];
		const idx = lastAssistantIndex(messages);
		if (idx < 0) return undefined;
		const answer = assistantText(messages[idx]);
		if (!answer.trim()) return undefined;

		const candidates = cfg.enabled
			? extractUrls(answer, { skipCodeBlocks: cfg.skipCodeBlocks })
					.filter((u) => skipReason(u.url, cfg.bypassDomains) === undefined)
					.slice(0, cfg.maxUrls)
			: [];
		const runDecider = cfg.decider.enabled;
		if (candidates.length === 0 && !runDecider) return undefined;

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

		if (candidates.length > 0 && runDecider) {
			setStatus(ctx, `pi-guard: checking ${candidates.length} URL(s) & answer…`);
		} else if (candidates.length > 0) {
			setStatus(ctx, `pi-guard: checking ${candidates.length} URL(s)…`);
		} else {
			setStatus(ctx, "pi-guard: checking answer with decider…");
		}

		try {
			const [findings, deciderFinding] = await Promise.all([
				candidates.length > 0 ? evaluate(candidates, answer, ctx, controller.signal) : Promise.resolve([]),
				runDecider ? evaluateAnswer(messages, idx, ctx, controller.signal) : Promise.resolve(undefined),
			]);
			if (controller.signal.aborted) return undefined;

			const failedUrls = findings.filter((f) => f.failed);
			const failedDecider = deciderFinding?.failed ? deciderFinding : undefined;
			if (failedUrls.length === 0 && !failedDecider) return undefined;

			const urlRewrite = failedUrls.length > 0 && cfg.mode === "rewrite" && state.rewriteCount < cfg.maxRewrites;
			const urlWarn = failedUrls.length > 0 && !urlRewrite;
			const deciderRewrite =
				!!failedDecider && cfg.decider.mode === "rewrite" && state.deciderRewriteCount < cfg.decider.maxRewrites;
			const deciderWarn = !!failedDecider && !deciderRewrite;

			if (urlWarn) notify(ctx, buildWarning(failedUrls), "warning");
			if (deciderWarn && failedDecider) notify(ctx, buildDeciderWarning(failedDecider), "warning");

			if (urlRewrite || deciderRewrite) {
				if (urlRewrite) state.rewriteCount++;
				if (deciderRewrite) state.deciderRewriteCount++;
				const rewriteParts: string[] = [];
				if (urlRewrite) rewriteParts.push(buildRewriteMessage(failedUrls));
				if (deciderRewrite && failedDecider) rewriteParts.push(buildDeciderRewriteMessage(failedDecider));

				return {
					entries: [
						...event.entries,
						{
							type: "custom_message" as const,
							customType: CUSTOM_TYPE,
							display: true,
							content: rewriteParts.join("\n\n"),
							details: {
								...(urlRewrite ? { failed: failedUrls, attempt: state.rewriteCount } : {}),
								...(deciderRewrite && failedDecider
									? { decider: failedDecider, deciderAttempt: state.deciderRewriteCount }
									: {}),
							},
						},
					],
					continue: true,
				};
			}

			return {
				entries: [
					...event.entries,
					{
						type: "custom" as const,
						customType: CUSTOM_TYPE,
						data: {
							...(failedUrls.length > 0 ? { failed: failedUrls, rewrites: state.rewriteCount } : {}),
							...(failedDecider ? { decider: failedDecider, deciderRewrites: state.deciderRewriteCount } : {}),
						},
					},
				],
			};
		} finally {
			ctx.signal?.removeEventListener("abort", onAbort);
			unsubscribeInput?.();
			setStatus(ctx, undefined);
		}
	});
}
