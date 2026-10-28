/**
 * Evaluates the assistant's final answer with a classifier/decision model
 * (e.g. via Pi's built-in `llama.cpp` provider and `ctx.modelRegistry.classify()`).
 *
 * Uses multi-angle orthogonal questions with positive/negative polarity cross-checking
 * and context-adaptive question sets (with vs. without tool results) to reduce false positives.
 */

import type {
	ClassifierAnswer,
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierQuestion,
	ClassifierResult,
	JsonObject,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TurnContext } from "./extractor.ts";
import type { DeciderConfig, DeciderDimensionScore, DeciderFinding } from "./types.ts";

export const DEFAULT_DECIDER_INSTRUCTIONS =
	"Judge whether `assistantAnswer` is wrong: does it contradict `toolResults`, fabricate facts or outputs not supported by the turn context, or contain clear factual or logical errors in response to `userPrompt`?";

export const DEFAULT_DECIDER_CRITERIA = {
	true: "The answer is wrong, hallucinated, or contradicts the tool outputs or user prompt.",
	false: "The answer is accurate, faithful to the tool outputs, and properly addresses the user prompt.",
} as const;

export interface DeciderQuestionSpec {
	id: string;
	/**
	 * - `"negative"`: `true` means the answer has a flaw (`risk = probability`).
	 * - `"positive"`: `true` means the answer is good (`risk = 1 - probability`).
	 */
	polarity: "negative" | "positive";
	weight: number;
	instructions: string;
	criteria: { true: string; false: string };
}

/** Orthogonal + bidirectional questions when `toolResults` are present in the turn. */
export const TOOL_TURN_QUESTIONS: readonly DeciderQuestionSpec[] = [
	{
		id: "contradicts_tools",
		polarity: "negative",
		weight: 0.35,
		instructions:
			"Does `assistantAnswer` directly contradict facts, numbers, statuses, file contents, or error outcomes present in `toolResults`?",
		criteria: {
			true: "The answer states facts, outputs, or statuses that conflict with `toolResults`.",
			false: "The answer is consistent with `toolResults`.",
		},
	},
	{
		id: "fabricated_claims",
		polarity: "negative",
		weight: 0.25,
		instructions:
			"Does `assistantAnswer` fabricate unverified facts, invent tool outputs, or claim actions were performed when `toolResults` do not support them?",
		criteria: {
			true: "The answer invents unsupported facts, outputs, or actions.",
			false: "All factual and operational claims are grounded in `toolResults` or `userPrompt`.",
		},
	},
	{
		id: "faithful_to_evidence",
		polarity: "positive",
		weight: 0.25,
		instructions: "Is `assistantAnswer` faithful and accurate with respect to `toolResults` and `userPrompt`?",
		criteria: {
			true: "The answer accurately reflects the tool outputs and evidence without distortion.",
			false: "The answer misrepresents, ignores, or distorts the evidence.",
		},
	},
	{
		id: "addresses_prompt",
		polarity: "positive",
		weight: 0.15,
		instructions: "Does `assistantAnswer` directly and coherently address `userPrompt` without internal contradictions?",
		criteria: {
			true: "The answer properly addresses the user prompt and is logically consistent.",
			false: "The answer ignores key requirements of the prompt or contradicts itself.",
		},
	},
];

/** Orthogonal + bidirectional questions when no tools were called in the turn. */
export const NO_TOOL_TURN_QUESTIONS: readonly DeciderQuestionSpec[] = [
	{
		id: "fabricated_claims",
		polarity: "negative",
		weight: 0.3,
		instructions:
			"Does `assistantAnswer` fabricate facts, invent external outputs, or claim to have executed tools or verified state not present in the turn context?",
		criteria: {
			true: "The answer fabricates facts or claims unexecuted actions or verifications.",
			false: "The answer makes no fabricated or unverified operational claims.",
		},
	},
	{
		id: "logical_or_factual_error",
		polarity: "negative",
		weight: 0.3,
		instructions:
			"Does `assistantAnswer` contain clear factual errors, broken reasoning, or internal self-contradictions in response to `userPrompt`?",
		criteria: {
			true: "The answer contains factual errors, flawed logic, or self-contradictions.",
			false: "The answer is logically sound and factually accurate.",
		},
	},
	{
		id: "accurate_and_sound",
		polarity: "positive",
		weight: 0.25,
		instructions: "Is `assistantAnswer` factually accurate and logically sound for `userPrompt`?",
		criteria: {
			true: "The answer is accurate, sound, and trustworthy.",
			false: "The answer is inaccurate, misleading, or logically flawed.",
		},
	},
	{
		id: "addresses_prompt",
		polarity: "positive",
		weight: 0.15,
		instructions: "Does `assistantAnswer` directly and completely address the core request in `userPrompt`?",
		criteria: {
			true: "The answer directly addresses the user's request.",
			false: "The answer misses or ignores the user's core request.",
		},
	},
];

/**
 * Selects the question set based on turn context (whether `toolResults` exist)
 * and optional custom `instructions`.
 */
export function getDeciderQuestionSpecs(
	turn: Pick<TurnContext, "toolResults">,
	cfg: Pick<DeciderConfig, "instructions">,
): DeciderQuestionSpec[] {
	const base = turn.toolResults.length > 0 ? TOOL_TURN_QUESTIONS : NO_TOOL_TURN_QUESTIONS;
	if (!cfg.instructions) {
		return base.map((q) => ({ ...q, criteria: { ...q.criteria } }));
	}
	// When custom instructions are provided, include `wrong` with weight 0.4 and scale the base questions to 0.6.
	const customSpec: DeciderQuestionSpec = {
		id: "wrong",
		polarity: "negative",
		weight: 0.4,
		instructions: cfg.instructions,
		criteria: { ...DEFAULT_DECIDER_CRITERIA },
	};
	const scaledBase = base.map((q) => ({
		...q,
		weight: Number((q.weight * 0.6).toFixed(4)),
		criteria: { ...q.criteria },
	}));
	return [customSpec, ...scaledBase];
}

export interface ResolvedDeciderModel {
	model: ClassifierModel<ClassifierApi> | undefined;
	warning?: string;
}

export interface DeciderRegistryLike {
	findOfType(type: "classifier", provider: string, modelId: string): ClassifierModel<ClassifierApi> | undefined;
	getModelsOfType(type: "classifier", provider?: string): readonly ClassifierModel<ClassifierApi>[];
	classify: ExtensionContext["modelRegistry"]["classify"];
}

/**
 * Resolves the classifier model for `decider`:
 * - When `cfg.model` is set, looks up `cfg.provider`/`cfg.model` among classifier models.
 * - When `cfg.model` is `null`, auto-selects the classifier model if `cfg.provider` has exactly one.
 */
export function resolveDeciderModel(
	cfg: Pick<DeciderConfig, "provider" | "model">,
	registry: Pick<DeciderRegistryLike, "findOfType" | "getModelsOfType">,
): ResolvedDeciderModel {
	const provider = cfg.provider;
	if (cfg.model) {
		let found: ClassifierModel<ClassifierApi> | undefined;
		try {
			found = registry.findOfType("classifier", provider, cfg.model);
			if (!found) {
				const needle = cfg.model.toLowerCase();
				const list = registry.getModelsOfType("classifier", provider) ?? [];
				found = list.find((m) => m.id.toLowerCase() === needle || m.name.toLowerCase() === needle);
			}
		} catch {
			found = undefined;
		}
		if (!found) {
			return {
				model: undefined,
				warning: `decider model "${provider}/${cfg.model}" not found; load it with /llama or check decider.model`,
			};
		}
		return { model: found };
	}

	let list: readonly ClassifierModel<ClassifierApi>[] = [];
	try {
		list = registry.getModelsOfType("classifier", provider) ?? [];
	} catch {
		list = [];
	}
	if (list.length === 1) {
		return { model: list[0] };
	}
	if (list.length === 0) {
		return {
			model: undefined,
			warning: `no classifier model available for provider "${provider}"; load a model with /llama or set decider.model`,
		};
	}
	return {
		model: undefined,
		warning: `multiple classifier models available on "${provider}" (${list.map((m) => m.id).join(", ")}); set decider.model in pi-guard.json`,
	};
}

/** Builds the `ClassifierContext` sent to `registry.classify()`. */
export function buildDeciderContext(
	turn: TurnContext,
	cfg: Pick<DeciderConfig, "instructions">,
): ClassifierContext {
	const state: JsonObject = {
		userPrompt: turn.userPrompt,
		...(turn.toolResults.length > 0
			? {
					toolResults: turn.toolResults.map((t) => ({
						toolName: t.toolName,
						...(t.isError !== undefined ? { isError: t.isError } : {}),
						content: t.content,
					})),
				}
			: {}),
		assistantAnswer: turn.assistantAnswer,
	};
	const specs = getDeciderQuestionSpecs(turn, cfg);
	const questions: Record<string, ClassifierQuestion> = {};
	for (const spec of specs) {
		questions[spec.id] = {
			type: "bool",
			instructions: spec.instructions,
			criteria: { ...spec.criteria },
		};
	}
	return { state, questions };
}

export interface AggregatedDeciderScore {
	probability: number;
	breakdown: DeciderDimensionScore[];
}

function clamp01(v: number): number {
	return Math.max(0, Math.min(1, v));
}

function round4(v: number): number {
	return Math.round(v * 10000) / 10000;
}

/**
 * Combines multi-question boolean probabilities into a single calibrated wrongness probability:
 * 1. Normalizes each question into a wrongness `risk` (`p` for negative polarity, `1 - p` for positive polarity).
 * 2. Computes the weighted average risk across all answered questions.
 * 3. Applies a polarity cross-check damping factor when positive and negative question groups disagree
 *    (e.g. Yes-bias where the classifier answers `true` to both flaw and faithfulness questions).
 */
export function aggregateDeciderScores(
	specs: readonly DeciderQuestionSpec[],
	answers: Record<string, ClassifierAnswer> | undefined,
): AggregatedDeciderScore | undefined {
	if (!answers) return undefined;

	const breakdown: DeciderDimensionScore[] = [];
	for (const spec of specs) {
		const ans = answers[spec.id];
		if (!ans || ans.type !== "bool" || typeof ans.probability !== "number" || !Number.isFinite(ans.probability)) {
			continue;
		}
		const probability = clamp01(ans.probability);
		const risk = round4(spec.polarity === "negative" ? probability : 1 - probability);
		breakdown.push({
			id: spec.id,
			polarity: spec.polarity,
			probability,
			risk,
			weight: spec.weight,
		});
	}

	// Fallback if a legacy/custom classifier only returned a single `wrong` answer not in `specs`
	if (breakdown.length === 0) {
		const fallbackWrong = answers.wrong;
		if (
			fallbackWrong &&
			fallbackWrong.type === "bool" &&
			typeof fallbackWrong.probability === "number" &&
			Number.isFinite(fallbackWrong.probability)
		) {
			const probability = clamp01(fallbackWrong.probability);
			return {
				probability,
				breakdown: [{ id: "wrong", polarity: "negative", probability, risk: probability, weight: 1 }],
			};
		}
		return undefined;
	}

	let totalWeight = 0;
	let weightedRiskSum = 0;
	let negWeight = 0;
	let negRiskSum = 0;
	let posWeight = 0;
	let posRiskSum = 0;

	for (const item of breakdown) {
		totalWeight += item.weight;
		weightedRiskSum += item.weight * item.risk;
		if (item.polarity === "negative") {
			negWeight += item.weight;
			negRiskSum += item.weight * item.risk;
		} else {
			posWeight += item.weight;
			posRiskSum += item.weight * item.risk;
		}
	}

	if (totalWeight <= 0) return undefined;
	let composite = weightedRiskSum / totalWeight;

	// Polarity cross-check: if both negative and positive questions were answered, check whether they agree.
	if (negWeight > 0 && posWeight > 0) {
		const negRisk = negRiskSum / negWeight;
		const posRisk = posRiskSum / posWeight;
		// When one polarity group indicates "likely fine" (< 0.5) while the other indicates "likely wrong",
		// dampen the composite score proportional to their disagreement to suppress yes/no bias false positives.
		if (Math.min(negRisk, posRisk) < 0.5) {
			const disagreement = Math.abs(negRisk - posRisk);
			composite *= 1 - 0.5 * disagreement;
		}
	}

	return {
		probability: round4(clamp01(composite)),
		breakdown,
	};
}

export interface EvaluateDeciderOptions {
	model: ClassifierModel<ClassifierApi> | undefined;
	registry: Pick<DeciderRegistryLike, "classify">;
	config: DeciderConfig;
	signal?: AbortSignal;
}

export interface DeciderOutcome {
	finding?: DeciderFinding;
	/** Set when the call failed or no model was available (fail-open). */
	error?: string;
}

function formatPercent(p: number): string {
	return `${Math.round(p * 100)}%`;
}

/** Evaluates the current turn with the classifier model. Never throws; failures yield `finding: undefined` and `error`. */
export async function evaluateWithDecider(
	turn: TurnContext,
	opts: EvaluateDeciderOptions,
): Promise<DeciderOutcome> {
	if (!opts.model) return { error: "no decider model available" };

	const timeout = AbortSignal.timeout(opts.config.timeoutMs);
	const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
	const specs = getDeciderQuestionSpecs(turn, opts.config);
	const context = buildDeciderContext(turn, opts.config);

	let onAbort: (() => void) | undefined;
	try {
		const classifyPromise = opts.registry.classify(opts.model, context, {
			signal,
			timeoutMs: opts.config.timeoutMs,
		});
		const aborted = new Promise<never>((_, reject) => {
			if (signal.aborted) {
				reject(signal.reason);
				return;
			}
			onAbort = () => reject(signal.reason);
			signal.addEventListener("abort", onAbort, { once: true });
		});
		aborted.catch(() => {});
		const result: ClassifierResult = await Promise.race([classifyPromise, aborted]);

		if (result.stopReason === "error" || result.stopReason === "aborted") {
			const err =
				result.stopReason === "aborted"
					? timeout.aborted
						? "decider timeout"
						: "decider aborted"
					: `decider error: ${result.errorMessage ?? "unknown"}`;
			return { error: err };
		}

		const aggregated = aggregateDeciderScores(specs, result.answers);
		if (!aggregated) {
			return { error: "decider returned no valid boolean probabilities" };
		}

		const { probability, breakdown } = aggregated;
		const threshold = opts.config.threshold;
		const failed = probability >= threshold;
		const label = `${opts.model.provider}/${opts.model.id}`;
		const topRisks = breakdown
			.filter((b) => b.risk >= 0.5)
			.sort((a, b) => b.risk - a.risk)
			.map((b) => `${b.id}=${formatPercent(b.risk)}`);
		const detailSuffix = topRisks.length > 0 ? ` [${topRisks.join(", ")}]` : "";
		const reason = `decider (${label}): ${formatPercent(probability)} wrong (threshold ${formatPercent(threshold)})${detailSuffix}`;

		return {
			finding: {
				provider: opts.model.provider,
				model: opts.model.id,
				probability,
				threshold,
				failed,
				reason,
				breakdown,
			},
		};
	} catch (err) {
		if (timeout.aborted) return { error: "decider timeout" };
		if (opts.signal?.aborted) return { error: "decider aborted" };
		return { error: `decider error: ${err instanceof Error ? err.message : String(err)}` };
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
}
