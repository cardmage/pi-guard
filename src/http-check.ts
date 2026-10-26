/** HTTP existence check: HEAD, falling back to GET, mapped to OK / NOT_FOUND / UNCERTAIN. */

import { type Dispatcher, fetch } from "undici";
import { maskCredentialsInText } from "./dispatcher.ts";
import type { HttpCheckResult, HttpErrorKind, HttpVerdict } from "./types.ts";

export const DEFAULT_USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

const MAX_CONTENT_BYTES = 64 * 1024;
const MAX_CONTENT_CHARS = 4000;

export interface HttpCheckOptions {
	dispatcher?: Dispatcher;
	timeoutMs: number;
	concurrency: number;
	userAgent?: string | null;
	signal?: AbortSignal;
	/** A proxy may be in use: DNS failures for other hosts are proxy problems, not missing pages. */
	proxyConfigured?: boolean;
	/** When true, fetches up to 64 KB of textual body on 2xx responses and extracts readable text. */
	fetchContent?: boolean;
}

/** Strips HTML tags, scripts, styles, and collapses whitespace into a compact readable snippet. */
export function extractTextFromBody(raw: string, contentType: string): string {
	const decodeEntities = (s: string) =>
		s
			.replace(/&nbsp;/gi, " ")
			.replace(/&amp;/gi, "&")
			.replace(/&lt;/gi, "<")
			.replace(/&gt;/gi, ">")
			.replace(/&quot;/gi, '"')
			.replace(/&#39;/gi, "'");

	let text = raw;
	if (/html|xml/i.test(contentType)) {
		const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
		const title = titleMatch ? decodeEntities(titleMatch[1]!.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim() : "";
		text = decodeEntities(
			text
				.replace(/<(script|style|noscript|svg|head)[^>]*>[\s\S]*?<\/\1>/gi, " ")
				.replace(/<!--[\s\S]*?-->/g, " ")
				.replace(/<[^>]+>/g, " "),
		)
			.replace(/\s+/g, " ")
			.trim();
		if (title && !text.startsWith(title)) {
			text = text ? `${title} — ${text}` : title;
		}
	} else {
		text = text.replace(/\s+/g, " ").trim();
	}
	return text.slice(0, MAX_CONTENT_CHARS);
}

/** Maps a final HTTP status to a verdict. */
export function classifyStatus(status: number): HttpVerdict {
	if (status >= 200 && status < 400) return "OK";
	if (status === 404 || status === 410) return "NOT_FOUND";
	return "UNCERTAIN";
}

const TLS_CODES = new Set([
	"CERT_HAS_EXPIRED",
	"CERT_NOT_YET_VALID",
	"CERT_UNTRUSTED",
	"CERT_REVOKED",
	"DEPTH_ZERO_SELF_SIGNED_CERT",
	"SELF_SIGNED_CERT_IN_CHAIN",
	"UNABLE_TO_GET_ISSUER_CERT",
	"UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
	"ERR_TLS_CERT_ALTNAME_INVALID",
	"ERR_SSL_WRONG_VERSION_NUMBER",
	"EPROTO",
]);

const TIMEOUT_CODES = new Set([
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT",
	"ETIMEDOUT",
	"ESOCKETTIMEDOUT",
]);

interface ErrorInfo {
	codes: string[];
	messages: string[];
	hostnames: string[];
	names: string[];
}

function walkError(err: unknown): ErrorInfo {
	const info: ErrorInfo = { codes: [], messages: [], hostnames: [], names: [] };
	let cur: unknown = err;
	for (let depth = 0; cur && depth < 8; depth++) {
		const e = cur as { code?: unknown; message?: unknown; hostname?: unknown; name?: unknown; cause?: unknown; errors?: unknown };
		if (typeof e.code === "string") info.codes.push(e.code);
		if (typeof e.message === "string") info.messages.push(e.message);
		if (typeof e.hostname === "string") info.hostnames.push(e.hostname.toLowerCase());
		if (typeof e.name === "string") info.names.push(e.name);
		if (Array.isArray(e.errors)) {
			for (const sub of e.errors) {
				const s = walkError(sub);
				info.codes.push(...s.codes);
				info.messages.push(...s.messages);
				info.hostnames.push(...s.hostnames);
			}
		}
		cur = e.cause;
	}
	return info;
}

/**
 * Maps a fetch error to a verdict.
 * - `ENOTFOUND` for the target host → NOT_FOUND (the domain does not exist)
 * - everything else (timeouts, TLS, proxy, resets, temporary DNS failure) → UNCERTAIN
 */
export function classifyError(
	err: unknown,
	targetHost: string,
	proxyConfigured = false,
): { verdict: HttpVerdict; kind: HttpErrorKind; error: string } {
	const info = walkError(err);
	const message = maskCredentialsInText(
		[...new Set(info.messages.filter((m) => m && m !== "fetch failed"))].join(": ") || String(err),
	);
	const has = (set: Set<string>) => info.codes.some((c) => set.has(c));

	// Before the abort check: undici reports failed CONNECT tunnels as RequestAbortedError (name "AbortError").
	if (info.messages.some((m) => /proxy/i.test(m)) || info.codes.includes("UND_ERR_PRX_TLS")) {
		return { verdict: "UNCERTAIN", kind: "proxy", error: message };
	}
	if (info.names.includes("AbortError") || info.names.includes("TimeoutError") || has(TIMEOUT_CODES)) {
		const timeout = info.names.includes("TimeoutError") || has(TIMEOUT_CODES);
		return { verdict: "UNCERTAIN", kind: timeout ? "timeout" : "aborted", error: timeout ? "timeout" : "aborted" };
	}
	if (info.codes.includes("ENOTFOUND")) {
		const host = targetHost.toLowerCase();
		// With a proxy, an unresolvable host may be the proxy itself.
		const aboutTarget = info.hostnames.length === 0 ? !proxyConfigured : info.hostnames.includes(host);
		if (aboutTarget) return { verdict: "NOT_FOUND", kind: "dns", error: `DNS: host not found (${host})` };
		return { verdict: "UNCERTAIN", kind: "proxy", error: message };
	}
	if (has(TLS_CODES) || info.messages.some((m) => /certificate|SSL routines|TLS/i.test(m))) {
		return { verdict: "UNCERTAIN", kind: "tls", error: message };
	}
	if (proxyConfigured && info.codes.some((c) => c === "ECONNREFUSED" || c === "ECONNRESET" || c === "UND_ERR_SOCKET")) {
		return { verdict: "UNCERTAIN", kind: "proxy", error: message };
	}
	if (info.codes.includes("EAI_AGAIN")) {
		return { verdict: "UNCERTAIN", kind: "dns", error: `DNS temporarily unavailable (${targetHost})` };
	}
	return { verdict: "UNCERTAIN", kind: "network", error: message };
}

async function readBoundedText(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (total < maxBytes) {
			const { done, value } = await reader.read();
			if (done || !value) break;
			const take = total + value.byteLength > maxBytes ? value.subarray(0, maxBytes - total) : value;
			chunks.push(take);
			total += take.byteLength;
			if (total >= maxBytes) break;
		}
	} catch {
		// Ignore mid-stream errors if we already got headers/partial content
	} finally {
		reader.cancel().catch(() => {});
	}
	if (chunks.length === 0) return "";
	return Buffer.concat(chunks).toString("utf8");
}

function isTextualContentType(ct: string): boolean {
	return /text\/|application\/(json|xml|xhtml\+xml|javascript)|\+json|\+xml/i.test(ct);
}

async function request(
	url: string,
	method: "HEAD" | "GET",
	opts: HttpCheckOptions,
	signal: AbortSignal,
	readBody = false,
): Promise<{ status: number; pageContent?: string }> {
	const controller = new AbortController();
	const onAbort = () => controller.abort(signal.reason);
	if (signal.aborted) controller.abort(signal.reason);
	else signal.addEventListener("abort", onAbort, { once: true });
	try {
		const res = await fetch(url, {
			method,
			redirect: "follow",
			signal: controller.signal,
			dispatcher: opts.dispatcher,
			headers: {
				"user-agent": opts.userAgent || DEFAULT_USER_AGENT,
				accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
				"accept-language": "en-US,en;q=0.9",
			},
		});
		let pageContent: string | undefined;
		const contentType = res.headers.get("content-type") ?? "";
		if (readBody && method === "GET" && res.status >= 200 && res.status < 300 && res.body && isTextualContentType(contentType)) {
			const raw = await readBoundedText(res.body, MAX_CONTENT_BYTES);
			controller.abort();
			if (raw) {
				const extracted = extractTextFromBody(raw, contentType);
				if (extracted) pageContent = extracted;
			}
		} else if (res.body) {
			controller.abort();
			res.body.cancel().catch(() => {});
		}
		return { status: res.status, ...(pageContent ? { pageContent } : {}) };
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

/** Checks one URL. Never throws. */
export async function checkUrl(url: string, opts: HttpCheckOptions): Promise<HttpCheckResult> {
	let host = "";
	try {
		host = new URL(url).hostname.replace(/^\[|\]$/g, "");
	} catch {
		return { url, verdict: "UNCERTAIN", error: "invalid URL", errorKind: "network" };
	}
	const timeout = AbortSignal.timeout(opts.timeoutMs);
	const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

	if (opts.fetchContent) {
		try {
			const { status, pageContent } = await request(url, "GET", opts, signal, true);
			return { url, verdict: classifyStatus(status), status, ...(pageContent ? { pageContent } : {}) };
		} catch (err) {
			const c = classifyError(timeout.aborted ? timeout.reason : err, host, opts.proxyConfigured);
			return { url, verdict: c.verdict, error: c.error, errorKind: c.kind };
		}
	}

	let headResult: HttpCheckResult;
	try {
		const { status } = await request(url, "HEAD", opts, signal);
		headResult = { url, verdict: classifyStatus(status), status };
		if (headResult.verdict === "OK") return headResult;
	} catch (err) {
		const c = classifyError(timeout.aborted ? timeout.reason : err, host, opts.proxyConfigured);
		headResult = { url, verdict: c.verdict, error: c.error, errorKind: c.kind };
		// Timeout, user abort, missing domain, proxy or TLS failure: a GET would fail the same way.
		if (c.kind !== "network" || signal.aborted) return headResult;
	}
	if (signal.aborted) return headResult;

	// HEAD is unreliable (405/501, bot filters, some servers 404 on HEAD only): confirm with GET.
	try {
		const { status } = await request(url, "GET", opts, signal);
		return { url, verdict: classifyStatus(status), status };
	} catch (err) {
		if (headResult.status !== undefined && headResult.verdict === "NOT_FOUND") {
			// GET failed after a definitive HEAD 404/410: trust HEAD only if GET never answered.
			return { ...headResult, verdict: "UNCERTAIN", error: `HEAD ${headResult.status}, GET failed` };
		}
		const c = classifyError(timeout.aborted ? timeout.reason : err, host, opts.proxyConfigured);
		return { url, verdict: c.verdict, error: c.error, errorKind: c.kind, status: headResult.status };
	}
}

/** Runs `fn` over `items` with at most `limit` in flight. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
		for (;;) {
			const i = next++;
			if (i >= items.length) return;
			results[i] = await fn(items[i]!);
		}
	});
	await Promise.all(workers);
	return results;
}

/** Checks URLs with bounded concurrency. Results are in input order. */
export async function checkUrls(urls: readonly string[], opts: HttpCheckOptions): Promise<HttpCheckResult[]> {
	return mapLimit(urls, opts.concurrency, (u) => checkUrl(u, opts));
}
