/** Loads and validates `<agentDir>/pi-guard.json`. */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type DeciderConfig,
	type HttpConfig,
	MODES,
	type PiGuardConfig,
	THINKING_LEVELS,
	type VerifierConfig,
} from "./types.ts";

export const CONFIG_FILE_NAME = "pi-guard.json";

export function defaultConfig(): PiGuardConfig {
	return {
		enabled: true,
		mode: "rewrite",
		maxRewrites: 1,
		maxUrls: 20,
		skipCodeBlocks: true,
		verifyContent: true,
		bypassDomains: [],
		verifier: {
			provider: null,
			model: null,
			thinking: "low",
			systemPrompt: null,
			timeoutMs: 30000,
		},
		http: {
			enabled: true,
			timeoutMs: 8000,
			concurrency: 5,
			userAgent: null,
			proxy: "env",
			noProxy: [],
			useSystemCa: true,
		},
		decider: {
			enabled: false,
			mode: "rewrite",
			maxRewrites: 1,
			provider: "llama.cpp",
			model: null,
			threshold: 0.8,
			timeoutMs: 15000,
			instructions: null,
		},
	};
}

export function getConfigPath(agentDir: string): string {
	return join(agentDir, CONFIG_FILE_NAME);
}

export interface ConfigLoadResult {
	config: PiGuardConfig;
	/** Validation / parse problems. Invalid values fall back to their defaults. */
	warnings: string[];
	/** Whether a config file was found. */
	found: boolean;
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

class Validator {
	readonly warnings: string[] = [];

	private warn(key: string, expected: string, value: unknown): void {
		this.warnings.push(`"${key}": expected ${expected}, got ${JSON.stringify(value)} (using default)`);
	}

	bool(src: Obj, key: string, path: string, fallback: boolean): boolean {
		if (!(key in src) || src[key] === undefined) return fallback;
		const v = src[key];
		if (typeof v === "boolean") return v;
		this.warn(path, "boolean", v);
		return fallback;
	}

	int(src: Obj, key: string, path: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
		if (!(key in src) || src[key] === undefined) return fallback;
		const v = src[key];
		if (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max) return v;
		this.warn(path, `integer in [${min}, ${max}]`, v);
		return fallback;
	}

	probability(src: Obj, key: string, path: string, fallback: number): number {
		if (!(key in src) || src[key] === undefined) return fallback;
		const v = src[key];
		if (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1) return v;
		this.warn(path, "number in (0, 1]", v);
		return fallback;
	}

	enumOf<T extends string>(src: Obj, key: string, path: string, allowed: readonly T[], fallback: T): T {
		if (!(key in src) || src[key] === undefined) return fallback;
		const v = src[key];
		if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as T;
		this.warn(path, allowed.map((a) => `"${a}"`).join(" | "), v);
		return fallback;
	}

	nullableString(src: Obj, key: string, path: string, fallback: string | null): string | null {
		if (!(key in src) || src[key] === undefined) return fallback;
		const v = src[key];
		if (v === null) return null;
		if (typeof v === "string") return v.trim() === "" ? null : v;
		this.warn(path, "string or null", v);
		return fallback;
	}

	string(src: Obj, key: string, path: string, fallback: string): string {
		if (!(key in src) || src[key] === undefined) return fallback;
		const v = src[key];
		if (typeof v === "string" && v.trim() !== "") return v.trim();
		this.warn(path, "non-empty string", v);
		return fallback;
	}

	stringArray(src: Obj, key: string, path: string, fallback: string[]): string[] {
		if (!(key in src) || src[key] === undefined) return fallback;
		const v = src[key];
		if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
			return v.map((x: string) => x.trim()).filter((x) => x !== "");
		}
		this.warn(path, "array of strings", v);
		return fallback;
	}

	section(src: Obj, key: string): Obj {
		const v = src[key];
		if (v === undefined) return {};
		if (isObj(v)) return v;
		this.warn(key, "object", v);
		return {};
	}
}

/** Validates a parsed JSON value, merging it onto the defaults. Never throws. */
export function validateConfig(raw: unknown): { config: PiGuardConfig; warnings: string[] } {
	const d = defaultConfig();
	const val = new Validator();
	if (raw === undefined || raw === null) return { config: d, warnings: [] };
	if (!isObj(raw)) {
		return { config: d, warnings: ["config root must be a JSON object (using defaults)"] };
	}

	const v = val.section(raw, "verifier");
	const h = val.section(raw, "http");
	const dec = val.section(raw, "decider");

	const verifier: VerifierConfig = {
		provider: val.nullableString(v, "provider", "verifier.provider", d.verifier.provider),
		model: val.nullableString(v, "model", "verifier.model", d.verifier.model),
		thinking: val.enumOf(v, "thinking", "verifier.thinking", THINKING_LEVELS, d.verifier.thinking),
		systemPrompt: val.nullableString(v, "systemPrompt", "verifier.systemPrompt", d.verifier.systemPrompt),
		timeoutMs: val.int(v, "timeoutMs", "verifier.timeoutMs", d.verifier.timeoutMs, 1000, 600_000),
	};

	const http: HttpConfig = {
		enabled: val.bool(h, "enabled", "http.enabled", d.http.enabled),
		timeoutMs: val.int(h, "timeoutMs", "http.timeoutMs", d.http.timeoutMs, 500, 120_000),
		concurrency: val.int(h, "concurrency", "http.concurrency", d.http.concurrency, 1, 64),
		userAgent: val.nullableString(h, "userAgent", "http.userAgent", d.http.userAgent),
		proxy: val.string(h, "proxy", "http.proxy", d.http.proxy),
		noProxy: val.stringArray(h, "noProxy", "http.noProxy", d.http.noProxy),
		useSystemCa: val.bool(h, "useSystemCa", "http.useSystemCa", d.http.useSystemCa),
	};

	const decider: DeciderConfig = {
		enabled: val.bool(dec, "enabled", "decider.enabled", d.decider.enabled),
		mode: val.enumOf(dec, "mode", "decider.mode", MODES, d.decider.mode),
		maxRewrites: val.int(dec, "maxRewrites", "decider.maxRewrites", d.decider.maxRewrites, 0, 10),
		provider: val.string(dec, "provider", "decider.provider", d.decider.provider),
		model: val.nullableString(dec, "model", "decider.model", d.decider.model),
		threshold: val.probability(dec, "threshold", "decider.threshold", d.decider.threshold),
		timeoutMs: val.int(dec, "timeoutMs", "decider.timeoutMs", d.decider.timeoutMs, 500, 600_000),
		instructions: val.nullableString(dec, "instructions", "decider.instructions", d.decider.instructions),
	};

	const config: PiGuardConfig = {
		enabled: val.bool(raw, "enabled", "enabled", d.enabled),
		mode: val.enumOf(raw, "mode", "mode", MODES, d.mode),
		maxRewrites: val.int(raw, "maxRewrites", "maxRewrites", d.maxRewrites, 0, 10),
		maxUrls: val.int(raw, "maxUrls", "maxUrls", d.maxUrls, 1, 200),
		skipCodeBlocks: val.bool(raw, "skipCodeBlocks", "skipCodeBlocks", d.skipCodeBlocks),
		verifyContent: val.bool(raw, "verifyContent", "verifyContent", d.verifyContent),
		bypassDomains: val.stringArray(raw, "bypassDomains", "bypassDomains", d.bypassDomains),
		verifier,
		http,
		decider,
	};
	return { config, warnings: val.warnings };
}

/** Parses config file text (UTF-8 BOM and CRLF tolerant). Never throws. */
export function parseConfigText(text: string): { config: PiGuardConfig; warnings: string[] } {
	const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	if (stripped.trim() === "") return { config: defaultConfig(), warnings: [] };
	let raw: unknown;
	try {
		raw = JSON.parse(stripped);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { config: defaultConfig(), warnings: [`invalid JSON: ${msg} (using defaults)`] };
	}
	return validateConfig(raw);
}

/** Reads the config file. A missing file yields the defaults without warnings. Never throws. */
export async function loadConfig(path: string): Promise<ConfigLoadResult> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code === "ENOENT" || code === "ENOTDIR") {
			return { config: defaultConfig(), warnings: [], found: false };
		}
		const msg = err instanceof Error ? err.message : String(err);
		return { config: defaultConfig(), warnings: [`cannot read ${path}: ${msg} (using defaults)`], found: true };
	}
	return { ...parseConfigText(text), found: true };
}
