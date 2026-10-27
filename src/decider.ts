/**
 * Evaluates the assistant's final answer with a classifier/decision model
 * (e.g. via Pi's built-in `llama.cpp` provider and `ctx.modelRegistry.classify()`).
 */

import type { ClassifierApi, ClassifierContext, ClassifierModel, ClassifierResult, JsonObject } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TurnContext } from "./extractor.ts";
import type { DeciderConfig, DeciderFinding } from "./types.ts";

export const DEFAULT_DECIDER_INSTRUCTIONS =
	"Judge whether `assistantAnswer` is wrong: does it contradict `toolResults`, fabricate facts or outputs not supported by the turn context, or contain clear factual or logical errors in response to `userPrompt`?";

export const DEFAULT_DECIDER_CRITERIA = {
	true: "The answer is wrong, hallucinated, or contradicts the tool outputs or user prompt.",
	false: "The answer is accurate, faithful to the tool outputs, and properly addresses the user prompt.",
} as const;

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
	return {
		state,
		questions: {
			wrong: {
				type: "bool",
				instructions: cfg.instructions ?? DEFAULT_DECIDER_INSTRUCTIONS,
				criteria: { ...DEFAULT_DECIDER_CRITERIA },
			},
		},
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

		const answer = result.answers?.wrong;
		if (!answer || answer.type !== "bool" || typeof answer.probability !== "number" || !Number.isFinite(answer.probability)) {
			return { error: "decider returned no valid boolean probability for 'wrong'" };
		}

		const probability = Math.max(0, Math.min(1, answer.probability));
		const threshold = opts.config.threshold;
		const failed = probability >= threshold;
		const label = `${opts.model.provider}/${opts.model.id}`;
		const reason = `decider (${label}): ${formatPercent(probability)} wrong (threshold ${formatPercent(threshold)})`;

		return {
			finding: {
				provider: opts.model.provider,
				model: opts.model.id,
				probability,
				threshold,
				failed,
				reason,
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
