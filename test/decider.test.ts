import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.ts";
import {
	aggregateDeciderScores,
	buildDeciderContext,
	evaluateWithDecider,
	getDeciderQuestionSpecs,
	NO_TOOL_TURN_QUESTIONS,
	resolveDeciderModel,
	TOOL_TURN_QUESTIONS,
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

describe("buildDeciderContext & context-adaptive question sets (Idea 4)", () => {
	it("uses tool-grounding multi-angle questions when toolResults are present", () => {
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
		expect(Object.keys(ctx.questions)).toEqual(TOOL_TURN_QUESTIONS.map((q) => q.id));
		expect(ctx.questions.contradicts_tools).toBeDefined();
		expect(ctx.questions.faithful_to_evidence).toBeDefined();
		expect(ctx.questions.logical_or_factual_error).toBeUndefined();
	});

	it("uses reasoning/factual multi-angle questions without tool references when toolResults are empty", () => {
		const ctx = buildDeciderContext(
			{
				userPrompt: "What is 2+2?",
				toolResults: [],
				assistantAnswer: "5",
			},
			{ instructions: null },
		);
		expect(ctx.state).toEqual({
			userPrompt: "What is 2+2?",
			assistantAnswer: "5",
		});
		expect(Object.keys(ctx.questions)).toEqual(NO_TOOL_TURN_QUESTIONS.map((q) => q.id));
		expect(ctx.questions.logical_or_factual_error).toBeDefined();
		expect(ctx.questions.accurate_and_sound).toBeDefined();
		expect(ctx.questions.contradicts_tools).toBeUndefined();
	});

	it("includes custom instructions as 'wrong' alongside scaled base questions when configured", () => {
		const ctx = buildDeciderContext(
			{
				userPrompt: "What is 2+2?",
				toolResults: [],
				assistantAnswer: "5",
			},
			{ instructions: "Is this math wrong?" },
		);
		expect(ctx.questions.wrong?.instructions).toBe("Is this math wrong?");
		expect(ctx.questions.logical_or_factual_error).toBeDefined();
		expect(ctx.questions.accurate_and_sound).toBeDefined();
	});
});

describe("aggregateDeciderScores (Ideas 1 & 2: orthogonal weights + polarity cross-check)", () => {
	it("computes weighted risk when negative and positive questions agree on wrongness", () => {
		const specs = getDeciderQuestionSpecs(
			{ toolResults: [{ toolName: "bash", content: "FAIL" }] },
			{ instructions: null },
		);
		const agg = aggregateDeciderScores(specs, {
			contradicts_tools: { type: "bool", probability: 0.95 }, // neg, w=0.30 -> risk 0.95
			fabricated_claims: { type: "bool", probability: 0.85 }, // neg, w=0.20 -> risk 0.85
			faithful_to_evidence: { type: "bool", probability: 0.1 }, // pos, w=0.25 -> risk 0.90
			ignores_prompt: { type: "bool", probability: 0.8 }, // neg, w=0.125 -> risk 0.80
			addresses_prompt: { type: "bool", probability: 0.2 }, // pos, w=0.125 -> risk 0.80
		});
		expect(agg).toBeDefined();
		// Weighted sum: 0.30*0.95 + 0.20*0.85 + 0.25*0.90 + 0.125*0.80 + 0.125*0.80 = 0.285 + 0.17 + 0.225 + 0.10 + 0.10 = 0.88
		expect(agg!.probability).toBeCloseTo(0.88, 4);
	});

	it("dampens false positives when classifier exhibits Yes-bias (both negative and positive answered true)", () => {
		const specs = getDeciderQuestionSpecs(
			{ toolResults: [{ toolName: "bash", content: "OK" }] },
			{ instructions: null },
		);
		// Model blindly outputs 0.90 probability of `true` for every question (Yes-bias)
		const agg = aggregateDeciderScores(specs, {
			contradicts_tools: { type: "bool", probability: 0.9 }, // risk = 0.9
			fabricated_claims: { type: "bool", probability: 0.9 }, // risk = 0.9
			faithful_to_evidence: { type: "bool", probability: 0.9 }, // risk = 0.1 (since positive)
			ignores_prompt: { type: "bool", probability: 0.9 }, // risk = 0.9
			addresses_prompt: { type: "bool", probability: 0.9 }, // risk = 0.1 (since positive)
		});
		expect(agg).toBeDefined();
		expect(agg!.probability).toBeCloseTo(0.36, 3);
		expect(agg!.probability).toBeLessThan(0.5);
	});

	it("dampens false positives when only negative questions spike mildly but positive questions confirm faithfulness", () => {
		const specs = getDeciderQuestionSpecs({ toolResults: [] }, { instructions: null });
		const agg = aggregateDeciderScores(specs, {
			fabricated_claims: { type: "bool", probability: 0.85 }, // risk = 0.85
			logical_or_factual_error: { type: "bool", probability: 0.85 }, // risk = 0.85
			accurate_and_sound: { type: "bool", probability: 0.85 }, // risk = 0.15
			ignores_prompt: { type: "bool", probability: 0.1 }, // risk = 0.10
			addresses_prompt: { type: "bool", probability: 0.9 }, // risk = 0.10
		});
		expect(agg).toBeDefined();
		expect(agg!.probability).toBeLessThan(0.5);
	});

	it("does not dilute a single orthogonal flaw (tool contradiction) when unrelated dimensions pass", () => {
		const specs = getDeciderQuestionSpecs(
			{ toolResults: [{ toolName: "bash", isError: true, content: "1 test failed" }] },
			{ instructions: null },
		);
		const agg = aggregateDeciderScores(specs, {
			contradicts_tools: { type: "bool", probability: 0.96 }, // neg, w=0.30 -> risk 0.96 (triggered)
			fabricated_claims: { type: "bool", probability: 0.05 }, // neg, w=0.20 -> risk 0.05 (not triggered)
			faithful_to_evidence: { type: "bool", probability: 0.04 }, // pos, w=0.25 -> risk 0.96 (triggered)
			ignores_prompt: { type: "bool", probability: 0.05 }, // neg, w=0.125 -> risk 0.05 (not triggered)
			addresses_prompt: { type: "bool", probability: 0.95 }, // pos, w=0.125 -> risk 0.05 (not triggered)
		});
		expect(agg).toBeDefined();
		expect(agg!.probability).toBeCloseTo(0.96, 4);
		expect(agg!.probability).toBeGreaterThanOrEqual(0.8);
	});

	it("does not dilute a single orthogonal flaw (factual/math error in no-tool turn) when unrelated dimensions pass", () => {
		const specs = getDeciderQuestionSpecs({ toolResults: [] }, { instructions: null });
		const agg = aggregateDeciderScores(specs, {
			fabricated_claims: { type: "bool", probability: 0.02 }, // neg, w=0.25 -> risk 0.02 (not triggered)
			logical_or_factual_error: { type: "bool", probability: 0.95 }, // neg, w=0.25 -> risk 0.95 (triggered)
			accurate_and_sound: { type: "bool", probability: 0.05 }, // pos, w=0.25 -> risk 0.95 (triggered)
			ignores_prompt: { type: "bool", probability: 0.02 }, // neg, w=0.125 -> risk 0.02 (not triggered)
			addresses_prompt: { type: "bool", probability: 0.98 }, // pos, w=0.125 -> risk 0.02 (not triggered)
		});
		expect(agg).toBeDefined();
		expect(agg!.probability).toBeCloseTo(0.95, 4);
		expect(agg!.probability).toBeGreaterThanOrEqual(0.8);
	});

	it("does not dampen prompt_response flaw when soundness questions pass (Issue #4)", () => {
		const specs = getDeciderQuestionSpecs({ toolResults: [] }, { instructions: null });
		// Answer is factually accurate and sound (0.01 risk), but misses the user's core request (0.99 risk)
		const aggPaired = aggregateDeciderScores(specs, {
			fabricated_claims: { type: "bool", probability: 0.01 }, // risk = 0.01
			logical_or_factual_error: { type: "bool", probability: 0.01 }, // risk = 0.01
			accurate_and_sound: { type: "bool", probability: 0.99 }, // risk = 0.01
			ignores_prompt: { type: "bool", probability: 0.99 }, // risk = 0.99 (triggered)
			addresses_prompt: { type: "bool", probability: 0.01 }, // risk = 0.99 (triggered)
		});
		expect(aggPaired).toBeDefined();
		expect(aggPaired!.probability).toBeCloseTo(0.99, 4);
		expect(aggPaired!.probability).toBeGreaterThanOrEqual(0.8);

		// Also works if only the 4 original questions were answered
		const aggFour = aggregateDeciderScores(specs, {
			fabricated_claims: { type: "bool", probability: 0.01 },
			logical_or_factual_error: { type: "bool", probability: 0.01 },
			accurate_and_sound: { type: "bool", probability: 0.99 },
			addresses_prompt: { type: "bool", probability: 0.01 }, // risk = 0.99
		});
		expect(aggFour).toBeDefined();
		expect(aggFour!.probability).toBeCloseTo(0.99, 4);
	});

	it("does not falsely flag casual greetings when negative flaw checks are false even if positive prompt check wobbles", () => {
		const specs = getDeciderQuestionSpecs({ toolResults: [] }, { instructions: null });
		// e.g. User: "안녕", Assistant: "안녕하세요" -> no factual errors, no ignored request (ignores_prompt=0.01),
		// even if addresses_prompt returns low probability (0.1 -> risk 0.9) because there was no "core request".
		const agg = aggregateDeciderScores(specs, {
			fabricated_claims: { type: "bool", probability: 0.01 }, // risk = 0.01
			logical_or_factual_error: { type: "bool", probability: 0.01 }, // risk = 0.01
			accurate_and_sound: { type: "bool", probability: 0.99 }, // risk = 0.01
			ignores_prompt: { type: "bool", probability: 0.01 }, // risk = 0.01 (did NOT ignore a request)
			addresses_prompt: { type: "bool", probability: 0.1 }, // risk = 0.90 (unconfirmed positive wobble)
		});
		expect(agg).toBeDefined();
		expect(agg!.probability).toBeLessThan(0.2);
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

	it("flags the answer when composite probability >= threshold and includes breakdown", async () => {
		const reg = fakeRegistry({ models: [], classifiers: [model], classifyProbability: 0.92 });
		const out = await evaluateWithDecider(turn, { model, registry: reg, config: baseCfg });
		expect(out.error).toBeUndefined();
		expect(out.finding?.provider).toBe("llama.cpp");
		expect(out.finding?.model).toBe("pplx-decider-v1.1-27b");
		expect(out.finding?.probability).toBe(0.92);
		expect(out.finding?.threshold).toBe(0.8);
		expect(out.finding?.failed).toBe(true);
		expect(out.finding?.reason).toContain("decider (llama.cpp/pplx-decider-v1.1-27b): 92% wrong (threshold 80%)");
		expect(out.finding?.reason).toContain("contradicts_tools=92%");
		expect(out.finding?.breakdown).toHaveLength(5);
	});

	it("passes the answer when probability < threshold", async () => {
		const reg = fakeRegistry({ models: [], classifiers: [model], classifyProbability: 0.15 });
		const out = await evaluateWithDecider(turn, { model, registry: reg, config: baseCfg });
		expect(out.error).toBeUndefined();
		expect(out.finding?.failed).toBe(false);
		expect(out.finding?.probability).toBe(0.15);
	});

	it("prevents false positive rewrite when positive questions contradict negative questions", async () => {
		const reg = fakeRegistry({
			models: [],
			classifiers: [model],
			classifyAnswers: {
				contradicts_tools: 0.88,
				fabricated_claims: 0.82,
				faithful_to_evidence: 0.9, // positive: 90% faithful -> 10% risk
				addresses_prompt: 0.95, // positive: 95% addresses prompt -> 5% risk
			},
		});
		const out = await evaluateWithDecider(turn, { model, registry: reg, config: baseCfg });
		expect(out.error).toBeUndefined();
		expect(out.finding?.failed).toBe(false);
		expect(out.finding?.probability).toBeLessThan(0.8);
	});

	it("flags a single cross-confirmed flaw even when other orthogonal dimensions pass", async () => {
		const reg = fakeRegistry({
			models: [],
			classifiers: [model],
			classifyAnswers: {
				contradicts_tools: 0.94,
				fabricated_claims: 0.08,
				faithful_to_evidence: 0.06, // positive: 6% faithful -> 94% risk
				addresses_prompt: 0.95, // positive: 95% addresses prompt -> 5% risk
			},
		});
		const out = await evaluateWithDecider(turn, { model, registry: reg, config: baseCfg });
		expect(out.error).toBeUndefined();
		expect(out.finding?.failed).toBe(true);
		expect(out.finding?.probability).toBe(0.94);
		expect(out.finding?.reason).toContain("contradicts_tools=94%");
		expect(out.finding?.reason).toContain("faithful_to_evidence=94%");
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
