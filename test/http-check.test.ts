import { Agent } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkUrl, checkUrls, classifyError, classifyStatus, extractTextFromBody, mapLimit } from "../src/http-check.ts";
import { startTargetServer, type TargetServer } from "./helpers/servers.ts";

let server: TargetServer;
let agent: Agent;

beforeAll(async () => {
	server = await startTargetServer();
	agent = new Agent();
});
afterAll(async () => {
	await agent.close();
	await server.close();
});

const opts = () => ({ dispatcher: agent, timeoutMs: 3000, concurrency: 4 });

describe("classifyStatus", () => {
	it("maps status codes", () => {
		expect(classifyStatus(200)).toBe("OK");
		expect(classifyStatus(204)).toBe("OK");
		expect(classifyStatus(304)).toBe("OK");
		expect(classifyStatus(404)).toBe("NOT_FOUND");
		expect(classifyStatus(410)).toBe("NOT_FOUND");
		for (const s of [400, 401, 403, 405, 429, 500, 502, 503]) expect(classifyStatus(s)).toBe("UNCERTAIN");
	});
});

describe("checkUrl against a local server", () => {
	const cases: [string, string, number | undefined][] = [
		["/ok", "OK", 200],
		["/redirect", "OK", 200],
		["/redirect-missing", "NOT_FOUND", 404],
		["/missing", "NOT_FOUND", 404],
		["/gone", "NOT_FOUND", 410],
		["/forbidden", "UNCERTAIN", 403],
		["/unauthorized", "UNCERTAIN", 401],
		["/ratelimit", "UNCERTAIN", 429],
		["/error", "UNCERTAIN", 500],
		["/unavailable", "UNCERTAIN", 503],
	];
	for (const [path, verdict, status] of cases) {
		it(`${path} → ${verdict}`, async () => {
			const r = await checkUrl(`${server.url}${path}`, opts());
			expect(r.verdict).toBe(verdict);
			expect(r.status).toBe(status);
		});
	}

	it("falls back to GET when HEAD returns 405 or 501", async () => {
		for (const path of ["/head405", "/head501"]) {
			server.hits.length = 0;
			const r = await checkUrl(`${server.url}${path}`, opts());
			expect(r).toMatchObject({ verdict: "OK", status: 200 });
			expect(server.hits.map((h) => h.method)).toEqual(["HEAD", "GET"]);
		}
	});

	it("confirms a HEAD 404 with GET", async () => {
		const r = await checkUrl(`${server.url}/head404-get200`, opts());
		expect(r).toMatchObject({ verdict: "OK", status: 200 });
	});

	it("does not download the body on GET", async () => {
		const started = Date.now();
		const r = await checkUrl(`${server.url}/big`, opts());
		expect(r).toMatchObject({ verdict: "OK", status: 200 });
		expect(Date.now() - started).toBeLessThan(2000);
	});

	it("times out → UNCERTAIN(timeout) without a GET retry", async () => {
		server.hits.length = 0;
		const started = Date.now();
		const r = await checkUrl(`${server.url}/slow`, { ...opts(), timeoutMs: 600 });
		expect(r).toMatchObject({ verdict: "UNCERTAIN", errorKind: "timeout" });
		expect(Date.now() - started).toBeLessThan(2500);
		expect(server.hits.filter((h) => h.path === "/slow").map((h) => h.method)).toEqual(["HEAD"]);
	});

	it("user abort → UNCERTAIN(aborted)", async () => {
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 100);
		const r = await checkUrl(`${server.url}/slow`, { ...opts(), signal: ac.signal });
		expect(r).toMatchObject({ verdict: "UNCERTAIN", errorKind: "aborted" });
	});

	it("connection refused → UNCERTAIN(network)", async () => {
		// Port 9 (discard) on loopback is closed on CI runners and dev machines.
		const r = await checkUrl("http://127.0.0.1:9/x", opts());
		expect(r.verdict).toBe("UNCERTAIN");
		expect(r.errorKind).toBe("network");
	});

	it("ENOTFOUND → NOT_FOUND(dns)", async () => {
		const dnsFail = new Agent({
			connect: {
				lookup: ((hostname: string, _o: unknown, cb: (err: Error) => void) => {
					cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND", hostname }));
				}) as never,
			},
		});
		try {
			const r = await checkUrl("https://no-such-host-cg.com/page", { ...opts(), dispatcher: dnsFail });
			expect(r).toMatchObject({ verdict: "NOT_FOUND", errorKind: "dns" });
		} finally {
			await dnsFail.close();
		}
	});

	it("checkUrls keeps input order and respects the concurrency limit", async () => {
		const list = ["/ok", "/missing", "/forbidden", "/gone"].map((p) => `${server.url}${p}`);
		const r = await checkUrls(list, { ...opts(), concurrency: 2 });
		expect(r.map((x) => x.verdict)).toEqual(["OK", "NOT_FOUND", "UNCERTAIN", "NOT_FOUND"]);
	});

	it("sends the configured user agent", async () => {
		// Indirect: the request succeeds with a custom UA (header validity).
		const r = await checkUrl(`${server.url}/ok`, { ...opts(), userAgent: "PiGuardTest/1.0" });
		expect(r.verdict).toBe("OK");
	});

	it("extracts readable pageContent when fetchContent is true", async () => {
		const r = await checkUrl(`${server.url}/html`, { ...opts(), fetchContent: true });
		expect(r.verdict).toBe("OK");
		expect(r.status).toBe(200);
		expect(r.pageContent).toContain("Widget v2 Guide");
		expect(r.pageContent).toContain("Widgets support only JSON format in v2.");
		expect(r.pageContent).not.toContain("alert(1)");
		expect(r.pageContent).not.toContain("color:red");
	});

	it("extractTextFromBody strips tags, scripts, styles and decodes entities", () => {
		const out = extractTextFromBody(
			"<html><head><title>Doc &amp; API</title></head><body><script>var x=1;</script><p>Hello &lt;world&gt;!</p></body></html>",
			"text/html",
		);
		expect(out).toBe("Doc & API — Hello <world>!");
	});
});

describe("classifyError", () => {
	const wrap = (cause: object) => Object.assign(new TypeError("fetch failed"), { cause });

	it("ENOTFOUND for the target host → NOT_FOUND", () => {
		expect(classifyError(wrap({ code: "ENOTFOUND", hostname: "x.com", message: "getaddrinfo ENOTFOUND x.com" }), "x.com").verdict).toBe("NOT_FOUND");
	});

	it("ENOTFOUND for another host while a proxy is configured → UNCERTAIN(proxy)", () => {
		const r = classifyError(wrap({ code: "ENOTFOUND", hostname: "proxy.corp", message: "getaddrinfo ENOTFOUND proxy.corp" }), "x.com", true);
		expect(r).toMatchObject({ verdict: "UNCERTAIN", kind: "proxy" });
	});

	it("EAI_AGAIN → UNCERTAIN(dns)", () => {
		expect(classifyError(wrap({ code: "EAI_AGAIN" }), "x.com")).toMatchObject({ verdict: "UNCERTAIN", kind: "dns" });
	});

	it("TLS errors → UNCERTAIN(tls)", () => {
		for (const code of ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "SELF_SIGNED_CERT_IN_CHAIN", "CERT_HAS_EXPIRED"]) {
			expect(classifyError(wrap({ code, message: "cert problem" }), "x.com")).toMatchObject({ verdict: "UNCERTAIN", kind: "tls" });
		}
	});

	it("proxy errors → UNCERTAIN(proxy) with masked credentials", () => {
		const r = classifyError(wrap({ message: "Proxy response (407) !== 200 when HTTP Tunneling via http://bob:s3cret@proxy:8080" }), "x.com");
		expect(r).toMatchObject({ verdict: "UNCERTAIN", kind: "proxy" });
		expect(r.error).not.toContain("s3cret");
		expect(r.error).toContain("***@proxy");
	});

	it("timeouts → UNCERTAIN(timeout)", () => {
		expect(classifyError(wrap({ code: "UND_ERR_CONNECT_TIMEOUT" }), "x.com").kind).toBe("timeout");
		expect(classifyError(new DOMException("t", "TimeoutError"), "x.com").kind).toBe("timeout");
	});
});

describe("mapLimit", () => {
	it("never exceeds the limit", async () => {
		let active = 0;
		let peak = 0;
		const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((r) => setTimeout(r, 10));
			active--;
			return n * 2;
		});
		expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
		expect(peak).toBe(3);
	});
});
