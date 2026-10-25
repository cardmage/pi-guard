/** Builds the undici dispatcher (proxy + CA trust) used by the HTTP checker. */

import * as tls from "node:tls";
import { Agent, type Dispatcher, EnvHttpProxyAgent } from "undici";
import type { HttpConfig } from "./types.ts";

const PROXY_PROTOCOLS = new Set(["http:", "https:", "socks5:", "socks:"]);

/** Masks `user:pass@` in a proxy URL for logs, notifications and LLM input. */
export function maskProxyUrl(value: string): string {
	try {
		const u = new URL(value);
		if (u.username || u.password) {
			u.username = "***";
			u.password = u.password ? "***" : "";
		}
		return u.href.replace(/\/$/, "");
	} catch {
		// Not parseable: mask anything that looks like userinfo.
		return value.replace(/\/\/[^/@\s]*@/, "//***@");
	}
}

/** Masks credentials of any proxy URL embedded in free text (e.g. error messages). */
export function maskCredentialsInText(text: string): string {
	return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s:]+(?::[^/@\s]*)?@/gi, "$1***@");
}

/** Validates a proxy URL. Returns an error message, or `undefined` when valid. */
export function validateProxyUrl(value: string): string | undefined {
	let u: URL;
	try {
		u = new URL(value);
	} catch {
		return "not a valid URL";
	}
	if (!PROXY_PROTOCOLS.has(u.protocol)) return `unsupported protocol "${u.protocol}" (use http, https or socks5)`;
	if (!u.hostname) return "missing host";
	return undefined;
}

/**
 * Default + OS store CA certificates, deduplicated. `"default"` already includes
 * Node's bundled roots and `NODE_EXTRA_CA_CERTS`. Returns `undefined` when the API
 * is unavailable or fails (Node then uses its built-in defaults).
 */
export function getCaCertificates(): string[] | undefined {
	const get = (tls as { getCACertificates?: (type?: string) => string[] }).getCACertificates;
	if (typeof get !== "function") return undefined;
	try {
		const all = new Set<string>();
		for (const c of get("default")) all.add(c.trim());
		try {
			for (const c of get("system")) all.add(c.trim());
		} catch {
			// System store unreadable: keep defaults only.
		}
		return all.size > 0 ? [...all] : undefined;
	} catch {
		return undefined;
	}
}

export interface DispatcherBuild {
	dispatcher: Dispatcher;
	/** Effective mode after validation. */
	mode: "env" | "none" | "url";
	/** Masked description of the effective proxy, for diagnostics. */
	description: string;
	/** Whether requests may go through a proxy (affects error classification). */
	proxyConfigured: boolean;
	warnings: string[];
}

function envProxy(env: NodeJS.ProcessEnv): string | undefined {
	return env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY || undefined;
}

export interface CreateDispatcherOptions {
	/** Environment used to describe `"env"` mode (undici itself reads process.env). */
	env?: NodeJS.ProcessEnv;
	/** Override CA list (tests). */
	ca?: string[];
}

/** Creates the dispatcher for the given HTTP config. Never throws for config errors. */
export function createDispatcher(http: HttpConfig, options: CreateDispatcherOptions = {}): DispatcherBuild {
	const env = options.env ?? process.env;
	const warnings: string[] = [];
	const ca = options.ca ?? (http.useSystemCa ? getCaCertificates() : undefined);

	const tlsOpts = ca ? { ca } : {};
	const agentOpts = {
		connect: { ...tlsOpts },
		requestTls: { ...tlsOpts },
		proxyTls: { ...tlsOpts },
	};

	let proxy = http.proxy;
	if (proxy !== "env" && proxy !== "none") {
		const err = validateProxyUrl(proxy);
		if (err) {
			warnings.push(`http.proxy "${maskProxyUrl(proxy)}": ${err}; falling back to "env"`);
			proxy = "env";
		}
	}

	if (proxy === "none") {
		return {
			dispatcher: new Agent({ connect: agentOpts.connect }),
			mode: "none",
			description: "direct (proxy: none)",
			proxyConfigured: false,
			warnings,
		};
	}

	if (proxy === "env") {
		const fromEnv = envProxy(env);
		return {
			dispatcher: new EnvHttpProxyAgent(agentOpts),
			mode: "env",
			description: fromEnv ? `env proxy ${maskProxyUrl(fromEnv)}` : "direct (no proxy env vars)",
			proxyConfigured: !!fromEnv,
			warnings,
		};
	}

	return {
		dispatcher: new EnvHttpProxyAgent({
			...agentOpts,
			httpProxy: proxy,
			httpsProxy: proxy,
			noProxy: http.noProxy.join(","),
		}),
		mode: "url",
		description: `proxy ${maskProxyUrl(proxy)}`,
		proxyConfigured: true,
		warnings,
	};
}

/** Closes a dispatcher, ignoring errors. Idempotent. */
export async function closeDispatcher(dispatcher: Dispatcher | undefined): Promise<void> {
	if (!dispatcher) return;
	try {
		await dispatcher.close();
	} catch {
		try {
			await dispatcher.destroy();
		} catch {
			// ignore
		}
	}
}
