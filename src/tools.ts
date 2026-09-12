import path from "node:path";
import { z } from "zod";
import type { RunMode } from "./runner.js";

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
  dirs: z
    .array(z.string())
    .optional()
    .describe(
      "Extra directories to add to agy's workspace, for cross-repo or worktree-vs-base analysis.",
    ),
  model: z
    .string()
    .optional()
    .describe(
      'Override the model. Accepts a display name ("Gemini 3.8 Flash (High)"), an id ' +
        '("gemini-3.8-flash-high"), or a family selector ("gemini-pro@latest-high"). ' +
        "Normally omit — the tool routes automatically.",
    ),
  effort: z
    .enum(["low", "medium", "high"])
    .optional()
    .describe(
      "Reasoning tier. Gemini models carry their tier in the name, so this switches to the " +
        "sibling model at that tier (Flash (High) -> Flash (Medium)); agy's own --effort flag " +
        "only reaches models without a tier. Defaults to the user's set_model choice, else the " +
        "tool's own tier.",
    ),
  slash_commands: z
    .boolean()
    .optional()
    .describe(
      "Let agy expand your slash commands and skills into the prompt. Off by default: a " +
        "hostile file in the workspace can otherwise steer the delegated model.",
    ),
};

const structuredShape = {
  schema: z
    .string()
    .optional()
    .describe(
      "JSON Schema (as a string) constraining the answer. Returns structuredContent as well " +
        "as text. Costs noticeably more latency and tokens, so use it only when you will parse " +
        "the result.",
    ),
};

/**
 * The arguments the server itself reads to route a call, as opposed to the
 * arguments a tool turns into a prompt. Parsing against this strips everything
 * else, so no call site has to cast.
 */
export const ROUTING_ARGS = z.object({
  ...commonShape,
  ...structuredShape,
  session_id: z.string().optional(),
  write: z.boolean().optional(),
  sandbox: z.boolean().optional(),
});

type ToolSchema = z.ZodObject<z.ZodRawShape>;

/**
 * How much authority a tool's runs ask for.
 *
 * `read-only` pins `--mode plan`. Read that as a request, not a guarantee:
 * plan mode is advisory once `--dangerously-skip-permissions` is on, which is
 * the default, and it was verified against agy 1.2.1 and 1.2.2 that a plan-mode
 * run will still create files. `denied_actions` only ever populates when the
 * permission grant is off, so its absence proves nothing either.
 *
 * The proof comes from outside agy: the bridge fingerprints the working tree
 * around every plan-mode run and reports `wroteInReadOnlyMode` when the tree
 * moved. That flag, not this type, is the evidence a caller should trust.
 */
export type Privilege = "read-only" | "caller-chooses";

/** What the server does with the call, beyond turning arguments into a prompt. */
export type ToolKind = "delegate" | "fanout" | "status" | "configure";

export interface ToolDef {
  name: string;
  description: string;
  /** Full input schema. The MCP SDK validates every call against it before the handler runs. */
  schema: ToolSchema;
  /** Model preference order. Omitted when the tool has no say — `follow_up` reuses its session's model. */
  chain?: string[];
  privilege: Privilege;
  kind: ToolKind;
  /** Validates `args` against `schema`, then renders the agy prompt. */
  buildPrompt(args: unknown, cwd: string): string;
  /** Extra workspace roots this tool's own arguments imply. */
  extraDirs(args: unknown, cwd: string): string[];
  /** Absolute paths this call will hand to agy, for the allowed-roots check. */
  touchedPaths(args: unknown, cwd: string): string[];
}

export function modeFor(tool: ToolDef, write: boolean | undefined): RunMode {
  if (tool.privilege === "read-only") return "plan";
  return write ? "accept-edits" : "plan";
}

function defineTool<S extends ToolSchema>(def: {
  name: string;
  description: string;
  schema: S;
  chain?: string[];
  privilege: Privilege;
  kind?: ToolKind;
  prompt(args: z.output<S>, cwd: string): string;
  paths?(args: z.output<S>, cwd: string): string[];
}): ToolDef {
  const { prompt, paths, kind, ...rest } = def;
  const pathsOf = (args: unknown, cwd: string) => paths?.(def.schema.parse(args), cwd) ?? [];
  return {
    ...rest,
    kind: kind ?? "delegate",
    buildPrompt: (args, cwd) => prompt(def.schema.parse(args), cwd),
    extraDirs: (args, cwd) => [...new Set(pathsOf(args, cwd).map((p) => path.dirname(p)))],
    touchedPaths: pathsOf,
  };
}

export const TOOLS: ToolDef[] = [
  defineTool({
    name: "analyze_files",
    description:
      "Delegate file analysis to the Antigravity CLI (Gemini) instead of reading files yourself. " +
      "USE THIS whenever a file is large (>200 lines) or the task spans more than 3 files: " +
      "logs, database dumps, generated code, cross-file reviews, comparisons. " +
      "The files never enter your context — only the answer does.",
    schema: z.object({
      files: z
        .array(z.string())
        .min(1)
        .describe("File paths to analyze (relative to cwd or absolute)."),
      question: z.string().describe("What you want to know about these files."),
      ...commonShape,
      ...structuredShape,
    }),
    chain: ["gemini-flash@latest-high", "gemini-pro@latest-low"],
    privilege: "read-only",
    paths: (args, cwd) => resolveFiles(args.files, cwd),
    prompt(args, cwd) {
      const files = resolveFiles(args.files, cwd);
      return (
        `Read and analyze these files:\n${files.map((f) => `- ${f}`).join("\n")}\n\n` +
        `Question: ${args.question}\n\n${OUTPUT_RULES}`
      );
    },
  }),
  defineTool({
    name: "deep_search",
    description:
      "Delegate codebase archaeology to the Antigravity CLI: git log/diff/blame spelunking, " +
      "wide greps across a repo, 'when/why did X change', 'where is Y used'. " +
      "USE THIS instead of running many search commands yourself — it saves your context.",
    schema: z.object({
      query: z
        .string()
        .describe("What to find, e.g. 'when was the auth middleware refactored and why'."),
      ...commonShape,
      ...structuredShape,
    }),
    chain: ["gemini-flash@latest-high", "gemini-flash@latest-medium"],
    privilege: "read-only",
    prompt(args) {
      return (
        `Search this repository to answer the following. Use git log, git diff, git blame, ` +
        `and grep as needed.\n\nQuery: ${args.query}\n\n` +
        `Report findings with commit hashes where relevant. ${OUTPUT_RULES}`
      );
    },
  }),
  defineTool({
    name: "web_lookup",
    description:
      "Delegate a web/documentation lookup to the Antigravity CLI (Gemini with web access): " +
      "library docs, API references, error messages, current versions, external knowledge. " +
      "USE THIS when you need information you don't have or that may be newer than your training data.",
    schema: z.object({
      query: z.string().describe("What to look up on the web."),
      ...commonShape,
      ...structuredShape,
    }),
    chain: ["gemini-flash@latest-high", "gemini-flash@latest-medium"],
    privilege: "read-only",
    prompt(args) {
      return `Look up on the web: ${args.query}\n\nInclude source URLs for key claims. ${OUTPUT_RULES}`;
    },
  }),
  defineTool({
    name: "adversarial_review",
    description:
      "Get an adversarial second opinion from a different model family (Gemini Pro). " +
      "ALWAYS use this for plan critiques, design reviews, and pre-merge code review: " +
      "it hunts for flaws, edge cases, security issues, and unstated assumptions you may have missed. " +
      "Pass either `content` or `files` — a call with neither is rejected. " +
      "Pass `schema` to get ranked findings back as data instead of prose.",
    schema: z
      .object({
        content: z
          .string()
          .optional()
          .describe("Inline content to review (plan, diff, code snippet)."),
        files: z
          .array(z.string())
          .optional()
          .describe("File paths to review instead of inline content."),
        focus: z
          .string()
          .optional()
          .describe("Optional focus area, e.g. 'security', 'concurrency'."),
        ...commonShape,
        ...structuredShape,
      })
      .refine((a) => Boolean(a.content) || Boolean(a.files?.length), {
        message: "adversarial_review requires either `content` or `files`.",
      }),
    chain: ["gemini-flash@latest-high", "gemini-pro@latest-high", "claude-opus@latest"],
    privilege: "read-only",
    paths: (args, cwd) => resolveFiles(args.files ?? [], cwd),
    prompt(args, cwd) {
      const subject = args.content
        ? `Review the following:\n\n${args.content}`
        : `Read and review these files:\n${resolveFiles(args.files ?? [], cwd)
            .map((f) => `- ${f}`)
            .join("\n")}`;
      const focus = args.focus ? `\nFocus especially on: ${args.focus}.` : "";
      return (
        `You are an adversarial reviewer. Find real flaws: bugs, edge cases, security issues, ` +
        `performance traps, unstated assumptions, and simpler alternatives.${focus}\n\n${subject}\n\n` +
        `Rank findings by severity (critical/major/minor) and justify each. ` +
        `Do not pad with praise or restate the input. ${OUTPUT_RULES}`
      );
    },
  }),
  defineTool({
    name: "follow_up",
    description:
      "Continue a previous Antigravity session by session_id (returned by every other tool). " +
      "USE THIS for follow-up questions about a prior delegation — the full prior context " +
      "is already on agy's side, so you don't resend anything. Pass `model` to get a second " +
      "opinion on the same history from a different model without re-sending it. " +
      "Read-only by default; pass `write: true` to rework a delegation that edited files.",
    schema: z.object({
      session_id: z.string().describe("The session id returned by a previous claude-agy-mcp call."),
      question: z.string().describe("The follow-up question."),
      write: z
        .boolean()
        .optional()
        .describe("Allow file edits and command execution. Off by default."),
      ...commonShape,
      ...structuredShape,
    }),
    // The rework path for a write delegation runs through here, so it has to be
    // able to write. It was pinned read-only, and only appeared to work because
    // plan mode is advisory under the default permission grant.
    privilege: "caller-chooses",
    prompt(args) {
      return args.question;
    },
  }),
  defineTool({
    name: "delegate",
    description:
      "Raw delegation to the Antigravity CLI for heavy tasks that don't fit the other tools. " +
      "Read-only by default; pass `write: true` to let agy edit files, `sandbox: true` to " +
      "confine it. Anything it was refused comes back as a denied-actions note.",
    schema: z.object({
      prompt: z.string().describe("The complete task prompt for agy."),
      write: z
        .boolean()
        .optional()
        .describe("Allow file edits and command execution. Off by default."),
      sandbox: z.boolean().optional().describe("Run agy with terminal restrictions enabled."),
      ...commonShape,
      ...structuredShape,
    }),
    chain: ["gemini-flash@latest-high", "gemini-pro@latest-low"],
    privilege: "caller-chooses",
    prompt(args) {
      return args.prompt;
    },
  }),
  defineTool({
    name: "delegate_many",
    description:
      "Fan one question out to several models at once (a council, with a disagreement report), " +
      "or fan several sub-tasks out to one model. Runs behind the same concurrency cap as " +
      "everything else, so it queues rather than stampedes the shared quota.",
    schema: z
      .object({
        prompt: z.string().optional().describe("One prompt to send to every model in `models`."),
        tasks: z
          .array(z.string())
          .optional()
          .describe("Several prompts to run, each as its own delegation."),
        models: z
          .array(z.string())
          .optional()
          .describe(
            "Models to ask. Defaults to a Flash/Pro/Opus council when `prompt` is used, " +
              "and to the automatic route when `tasks` is used.",
          ),
        ...commonShape,
      })
      .refine((a) => Boolean(a.prompt) || Boolean(a.tasks?.length), {
        message: "delegate_many requires either `prompt` or `tasks`.",
      }),
    chain: ["gemini-flash@latest-high", "gemini-pro@latest-high", "claude-opus@latest"],
    privilege: "read-only",
    kind: "fanout",
    prompt(args) {
      return args.prompt ?? (args.tasks ?? []).join("\n\n");
    },
  }),
  defineTool({
    name: "set_model",
    description:
      "Choose the model and reasoning tier every tool uses from now on, on this machine. Ask the " +
      'user first — "proceed with the default, or change model or effort?" — then call this ' +
      "once: with no arguments to accept the default, or with what they chose. The choice is " +
      "saved and no tool asks again. An explicit `model` argument on a call still wins for that " +
      "call. Set AGY_ASK_MODEL=false to skip the gate and route on the built-in chains.",
    schema: z.object({
      model: z
        .string()
        .min(1)
        .optional()
        .describe(
          'The model the user chose: a display name ("Gemini 3.8 Flash (High)"), an id ' +
            '("gemini-3.8-flash-high"), or a family selector ("gemini-flash@latest-high"). ' +
            "Omit to accept the default (AGY_DEFAULT_MODEL, Gemini Flash High out of the box).",
        ),
      effort: z
        .enum(["low", "medium", "high"])
        .optional()
        .describe("The tier the user chose. Omit to take the tier the model name carries."),
    }),
    privilege: "read-only",
    kind: "configure",
    prompt() {
      return "";
    },
  }),
  defineTool({
    name: "agy_status",
    description:
      "What this bridge has spent and what it can still do: tokens by model, live quota " +
      "cooldowns, runs in flight, the resolved model chain per tool, the user's set_model " +
      "choice, the models agy offers, warm sessions, and the agy version and flags detected " +
      "at startup. Check this before a large fan-out, or to list models before set_model.",
    schema: z.object({}),
    privilege: "read-only",
    kind: "status",
    prompt() {
      return "";
    },
  }),
];

export const TOOLS_BY_NAME: ReadonlyMap<string, ToolDef> = new Map(TOOLS.map((t) => [t.name, t]));
