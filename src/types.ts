/** Shared configuration and result types for pi-guard. */

export const MODES = ["rewrite", "warn"] as const;
export type Mode = (typeof MODES)[number];

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingSetting = (typeof THINKING_LEVELS)[number];

export interface VerifierConfig {
	/** Provider of the verifier model. `null` = use the session model. */
	provider: string | null;
	/** Model id of the verifier model. `null` = use the session model. */
	model: string | null;
	thinking: ThinkingSetting;
	/** Replaces the built-in system prompt entirely when set. */
	systemPrompt: string | null;
	timeoutMs: number;
}

export interface HttpConfig {
	enabled: boolean;
	timeoutMs: number;
	concurrency: number;
	/** `null` = browser-like default user agent. */
	userAgent: string | null;
	/** `"env"` | `"none"` | proxy URL (`http://`, `https://`, `socks5://`). */
	proxy: string;
	/** Hosts that bypass `proxy` when it is a URL. */
	noProxy: string[];
	useSystemCa: boolean;
}

export interface PiGuardConfig {
	enabled: boolean;
	mode: Mode;
	maxRewrites: number;
	maxUrls: number;
	skipCodeBlocks: boolean;
	bypassDomains: string[];
	verifier: VerifierConfig;
	http: HttpConfig;
}

/** Outcome of the HTTP existence check. */
export type HttpVerdict = "OK" | "NOT_FOUND" | "UNCERTAIN";

/** Coarse error category, used for diagnostics and the one-time proxy/TLS warning. */
export type HttpErrorKind = "dns" | "timeout" | "tls" | "proxy" | "network" | "aborted" | "disabled";

export interface HttpCheckResult {
	url: string;
	verdict: HttpVerdict;
	/** Final HTTP status code, when a response was received. */
	status?: number;
	/** Human-readable error, when no usable response was received. */
	error?: string;
	errorKind?: HttpErrorKind;
}

/** Outcome of the LLM judgement for URLs the HTTP check could not decide. */
export type LlmVerdict = "EXISTS" | "NOT_EXISTS" | "UNKNOWN";

export interface LlmResult {
	url: string;
	verdict: LlmVerdict;
	reason: string;
}

/** Combined verdict for one URL. */
export interface UrlFinding {
	url: string;
	http?: HttpCheckResult;
	llm?: LlmResult;
	/** True when the URL is considered hallucinated (HTTP NOT_FOUND or LLM NOT_EXISTS). */
	failed: boolean;
	/** Short explanation (HTTP status / error / LLM reason). */
	reason: string;
}
