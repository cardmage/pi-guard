import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.ts";
import {
	buildDeciderContext,
	DEFAULT_DECIDER_INSTRUCTIONS,
	evaluateWithDecider,
	resolveDeciderModel,
} from "../src/decider.ts";
import { fakeClassifierModel, fakeRegistry } from "./helpers/fakes.ts";

describe("resolveDeciderModel", () => {
	const m1 = fakeClassifierModel("llama.cpp", "pplx-decider-v1.1-27b");
	const m2 = fakeClassifierModel("llama.cpp", "openjev-7b");

	it("finds an explicitly configured model by provider and id", () => {
		const reg = fakeRegistry({ models: [], classifiers: [m1, m2] });
		const res = resolveDeciderModel({ provider: "llama.cpp", model: "pplx-decider-v1.1-27b" }, reg);
		expect(res).toEqual({ model: m1 });
	});

	it("matches model case-insensitively from getModelsOfType when findOfType misses", () => {
		const reg = fakeRegistry({ models: [], classifiers: [m1] });
		const res = resolveDeciderModel({ provider: "llama.cpp", model: "PPLX-DECIDER-V1.1-27B" }, reg);
		expect(res).toEqual({ model: m1 });
	});

	it("returns a warning when the configured model is not found", () => {
		const reg = fakeRegistry({ models: [], classifiers: [m1] });
		const res = resolveDeciderModel({ provider: "llama.cpp", model: "missing-model" }, reg);
		expect(res.model).toBeUndefined();
		expect(res.warning).toContain('decider model "llama.cpp/missing-model" not found');
	});

	it("auto-selects when model is null and the provider has a single classifier model", () => {
		const reg = fakeRegistry({ models: [], classifiers: [m1] });
		const res = resolveDeciderModel({ provider: "llama.cpp", model: null }, reg);
		expect(res).toEqual({ model: m1 });
	});

	it("warns when model is null and the provider has no classifier models", () => {
		const reg = fakeRegistry({ models: [], classifiers: [] });
		const res = resolveDeciderModel({ provider: "llama.cpp", model: null }, reg);
		expect(res.model).toBeUndefined();
		expect(res.warning).toContain('no classifier model available for provider "llama.cpp"');
	});

	it("warns when model is null and the provider has multiple classifier models", () => {
		const reg = fakeRegistry({ models: [], classifiers: [m1, m2] });
		const res = resolveDeciderModel({ provider: "llama.cpp", model: null }, reg);
		expect(res.model).toBeUndefined();
		expect(res.warning).toContain('multiple classifier models available on "llama.cpp"');
	});
});

describe("buildDeciderContext", () => {
	it("includes userPrompt, toolResults when non-empty, and assistantAnswer", () => {
		const ctx = buildDeciderContext(
			{
				userPrompt: "Did the tests pass?",
				toolResults: [{ toolName: "bash", isError: true, content: "1 failed" }],
				assistantAnswer: "All tests passed!",
			},
			{ instructions: null },
		);
		expect(ctx.state).toEqual({
			userPrompt: "Did the tests pass?",
			toolResults: [{ toolName: "bash", isError: true, content: "1 failed" }],
			assistantAnswer: "All tests passed!",
		});
		expect(ctx.questions.wrong).toEqual({
			type: "bool",
			instructions: DEFAULT_DECIDER_INSTRUCTIONS,
			criteria: expect.objectContaining({
				true: expect.any(String),
				false: expect.any(String),
			}),
		});
	});

	it("omits toolResults when none occurred in the turn and uses custom instructions", () => {
		const ctx = buildDeciderContext(
			{
				userPrompt: "What is 2+2?",
				toolResults: [],
				assistantAnswer: "5",
			},
			{ instructions: "Is this math wrong?" },
		);
		expect(ctx.state).toEqual({
			userPrompt: "What is 2+2?",
			assistantAnswer: "5",
		});
		expect(ctx.questions.wrong?.instructions).toBe("Is this math wrong?");
	});
});

describe("evaluateWithDecider", () => {
	const model = fakeClassifierModel("llama.cpp", "pplx-decider-v1.1-27b");
	const baseCfg = {
		...defaultConfig().decider,
		enabled: true,
		model: "pplx-decider-v1.1-27b",
		threshold: 0.8,
	};
	const turn = {
		userPrompt: "Run tests",
		toolResults: [{ toolName: "bash", isError: true, content: "FAIL" }],
		assistantAnswer: "Tests succeeded",
	};

	it("flags the answer when probability >= threshold", async () => {
		const reg = fakeRegistry({ models: [], classifiers: [model], classifyProbability: 0.92 });
		const out = await evaluateWithDecider(turn, { model, registry: reg, config: baseCfg });
		expect(out.error).toBeUndefined();
		expect(out.finding).toEqual({
			provider: "llama.cpp",
			model: "pplx-decider-v1.1-27b",
			probability: 0.92,
			threshold: 0.8,
			failed: true,
			reason: "decider (llama.cpp/pplx-decider-v1.1-27b): 92% wrong (threshold 80%)",
		});
	});

	it("passes the answer when probability < threshold", async () => {
		const reg = fakeRegistry({ models: [], classifiers: [model], classifyProbability: 0.15 });
		const out = await evaluateWithDecider(turn, { model, registry: reg, config: baseCfg });
		expect(out.error).toBeUndefined();
		expect(out.finding?.failed).toBe(false);
		expect(out.finding?.probability).toBe(0.15);
	});

	it("fails open on provider error or thrown error", async () => {
		const regErr = fakeRegistry({
			models: [],
			classifiers: [model],
			classifyStopReason: "error",
			classifyErrorMessage: "connection refused",
		});
		const out1 = await evaluateWithDecider(turn, { model, registry: regErr, config: baseCfg });
		expect(out1.finding).toBeUndefined();
		expect(out1.error).toContain("connection refused");

		const regThrow = fakeRegistry({ models: [], classifiers: [model], classifyThrows: true });
		const out2 = await evaluateWithDecider(turn, { model, registry: regThrow, config: baseCfg });
		expect(out2.finding).toBeUndefined();
		expect(out2.error).toContain("classify boom");
	});

	it("fails open on timeout", async () => {
		const regHang = fakeRegistry({ models: [], classifiers: [model], classifyHang: true });
		const out = await evaluateWithDecider(turn, {
			model,
			registry: regHang,
			config: { ...baseCfg, timeoutMs: 30 },
		});
		expect(out.finding).toBeUndefined();
		expect(out.error).toBe("decider timeout");
	});
});
