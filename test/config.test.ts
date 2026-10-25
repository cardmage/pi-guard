import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultConfig, getConfigPath, loadConfig, parseConfigText, validateConfig } from "../src/config.ts";

describe("validateConfig", () => {
	it("returns defaults for empty input", () => {
		expect(validateConfig(undefined)).toEqual({ config: defaultConfig(), warnings: [] });
		expect(validateConfig({})).toEqual({ config: defaultConfig(), warnings: [] });
	});

	it("merges partial config onto defaults, including nested sections", () => {
		const { config, warnings } = validateConfig({
			mode: "warn",
			verifier: { model: "gpt-x" },
			http: { proxy: "http://proxy:8080", noProxy: [".corp.com", " "] },
		});
		expect(warnings).toEqual([]);
		expect(config.mode).toBe("warn");
		expect(config.maxRewrites).toBe(1);
		expect(config.verifier).toEqual({ ...defaultConfig().verifier, model: "gpt-x" });
		expect(config.http.proxy).toBe("http://proxy:8080");
		expect(config.http.noProxy).toEqual([".corp.com"]);
		expect(config.http.timeoutMs).toBe(8000);
	});

	it("falls back to defaults for invalid enums and types, with warnings", () => {
		const { config, warnings } = validateConfig({
			mode: "block",
			maxRewrites: -1,
			maxUrls: "10",
			enabled: "yes",
			bypassDomains: [1, 2],
			verifier: { thinking: "ultra", timeoutMs: 1.5 },
			http: "fast",
		});
		const d = defaultConfig();
		expect(config.mode).toBe(d.mode);
		expect(config.maxRewrites).toBe(d.maxRewrites);
		expect(config.maxUrls).toBe(d.maxUrls);
		expect(config.enabled).toBe(true);
		expect(config.bypassDomains).toEqual([]);
		expect(config.verifier.thinking).toBe("low");
		expect(config.verifier.timeoutMs).toBe(30000);
		expect(config.http).toEqual(d.http);
		expect(warnings.length).toBe(8);
		expect(warnings.join("\n")).toContain('"mode"');
		expect(warnings.join("\n")).toContain('"verifier.thinking"');
	});

	it("accepts null and empty strings for nullable fields", () => {
		const { config } = validateConfig({ verifier: { provider: null, systemPrompt: "  " }, http: { userAgent: "UA/1" } });
		expect(config.verifier.provider).toBeNull();
		expect(config.verifier.systemPrompt).toBeNull();
		expect(config.http.userAgent).toBe("UA/1");
	});

	it("rejects a non-object root", () => {
		const r = validateConfig([1, 2]);
		expect(r.config).toEqual(defaultConfig());
		expect(r.warnings).toHaveLength(1);
	});
});

describe("parseConfigText", () => {
	it("handles UTF-8 BOM", () => {
		const r = parseConfigText('\uFEFF{"mode":"warn"}');
		expect(r.warnings).toEqual([]);
		expect(r.config.mode).toBe("warn");
	});

	it("handles CRLF line endings", () => {
		const r = parseConfigText('{\r\n  "maxUrls": 5,\r\n  "http": {\r\n    "enabled": false\r\n  }\r\n}\r\n');
		expect(r.warnings).toEqual([]);
		expect(r.config.maxUrls).toBe(5);
		expect(r.config.http.enabled).toBe(false);
	});

	it("returns defaults with a warning on invalid JSON", () => {
		const r = parseConfigText("{ mode: warn ");
		expect(r.config).toEqual(defaultConfig());
		expect(r.warnings[0]).toMatch(/invalid JSON/);
	});

	it("treats an empty file as defaults", () => {
		expect(parseConfigText("  \n")).toEqual({ config: defaultConfig(), warnings: [] });
	});
});

describe("loadConfig", () => {
	let dir: string;
	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "cg-config-"));
	});
	afterAll(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("builds the path with the platform separator", () => {
		expect(getConfigPath(dir)).toBe(join(dir, "pi-guard.json"));
	});

	it("missing file → defaults, no warnings", async () => {
		const r = await loadConfig(join(dir, "nope.json"));
		expect(r).toEqual({ config: defaultConfig(), warnings: [], found: false });
	});

	it("reads a BOM + CRLF file from disk", async () => {
		const p = getConfigPath(dir);
		await writeFile(p, Buffer.from('\uFEFF{\r\n"mode": "warn",\r\n"bypassDomains": ["*.corp.com"]\r\n}\r\n', "utf8"));
		const r = await loadConfig(p);
		expect(r.found).toBe(true);
		expect(r.warnings).toEqual([]);
		expect(r.config.mode).toBe("warn");
		expect(r.config.bypassDomains).toEqual(["*.corp.com"]);
	});
});
