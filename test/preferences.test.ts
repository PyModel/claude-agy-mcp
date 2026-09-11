import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { configDir, FilePreferenceStore } from "../src/preferences.js";

describe("FilePreferenceStore", () => {
  const dir = () => mkdtempSync(path.join(tmpdir(), "agy-prefs-"));

  it("round-trips the choice through disk", () => {
    const store = new FilePreferenceStore(dir());
    expect(store.load()).toBeNull();
    store.save({ model: "Gemini 3.8 Flash (High)", effort: "high", setAt: "2026-09-11T00:00:00Z" });
    expect(new FilePreferenceStore(path.dirname(fileOf(store))).load()).toEqual({
      model: "Gemini 3.8 Flash (High)",
      effort: "high",
      setAt: "2026-09-11T00:00:00Z",
    });
  });

  it("treats a corrupt or model-less file as no choice", () => {
    const d = dir();
    writeFileSync(path.join(d, "preferences.json"), "{not json");
    expect(new FilePreferenceStore(d).load()).toBeNull();
    writeFileSync(path.join(d, "preferences.json"), JSON.stringify({ effort: "high" }));
    expect(new FilePreferenceStore(d).load()).toBeNull();
  });

  it("drops an effort it does not recognise rather than passing it to agy", () => {
    const d = dir();
    writeFileSync(path.join(d, "preferences.json"), JSON.stringify({ model: "M", effort: "max" }));
    expect(new FilePreferenceStore(d).load()).toEqual({ model: "M", setAt: "" });
  });

  it("lives under XDG_CONFIG_HOME when set", () => {
    expect(configDir({ XDG_CONFIG_HOME: "/x" })).toBe(path.join("/x", "claude-agy-mcp"));
    expect(configDir({})).toContain(path.join(".config", "claude-agy-mcp"));
  });
});

function fileOf(store: FilePreferenceStore): string {
  return (store as unknown as { file: string }).file;
}
