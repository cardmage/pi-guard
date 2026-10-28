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

export interface DeciderConfig {
	/** Whether to check the assistant's final answer with a classifier/decision model. */
	enabled: boolean;
	mode: Mode;
	maxRewrites: number;
	/** Classifier model provider (defaults to `"llama.cpp"`). */
	provider: string;
	/** Classifier model id (e.g. `"pplx-decider-v1.1-27b"`). `null` = auto-pick when the provider has a single classifier model. */
	model: string | null;
	/** Probability threshold in `(0, 1]` at or above which the answer is considered wrong. */
	threshold: number;
	timeoutMs: number;
	/** Custom instructions for the `wrong` bool question. `null` = built-in multi-angle questions. */
	instructions: string | null;
}

export interface PiGuardConfig {
	enabled: boolean;
	mode: Mode;
	maxRewrites: number;
	maxUrls: number;
	skipCodeBlocks: boolean;
	/** When true, fetches page text for HTTP 200 URLs and uses the verifier LLM to check whether the cited page supports the claim around the URL. */
	verifyContent: boolean;
	bypassDomains: string[];
	verifier: VerifierConfig;
	http: HttpConfig;
	decider: DeciderConfig;
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
	/** Extracted readable text snippet from the page when `fetchContent` is enabled and the response is textual 2xx. */
	pageContent?: string;
}

/** Outcome of the LLM judgement for URLs (existence or content grounding). */
export type LlmVerdict = "EXISTS" | "NOT_EXISTS" | "SUPPORTED" | "CONTRADICTED" | "UNKNOWN";

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
	/** True when the URL is considered hallucinated or its content contradicts the claim (HTTP NOT_FOUND, LLM NOT_EXISTS, or LLM CONTRADICTED). */
	failed: boolean;
	/** Short explanation (HTTP status / error / LLM reason). */
	reason: string;
}

/** Score of a single evaluation dimension from the decider classifier. */
export interface DeciderDimensionScore {
	id: string;
	polarity: "negative" | "positive";
	/** Raw probability of `true` returned by the classifier in `[0, 1]`. */
	probability: number;
	/** Normalized wrongness risk in `[0, 1]` (`probability` for negative, `1 - probability` for positive). */
	risk: number;
	weight: number;
}

/** Verdict from the classifier/decision model for the assistant's overall answer. */
export interface DeciderFinding {
	provider: string;
	model: string;
	/** Calibrated probability in `[0, 1]` that the assistant's answer is wrong. */
	probability: number;
	threshold: number;
	/** True when `probability >= threshold`. */
	failed: boolean;
	/** Human-readable summary of the decision. */
	reason: string;
	/** Per-dimension breakdown from multi-angle evaluation. */
	breakdown?: DeciderDimensionScore[];
}
