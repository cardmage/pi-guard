import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config.ts";
import {
	buildUserPrompt,
	DEFAULT_SYSTEM_PROMPT,
	parseVerdicts,
	resolveVerifierModel,
	verifyWithLlm,
} from "../src/verifier.ts";
import { fakeModel, fakeRegistry } from "./helpers/fakes.ts";

const URLS = ["https://a.com/x", "https://b.com/y"];

describe("parseVerdicts", () => {
	it("parses plain JSON", () => {
		const r = parseVerdicts(
			'{"results":[{"url":"https://a.com/x","verdict":"EXISTS","reason":"known"},{"url":"https://b.com/y","verdict":"NOT_EXISTS","reason":"fake"}]}',
			URLS,
		);
		expect(r.get("https://a.com/x")).toEqual({ url: "https://a.com/x", verdict: "EXISTS", reason: "known" });
		expect(r.get("https://b.com/y")?.verdict).toBe("NOT_EXISTS");
	});

	it("parses JSON inside code fences with surrounding prose", () => {
		const text = 'Here you go:\n```json\n{"results":[{"url":"https://a.com/x","verdict":"not_exists","reason":"r"}]}\n```\nDone.';
		const r = parseVerdicts(text, URLS);
		expect(r.get("https://a.com/x")?.verdict).toBe("NOT_EXISTS");
		expect(r.get("https://b.com/y")?.verdict).toBe("UNKNOWN");
	});

	it("matches URLs loosely (trailing slash, case)", () => {
		const r = parseVerdicts('{"results":[{"url":"HTTPS://A.COM/X/","verdict":"EXISTS","reason":""}]}', URLS);
		expect(r.get("https://a.com/x")?.verdict).toBe("EXISTS");
	});

	it("broken JSON → all UNKNOWN", () => {
		for (const text of ["{\"results\": [ {\"url\": ", "no json here", '{"other":1}', "", '{"results":"x"}']) {
			const r = parseVerdicts(text, URLS);
			expect([...r.values()].every((v) => v.verdict === "UNKNOWN"), text).toBe(true);
			expect(r.size).toBe(2);
		}
	});

	it("ignores invalid verdicts and unknown URLs", () => {
		const r = parseVerdicts(
			'{"results":[{"url":"https://a.com/x","verdict":"MAYBE"},{"url":"https://zzz.com","verdict":"EXISTS"},{"url":5,"verdict":"EXISTS"}]}',
			URLS,
		);
		expect([...r.values()].every((v) => v.verdict === "UNKNOWN")).toBe(true);
		expect(r.has("https://zzz.com")).toBe(false);
	});
});

describe("buildUserPrompt", () => {
	it("contains each URL, HTTP signal, context and the output format", () => {
		const p = buildUserPrompt([
			{ url: "https://a.com/x", httpStatus: 403, context: "see https://a.com/x" },
			{ url: "https://b.com/y", httpError: "timeout", context: "ctx" },
		]);
		expect(p).toContain('"httpStatus": 403');
		expect(p).toContain('"httpError": "timeout"');
		expect(p).toContain('"verdict":"EXISTS|NOT_EXISTS|UNKNOWN"');
	});
});

describe("resolveVerifierModel", () => {
	const session = fakeModel("anthropic", "session-model");
	const other = fakeModel("openai", "verifier-model");

	it("null config → session model", () => {
		const reg = fakeRegistry({ models: [session, other] });
		expect(resolveVerifierModel({ provider: null, model: null }, reg, session)).toEqual({ model: session });
	});

	it("configured and authenticated → configured model", () => {
		const reg = fakeRegistry({ models: [session, other] });
		expect(resolveVerifierModel({ provider: "openai", model: "verifier-model" }, reg, session).model).toBe(other);
		expect(resolveVerifierModel({ provider: null, model: "verifier-model" }, reg, session).model).toBe(other);
	});

	it("unknown model → warning + session model", () => {
		const reg = fakeRegistry({ models: [session] });
		const r = resolveVerifierModel({ provider: "openai", model: "nope" }, reg, session);
		expect(r.model).toBe(session);
		expect(r.warning).toMatch(/not found/);
	});

	it("no auth → warning + session model", () => {
		const reg = fakeRegistry({ models: [session, other], noAuth: ["openai"] });
		const r = resolveVerifierModel({ provider: "openai", model: "verifier-model" }, reg, session);
		expect(r.model).toBe(session);
		expect(r.warning).toMatch(/no configured auth/);
	});
});

describe("verifyWithLlm", () => {
	const items = [
		{ url: "https://a.com/x", httpStatus: 403, context: "c1" },
		{ url: "https://b.com/y", httpError: "timeout", context: "c2" },
	];
	const reply = '{"results":[{"url":"https://a.com/x","verdict":"EXISTS","reason":"ok"},{"url":"https://b.com/y","verdict":"NOT_EXISTS","reason":"fake"}]}';

	it("calls streamSimple once with system prompt, reasoning and signal", async () => {
		const model = fakeModel("p", "m", { reasoning: true });
		const reg = fakeRegistry({ models: [model], reply });
		const out = await verifyWithLlm(items, { model, registry: reg, config: defaultConfig().verifier });
		expect(out.error).toBeUndefined();
		expect(out.results.get("https://a.com/x")?.verdict).toBe("EXISTS");
		expect(out.results.get("https://b.com/y")?.verdict).toBe("NOT_EXISTS");
		expect(reg.calls).toHaveLength(1);
		const call = reg.calls[0]!;
		expect(call.context.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
		expect(call.options?.reasoning).toBe("low");
		expect(call.options?.signal).toBeInstanceOf(AbortSignal);
		expect(call.options?.maxTokens).toBeGreaterThan(0);
	});

	it("omits reasoning when thinking is off or the model has no reasoning", async () => {
		const plain = fakeModel("p", "m", { reasoning: false });
		const reg = fakeRegistry({ models: [plain], reply });
		await verifyWithLlm(items, { model: plain, registry: reg, config: defaultConfig().verifier });
		expect(reg.calls[0]!.options).not.toHaveProperty("reasoning");

		const smart = fakeModel("p", "m2", { reasoning: true });
		const reg2 = fakeRegistry({ models: [smart], reply });
		await verifyWithLlm(items, { model: smart, registry: reg2, config: { ...defaultConfig().verifier, thinking: "off" } });
		expect(reg2.calls[0]!.options).not.toHaveProperty("reasoning");
	});

	it("uses a custom system prompt verbatim", async () => {
		const model = fakeModel("p", "m");
		const reg = fakeRegistry({ models: [model], reply });
		await verifyWithLlm(items, { model, registry: reg, config: { ...defaultConfig().verifier, systemPrompt: "Be strict." } });
		expect(reg.calls[0]!.context.systemPrompt).toBe("Be strict.");
	});

	it("fails open: no model, provider error, throw, timeout, abort", async () => {
		const model = fakeModel("p", "m");
		const cfg = defaultConfig().verifier;
		const allUnknown = (o: Awaited<ReturnType<typeof verifyWithLlm>>) =>
			[...o.results.values()].every((r) => r.verdict === "UNKNOWN") && o.results.size === 2;

		const noModel = await verifyWithLlm(items, { model: undefined, registry: fakeRegistry({ models: [] }), config: cfg });
		expect(allUnknown(noModel)).toBe(true);
		expect(noModel.error).toMatch(/no verifier model/);

		const errored = await verifyWithLlm(items, { model, registry: fakeRegistry({ models: [model], stopReason: "error" }), config: cfg });
		expect(allUnknown(errored)).toBe(true);
		expect(errored.error).toMatch(/verifier error/);

		const thrown = await verifyWithLlm(items, { model, registry: fakeRegistry({ models: [model], throws: true }), config: cfg });
		expect(allUnknown(thrown)).toBe(true);

		const slow = await verifyWithLlm(items, {
			model,
			registry: fakeRegistry({ models: [model], hang: true }),
			config: { ...cfg, timeoutMs: 1000 },
		});
		expect(allUnknown(slow)).toBe(true);
		expect(slow.error).toBe("verifier timeout");

		const ac = new AbortController();
		setTimeout(() => ac.abort(), 50);
		const aborted = await verifyWithLlm(items, { model, registry: fakeRegistry({ models: [model], hang: true }), config: cfg, signal: ac.signal });
		expect(allUnknown(aborted)).toBe(true);
		expect(aborted.error).toBe("verifier aborted");
	});

	it("does not call the model for an empty list", async () => {
		const model = fakeModel("p", "m");
		const reg = fakeRegistry({ models: [model], reply });
		const spy = vi.spyOn(reg, "streamSimple");
		const out = await verifyWithLlm([], { model, registry: reg, config: defaultConfig().verifier });
		expect(out.results.size).toBe(0);
		expect(spy).not.toHaveBeenCalled();
	});
});
