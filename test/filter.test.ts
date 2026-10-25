import { describe, expect, it } from "vitest";
import { isExampleDomain, isPrivateOrLocal, matchesBypass, skipReason } from "../src/filter.ts";

describe("isPrivateOrLocal", () => {
	it("detects loopback and private IPv4 ranges with exact 172.16/12 boundaries", () => {
		for (const h of ["127.0.0.1", "127.255.1.2", "10.0.0.1", "192.168.1.1", "172.16.0.1", "172.31.255.255", "169.254.1.1", "0.0.0.0"]) {
			expect(isPrivateOrLocal(h), h).toBe(true);
		}
		for (const h of ["172.15.255.255", "172.32.0.1", "8.8.8.8", "192.169.0.1", "11.0.0.1"]) {
			expect(isPrivateOrLocal(h), h).toBe(false);
		}
	});

	it("detects IPv6 loopback / ULA / link-local, bracketed or not", () => {
		for (const h of ["::1", "[::1]", "fd12:3456::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) {
			expect(isPrivateOrLocal(h), h).toBe(true);
		}
		expect(isPrivateOrLocal("2606:4700::1111")).toBe(false);
	});

	it("detects local names", () => {
		for (const h of ["localhost", "LOCALHOST", "printer.local", "svc.internal", "git.corp", "nas.lan", "intranet", "jenkins"]) {
			expect(isPrivateOrLocal(h), h).toBe(true);
		}
		for (const h of ["github.com", "local.com", "corp.example.org", "internal.io"]) {
			expect(isPrivateOrLocal(h), h).toBe(false);
		}
	});
});

describe("isExampleDomain", () => {
	it("matches RFC 2606 / 6761 names", () => {
		for (const h of ["example.com", "www.example.com", "example.net", "example.org", "foo.test", "a.example", "x.invalid", "app.localhost"]) {
			expect(isExampleDomain(h), h).toBe(true);
		}
		for (const h of ["examples.com", "myexample.com", "example.co", "test.com"]) {
			expect(isExampleDomain(h), h).toBe(false);
		}
	});
});

describe("matchesBypass", () => {
	it("plain domain matches apex and subdomains", () => {
		expect(matchesBypass("foo.com", ["foo.com"])).toBe(true);
		expect(matchesBypass("a.b.foo.com", ["foo.com"])).toBe(true);
		expect(matchesBypass("barfoo.com", ["foo.com"])).toBe(false);
	});

	it("*.domain matches subdomains only", () => {
		expect(matchesBypass("a.foo.com", ["*.foo.com"])).toBe(true);
		expect(matchesBypass("x.y.foo.com", ["*.foo.com"])).toBe(true);
		expect(matchesBypass("foo.com", ["*.foo.com"])).toBe(false);
		expect(matchesBypass("a.foo.com", [".foo.com"])).toBe(true);
	});

	it("supports glob patterns, case-insensitivity and URL-ish entries", () => {
		expect(matchesBypass("git-01.dev.io", ["git-*.dev.io"])).toBe(true);
		expect(matchesBypass("Docs.Foo.COM", ["docs.foo.com"])).toBe(true);
		expect(matchesBypass("docs.foo.com", ["https://docs.foo.com/path"])).toBe(true);
		expect(matchesBypass("anything.com", ["*"])).toBe(true);
		expect(matchesBypass("foo.com", [])).toBe(false);
	});
});

describe("skipReason", () => {
	it("classifies in priority order", () => {
		const ctx = new Set(["https://seen.com/a"]);
		expect(skipReason("http://localhost:3000/", "x", [], ctx)).toBe("private");
		expect(skipReason("https://example.com/x", "x", [], ctx)).toBe("example");
		expect(skipReason("https://wiki.corp.com/x", "x", ["corp.com"], ctx)).toBe("bypass");
		expect(skipReason("https://seen.com/a", "https://seen.com/a", [], ctx)).toBe("context");
		expect(skipReason("https://new.com/a", "https://new.com/a", [], ctx)).toBeUndefined();
	});
});
