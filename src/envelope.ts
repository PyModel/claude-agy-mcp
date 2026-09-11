/**
 * The JSON envelope agy prints under `--output-format json`, and the NDJSON
 * events it prints under `--output-format stream-json`.
 *
 * agy writes human-readable error text to stdout *before* the envelope on a
 * startup failure, so the envelope is found by scanning stdout backwards for
 * the last line that parses as a JSON object carrying a `status` field.
 */

export interface AgyUsage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  /** agy's own total. Not the sum of the fields above — cache_read is reported separately. */
  totalTokens: number;
}

/** One tool action agy wanted to take and was not permitted to. */
export interface DeniedAction {
  action: string;
  displayName: string;
}

export interface AgyEnvelope {
  /** Empty string in agy's output when the run never started; normalised to undefined. */
  conversationId?: string;
  /** "SUCCESS" | "ERROR" observed; treated as an open set. */
  status: string;
  response: string;
  error?: string;
  numTurns: number;
  durationSeconds: number;
  usage: AgyUsage;
  /** Always an array, empty when agy omitted the field. */
  deniedActions: DeniedAction[];
  /** Present only when the run was given a --json-schema. */
  structuredOutput?: unknown;
}

export const EMPTY_USAGE: AgyUsage = {
  inputTokens: 0,
  outputTokens: 0,
  thinkingTokens: 0,
  cacheReadTokens: 0,
  totalTokens: 0,
};

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function usageOf(raw: unknown): AgyUsage {
  const u = (raw ?? {}) as Record<string, unknown>;
  return {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    thinkingTokens: num(u.thinking_tokens),
    cacheReadTokens: num(u.cache_read_tokens),
    totalTokens: num(u.total_tokens),
  };
}

function deniedOf(raw: unknown): DeniedAction[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((d) => {
    const o = (d ?? {}) as Record<string, unknown>;
    return { action: str(o.action), displayName: str(o.display_name) || str(o.action) };
  });
}

/** Shapes a decoded JSON object into an envelope, or null if it isn't one. */
function shape(o: Record<string, unknown>): AgyEnvelope | null {
  if (typeof o.status !== "string") return null;
  const conversationId = str(o.conversation_id);
  return {
    ...(conversationId ? { conversationId } : {}),
    status: o.status,
    response: str(o.response),
    ...(str(o.error) ? { error: str(o.error) } : {}),
    numTurns: num(o.num_turns),
    durationSeconds: num(o.duration_seconds),
    usage: usageOf(o.usage),
    deniedActions: deniedOf(o.denied_actions),
    ...(o.structured_output !== undefined ? { structuredOutput: o.structured_output } : {}),
  };
}

function decodeObject(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const v: unknown = JSON.parse(trimmed);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The envelope in `stdout`, or null when agy produced none (a crash before the
 * envelope, or a version without --output-format).
 *
 * Under `json` the envelope is the top-level object; under `stream-json` it is
 * the `result` field of the final `{"event":"result"}` line. Both are accepted,
 * so the runner reads one shape whichever format it asked for. Only call this
 * for output that was requested in one of those formats: a text-mode answer
 * that happens to contain a JSON line with a `status` field would pass for one.
 */
export function parseEnvelope(stdout: string): AgyEnvelope | null {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const o = decodeObject(lines[i]!);
    if (!o) continue;
    const env = str(o.event) === "result" ? resultEnvelope(o) : shape(o);
    if (env) return env;
  }
  return null;
}

function resultEnvelope(o: Record<string, unknown>): AgyEnvelope | null {
  const r = o.result;
  return typeof r === "object" && r !== null ? shape(r as Record<string, unknown>) : null;
}

/** One NDJSON line from --output-format stream-json. */
export type StreamEvent =
  | {
      kind: "init";
      conversationId?: string;
      cwd?: string;
      tools: string[];
      permissionMode?: string;
    }
  | {
      kind: "step";
      stepIndex: number;
      state: string;
      stepType: string;
      textDelta: string;
      usage?: AgyUsage;
    }
  | { kind: "result"; envelope: AgyEnvelope }
  | { kind: "other"; event: string };

function streamEvent(o: Record<string, unknown>): StreamEvent | null {
  const event = str(o.event);
  if (!event) return null;
  if (event === "init") {
    const init = (o.init ?? {}) as Record<string, unknown>;
    const conversationId = str(o.conversation_id) || str(init.conversation_id);
    return {
      kind: "init",
      ...(conversationId ? { conversationId } : {}),
      ...(str(init.cwd) ? { cwd: str(init.cwd) } : {}),
      tools: Array.isArray(init.tools)
        ? init.tools.filter((t): t is string => typeof t === "string")
        : [],
      ...(str(init.permission_mode) ? { permissionMode: str(init.permission_mode) } : {}),
    };
  }
  if (event === "step_update") {
    const s = (o.step_update ?? {}) as Record<string, unknown>;
    return {
      kind: "step",
      stepIndex: num(s.step_index),
      state: str(s.state),
      stepType: str(s.step_type),
      textDelta: str(s.text_delta),
      ...(s.usage ? { usage: usageOf(s.usage) } : {}),
    };
  }
  if (event === "result") {
    const env = resultEnvelope(o);
    return env ? { kind: "result", envelope: env } : null;
  }
  return { kind: "other", event };
}

/**
 * Decodes whole NDJSON lines, returning the events and the unconsumed remainder
 * so a caller can feed it growing output without splitting a line in half.
 */
export function parseStreamEvents(chunk: string): { events: StreamEvent[]; rest: string } {
  const lines = chunk.split("\n");
  const rest = lines.pop() ?? "";
  const events: StreamEvent[] = [];
  for (const line of lines) {
    const o = decodeObject(line);
    const ev = o && streamEvent(o);
    if (ev) events.push(ev);
  }
  return { events, rest };
}
