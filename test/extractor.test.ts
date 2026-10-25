import { describe, expect, it } from "vitest";
import {
	assistantText,
	canonicalKey,
	collectContextUrls,
	extractUrls,
	lastAssistantIndex,
	maskCode,
	snippetAround,
	trimUrlCandidate,
} from "../src/extractor.ts";

const urls = (text: string, skipCodeBlocks = true) => extractUrls(text, { skipCodeBlocks }).map((u) => u.url);

describe("extractUrls", () => {
	it("finds markdown links, autolinks and bare URLs", () => {
		const text = [
			"See [the docs](https://docs.foo.com/guide) for details.",
			"Also <https://bar.org/page> and https://baz.net/a/b?x=1.",
		].join("\n");
		expect(urls(text)).toEqual(["https://docs.foo.com/guide", "https://bar.org/page", "https://baz.net/a/b?x=1"]);
	});

	it("handles markdown links with titles and angle-bracket targets", () => {
		expect(urls('[a](https://a.com/x "Title") [b](<https://b.com/y>)')).toEqual(["https://a.com/x", "https://b.com/y"]);
	});

	it("keeps balanced parentheses inside URLs", () => {
		expect(urls("[wiki](https://en.wikipedia.org/wiki/Foo_(bar))")).toEqual(["https://en.wikipedia.org/wiki/Foo_(bar)"]);
		expect(urls("(see https://en.wikipedia.org/wiki/Foo_(bar))")).toEqual(["https://en.wikipedia.org/wiki/Foo_(bar)"]);
	});

	it("strips trailing punctuation and unbalanced closing parens", () => {
		expect(urls("Visit https://a.com/x.")).toEqual(["https://a.com/x"]);
		expect(urls("Visit https://a.com/x, then")).toEqual(["https://a.com/x"]);
		expect(urls("(https://a.com/x)")).toEqual(["https://a.com/x"]);
		expect(urls("Really https://a.com/x?!")).toEqual(["https://a.com/x"]);
		expect(urls('"https://a.com/q"')).toEqual(["https://a.com/q"]);
		expect(urls("**https://a.com/bold**")).toEqual(["https://a.com/bold"]);
	});

	it("does not swallow CJK prose or punctuation", () => {
		expect(urls("https://a.com/docs에서 확인하세요")).toEqual(["https://a.com/docs"]);
		expect(urls("https://a.com에서 확인")).toEqual(["https://a.com/"]);
		expect(urls("参见https://a.com/x。")).toEqual(["https://a.com/x"]);
		expect(urls("https://ko.wikipedia.org/wiki/서울 문서")).toEqual([
			`https://ko.wikipedia.org/wiki/${encodeURIComponent("서울")}`,
		]);
	});

	it("deduplicates by canonical key (fragment, trailing slash)", () => {
		expect(urls("https://a.com/x https://a.com/x/ https://a.com/x#sec [y](https://a.com/x)")).toEqual(["https://a.com/x"]);
	});

	it("drops fragments and ignores non-http schemes", () => {
		expect(urls("https://a.com/p#frag ftp://a.com/f mailto:x@y.com")).toEqual(["https://a.com/p"]);
	});

	it("skips code blocks and inline code by default", () => {
		const text = [
			"Real: https://real.com/a",
			"```bash",
			"curl https://fenced.com/b",
			"```",
			"~~~",
			"https://tilde.com/c",
			"~~~",
			"Inline `https://inline.com/d` and ``code with ` https://double.com/e``.",
		].join("\n");
		expect(urls(text)).toEqual(["https://real.com/a"]);
		expect(urls(text, false)).toEqual([
			"https://real.com/a",
			"https://fenced.com/b",
			"https://tilde.com/c",
			"https://inline.com/d",
			"https://double.com/e",
		]);
	});

	it("treats an unclosed fence as code until the end", () => {
		expect(urls("ok https://a.com/1\n```\nhttps://b.com/2\n")).toEqual(["https://a.com/1"]);
	});

	it("reports offsets into the original text", () => {
		const text = "xx https://a.com/p yy";
		const [u] = extractUrls(text);
		expect(text.slice(u!.index, u!.index + u!.length)).toBe("https://a.com/p");
	});

	it("handles IPv6 and ports", () => {
		expect(urls("http://[::1]:8080/x and http://host.com:8443/y")).toEqual(["http://[::1]:8080/x", "http://host.com:8443/y"]);
	});
});

describe("helpers", () => {
	it("maskCode preserves length and newlines", () => {
		const t = "a `b` c\n```\nx\n```\nd";
		const m = maskCode(t);
		expect(m.length).toBe(t.length);
		expect(m.split("\n").length).toBe(t.split("\n").length);
		expect(m).not.toContain("b");
	});

	it("trimUrlCandidate", () => {
		expect(trimUrlCandidate("https://a.com/x).")).toBe("https://a.com/x");
		expect(trimUrlCandidate("https://a.com/x_(y))")).toBe("https://a.com/x_(y)");
	});

	it("canonicalKey", () => {
		expect(canonicalKey("https://A.com/x/#h")).toBe("https://a.com/x");
		expect(canonicalKey("https://a.com./")).toBe("https://a.com/");
		expect(canonicalKey("https://a.com/x/?q=1")).toBe("https://a.com/x/?q=1");
	});

	it("snippetAround", () => {
		const text = `${"a".repeat(300)}URL${"b".repeat(300)}`;
		const s = snippetAround(text, 300, 3, 10);
		expect(s).toBe(`…${"a".repeat(10)}URL${"b".repeat(10)}…`);
	});
});

describe("context whitelist", () => {
	const messages = [
		{ role: "user", content: "Check https://user-given.com/page please" },
		{
			role: "assistant",
			content: [
				{ type: "text", text: "Hallucinated https://assistant-prose.com/x" },
				{ type: "toolCall", id: "1", name: "fetch", arguments: { url: "https://tool-arg.com/a", nested: { list: ["https://deep.com/b"] } } },
			],
		},
		{ role: "toolResult", toolCallId: "1", toolName: "fetch", content: [{ type: "text", text: "Found https://tool-result.com/c" }], isError: false },
		{ role: "custom", customType: "pi-guard", content: "bad https://our-feedback.com/d" },
		{ role: "custom", customType: "other-ext", content: [{ type: "text", text: "https://other-ext.com/e" }] },
		{ role: "bashExecution", command: "curl https://bash-cmd.com/f", output: "" },
		{ role: "compactionSummary", summary: "Read https://summary.com/g" },
		{ role: "assistant", content: [{ type: "text", text: "Final https://final.com/h" }] },
	];

	it("collects URLs from user, tool results, tool-call args, other custom messages, summaries", () => {
		const keys = collectContextUrls(messages);
		for (const u of [
			"https://user-given.com/page",
			"https://tool-arg.com/a",
			"https://deep.com/b",
			"https://tool-result.com/c",
			"https://other-ext.com/e",
			"https://bash-cmd.com/f",
			"https://summary.com/g",
		]) {
			expect(keys.has(canonicalKey(u)), u).toBe(true);
		}
		expect(keys.has(canonicalKey("https://assistant-prose.com/x"))).toBe(false);
		expect(keys.has(canonicalKey("https://our-feedback.com/d"))).toBe(false);
		expect(keys.has(canonicalKey("https://final.com/h"))).toBe(false);
	});

	it("finds the last assistant message text", () => {
		const idx = lastAssistantIndex(messages);
		expect(idx).toBe(messages.length - 1);
		expect(assistantText(messages[idx])).toBe("Final https://final.com/h");
		expect(lastAssistantIndex([{ role: "user", content: "x" }])).toBe(-1);
	});
});
