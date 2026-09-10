import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { createToolHandler, renderDelegation, VERSION } from "../src/server.js";
import { type Delegation } from "../src/delegation.js";
import type { Config } from "../src/config.js";
import { fakeAgy, makeDelegator, toolNamed, valueOf } from "./support.js";

const delegation = (over: Partial<Delegation> = {}): Delegation => ({
  output: "the answer",
  model: "Gemini 3.7 Flash (High)",
  attempts: [],
  timedOut: false,
  ...over,
});

const textOf = (res: { content: { text: string }[] }) => res.content[0].text;

/** A fake agy that cannot be launched at all, standing in for a broken binary. */
const exploding = (): ReturnType<typeof fakeAgy> => ({
  spawn: () => {
    throw new Error("kaboom");
  },
  runs: [],
  kills: [],
  modelOf: () => undefined,
});

function handlerFor(
  name: string,
  overrides: Partial<Config> = {},
  agy = fakeAgy({ stdout: "the answer" }),
) {
  const { cfg, delegator } = makeDelegator({
    spawn: agy.spawn,
    cfg: overrides,
    sessions: JSON.stringify({ [process.cwd()]: "sess-1" }),
  });
  return { handler: createToolHandler(toolNamed(name), cfg, delegator), agy };
}

describe("renderDelegation", () => {
  it("appends the model footer", () => {
    expect(renderDelegation(delegation(), 3600)).toBe(
      "the answer\n\n---\n[claude-agy-mcp] model: Gemini 3.7 Flash (High)",
    );
  });

  it("names agy's own choice when no model was pinned", () => {
    expect(renderDelegation(delegation({ model: undefined }), 3600)).toContain(
      "model: agy default",
    );
  });

  it("lists note, failover attempts and session in the footer", () => {
    const text = renderDelegation(
      delegation({
        note: "could not list agy models",
        attempts: ["Gemini 3.7 Flash (Medium): quota exhausted (resets in 4h24m)"],
        sessionId: "sess-1",
      }),
      3600,
    );
    expect(text).toContain("note: could not list agy models");
    expect(text).toContain(
      "failover: Gemini 3.7 Flash (Medium): quota exhausted (resets in 4h24m)",
    );
    expect(text).toContain("session: sess-1 (use follow_up to continue)");
  });

  it("prefixes a timed-out run with the runtime-ceiling notice", () => {
    const text = renderDelegation(delegation({ output: "partial output", timedOut: true }), 900);
    expect(text).toContain(
      "[claude-agy-mcp] MAXIMUM RUNTIME EXCEEDED after 900s — agy was killed at the resource " +
        "ceiling (AGY_MAX_RUNTIME). This is not a diagnosis that it was stuck. Any file changes " +
        "it already made are on disk. Partial output follows.",
    );
    expect(text).toContain("partial output");
  });
});

describe("createToolHandler", () => {
  it("returns the rendered delegation", async () => {
    const { handler } = handlerFor("delegate");
    const text = textOf(await handler({ prompt: "do x" }));
    expect(text).toContain("the answer");
    expect(text).toContain("model: Gemini 3.7 Flash (High)");
    expect(text).toContain("sess-1");
  });

  it("uses the runtime ceiling for every tool", async () => {
    for (const name of ["delegate", "web_lookup"]) {
      const { handler, agy } = handlerFor(name);
      await handler(name === "delegate" ? { prompt: "x" } : { query: "x" });
      expect(valueOf(agy.runs[0], "--print-timeout")).toBe("3600s");
    }
  });

  it("uses the configured default timeout", async () => {
    const { handler, agy } = handlerFor("web_lookup", { defaultTimeoutSec: 900 });
    await handler({ query: "q" });
    expect(valueOf(agy.runs[0], "--print-timeout")).toBe("900s");
  });

  it("a per-tool override wins over the default timeout", async () => {
    const cfg = { defaultTimeoutSec: 900, perToolTimeouts: { deep_search: 300 } };
    const search = handlerFor("deep_search", cfg);
    await search.handler({ query: "q" });
    expect(valueOf(search.agy.runs[0], "--print-timeout")).toBe("300s");

    const lookup = handlerFor("web_lookup", cfg);
    await lookup.handler({ query: "q" });
    expect(valueOf(lookup.agy.runs[0], "--print-timeout")).toBe("900s");
  });

  it("flags a timed-out delegation as an error", async () => {
    const { handler, agy } = handlerFor(
      "delegate",
      { defaultTimeoutSec: 0.05 },
      fakeAgy({ neverExit: true, stdout: "partial output" }),
    );
    const res = await handler({ prompt: "x" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("MAXIMUM RUNTIME EXCEEDED after 0.05s");
    expect(agy.runs).toHaveLength(1);
  });

  it("returns isError content on failure instead of throwing", async () => {
    const { handler } = handlerFor("delegate", {}, exploding());
    const res = await handler({ prompt: "x" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("kaboom");
    expect(textOf(res)).not.toContain("Do NOT perform this work yourself");
  });

  it("strict mode appends the do-not-fallback instruction to errors", async () => {
    const { handler } = handlerFor("delegate", { onFailure: "strict" }, exploding());
    const res = await handler({ prompt: "x" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("kaboom");
    expect(textOf(res)).toContain("Do NOT perform this work yourself");
  });

  it("forwards the MCP abort signal", async () => {
    const { handler } = handlerFor("delegate");
    const ac = new AbortController();
    ac.abort();
    const res = await handler({ prompt: "x" }, { signal: ac.signal });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/cancelled/i);
  });

  it("surfaces a schema violation as an error response", async () => {
    const { handler, agy } = handlerFor("adversarial_review");
    const res = await handler({});
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/content.*files/i);
    expect(agy.runs).toHaveLength(0);
  });
});

it("advertises the published package version", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  expect(VERSION).toBe(pkg.version);
});
