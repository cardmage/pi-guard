/** Fakes for pi's model registry and extension API/context. */

import type {
	Api,
	AssistantMessage,
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierResult,
	Context,
	Model,
	ModelsClassifierOptions,
	ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";

export function fakeModel(provider: string, id: string, over: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "http://localhost",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: false,
		contextWindow: 100_000,
		maxTokens: 8192,
		...over,
	} as Model<Api>;
}

export function fakeClassifierModel(
	provider: string,
	id: string,
	over: Partial<ClassifierModel<ClassifierApi>> = {},
): ClassifierModel<ClassifierApi> {
	return {
		type: "classifier",
		id,
		name: id,
		api: "typesafe-system-one",
		provider,
		baseUrl: "http://127.0.0.1:8080/v1",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_768,
		...over,
	} as ClassifierModel<ClassifierApi>;
}

export interface FakeRegistryOptions {
	models: Model<Api>[];
	classifiers?: ClassifierModel<ClassifierApi>[];
	/** Text reply, or a function of the prompt text. */
	reply?: string | ((prompt: string) => string);
	stopReason?: AssistantMessage["stopReason"];
	throws?: boolean;
	/** Never resolve unless the signal aborts. */
	hang?: boolean;
	noAuth?: string[];
	/** Probability returned for the `wrong` bool question, or a function of the classifier context. */
	classifyProbability?: number | ((ctx: ClassifierContext, model: ClassifierModel<ClassifierApi>) => number);
	classifyStopReason?: ClassifierResult["stopReason"];
	classifyErrorMessage?: string;
	classifyThrows?: boolean;
	classifyHang?: boolean;
}

export interface RegistryCall {
	model: Model<Api>;
	context: Context;
	options?: ModelsSimpleStreamOptions;
}

export interface ClassifyCall {
	model: ClassifierModel<ClassifierApi>;
	context: ClassifierContext;
	options?: ModelsClassifierOptions;
}

export function fakeRegistry(opts: FakeRegistryOptions) {
	const calls: RegistryCall[] = [];
	const classifyCalls: ClassifyCall[] = [];
	const classifiers = opts.classifiers ?? [];
	const registry = {
		calls,
		classifyCalls,
		find: (provider: string, id: string) => opts.models.find((m) => m.provider === provider && m.id === id),
		findOfType: (type: string, provider: string, id: string) => {
			if (type === "classifier") return classifiers.find((m) => m.provider === provider && m.id === id);
			return undefined;
		},
		getModelsOfType: (type: string, provider?: string) => {
			if (type === "classifier") return provider ? classifiers.filter((m) => m.provider === provider) : classifiers;
			return [];
		},
		getAll: () => opts.models,
		hasConfiguredAuth: (m: Model<Api>) => !(opts.noAuth ?? []).includes(m.provider),
		classify: (
			model: ClassifierModel<ClassifierApi>,
			context: ClassifierContext,
			options?: ModelsClassifierOptions,
		): Promise<ClassifierResult> => {
			classifyCalls.push({ model, context, options });
			if (opts.classifyThrows) return Promise.reject(new Error("classify boom"));
			if (opts.classifyHang) return new Promise<ClassifierResult>(() => {});
			const prob =
				typeof opts.classifyProbability === "function"
					? opts.classifyProbability(context, model)
					: (opts.classifyProbability ?? 0.1);
			const stopReason = opts.classifyStopReason ?? "stop";
			return Promise.resolve({
				api: model.api,
				provider: model.provider,
				model: model.id,
				answers: {
					wrong: {
						type: "bool",
						probability: prob,
					},
				},
				stopReason,
				...(stopReason === "error" ? { errorMessage: opts.classifyErrorMessage ?? "classifier failed" } : {}),
				timestamp: Date.now(),
			});
		},
		streamSimple: (model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions) => {
			calls.push({ model, context, options });
			if (opts.throws) throw new Error("boom");
			const prompt = context.messages
				.map((m) => (typeof m.content === "string" ? m.content : (m.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("")))
				.join("\n");
			const message = (): AssistantMessage => ({
				role: "assistant",
				content: [{ type: "text", text: typeof opts.reply === "function" ? opts.reply(prompt) : (opts.reply ?? "") }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: opts.stopReason ?? "stop",
				errorMessage: opts.stopReason === "error" ? "provider failed" : undefined,
				timestamp: Date.now(),
			}) as AssistantMessage;
			// Only `result()` is used by the verifier.
			return {
				result: () => (opts.hang ? new Promise<AssistantMessage>(() => {}) : Promise.resolve(message())),
			} as never;
		},
	};
	return registry;
}
