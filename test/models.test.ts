import { describe, it, expect } from "vitest";
import { parseModels } from "../src/models.js";

const LISTING = `Gemini 3.5 Flash (Medium)
Gemini 3.6 Flash (High)
Gemini 3.5 Flash (High)
Gemini 3.1 Pro (High)
`;

describe("parseModels", () => {
  it("returns one trimmed model per non-empty line", () => {
    expect(parseModels(LISTING)).toEqual([
      "Gemini 3.5 Flash (Medium)",
      "Gemini 3.6 Flash (High)",
      "Gemini 3.5 Flash (High)",
      "Gemini 3.1 Pro (High)",
    ]);
  });

  it("returns both the id and the display name from tab-separated listings", () => {
    const raw =
      "gemini-3.6-flash-high\tGemini 3.6 Flash (High)\n" +
      "gemini-3.1-pro-low\tGemini 3.1 Pro (Low)\n";
    expect(parseModels(raw)).toEqual([
      "gemini-3.6-flash-high",
      "Gemini 3.6 Flash (High)",
      "gemini-3.1-pro-low",
      "Gemini 3.1 Pro (Low)",
    ]);
  });

  it("strips a trailing ' (current)' marker", () => {
    expect(parseModels("Claude Opus 4.6 (Thinking) (current)\n")).toEqual([
      "Claude Opus 4.6 (Thinking)",
    ]);
  });
});
