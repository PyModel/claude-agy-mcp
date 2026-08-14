import type { Config } from "./config.js";
import { ModelRegistry } from "./models.js";
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
  registry: ModelRegistry,
  deps: RunnerDeps = defaultDeps,
): (args: Record<string, unknown>, extra?: HandlerExtra) => Promise<ToolResponse> {
  return async (args, extra) => {
    try {
      const cwd = (args.cwd as string | undefined) ?? process.cwd();
      const conversationId = args.session_id as string | undefined;
      const prompt = tool.buildPrompt(args, cwd);
      const timeoutSec =
        cfg.perToolTimeouts[tool.name] ??
        (cfg.timeoutExplicit ? cfg.timeoutSec : cfg.maxRuntimeSec);

      const resolution = conversationId
        ? { models: [undefined], note: undefined }
        : await registry.resolveChain({
            explicit: args.model as string | undefined,
            chain: tool.chain,
            defaultModel: cfg.defaultModel,
          });

      const result = await runAgy(
        {
          prompt,
          cwd,
          model: resolution.models[0],
          conversationId,
          timeoutSec,
          signal: extra?.signal,
        },
        cfg,
        deps,
      );
      return { content: [{ type: "text", text: result.output }] };
    } catch (err) {
      let text = (err as Error).message;
      if (cfg.onFailure === "strict") {
        text +=
          "\n\n[claude-agy-mcp strict mode] Delegation failed. Do NOT perform this work yourself " +
          "in the main context — report the failure to the user and let them decide how to proceed.";
      }
      return {
        content: [{ type: "text", text }],
        isError: true,
      };
    }
  };
}
