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
	const [a, b, c] = o as [number, number, number, number];
	return (
		a === 0 || // 0.0.0.0/8 "this network"
		a === 10 ||
		a === 127 ||
		(a === 169 && b === 254) || // link-local
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 192 && b === 0 && (c === 0 || c === 2)) || // 192.0.0.0/24 IETF, 192.0.2.0/24 TEST-NET-1
		(a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15 benchmarking
		(a === 198 && b === 51 && c === 100) || // TEST-NET-2
		(a === 203 && b === 0 && c === 113) || // TEST-NET-3
		(a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64.0.0/10
		a >= 224 // multicast, reserved, broadcast
	);
}

/** Expands an IPv6 literal (optionally with a dotted IPv4 tail) into 8 numeric groups. */
function expandIpv6(h: string): number[] | undefined {
	let text = h;
	const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
	if (tail) {
		const o = ipv4Octets(tail[1]!);
		if (!o) return undefined;
		text = text.slice(0, tail.index) + ((o[0]! << 8) | o[1]!).toString(16) + ":" + ((o[2]! << 8) | o[3]!).toString(16);
	}
	const halves = text.split("::");
	if (halves.length > 2) return undefined;
	const parse = (part: string) => (part ? part.split(":").map((g) => Number.parseInt(g, 16)) : []);
	const head = parse(halves[0]!);
	const rest = halves.length === 2 ? parse(halves[1]!) : [];
	const missing = 8 - head.length - rest.length;
	if (halves.length === 1 ? head.length !== 8 : missing < 0) return undefined;
	const groups = [...head, ...new Array<number>(halves.length === 2 ? missing : 0).fill(0), ...rest];
	return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : undefined;
}

function v4FromGroups(hi: number, lo: number): number[] {
	return [hi >> 8, hi & 255, lo >> 8, lo & 255];
}

function isPrivateIpv6(h: string): boolean {
	const g = expandIpv6(h);
	if (!g) return true; // unparseable literal: never fetch
	const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
	const zeroPrefix = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
	if (zeroPrefix && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true; // :: and ::1
	if (zeroPrefix && (g5 === 0xffff || g5 === 0)) return isPrivateIpv4(v4FromGroups(g6, g7)); // IPv4-mapped / -compatible
	if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
		return isPrivateIpv4(v4FromGroups(g6, g7)); // NAT64 64:ff9b::/96
	}
	if (g0 === 0x2002) return isPrivateIpv4(v4FromGroups(g1, g2)); // 6to4 embeds an IPv4 address
	return (
		(g0 & 0xfe00) === 0xfc00 || // fc00::/7 unique local
		(g0 & 0xffc0) === 0xfe80 || // fe80::/10 link-local
		(g0 & 0xff00) === 0xff00 || // ff00::/8 multicast
		(g0 === 0x2001 && g1 === 0x0db8) // documentation
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
