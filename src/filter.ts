/** Hosts that must never be checked: private/local networks, reserved example domains, user bypass list. */

import { isIP } from "node:net";

function cleanHost(hostname: string): string {
	let h = hostname.trim().toLowerCase();
	if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
	if (h.length > 1 && h.endsWith(".")) h = h.slice(0, -1);
	return h;
}

function ipv4Octets(h: string): number[] | undefined {
	if (isIP(h) !== 4) return undefined;
	return h.split(".").map(Number);
}

function isPrivateIpv4(o: number[]): boolean {
	const [a, b] = o as [number, number];
	return (
		a === 0 || // 0.0.0.0/8 "this network"
		a === 10 ||
		a === 127 ||
		(a === 169 && b === 254) || // link-local
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 100 && b >= 64 && b <= 127) // CGNAT 100.64.0.0/10
	);
}

function isPrivateIpv6(h: string): boolean {
	if (h === "::1" || h === "::") return true;
	// IPv4-mapped (::ffff:a.b.c.d or ::ffff:7f00:1)
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
	if (mapped) {
		const o = ipv4Octets(mapped[1]!);
		return o ? isPrivateIpv4(o) : false;
	}
	const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
	if (mappedHex) {
		const hi = Number.parseInt(mappedHex[1]!, 16);
		const lo = Number.parseInt(mappedHex[2]!, 16);
		return isPrivateIpv4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
	}
	const first = Number.parseInt(h.split(":")[0] || "0", 16);
	return (
		(first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
		(first & 0xffc0) === 0xfe80 // fe80::/10 link-local
	);
}

const LOCAL_SUFFIXES = ["local", "internal", "corp", "lan", "home.arpa", "intranet"];

/** True for loopback, private/link-local IPs, single-label hosts, and internal TLDs. */
export function isPrivateOrLocal(hostname: string): boolean {
	const h = cleanHost(hostname);
	if (!h) return true;
	const v4 = ipv4Octets(h);
	if (v4) return isPrivateIpv4(v4);
	if (isIP(h) === 6) return isPrivateIpv6(h);
	if (h === "localhost") return true;
	// Single-label names (http://intranet/, http://jenkins:8080/) only resolve on local networks.
	if (!h.includes(".")) return true;
	return LOCAL_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));
}

const EXAMPLE_DOMAINS = ["example.com", "example.net", "example.org"];
const RESERVED_TLDS = ["test", "example", "invalid", "localhost"];

/** True for RFC 2606 / RFC 6761 reserved example names. */
export function isExampleDomain(hostname: string): boolean {
	const h = cleanHost(hostname);
	if (EXAMPLE_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`))) return true;
	const tld = h.slice(h.lastIndexOf(".") + 1);
	return RESERVED_TLDS.includes(tld);
}

interface ParsedPattern {
	host: string;
	pathPrefix: string;
}

function parseBypassPattern(pattern: string): ParsedPattern | undefined {
	let p = pattern.trim().toLowerCase();
	if (!p) return undefined;
	p = p.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
	p = p.replace(/[?#].*$/, "");

	const slashIdx = p.indexOf("/");
	let hostPart = slashIdx === -1 ? p : p.slice(0, slashIdx);
	let pathPrefix = slashIdx === -1 ? "" : p.slice(slashIdx);

	hostPart = hostPart.replace(/:\d+$/, "");
	if (hostPart.startsWith(".")) hostPart = `*${hostPart}`;
	if (hostPart.length > 1 && hostPart.endsWith(".")) hostPart = hostPart.slice(0, -1);
	if (!hostPart) return undefined;

	if (pathPrefix === "/") pathPrefix = "";
	else if (pathPrefix.length > 1 && pathPrefix.endsWith("/")) pathPrefix = pathPrefix.slice(0, -1);

	return { host: hostPart, pathPrefix };
}

function matchesHostPattern(h: string, p: string): boolean {
	if (p === "*") return true;
	if (p.startsWith("*.") && !p.slice(2).includes("*")) {
		return h.endsWith(p.slice(1));
	}
	if (p.includes("*")) {
		const re = new RegExp(`^${p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
		return re.test(h);
	}
	return h === p || h.endsWith(`.${p}`);
}

function matchesPathPrefix(pathname: string, pathPrefix: string): boolean {
	if (!pathPrefix) return true;
	const path = pathname.toLowerCase();
	if (pathPrefix.includes("*")) {
		const re = new RegExp(`^${pathPrefix.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}(?:/|$)`);
		return re.test(path);
	}
	return path === pathPrefix || path.startsWith(`${pathPrefix}/`);
}

/**
 * Bypass list matching.
 * - `foo.com`   → `foo.com` and all its subdomains
 * - `*.foo.com` / `.foo.com` → subdomains of `foo.com` only
 * - `foo.com/path` → only URLs on `foo.com` (and subdomains) whose path is `/path` or under `/path/...`
 * - other `*` → glob (`*` matches any characters)
 */
export function matchesBypass(urlOrHost: string, patterns: readonly string[]): boolean {
	let h: string;
	let pathname = "/";
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(urlOrHost)) {
		try {
			const u = new URL(urlOrHost);
			h = cleanHost(u.hostname);
			pathname = u.pathname || "/";
		} catch {
			return false;
		}
	} else {
		const slashIdx = urlOrHost.indexOf("/");
		if (slashIdx === -1) {
			h = cleanHost(urlOrHost);
		} else {
			h = cleanHost(urlOrHost.slice(0, slashIdx));
			pathname = urlOrHost.slice(slashIdx);
		}
	}
	if (!h) return false;

	for (const raw of patterns) {
		const parsed = parseBypassPattern(raw);
		if (!parsed) continue;
		if (matchesHostPattern(h, parsed.host) && matchesPathPrefix(pathname, parsed.pathPrefix)) {
			return true;
		}
	}
	return false;
}

export type SkipReason = "private" | "example" | "bypass" | "invalid";

/** Returns why a URL must not be checked, or `undefined` if it should be checked. */
export function skipReason(url: string, bypassDomains: readonly string[]): SkipReason | undefined {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return "invalid";
	}
	if (isPrivateOrLocal(u.hostname)) return "private";
	if (isExampleDomain(u.hostname)) return "example";
	if (matchesBypass(url, bypassDomains)) return "bypass";
	return undefined;
}
