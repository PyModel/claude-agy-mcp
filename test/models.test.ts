import { describe, it, expect } from "vitest";
import { writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseListing,
  pickTier,
  describeModel,
  resolveEntry,
  ModelRegistry,
  ModelSkewError,
  listModels,
} from "../src/models.js";
import { LISTING } from "./support.js";

describe("parseListing", () => {
  it("returns one row per tab-separated line, keeping id and display name apart", () => {
    expect(parseListing("gemini-3.7-flash-high\tGemini 3.7 Flash (High)\n")).toEqual([
      {
        id: "gemini-3.7-flash-high",
        name: "Gemini 3.7 Flash (High)",
        family: "gemini-flash",
        version: [3, 7],
        effort: "high",
      },
    ]);
  });

  it("drops the 'Fetching available models...' progress line agy prints first", () => {
    const raw = "Fetching available models...\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n";
    expect(parseListing(raw).map((m) => m.name)).toEqual(["Gemini 3.8 Flash (Low)"]);
  });

  it("strips a trailing ' (current)' marker", () => {
    const raw = "claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking) (current)\n";
    expect(parseListing(raw)[0]!.name).toBe("Claude Opus 4.6 (Thinking)");
  });
});

describe("describeModel", () => {
  it("splits a versioned name into family, version and effort", () => {
    expect(describeModel("x", "Gemini 3.1 Pro (High)")).toMatchObject({
      family: "gemini-pro",
      version: [3, 1],
      effort: "high",
    });
  });

  it("keeps a size token in the family when it is not a version", () => {
    expect(describeModel("x", "GPT-OSS 120B (Medium)")).toMatchObject({
      family: "gpt-oss-120b",
      version: [],
      effort: "medium",
    });
  });
});

describe("resolveEntry", () => {
  const available = parseListing(LISTING);

  it("accepts an exact display name", () => {
    expect(resolveEntry("Gemini 3.1 Pro (High)", available)).toBe("Gemini 3.1 Pro (High)");
  });

  it("accepts an id and returns the display name", () => {
    expect(resolveEntry("gemini-3.7-flash-high", available)).toBe("Gemini 3.7 Flash (High)");
  });

  it("resolves a family selector to the newest version at that effort", () => {
    expect(resolveEntry("gemini-flash@latest-high", available)).toBe("Gemini 3.8 Flash (High)");
  });

  it("resolves a pinned version selector", () => {
    expect(resolveEntry("gemini-flash@3.7-medium", available)).toBe("Gemini 3.7 Flash (Medium)");
  });

  it("returns undefined for a family that is not offered", () => {
    expect(resolveEntry("llama@latest", available)).toBeUndefined();
  });
});

describe("ModelRegistry.resolveChain", () => {
  const registry = (out: string | Error) =>
    new ModelRegistry(async () => {
      if (out instanceof Error) throw out;
      return out;
    });

  it("returns every resolvable chain entry in order, then defaultModel", async () => {
    const r = await registry(LISTING).resolveChain({
      chain: ["Gemini 9.9 Ultra", "gemini-flash@latest-medium", "Gemini 3.1 Pro (High)"],
      defaultModel: "Gemini 3.7 Flash (High)",
    });
    expect(r.models).toEqual([
      "Gemini 3.8 Flash (Medium)",
      "Gemini 3.1 Pro (High)",
      "Gemini 3.7 Flash (High)",
    ]);
  });

  it("does not repeat a model that the chain and the default both name", async () => {
    const r = await registry(LISTING).resolveChain({
      chain: ["gemini-flash@latest-high"],
      defaultModel: "Gemini 3.8 Flash (High)",
    });
    expect(r.models).toEqual(["Gemini 3.8 Flash (High)"]);
  });

  it("uses an explicit model when it resolves", async () => {
    const r = await registry(LISTING).resolveChain({
      explicit: "Gemini 3.1 Pro (High)",
      chain: ["gemini-flash@latest-high"],
    });
    expect(r.models).toEqual(["Gemini 3.1 Pro (High)"]);
  });

  it("throws on an explicit model the listing does not offer, showing the options", async () => {
    await expect(registry(LISTING).resolveChain({ explicit: "Nope", chain: [] })).rejects.toThrow(
      /Gemini 3\.8 Flash \(High\)/,
    );
  });

  it("throws ModelSkewError rather than silently using agy's default when nothing resolves", async () => {
    await expect(
      registry(LISTING).resolveChain({ chain: ["Gemini 9.9 Ultra"], defaultModel: "Also Gone" }),
    ).rejects.toThrow(ModelSkewError);
  });

  it("degrades to agy's own default only when the listing itself is unreadable", async () => {
    const reg = registry(new Error("boom"));
    const a = await reg.resolveChain({ explicit: "Whatever", chain: [] });
    expect(a.models).toEqual(["Whatever"]);
    expect(a.note).toMatch(/could not list/i);
    const b = await reg.resolveChain({ chain: ["Gemini 3.7 Flash (High)"] });
    expect(b.models).toEqual([undefined]);
    expect(b.note).toMatch(/could not list/i);
  });

  it("treats an unparseable listing as unreadable rather than as zero models", async () => {
    const r = await registry("some new format with no tabs\n").resolveChain({
      chain: ["Gemini 3.7 Flash (High)"],
    });
    expect(r.models).toEqual([undefined]);
    expect(r.note).toMatch(/could not list/i);
  });

  it("fetches the listing only once under concurrent calls", async () => {
    let calls = 0;
    const reg = new ModelRegistry(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return LISTING;
    });
    const [a, b] = await Promise.all([
      reg.resolveChain({ chain: ["Gemini 3.7 Flash (High)"] }),
      reg.resolveChain({ chain: ["Gemini 3.1 Pro (High)"] }),
    ]);
    expect(calls).toBe(1);
    expect(a.models).toEqual(["Gemini 3.7 Flash (High)"]);
    expect(b.models).toEqual(["Gemini 3.1 Pro (High)"]);
  });

  it("retries the listing after a transient failure instead of caching null forever", async () => {
    let calls = 0;
    const reg = new ModelRegistry(async () => {
      if (++calls === 1) throw new Error("transient");
      return LISTING;
    });
    expect((await reg.resolveChain({ chain: ["Gemini 3.1 Pro (High)"] })).models).toEqual([
      undefined,
    ]);
    expect((await reg.resolveChain({ chain: ["Gemini 3.1 Pro (High)"] })).models).toEqual([
      "Gemini 3.1 Pro (High)",
    ]);
  });
});

describe("listModels", () => {
  it("closes stdin so agy exits instead of waiting on EOF", async () => {
    // A stub that reads stdin to EOF first: it only prints if stdin was closed.
    const stub = path.join(tmpdir(), `agy-stub-${process.pid}.sh`);
    writeFileSync(
      stub,
      '#!/bin/sh\ncat >/dev/null\nprintf "gemini-3.7-flash-high\\tGemini 3.7 Flash (High)\\n"\n',
    );
    chmodSync(stub, 0o755);
    try {
      expect(parseListing(await listModels(stub)).map((m) => m.name)).toEqual([
        "Gemini 3.7 Flash (High)",
      ]);
    } finally {
      rmSync(stub, { force: true });
    }
  });
});

describe("pickTier", () => {
  const listing = parseListing(LISTING);

  it("uses a tiered model as-is and sends no --effort when the tiers agree or none is asked", () => {
    expect(pickTier("Gemini 3.8 Flash (High)", undefined, listing)).toEqual({
      model: "Gemini 3.8 Flash (High)",
    });
    expect(pickTier("Gemini 3.8 Flash (High)", "high", listing)).toEqual({
      model: "Gemini 3.8 Flash (High)",
    });
  });

  it("selects the sibling at the asked tier within the same family and version", () => {
    expect(pickTier("Gemini 3.8 Flash (High)", "medium", listing)).toEqual({
      model: "Gemini 3.8 Flash (Medium)",
    });
    expect(pickTier("Gemini 3.1 Pro (High)", "low", listing)).toEqual({
      model: "Gemini 3.1 Pro (Low)",
    });
  });

  it("keeps the model when no sibling exists at that tier, still without --effort", () => {
    expect(pickTier("Gemini 3.8 Flash (High)", "low", listing)).toEqual({
      model: "Gemini 3.8 Flash (High)",
    });
  });

  it("passes --effort through for a model with no tier in its name", () => {
    const untiered = parseListing("gpt-oss-120b\tGPT-OSS 120B\n");
    expect(pickTier("GPT-OSS 120B", "low", untiered)).toEqual({
      model: "GPT-OSS 120B",
      effort: "low",
    });
    expect(pickTier("GPT-OSS 120B", undefined, untiered)).toEqual({ model: "GPT-OSS 120B" });
  });
});
