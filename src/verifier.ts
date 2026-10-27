/** LLM fallback for URLs the HTTP check could not decide. */

import type { Api, AssistantMessage, Model, UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LlmResult, LlmVerdict, VerifierConfig } from "./types.ts";

export const DEFAULT_SYSTEM_PROMPT = `You are a citation auditor. You judge whether URLs cited by an AI assistant point to real pages and, when page content is provided, whether the page actually supports the assistant's claim.

Case 1 — Existence check (no \`pageContent\` provided):
Some URLs could not be verified over HTTP (blocked by bot protection, rate limits, server errors, timeouts, or network problems). Use your knowledge of the site's real URL structure, documentation layout, versioning scheme, and naming conventions to decide:
- "EXISTS": you are confident the page exists (well-known page, plausible path on a site whose structure you know, or the HTTP signal suggests a live page behind access control).
- "NOT_EXISTS": you are confident the URL is fabricated (non-existent product/version, invented path segments, impossible structure, made-up domain).
- "UNKNOWN": you cannot tell. Prefer UNKNOWN over guessing.
A 401/403/429 status usually means the server is up and blocks automated clients; it is not evidence that the page is missing.

Case 2 — Content grounding check (\`pageContent\` is provided):
The URL returned HTTP 200 and its extracted text is given in \`pageContent\`. Compare \`pageContent\` with the assistant's surrounding \`context\`:
- "NOT_EXISTS": \`pageContent\` is clearly a soft-404 / "page not found" / missing-resource error page despite HTTP 200.
- "SUPPORTED": the page is relevant and supports (or is consistent with) the claim or citation in \`context\`. General reference links (e.g. homepage or docs root cited as a general pointer) are also SUPPORTED.
- "CONTRADICTED": the assistant makes a specific factual claim attributed to this URL, and \`pageContent\` clearly contradicts it or is about a completely unrelated topic that does not contain the claimed information.
- "UNKNOWN": \`pageContent\` is truncated, empty, a login/JS shell, or insufficient to tell. Prefer UNKNOWN over false alarms.

Judge each URL independently. Never invent new URLs.`;

const VERDICTS: readonly LlmVerdict[] = ["EXISTS", "NOT_EXISTS", "SUPPORTED", "CONTRADICTED", "UNKNOWN"];

export interface VerifyItem {
	url: string;
	httpStatus?: number;
	httpError?: string;
	/** Extracted text from the fetched page (when HTTP 2xx and content verification is enabled). */
	pageContent?: string;
	/** Answer text around the URL. */
	context: string;
}

export interface ResolvedModel {
	model: Model<Api> | undefined;
	warning?: string;
}

type RegistryLike = Pick<ExtensionContext["modelRegistry"], "find" | "getAll" | "hasConfiguredAuth">;

/**
 * Picks the verifier model: the configured provider/model when found and authenticated,
 * otherwise the session model (with a warning when a configured model was rejected).
 */
export function resolveVerifierModel(
	cfg: Pick<VerifierConfig, "provider" | "model">,
	registry: RegistryLike,
	sessionModel: Model<Api> | undefined,
): ResolvedModel {
	if (!cfg.provider && !cfg.model) return { model: sessionModel };
	const label = `${cfg.provider ?? "*"}/${cfg.model ?? "*"}`;
	let found: Model<Api> | undefined;
	try {
		if (cfg.provider && cfg.model) {
			found = registry.find(cfg.provider, cfg.model);
		} else if (cfg.model) {
			found = registry.getAll().find((m) => m.id === cfg.model);
		} else {
			return { model: sessionModel, warning: `verifier.model is required when verifier.provider is set; using session model` };
		}
	} catch {
		found = undefined;
	}
	if (!found) {
		return { model: sessionModel, warning: `verifier model "${label}" not found; using session model` };
	}
	let authed = false;
	try {
		authed = registry.hasConfiguredAuth(found);
	} catch {
		authed = false;
	}
	if (!authed) {
		return { model: sessionModel, warning: `verifier model "${label}" has no configured auth; using session model` };
	}
	return { model: found };
}

/** Builds the user message. The output format lives here so a custom system prompt keeps the parser working. */
export function buildUserPrompt(items: readonly VerifyItem[]): string {
	const payload = items.map((it) => ({
		url: it.url,
		...(it.httpStatus !== undefined ? { httpStatus: it.httpStatus } : {}),
		...(it.httpError ? { httpError: it.httpError } : {}),
		...(it.pageContent ? { pageContent: it.pageContent } : {}),
		context: it.context,
	}));
	return [
		"Judge each URL below. `context` is the assistant's answer text around the URL. When `pageContent` is present, verify that the page is not a soft-404 and that it supports the assistant's claim in `context`.",
		"",
		"<urls>",
		JSON.stringify(payload, null, 2),
		"</urls>",
		"",
		"Respond with JSON only, no prose, exactly in this shape (one entry per URL, same URL strings):",
		'{"results":[{"url":"<url>","verdict":"EXISTS|NOT_EXISTS|SUPPORTED|CONTRADICTED|UNKNOWN","reason":"<short reason>"}]}',
	].join("\n");
}

/**
 * Parses the model output. Strips code fences, takes the first `{` to the last `}`,
 * validates the shape. URLs missing from (or invalid in) the output become UNKNOWN.
 */
export function parseVerdicts(text: string, urls: readonly string[]): Map<string, LlmResult> {
	const out = new Map<string, LlmResult>();
	for (const url of urls) out.set(url, { url, verdict: "UNKNOWN", reason: "no verdict" });

	let body = text.replace(/```(?:json)?/gi, "");
	const start = body.indexOf("{");
	const end = body.lastIndexOf("}");
	if (start === -1 || end <= start) return markAll(out, "unparseable verifier output");
	body = body.slice(start, end + 1);

	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return markAll(out, "unparseable verifier output");
	}
	const results = (parsed as { results?: unknown })?.results;
	if (!Array.isArray(results)) return markAll(out, "unparseable verifier output");

	const wanted = new Set(urls);
	const loose = new Map(urls.map((u) => [looseKey(u), u]));
	for (const r of results) {
		if (!r || typeof r !== "object") continue;
		const { url, verdict, reason } = r as { url?: unknown; verdict?: unknown; reason?: unknown };
		if (typeof url !== "string" || typeof verdict !== "string") continue;
		const v = verdict.trim().toUpperCase() as LlmVerdict;
		if (!VERDICTS.includes(v)) continue;
		const target = wanted.has(url) ? url : loose.get(looseKey(url));
		if (!target) continue;
		out.set(target, { url: target, verdict: v, reason: typeof reason === "string" ? reason.slice(0, 500) : "" });
	}
	return out;
}

function looseKey(url: string): string {
	return url.trim().replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase();
}

function markAll(map: Map<string, LlmResult>, reason: string): Map<string, LlmResult> {
	for (const [url] of map) map.set(url, { url, verdict: "UNKNOWN", reason });
	return map;
}

export interface VerifyOptions {
	model: Model<Api> | undefined;
	registry: Pick<ExtensionContext["modelRegistry"], "streamSimple">;
	config: VerifierConfig;
	signal?: AbortSignal;
}

export interface VerifyOutcome {
	results: Map<string, LlmResult>;
	/** Set when the call failed (fail-open: every result is UNKNOWN). */
	error?: string;
}

function textOf(msg: AssistantMessage): string {
	return msg.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

/** Judges all items with one model call. Never throws; failures yield UNKNOWN for every URL. */
export async function verifyWithLlm(items: readonly VerifyItem[], opts: VerifyOptions): Promise<VerifyOutcome> {
	const urls = items.map((i) => i.url);
	const fail = (error: string): VerifyOutcome => ({
		results: markAll(new Map(urls.map((u) => [u, { url: u, verdict: "UNKNOWN", reason: error }])), error),
		error,
	});
	if (items.length === 0) return { results: new Map() };
	if (!opts.model) return fail("no verifier model available");

	const timeout = AbortSignal.timeout(opts.config.timeoutMs);
	const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
	const userMessage: UserMessage = {
		role: "user",
		content: [{ type: "text", text: buildUserPrompt(items) }],
		timestamp: Date.now(),
	};
	const useReasoning = opts.config.thinking !== "off" && opts.model.reasoning;
	const maxTokens = Math.min(opts.model.maxTokens > 0 ? opts.model.maxTokens : 4096, 512 + items.length * 200);

	let onAbort: (() => void) | undefined;
	try {
		const stream = opts.registry.streamSimple(
			opts.model,
			{ systemPrompt: opts.config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT, messages: [userMessage] },
			{
				...(useReasoning ? { reasoning: opts.config.thinking as Exclude<VerifierConfig["thinking"], "off"> } : {}),
				signal,
				timeoutMs: opts.config.timeoutMs,
				maxTokens,
			},
		);
		const resultPromise = stream.result();
		// stream.result() may not observe the abort signal promptly on every provider.
		const aborted = new Promise<never>((_, reject) => {
			if (signal.aborted) {
				reject(signal.reason);
				return;
			}
			onAbort = () => reject(signal.reason);
			signal.addEventListener("abort", onAbort, { once: true });
		});
		aborted.catch(() => {});
		const msg = await Promise.race([resultPromise, aborted]);
		if (msg.stopReason === "error" || msg.stopReason === "aborted") {
			return fail(msg.stopReason === "aborted" ? (timeout.aborted ? "verifier timeout" : "verifier aborted") : `verifier error: ${msg.errorMessage ?? "unknown"}`);
		}
		return { results: parseVerdicts(textOf(msg), urls) };
	} catch (err) {
		if (timeout.aborted) return fail("verifier timeout");
		if (opts.signal?.aborted) return fail("verifier aborted");
		return fail(`verifier error: ${err instanceof Error ? err.message : String(err)}`);
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
}
