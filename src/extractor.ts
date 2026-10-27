/**
 * URL extraction from assistant text.
 */

/** A URL found in a piece of text. */
export interface ExtractedUrl {
	/** Normalized URL (fragment removed). */
	url: string;
	/** Canonical comparison key (see {@link canonicalKey}). */
	key: string;
	/** Offset of the raw match in the original text. */
	index: number;
	/** Length of the raw match. */
	length: number;
}

export interface ExtractOptions {
	/** Ignore URLs inside fenced code blocks and inline code spans. */
	skipCodeBlocks?: boolean;
}

/** Custom message type used by this extension (never whitelisted). */
export const CUSTOM_TYPE = "pi-guard";

// ---------------------------------------------------------------------------
// Code masking
// ---------------------------------------------------------------------------

/** Replaces every character except line breaks with a space, preserving offsets. */
function blank(s: string): string {
	return s.replace(/[^\r\n]/g, " ");
}

/**
 * Replaces fenced code blocks (``` / ~~~) and inline code spans with spaces.
 * Offsets of the remaining text are preserved.
 */
export function maskCode(text: string): string {
	// Fenced blocks: an opening fence line, until a closing fence of the same
	// character and at least the same length, or the end of the text.
	const lines = text.split(/(?<=\n)/);
	let out = "";
	let fence: { ch: string; len: number } | null = null;
	for (const line of lines) {
		if (fence) {
			const close = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?\n?$/.exec(line);
			if (close && close[1]![0] === fence.ch && close[1]!.length >= fence.len) fence = null;
			out += blank(line);
			continue;
		}
		const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
		if (open && !(open[1]![0] === "`" && line.slice(open[0].length).includes("`"))) {
			fence = { ch: open[1]![0]!, len: open[1]!.length };
			out += blank(line);
			continue;
		}
		out += line;
	}

	// Inline code: a run of N backticks closed by the next run of exactly N backticks.
	let result = "";
	let i = 0;
	while (i < out.length) {
		if (out[i] !== "`") {
			result += out[i];
			i++;
			continue;
		}
		let n = 0;
		while (out[i + n] === "`") n++;
		const ticks = "`".repeat(n);
		let search = i + n;
		let close = -1;
		while (search < out.length) {
			const j = out.indexOf(ticks, search);
			if (j === -1) break;
			let m = 0;
			while (out[j + m] === "`") m++;
			if (m === n) {
				close = j;
				break;
			}
			search = j + m;
		}
		if (close === -1) {
			result += ticks;
			i += n;
			continue;
		}
		result += blank(out.slice(i, close + n));
		i = close + n;
	}
	return result;
}

// ---------------------------------------------------------------------------
// URL matching
// ---------------------------------------------------------------------------

const LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
const HOST = `(?:\\[[0-9A-Fa-f:.]+\\]|${LABEL}(?:\\.${LABEL})*\\.?)`;
// Characters allowed after the host. Excludes whitespace, characters that are
// never valid unencoded in URLs and commonly delimit them, plus CJK/full-width punctuation.
const PATH_CHAR = "[^\\s<>\"`{}|\\\\^\\[\\]\\u3000-\\u303F\\uFF01-\\uFF0F\\uFF1A-\\uFF20\\uFF3B-\\uFF40\\uFF5B-\\uFF65]";
const BARE_URL_RE = new RegExp(`\\bhttps?:\\/\\/${HOST}(?::\\d{1,5})?(?:[/?#]${PATH_CHAR}*)?`, "gi");

const TRAILING_PUNCT = new Set([".", ",", ";", ":", "!", "?", "'", "\"", "*", "~", "_"]);
// Hangul, kana, CJK ideographs.
const CJK_RE = /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF\u3040-\u30FF\u4E00-\u9FFF]/;
const CJK_TAIL_RE = /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF\u3040-\u30FF\u4E00-\u9FFF]+$/;

function count(s: string, ch: string): number {
	let n = 0;
	for (const c of s) if (c === ch) n++;
	return n;
}

/** Removes trailing punctuation, unbalanced closing parens, and CJK particles glued to an ASCII path. */
export function trimUrlCandidate(raw: string): string {
	let s = raw;
	for (;;) {
		const last = s[s.length - 1];
		if (last === undefined) return s;
		if (TRAILING_PUNCT.has(last)) {
			s = s.slice(0, -1);
			continue;
		}
		if (last === ")" && count(s, ")") > count(s, "(")) {
			s = s.slice(0, -1);
			continue;
		}
		// "https://x.com/docs에서" → "https://x.com/docs": a CJK run directly after an
		// ASCII character in the last path segment is almost always surrounding prose.
		const tail = CJK_TAIL_RE.exec(s);
		if (tail && tail.index > 0) {
			const before = s[tail.index - 1]!;
			if (!CJK_RE.test(before) && before !== "/" && before !== "=" && before !== "#" && before !== "?") {
				s = s.slice(0, tail.index);
				continue;
			}
		}
		return s;
	}
}

/** Normalizes a URL string: parses it, requires http(s), drops the fragment. */
export function normalizeUrl(raw: string): string | undefined {
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return undefined;
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
	if (!u.hostname) return undefined;
	u.hash = "";
	return u.href;
}

/**
 * Comparison key: normalized URL without fragment, without trailing slash in the
 * path, and without a trailing dot in the host. Used for dedupe, whitelist and cache.
 */
export function canonicalKey(url: string): string {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return url;
	}
	u.hash = "";
	if (u.hostname.endsWith(".")) u.hostname = u.hostname.slice(0, -1);
	let s = u.href;
	if (u.pathname.length > 1 && u.pathname.endsWith("/") && !u.search) s = s.slice(0, -1);
	return s;
}

/**
 * Finds markdown link targets `[text](url "title")` / `[text](<url>)`, handling balanced
 * parentheses inside the URL. Returns raw matches with their offsets.
 */
function findMarkdownTargets(text: string): { raw: string; index: number; length: number }[] {
	const found: { raw: string; index: number; length: number }[] = [];
	let from = 0;
	for (;;) {
		const at = text.indexOf("](", from);
		if (at === -1) break;
		from = at + 2;
		let i = at + 2;
		while (text[i] === " " || text[i] === "\t") i++;
		if (text[i] === "<") {
			const end = text.indexOf(">", i + 1);
			if (end === -1) continue;
			const raw = text.slice(i + 1, end);
			if (/^https?:\/\//i.test(raw) && !/[\s]/.test(raw)) found.push({ raw, index: i + 1, length: raw.length });
			continue;
		}
		if (!/^https?:\/\//i.test(text.slice(i, i + 8))) continue;
		const start = i;
		let depth = 0;
		while (i < text.length) {
			const c = text[i]!;
			if (/\s/.test(c)) break;
			if (c === "(") depth++;
			else if (c === ")") {
				if (depth === 0) break;
				depth--;
			}
			i++;
		}
		const raw = text.slice(start, i);
		found.push({ raw, index: start, length: raw.length });
		from = i;
	}
	return found;
}

/**
 * Extracts unique http(s) URLs from text: markdown links, `<autolinks>`, and bare URLs.
 * Results are in order of first appearance and deduplicated by {@link canonicalKey}.
 */
export function extractUrls(text: string, options: ExtractOptions = {}): ExtractedUrl[] {
	const source = options.skipCodeBlocks === false ? text : maskCode(text);
	const hits: { raw: string; index: number; length: number }[] = [];

	// 1. Markdown link targets (exact, paren-aware). Mask them for the bare scan.
	let masked = source;
	for (const t of findMarkdownTargets(source)) {
		hits.push(t);
		masked = masked.slice(0, t.index) + " ".repeat(t.length) + masked.slice(t.index + t.length);
	}

	// 2. Bare URLs and <autolinks> (angle brackets are not URL characters).
	for (const m of masked.matchAll(BARE_URL_RE)) {
		const raw = trimUrlCandidate(m[0]);
		hits.push({ raw, index: m.index, length: raw.length });
	}

	hits.sort((a, b) => a.index - b.index);
	const seen = new Set<string>();
	const out: ExtractedUrl[] = [];
	for (const h of hits) {
		const url = normalizeUrl(h.raw);
		if (!url) continue;
		const key = canonicalKey(url);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ url, key, index: h.index, length: h.length });
	}
	return out;
}

/** Returns up to `radius` characters of text on both sides of a match. */
export function snippetAround(text: string, index: number, length: number, radius = 200): string {
	const start = Math.max(0, index - radius);
	const end = Math.min(text.length, index + length + radius);
	return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

// ---------------------------------------------------------------------------
// Context messages
// ---------------------------------------------------------------------------

/** Structural view of an AgentMessage; avoids depending on pi's message unions here. */
export interface LooseMessage {
	role: string;
	[key: string]: unknown;
}

function textOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (part && typeof part === "object" && (part as { type?: unknown }).type === "text") {
			const t = (part as { text?: unknown }).text;
			if (typeof t === "string") parts.push(t);
		}
	}
	return parts.join("\n");
}

/** Index of the last assistant message, or -1. */
export function lastAssistantIndex(messages: readonly LooseMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "assistant") return i;
	}
	return -1;
}

/** Text parts of an assistant message joined with newlines. */
export function assistantText(msg: LooseMessage | undefined): string {
	if (!msg || msg.role !== "assistant") return "";
	return textOfContent(msg.content);
}

export interface TurnToolResult {
	toolName: string;
	isError?: boolean;
	content: string;
}

export interface TurnContext {
	userPrompt: string;
	toolResults: TurnToolResult[];
	assistantAnswer: string;
}

const MAX_USER_PROMPT_CHARS = 4_000;
const MAX_TOOL_RESULT_CHARS = 1_500;
const MAX_TOTAL_TOOL_CHARS = 8_000;
const MAX_ASSISTANT_ANSWER_CHARS = 8_000;

function truncateText(text: string, maxChars: number): string {
	const trimmed = text.trim();
	if (trimmed.length <= maxChars) return trimmed;
	return `${trimmed.slice(0, maxChars)}…`;
}

/**
 * Extracts the current turn's context leading up to `assistantIdx`:
 * the last user message before `assistantIdx`, any tool results between that user message
 * and `assistantIdx`, and the assistant's final answer text.
 */
export function extractTurnContext(messages: readonly LooseMessage[], assistantIdx: number): TurnContext {
	const answer = truncateText(assistantText(messages[assistantIdx]), MAX_ASSISTANT_ANSWER_CHARS);
	let userIdx = -1;
	for (let i = assistantIdx - 1; i >= 0; i--) {
		if (messages[i]?.role === "user") {
			userIdx = i;
			break;
		}
	}

	const userPrompt = userIdx >= 0 ? truncateText(textOfContent(messages[userIdx]?.content), MAX_USER_PROMPT_CHARS) : "";
	const toolResults: TurnToolResult[] = [];
	const startIdx = userIdx >= 0 ? userIdx + 1 : 0;
	let totalToolChars = 0;

	for (let i = startIdx; i < assistantIdx; i++) {
		const msg = messages[i];
		if (!msg || msg.role !== "toolResult") continue;
		const remaining = MAX_TOTAL_TOOL_CHARS - totalToolChars;
		if (remaining <= 0) break;
		const rawContent = textOfContent(msg.content);
		const content = truncateText(rawContent, Math.min(MAX_TOOL_RESULT_CHARS, remaining));
		if (!content) continue;
		totalToolChars += content.length;
		const toolName = typeof msg.toolName === "string" && msg.toolName.trim() ? msg.toolName.trim() : "tool";
		const isError = typeof msg.isError === "boolean" ? msg.isError : undefined;
		toolResults.push({
			toolName,
			...(isError !== undefined ? { isError } : {}),
			content,
		});
	}

	return {
		userPrompt,
		toolResults,
		assistantAnswer: answer,
	};
}
