import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.ts";
import {
	closeDispatcher,
	createDispatcher,
	getCaCertificates,
	maskCredentialsInText,
	maskProxyUrl,
	validateProxyUrl,
} from "../src/dispatcher.ts";
import { checkUrl } from "../src/http-check.ts";
import type { HttpConfig } from "../src/types.ts";
import { isolateProxyEnv, type ProxyServer, startProxy, startTargetServer, type TargetServer } from "./helpers/servers.ts";

const http = (over: Partial<HttpConfig> = {}): HttpConfig => ({ ...defaultConfig().http, useSystemCa: false, ...over });

let target: TargetServer;
let restoreEnv: () => void;

beforeAll(async () => {
	target = await startTargetServer();
});
afterAll(async () => {
	await target.close();
});
beforeEach(() => {
	restoreEnv = isolateProxyEnv();
});
afterEach(() => {
	restoreEnv();
});

async function withDispatcher<T>(cfg: HttpConfig, fn: (b: ReturnType<typeof createDispatcher>) => Promise<T>): Promise<T> {
	const b = createDispatcher(cfg);
	try {
		return await fn(b);
	} finally {
		await closeDispatcher(b.dispatcher);
	}
}

describe("masking and validation", () => {
	it("masks proxy credentials", () => {
		expect(maskProxyUrl("http://user:pass@proxy.corp:8080")).toBe("http://***:***@proxy.corp:8080");
		expect(maskProxyUrl("http://user@proxy.corp:8080/")).toBe("http://***@proxy.corp:8080");
		expect(maskProxyUrl("http://proxy.corp:8080")).toBe("http://proxy.corp:8080");
		expect(maskProxyUrl("not a url //u:p@host")).toBe("not a url //***@host");
		expect(maskCredentialsInText("failed via http://u:p@h:1 and socks5://x@y")).toBe("failed via http://***@h:1 and socks5://***@y");
	});

	it("validates proxy URLs", () => {
		expect(validateProxyUrl("http://proxy:8080")).toBeUndefined();
		expect(validateProxyUrl("https://proxy:8443")).toBeUndefined();
		expect(validateProxyUrl("socks5://proxy:1080")).toBeUndefined();
		expect(validateProxyUrl("ftp://proxy:21")).toMatch(/unsupported protocol/);
		expect(validateProxyUrl("proxy:8080")).toBeDefined();
		expect(validateProxyUrl("::nope")).toBe("not a valid URL");
	});
});

describe("createDispatcher", () => {
	it("invalid proxy URL → warning and env fallback, credentials masked", async () => {
		await withDispatcher(http({ proxy: "ftp://bob:s3cret@proxy:21" }), async (b) => {
			expect(b.mode).toBe("env");
			expect(b.warnings).toHaveLength(1);
			expect(b.warnings[0]).toContain("falling back");
			expect(b.warnings[0]).not.toContain("s3cret");
		});
	});

	it('"none" → direct connection even with proxy env vars', async () => {
		const proxy = await startProxy();
		process.env.HTTP_PROXY = proxy.url;
		try {
			await withDispatcher(http({ proxy: "none" }), async (b) => {
				expect(b.mode).toBe("none");
				const r = await checkUrl(`${target.url}/ok`, { dispatcher: b.dispatcher, timeoutMs: 3000, concurrency: 1 });
				expect(r.verdict).toBe("OK");
				expect(proxy.hits).toHaveLength(0);
			});
		} finally {
			await proxy.close();
		}
	});

	it('"env" without proxy vars → direct', async () => {
		await withDispatcher(http({ proxy: "env" }), async (b) => {
			expect(b.proxyConfigured).toBe(false);
			expect(b.description).toContain("direct");
			const r = await checkUrl(`${target.url}/ok`, { dispatcher: b.dispatcher, timeoutMs: 3000, concurrency: 1 });
			expect(r.verdict).toBe("OK");
		});
	});

	it("uses system CA certificates when available", async () => {
		const ca = getCaCertificates();
		expect(ca === undefined || (Array.isArray(ca) && ca.length > 0)).toBe(true);
		if (ca) expect(new Set(ca).size).toBe(ca.length);
		await withDispatcher(http({ useSystemCa: true }), async (b) => {
			const r = await checkUrl(`${target.url}/ok`, { dispatcher: b.dispatcher, timeoutMs: 3000, concurrency: 1 });
			expect(r.verdict).toBe("OK");
		});
	});
});

describe("proxy routing", () => {
	let proxy: ProxyServer;
	beforeEach(async () => {
		proxy = await startProxy();
	});
	afterEach(async () => {
		await proxy.close();
	});

	it("proxy URL: requests go through the proxy and statuses pass through", async () => {
		await withDispatcher(http({ proxy: proxy.url }), async (b) => {
			expect(b.mode).toBe("url");
			const ok = await checkUrl(`${target.url}/ok`, { dispatcher: b.dispatcher, timeoutMs: 3000, concurrency: 1, proxyConfigured: true });
			const missing = await checkUrl(`${target.url}/missing`, { dispatcher: b.dispatcher, timeoutMs: 3000, concurrency: 1, proxyConfigured: true });
			expect(ok).toMatchObject({ verdict: "OK", status: 200 });
			expect(missing).toMatchObject({ verdict: "NOT_FOUND", status: 404 });
			expect(proxy.hits.length).toBeGreaterThanOrEqual(2);
			expect(proxy.hits.some((h) => h.target.includes("/ok"))).toBe(true);
		});
	});

	it("proxy URL + noProxy: listed hosts connect directly", async () => {
		await withDispatcher(http({ proxy: proxy.url, noProxy: ["127.0.0.1"] }), async (b) => {
			const r = await checkUrl(`${target.url}/ok`, { dispatcher: b.dispatcher, timeoutMs: 3000, concurrency: 1 });
			expect(r.verdict).toBe("OK");
			expect(proxy.hits).toHaveLength(0);
		});
	});

	it("noProxy accepts host:port entries", async () => {
		await withDispatcher(http({ proxy: proxy.url, noProxy: [`127.0.0.1:${target.port}`] }), async (b) => {
			await checkUrl(`${target.url}/ok`, { dispatcher: b.dispatcher, timeoutMs: 3000, concurrency: 1 });
			expect(proxy.hits).toHaveLength(0);
		});
	});

	it('"env" + HTTP_PROXY routes http targets through the proxy', async () => {
		process.env.HTTP_PROXY = proxy.url;
		await withDispatcher(http({ proxy: "env" }), async (b) => {
			expect(b.proxyConfigured).toBe(true);
			const r = await checkUrl(`${target.url}/ok`, { dispatcher: b.dispatcher, timeoutMs: 3000, concurrency: 1 });
			expect(r.verdict).toBe("OK");
			expect(proxy.hits.some((h) => h.type === "forward")).toBe(true);
		});
	});

	it('"env" + HTTPS_PROXY tunnels https targets with CONNECT', async () => {
		await proxy.close();
		proxy = await startProxy({ connectStatus: 403 });
		process.env.HTTPS_PROXY = proxy.url;
		await withDispatcher(http({ proxy: "env" }), async (b) => {
			expect(b.description).toContain(`127.0.0.1:${proxy.port}`);
			const r = await checkUrl("https://docs.cg-test-target.com/page", {
				dispatcher: b.dispatcher,
				timeoutMs: 3000,
				concurrency: 1,
				proxyConfigured: true,
			});
			expect(r).toMatchObject({ verdict: "UNCERTAIN", errorKind: "proxy" });
			expect(proxy.hits.some((h) => h.type === "connect" && h.target === "docs.cg-test-target.com:443")).toBe(true);
		});
	});

	it('"env" honours NO_PROXY', async () => {
		process.env.HTTP_PROXY = proxy.url;
		process.env.NO_PROXY = "127.0.0.1";
		await withDispatcher(http({ proxy: "env" }), async (b) => {
			await checkUrl(`${target.url}/ok`, { dispatcher: b.dispatcher, timeoutMs: 3000, concurrency: 1 });
			expect(proxy.hits).toHaveLength(0);
		});
	});
});

describe("proxy authentication", () => {
	const auth = `Basic ${Buffer.from("bob:s3cret").toString("base64")}`;
	let proxy: ProxyServer;
	beforeEach(async () => {
		proxy = await startProxy({ requireAuth: auth });
	});
	afterEach(async () => {
		await proxy.close();
	});

	it("407 (forward, http target) → UNCERTAIN(proxy)", async () => {
		await withDispatcher(http({ proxy: proxy.url }), async (b) => {
			const r = await checkUrl(`${target.url}/ok`, { dispatcher: b.dispatcher, timeoutMs: 3000, concurrency: 1, proxyConfigured: true });
			expect(r).toMatchObject({ verdict: "UNCERTAIN", errorKind: "proxy" });
		});
	});

	it("407 (CONNECT, https target) → UNCERTAIN(proxy)", async () => {
		await withDispatcher(http({ proxy: proxy.url }), async (b) => {
			const r = await checkUrl("https://secure.cg-test-target.com/", { dispatcher: b.dispatcher, timeoutMs: 3000, concurrency: 1, proxyConfigured: true });
			expect(r).toMatchObject({ verdict: "UNCERTAIN", errorKind: "proxy" });
		});
	});

	it("credentials in the proxy URL authenticate and are masked in the description", async () => {
		const url = proxy.url.replace("http://", "http://bob:s3cret@");
		await withDispatcher(http({ proxy: url }), async (b) => {
			expect(b.description).not.toContain("s3cret");
			const r = await checkUrl(`${target.url}/ok`, { dispatcher: b.dispatcher, timeoutMs: 3000, concurrency: 1, proxyConfigured: true });
			expect(r).toMatchObject({ verdict: "OK", status: 200 });
			expect(proxy.hits.some((h) => h.auth === auth)).toBe(true);
		});
	});
});

describe("closeDispatcher", () => {
	it("is idempotent", async () => {
		const b = createDispatcher(http());
		await closeDispatcher(b.dispatcher);
		await closeDispatcher(b.dispatcher);
		await closeDispatcher(undefined);
	});
});
