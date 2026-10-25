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

function normalizePattern(pattern: string): string {
	let p = pattern.trim().toLowerCase();
	// Tolerate full URLs: "https://foo.com/path" → "foo.com"
	p = p.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
	p = p.replace(/[/?#].*$/, "");
	p = p.replace(/:\d+$/, "");
	if (p.startsWith(".")) p = `*${p}`;
	if (p.length > 1 && p.endsWith(".")) p = p.slice(0, -1);
	return p;
}

/**
 * Bypass list matching.
 * - `foo.com`   → `foo.com` and all its subdomains
 * - `*.foo.com` / `.foo.com` → subdomains of `foo.com` only
 * - other `*` → glob (`*` matches any characters)
 */
export function matchesBypass(hostname: string, patterns: readonly string[]): boolean {
	const h = cleanHost(hostname);
	for (const raw of patterns) {
		const p = normalizePattern(raw);
		if (!p) continue;
		if (p === "*") return true;
		if (p.startsWith("*.") && !p.slice(2).includes("*")) {
			if (h.endsWith(p.slice(1))) return true;
			continue;
		}
		if (p.includes("*")) {
			const re = new RegExp(`^${p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
			if (re.test(h)) return true;
			continue;
		}
		if (h === p || h.endsWith(`.${p}`)) return true;
	}
	return false;
}

export type SkipReason = "private" | "example" | "bypass" | "context" | "invalid";

/** Returns why a URL must not be checked, or `undefined` if it should be checked. */
export function skipReason(
	url: string,
	key: string,
	bypassDomains: readonly string[],
	contextKeys: ReadonlySet<string>,
): SkipReason | undefined {
	let host: string;
	try {
		host = new URL(url).hostname;
	} catch {
		return "invalid";
	}
	if (isPrivateOrLocal(host)) return "private";
	if (isExampleDomain(host)) return "example";
	if (matchesBypass(host, bypassDomains)) return "bypass";
	if (contextKeys.has(key)) return "context";
	return undefined;
}
