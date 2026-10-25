/** Fakes for pi's model registry and extension API/context. */

import type { Api, AssistantMessage, Context, Model, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";

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

export interface FakeRegistryOptions {
	models: Model<Api>[];
	/** Text reply, or a function of the prompt text. */
	reply?: string | ((prompt: string) => string);
	stopReason?: AssistantMessage["stopReason"];
	throws?: boolean;
	/** Never resolve unless the signal aborts. */
	hang?: boolean;
	noAuth?: string[];
}

export interface RegistryCall {
	model: Model<Api>;
	context: Context;
	options?: ModelsSimpleStreamOptions;
}

export function fakeRegistry(opts: FakeRegistryOptions) {
	const calls: RegistryCall[] = [];
	const registry = {
		calls,
		find: (provider: string, id: string) => opts.models.find((m) => m.provider === provider && m.id === id),
		getAll: () => opts.models,
		hasConfiguredAuth: (m: Model<Api>) => !(opts.noAuth ?? []).includes(m.provider),
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
