import path from "node:path";
import { z } from "zod";

const OUTPUT_RULES =
  "Answer directly with no preamble or closing remarks. Be thorough but concise. " +
  "Cite file:line for every code-level finding.";

export function resolveFiles(files: string[], cwd: string): string[] {
  return files.map((f) => (path.isAbsolute(f) ? f : path.resolve(cwd, f)));
}

const commonShape = {
  cwd: z
    .string()
    .optional()
    .describe(
      "Absolute path to the working directory / project root. Defaults to the server's cwd.",
    ),
  model: z
    .string()
    .optional()
    .describe(
      'Override the model (exact name from `agy models`, e.g. "Gemini 3.1 Pro (High)"). ' +
        "Normally omit — the tool routes automatically.",
    ),
};

export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  chain: string[];
  buildPrompt(args: Record<string, unknown>, cwd: string): string;
}

export const TOOLS: ToolDef[] = [];
