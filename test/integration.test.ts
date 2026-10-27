/** Tests for the extension lifecycle, settlement boundary, rewrites, warnings and aborts. */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AgentBeforeSettleEvent,
	type AgentBeforeSettleEventResult,
	type BeforeAgentStartEvent,
	DefaultResourceLoader,
	discoverAndLoadExtensions,
	type ExtensionAPI,
	type ExtensionContext,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_FILE_NAME } from "../src/config.ts";
import { CUSTOM_TYPE } from "../src/extractor.ts";
import piGuard, {
	buildDeciderRewriteMessage,
	buildDeciderWarning,
	buildRewriteMessage,
	buildWarning,
} from "../src/index.ts";
import type { DeciderFinding, UrlFinding } from "../src/types.ts";
import { fakeClassifierModel, fakeModel, fakeRegistry, type FakeRegistryOptions } from "./helpers/fakes.ts";
import { isolateProxyEnv, type ProxyServer, startProxy, startTargetServer, type TargetServer } from "./helpers/servers.ts";

type Handler<T> = (event: T, ctx: ExtensionContext) => Promise<unknown> | unknown;

interface Harness {
	target: TargetServer;
	proxy: ProxyServer;
	agentDir: string;
	ctx: ExtensionContext;
	notified: { message: string; type?: string }[];
	statuses: { key: string; text?: string }[];
	registry: ReturnType<typeof fakeRegistry>;
	terminalInputHandler?: (data: string) => unknown;
	sessionStart(event?: unknown): Promise<void>;
	sessionShutdown(): Promise<void>;
	beforeAgentStart(event: BeforeAgentStartEvent): Promise<void>;
	beforeSettle(event: AgentBeforeSettleEvent): Promise<AgentBeforeSettleEventResult | undefined>;
}

let targetServer: TargetServer;
let forwardProxy: ProxyServer;

beforeAll(async () => {
	targetServer = await startTargetServer();
	forwardProxy = await startProxy({ upstreamPort: targetServer.port });
});
afterAll(async () => {
	await forwardProxy.close();
	await targetServer.close();
});

async function createHarness(opts: {
	config?: object;
	registryOpts?: Partial<FakeRegistryOptions>;
	mode?: "tui" | "rpc" | "print";
	hasUI?: boolean;
} = {}): Promise<Harness> {
	const agentDir = await mkdtemp(join(tmpdir(), "cg-ext-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;

	if (opts.config) {
		await writeFile(join(agentDir, CONFIG_FILE_NAME), JSON.stringify(opts.config, null, 2), "utf8");
	}

	const sessionModel = fakeModel("test-provider", "session-model", { reasoning: false });
	const registry = fakeRegistry({
		models: [sessionModel],
		...opts.registryOpts,
	});

	const notified: { message: string; type?: string }[] = [];
	const statuses: { key: string; text?: string }[] = [];
	let terminalInputHandler: ((data: string) => unknown) | undefined;

	const ctx: ExtensionContext = {
		mode: opts.mode ?? "tui",
		hasUI: opts.hasUI ?? true,
		cwd: process.cwd(),
		signal: undefined,
		model: sessionModel,
		scopedModels: [],
		sessionManager: {} as never,
		modelRegistry: registry as never,
		isIdle: () => true,
		isProjectTrusted: () => true,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
		ui: {
			notify: (message: string, type?: string) => notified.push({ message, type }),
			setStatus: (key: string, text?: string) => statuses.push({ key, text }),
			onTerminalInput: (h: (data: string) => unknown) => {
				terminalInputHandler = h;
				return () => {
					if (terminalInputHandler === h) terminalInputHandler = undefined;
				};
			},
		} as never,
	};

	const handlers = new Map<string, Handler<unknown>[]>();
	const api: ExtensionAPI = {
		on: (name: string, handler: Handler<unknown>) => {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
			return () => {};
		},
	} as never;

	piGuard(api);

	const fire = async <E>(name: string, ev: E): Promise<any> => {
		let res: unknown;
		for (const h of handlers.get(name) ?? []) {
			res = await h(ev, ctx);
		}
		return res;
	};

	return {
		target: targetServer,
		proxy: forwardProxy,
		agentDir,
		ctx,
		notified,
		statuses,
		registry,
		get terminalInputHandler() {
			return terminalInputHandler;
		},
		sessionStart: (ev = { type: "session_start" }) => fire("session_start", ev),
		sessionShutdown: () => fire("session_shutdown", { type: "session_shutdown" }),
		beforeAgentStart: (ev) => fire("before_agent_start", ev),
		beforeSettle: (ev) => fire("agent_before_settle", ev),
	};
}

function makeSettleEvent(
	assistantText: string,
	contextBefore: AgentMessage[] = [],
	outcome: AgentBeforeSettleEvent["outcome"] = "completed",
): AgentBeforeSettleEvent {
	const lastMsg: AgentMessage = {
		role: "assistant",
		content: [{ type: "text", text: assistantText }],
		api: "openai-completions",
		provider: "test-provider",
		model: "session-model",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
	return {
		type: "agent_before_settle",
		outcome,
		continue: false,
		entries: [],
		context: {
			contextEntries: [],
			contextMessages: [...contextBefore, lastMsg],
			llmMessages: [],
			pendingMessages: [],
			canContinue: true,
		},
	};
}

describe("piGuard pipeline", () => {
	let restoreEnv: () => void;
	beforeEach(() => {
		restoreEnv = isolateProxyEnv();
	});
	afterEach(async () => {
		delete process.env.PI_CODING_AGENT_DIR;
		restoreEnv();
	});

	it("passes when the answer contains no URLs", async () => {
		const h = await createHarness();
		try {
			await h.sessionStart();
			const ev = makeSettleEvent("No links here, just plain text.");
			const res = await h.beforeSettle(ev);
			expect(res).toBeUndefined();
			expect(h.notified).toHaveLength(0);
		} finally {
			await h.sessionShutdown();
			await rm(h.agentDir, { recursive: true, force: true });
		}
	});

	it("ignores runs with outcome != completed", async () => {
		const h = await createHarness();
		try {
			await h.sessionStart();
			const ev = makeSettleEvent(`See ${h.target.url}/missing`, [], "aborted");
			const res = await h.beforeSettle(ev);
			expect(res).toBeUndefined();
		} finally {
			await h.sessionShutdown();
			await rm(h.agentDir, { recursive: true, force: true });
		}
	});

	it("bypasses local, example and user bypass URLs without HTTP checks", async () => {
		const h = await createHarness({
			config: {
				bypassDomains: ["mycorp.internal.net", "*.custom.io", "github.com/private-repo"],
			},
		});
		try {
			await h.sessionStart();
			const answer = [
				"1. http://localhost:3000/api",
				"2. https://example.com/guide",
				"3. https://service.mycorp.internal.net/doc",
				"4. https://api.custom.io/v1",
				"5. https://github.com/private-repo/issues/1",
			].join("\n");
			const ev = makeSettleEvent(answer);
			h.target.hits.length = 0;
			const res = await h.beforeSettle(ev);
			expect(res).toBeUndefined();
			expect(h.target.hits).toHaveLength(0);
		} finally {
			await h.sessionShutdown();
			await rm(h.agentDir, { recursive: true, force: true });
		}
	});

	it("still checks URLs even if they appeared in user messages or tool results", async () => {
		const h = await createHarness({
			config: {
				mode: "rewrite",
				maxRewrites: 1,
				http: { proxy: hProxy(forwardProxy) },
			},
		});
		try {
			await h.sessionStart();
			await h.beforeAgentStart({ type: "before_agent_start", messageType: "user", prompt: "q", systemPrompt: "", systemPromptOptions: {} as never });

			const priorMessages: AgentMessage[] = [
				{
					role: "user",
					content: [{ type: "text", text: "Please include http://docs.foo.com/missing in your answer" }],
					timestamp: Date.now(),
				},
			];
			const ev = makeSettleEvent("Sure: http://docs.foo.com/missing", priorMessages);
			const res = await h.beforeSettle(ev);
			expect(res?.continue).toBe(true);
			const entry = res?.entries?.[0] as { content: string };
			expect(entry.content).toContain("http://docs.foo.com/missing");
		} finally {
			await h.sessionShutdown();
			await rm(h.agentDir, { recursive: true, force: true });
		}
	});

	it("mode: rewrite triggers a custom_message continuation with failed URLs and reasons", async () => {
		const h = await createHarness({
			config: {
				mode: "rewrite",
				maxRewrites: 1,
				http: { proxy: hProxy(forwardProxy) },
			},
		});
		try {
			await h.sessionStart();
			await h.beforeAgentStart({ type: "before_agent_start", messageType: "user", prompt: "q", systemPrompt: "", systemPromptOptions: {} as never });

			const answer = `Visit http://docs.foo.com/ok and the fake http://docs.foo.com/missing for more.`;
			const ev = makeSettleEvent(answer);
			const res = await h.beforeSettle(ev);

			expect(res).toBeDefined();
			expect(res?.continue).toBe(true);
			expect(res?.entries).toHaveLength(1);
			const entry = res?.entries?.[0] as { type: string; customType: string; content: string; display: boolean };
			expect(entry.type).toBe("custom_message");
			expect(entry.customType).toBe(CUSTOM_TYPE);
			expect(entry.display).toBe(true);
			expect(entry.content).toContain("http://docs.foo.com/missing");
			expect(entry.content).toContain("HTTP 404");
			expect(entry.content).not.toContain("http://docs.foo.com/ok");
		} finally {
			await h.sessionShutdown();
			await rm(h.agentDir, { recursive: true, force: true });
		}
	});

	it("demotes to a warning when maxRewrites is reached", async () => {
		const h = await createHarness({
			config: {
				mode: "rewrite",
				maxRewrites: 1,
				http: { proxy: hProxy(forwardProxy) },
			},
		});
		try {
			await h.sessionStart();
			await h.beforeAgentStart({ type: "before_agent_start", messageType: "user", prompt: "q", systemPrompt: "", systemPromptOptions: {} as never });

			const ev1 = makeSettleEvent("See http://docs.foo.com/missing");
			const res1 = await h.beforeSettle(ev1);
			expect(res1?.continue).toBe(true);

			// Agent ran again and still hallucinated. Continuation turns do not trigger before_agent_start(user).
			const ev2 = makeSettleEvent("Still hallucinating http://docs.foo.com/missing");
			const res2 = await h.beforeSettle(ev2);
			expect(res2?.continue).toBeFalsy();
			expect(res2?.entries?.[0]?.type).toBe("custom");
			expect(h.notified.some((n) => n.message.includes("http://docs.foo.com/missing"))).toBe(true);
		} finally {
			await h.sessionShutdown();
			await rm(h.agentDir, { recursive: true, force: true });
		}
	});

	it("mode: warn shows a notification without requesting continuation", async () => {
		const h = await createHarness({
			config: {
				mode: "warn",
				http: { proxy: hProxy(forwardProxy) },
			},
		});
		try {
			await h.sessionStart();
			const ev = makeSettleEvent("See http://docs.foo.com/missing");
			const res = await h.beforeSettle(ev);
			expect(res?.continue).toBeFalsy();
			expect(h.notified.some((n) => n.type === "warning" && n.message.includes("http://docs.foo.com/missing"))).toBe(true);
		} finally {
			await h.sessionShutdown();
			await rm(h.agentDir, { recursive: true, force: true });
		}
	});

	it("falls back to LLM for UNCERTAIN HTTP statuses and respects verifier verdicts", async () => {
		const h = await createHarness({
			config: {
				mode: "rewrite",
				maxRewrites: 1,
				http: { proxy: hProxy(forwardProxy) },
			},
			registryOpts: {
				reply: (prompt) => {
					// The prompt receives URLs with httpStatus: 403.
					return JSON.stringify({
						results: [
							{ url: "http://docs.foo.com/forbidden", verdict: "NOT_EXISTS", reason: "discontinued product" },
							{ url: "http://docs.foo.com/unauthorized", verdict: "EXISTS", reason: "internal doc Behind SSO" },
							{ url: "http://docs.foo.com/ratelimit", verdict: "UNKNOWN", reason: "cannot tell" },
						],
					});
				},
			},
		});
		try {
			await h.sessionStart();
			await h.beforeAgentStart({ type: "before_agent_start", messageType: "user", prompt: "q", systemPrompt: "", systemPromptOptions: {} as never });

			const answer = "1. http://docs.foo.com/forbidden 2. http://docs.foo.com/unauthorized 3. http://docs.foo.com/ratelimit";
			const ev = makeSettleEvent(answer);
			const res = await h.beforeSettle(ev);

			expect(res?.continue).toBe(true);
			const msg = (res?.entries?.[0] as { content: string }).content;
			expect(msg).toContain("http://docs.foo.com/forbidden");
			expect(msg).toContain("discontinued product");
			// EXISTS and UNKNOWN are not flagged:
			expect(msg).not.toContain("http://docs.foo.com/unauthorized");
			expect(msg).not.toContain("http://docs.foo.com/ratelimit");
		} finally {
			await h.sessionShutdown();
			await rm(h.agentDir, { recursive: true, force: true });
		}
	});

	it("uses session cache to avoid re-checking identical URLs", async () => {
		const h = await createHarness({
			config: { http: { proxy: hProxy(forwardProxy) } },
		});
		try {
			await h.sessionStart();
			await h.beforeAgentStart({ type: "before_agent_start", messageType: "user", prompt: "q", systemPrompt: "", systemPromptOptions: {} as never });

			const ev1 = makeSettleEvent("http://docs.foo.com/ok");
			h.target.hits.length = 0;
			await h.beforeSettle(ev1);
			expect(h.target.hits.length).toBeGreaterThan(0);

			// Same URL again in the next turn
			h.target.hits.length = 0;
			const ev2 = makeSettleEvent("Still http://docs.foo.com/ok");
			await h.beforeSettle(ev2);
			expect(h.target.hits).toHaveLength(0);
		} finally {
			await h.sessionShutdown();
			await rm(h.agentDir, { recursive: true, force: true });
		}
	});

	it("verifies page content against the assistant's claim when verifyContent is true", async () => {
		const h = await createHarness({
			config: {
				mode: "rewrite",
				maxRewrites: 1,
				verifyContent: true,
				http: { proxy: hProxy(forwardProxy) },
			},
			registryOpts: {
				reply: (prompt) => {
					expect(prompt).toContain("Widgets support only JSON format in v2.");
					return JSON.stringify({
						results: [
							{
								url: "http://docs.foo.com/html",
								verdict: "CONTRADICTED",
								reason: "Page says Widgets support only JSON in v2, not XML",
							},
						],
					});
				},
			},
		});
		try {
			await h.sessionStart();
			await h.beforeAgentStart({ type: "before_agent_start", messageType: "user", prompt: "q", systemPrompt: "", systemPromptOptions: {} as never });

			const ev = makeSettleEvent("According to http://docs.foo.com/html, Widgets v2 supports XML natively.");
			const res = await h.beforeSettle(ev);
			expect(res?.continue).toBe(true);
			const msg = (res?.entries?.[0] as { content: string }).content;
			expect(msg).toContain("http://docs.foo.com/html");
			expect(msg).toContain("Page says Widgets support only JSON in v2, not XML");
		} finally {
			await h.sessionShutdown();
			await rm(h.agentDir, { recursive: true, force: true });
		}
	});

	it("aborts when the user presses Escape in the TUI", async () => {
		const h = await createHarness({
			config: {
				http: { proxy: hProxy(forwardProxy), timeoutMs: 10000 },
			},
		});
		try {
			await h.sessionStart();
			const ev = makeSettleEvent("Check http://docs.foo.com/slow");
			const promise = h.beforeSettle(ev);
			// Simulate Escape input after the settlement hook registers its listener
			await new Promise((r) => setTimeout(r, 50));
			expect(h.terminalInputHandler).toBeDefined();
			h.terminalInputHandler!("\x1b");

			const res = await promise;
			expect(res).toBeUndefined();
		} finally {
			await h.sessionShutdown();
			await rm(h.agentDir, { recursive: true, force: true });
		}
	});

	it("issues a one-time warning on consecutive network/proxy errors", async () => {
		const h = await createHarness({
			config: {
				// Proxy with auth required, but none provided → every request fails with 407.
				http: { proxy: "http://127.0.0.1:9", timeoutMs: 300 },
			},
			registryOpts: {
				reply: '{"results":[]}',
			},
		});
		try {
			await h.sessionStart();
			const answer = "https://one.com/a https://two.com/b https://three.com/c";
			await h.beforeSettle(makeSettleEvent(answer));
			expect(h.notified.some((n) => n.message.includes("Check proxy/certificate settings"))).toBe(true);
		} finally {
			await h.sessionShutdown();
			await rm(h.agentDir, { recursive: true, force: true });
		}
	});

	it("warns once and falls back to session model when configured verifier model is missing, and preserves existing event.entries", async () => {
		const h = await createHarness({
			config: {
				mode: "rewrite",
				maxRewrites: 1,
				verifier: { provider: "unknown-prov", model: "missing-model" },
				http: { enabled: false },
			},
			registryOpts: {
				reply: JSON.stringify({
					results: [{ url: "http://docs.foo.com/fake-cli", verdict: "NOT_EXISTS", reason: "no such CLI page" }],
				}),
			},
		});
		try {
			await h.sessionStart();
			await h.beforeAgentStart({ type: "before_agent_start", messageType: "user", prompt: "q", systemPrompt: "", systemPromptOptions: {} as never });

			const priorDraft = { type: "custom" as const, customType: "earlier-extension", data: { ok: true } };
			const ev = makeSettleEvent("Use http://docs.foo.com/fake-cli to configure it.");
			ev.entries = [priorDraft];

			const res = await h.beforeSettle(ev);
			expect(h.notified.some((n) => n.message.includes('verifier model "unknown-prov/missing-model" not found; using session model'))).toBe(true);
			expect(res?.continue).toBe(true);
			expect(res?.entries).toHaveLength(2);
			expect(res?.entries?.[0]).toEqual(priorDraft);
			expect(res?.entries?.[1]?.type).toBe("custom_message");
		} finally {
			await h.sessionShutdown();
			await rm(h.agentDir, { recursive: true, force: true });
		}
	});

	it("evaluates answers without URLs when decider.enabled is true and triggers rewrite", async () => {
		const deciderModel = fakeClassifierModel("llama.cpp", "pplx-decider-v1.1-27b");
		const h = await createHarness({
			config: {
				decider: {
					enabled: true,
					mode: "rewrite",
					maxRewrites: 1,
					provider: "llama.cpp",
					model: "pplx-decider-v1.1-27b",
					threshold: 0.8,
				},
			},
			registryOpts: {
				classifiers: [deciderModel],
				classifyProbability: (ctx) => {
					expect(ctx.state.userPrompt).toBe("Did tests pass?");
					expect(ctx.state.assistantAnswer).toBe("Yes, all 42 tests passed with 0 errors.");
					return 0.93;
				},
			},
		});
		try {
			await h.sessionStart();
			await h.beforeAgentStart({
				type: "before_agent_start",
				messageType: "user",
				prompt: "Did tests pass?",
				systemPrompt: "",
				systemPromptOptions: {} as never,
			});

			const priorMessages: AgentMessage[] = [
				{
					role: "user",
					content: [{ type: "text", text: "Did tests pass?" }],
					timestamp: Date.now(),
				},
			];
			const ev = makeSettleEvent("Yes, all 42 tests passed with 0 errors.", priorMessages);
			const res = await h.beforeSettle(ev);

			expect(res?.continue).toBe(true);
			const entry = res?.entries?.[0] as { type: string; content: string };
			expect(entry.type).toBe("custom_message");
			expect(entry.content).toContain("llama.cpp/pplx-decider-v1.1-27b: 93% >= 80% threshold");

			// Second attempt hits maxRewrites and demotes to warning
			const ev2 = makeSettleEvent("Yes, all 42 tests passed with 0 errors.", priorMessages);
			const res2 = await h.beforeSettle(ev2);
			expect(res2?.continue).toBeFalsy();
			expect(
				h.notified.some((n) => n.type === "warning" && n.message.includes("answer flagged as potentially incorrect (93% >= 80%")),
			).toBe(true);
		} finally {
			await h.sessionShutdown();
			await rm(h.agentDir, { recursive: true, force: true });
		}
	});

	it("supports independent modes for URL guard and decider (e.g. URL rewrite + decider warn)", async () => {
		const deciderModel = fakeClassifierModel("llama.cpp", "custom-decider");
		const h = await createHarness({
			config: {
				enabled: true,
				mode: "rewrite",
				maxRewrites: 1,
				http: { proxy: hProxy(forwardProxy) },
				decider: {
					enabled: true,
					mode: "warn",
					provider: "llama.cpp",
					model: null, // auto-select single classifier on llama.cpp
					threshold: 0.75,
				},
			},
			registryOpts: {
				classifiers: [deciderModel],
				classifyProbability: 0.88,
			},
		});
		try {
			await h.sessionStart();
			await h.beforeAgentStart({
				type: "before_agent_start",
				messageType: "user",
				prompt: "q",
				systemPrompt: "",
				systemPromptOptions: {} as never,
			});

			const ev = makeSettleEvent("Broken link: http://docs.foo.com/missing");
			const res = await h.beforeSettle(ev);

			// URL guard triggers rewrite continuation, while decider in warn mode issues a notification
			expect(res?.continue).toBe(true);
			const entry = res?.entries?.[0] as { content: string };
			expect(entry.content).toContain("http://docs.foo.com/missing");
			expect(
				h.notified.some((n) => n.type === "warning" && n.message.includes("answer flagged as potentially incorrect (88% >= 75%")),
			).toBe(true);
		} finally {
			await h.sessionShutdown();
			await rm(h.agentDir, { recursive: true, force: true });
		}
	});
});

describe("Pi extension loader (jiti & package.json manifest)", () => {
	it("loads ./src/index.ts via discoverAndLoadExtensions without errors", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "cg-loader-"));
		try {
			const loaded = await discoverAndLoadExtensions([join(process.cwd(), "src", "index.ts")], process.cwd(), agentDir);
			expect(loaded.errors).toEqual([]);
			expect(loaded.extensions).toHaveLength(1);
			const ext = loaded.extensions[0]!;
			expect(ext.handlers.get("session_start")?.length).toBe(1);
			expect(ext.handlers.get("session_shutdown")?.length).toBe(1);
			expect(ext.handlers.get("before_agent_start")?.length).toBe(1);
			expect(ext.handlers.get("agent_before_settle")?.length).toBe(1);
		} finally {
			await rm(agentDir, { recursive: true, force: true });
		}
	});

	it("discovers the extension from package.json pi.extensions via DefaultResourceLoader", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "cg-pkg-"));
		try {
			const settingsManager = SettingsManager.inMemory();
			const loader = new DefaultResourceLoader({
				cwd: process.cwd(),
				agentDir,
				settingsManager,
				noExtensions: true,
				additionalExtensionPaths: [process.cwd()],
			});
			await loader.reload();
			const exts = loader.getExtensions();
			expect(exts.errors).toEqual([]);
			expect(exts.extensions).toHaveLength(1);
		} finally {
			await rm(agentDir, { recursive: true, force: true });
		}
	});
});

function hProxy(p: ProxyServer): string {
	return p.url;
}

describe("formatters", () => {
	it("buildRewriteMessage", () => {
		const failed: UrlFinding[] = [{ url: "https://a.com/x", failed: true, reason: "HTTP 404" }];
		const m = buildRewriteMessage(failed);
		expect(m).toContain("https://a.com/x — HTTP 404");
		expect(m).toContain("Rewrite your answer");
	});

	it("buildWarning", () => {
		const failed: UrlFinding[] = [{ url: "https://a.com/x", failed: true, reason: "HTTP 404" }];
		expect(buildWarning(failed)).toContain("• https://a.com/x (HTTP 404)");
	});

	it("buildDeciderRewriteMessage and buildDeciderWarning", () => {
		const finding: DeciderFinding = {
			provider: "llama.cpp",
			model: "pplx-decider-v1.1-27b",
			probability: 0.91,
			threshold: 0.8,
			failed: true,
			reason: "decider (llama.cpp/pplx-decider-v1.1-27b): 91% wrong (threshold 80%)",
		};
		expect(buildDeciderRewriteMessage(finding)).toContain("llama.cpp/pplx-decider-v1.1-27b: 91% >= 80% threshold");
		expect(buildDeciderWarning(finding)).toContain("91% >= 80%, model: llama.cpp/pplx-decider-v1.1-27b");
	});
});
