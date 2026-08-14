import type { Config } from "./config.js";
import { runAgy, defaultDeps, type RunnerDeps } from "./runner.js";
import type { ToolDef } from "./tools.js";

interface ToolResponse {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

interface HandlerExtra {
  signal?: AbortSignal;
}

export function createToolHandler(
  tool: ToolDef,
  cfg: Config,
  deps: RunnerDeps = defaultDeps,
): (args: Record<string, unknown>, extra?: HandlerExtra) => Promise<ToolResponse> {
  return async (args, extra) => {
    try {
      const cwd = (args.cwd as string | undefined) ?? process.cwd();
      const prompt = tool.buildPrompt(args, cwd);
      const result = await runAgy(
        { prompt, cwd, model: args.model as string | undefined, signal: extra?.signal },
        cfg,
        deps,
      );
      return { content: [{ type: "text", text: result.output }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: (err as Error).message }],
        isError: true,
      };
    }
  };
}
