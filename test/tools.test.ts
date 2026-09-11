import { describe, it, expect } from "vitest";
import { TOOLS, modeFor, resolveFiles } from "../src/tools.js";

describe("TOOLS", () => {
  it("defines the nine tools", () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual([
      "adversarial_review",
      "agy_status",
      "analyze_files",
      "deep_search",
      "delegate",
      "delegate_many",
      "follow_up",
      "set_model",
      "web_lookup",
    ]);
  });

  it("keeps every read-only tool in plan mode, whatever the caller asks for", () => {
    for (const t of TOOLS) {
      if (t.privilege !== "read-only") continue;
      expect(modeFor(t, true)).toBe("plan");
      expect(modeFor(t, undefined)).toBe("plan");
    }
  });

  it("only delegate lets the caller ask for write access", () => {
    const delegate = TOOLS.find((t) => t.name === "delegate")!;
    expect(delegate.privilege).toBe("caller-chooses");
    expect(modeFor(delegate, true)).toBe("accept-edits");
    expect(modeFor(delegate, undefined)).toBe("plan");
  });

  it("declares a model chain for every tool that picks its own model", () => {
    for (const t of TOOLS) {
      // follow_up reuses the model of the session it continues; agy_status and
      // set_model never reach agy at all, so none of them declares a chain.
      if (["follow_up", "agy_status", "set_model"].includes(t.name))
        expect(t.chain).toBeUndefined();
      else expect(t.chain?.length).toBeGreaterThan(0);
    }
  });
});

describe("resolveFiles", () => {
  it("resolves relative paths against cwd, keeps absolute", () => {
    expect(resolveFiles(["a.ts", "/abs/b.ts"], "/repo")).toEqual(["/repo/a.ts", "/abs/b.ts"]);
  });
});

describe("prompt templates", () => {
  const get = (name: string) => TOOLS.find((t) => t.name === name)!;

  it("analyze_files lists absolute paths and the question", () => {
    const p = get("analyze_files").buildPrompt(
      { files: ["x.log"], question: "find errors" },
      "/repo",
    );
    expect(p).toContain("/repo/x.log");
    expect(p).toContain("find errors");
    expect(p).toMatch(/file:line/);
  });

  it("adversarial_review accepts inline content", () => {
    const p = get("adversarial_review").buildPrompt(
      { content: "plan text", focus: "security" },
      "/repo",
    );
    expect(p).toContain("plan text");
    expect(p).toContain("security");
    expect(p).toMatch(/severity/i);
  });

  it("adversarial_review states the content-or-files rule in its schema", () => {
    const t = get("adversarial_review");
    expect(t.schema.safeParse({}).success).toBe(false);
    expect(t.schema.safeParse({ content: "plan" }).success).toBe(true);
    expect(t.schema.safeParse({ files: ["a.ts"] }).success).toBe(true);
    expect(() => t.buildPrompt({}, "/repo")).toThrow(/content.*files/i);
  });

  it("follow_up passes the question through verbatim", () => {
    const args = { session_id: "sess-1", question: "and then?" };
    expect(get("follow_up").buildPrompt(args, "/repo")).toBe("and then?");
  });

  it("delegate passes the prompt through verbatim", () => {
    expect(get("delegate").buildPrompt({ prompt: "do x" }, "/repo")).toBe("do x");
  });
});
