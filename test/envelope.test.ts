import { describe, it, expect } from "vitest";
import { parseEnvelope, parseStreamEvents } from "../src/envelope.js";
import { DENIED_ENVELOPE, ERROR_ENVELOPE, SUCCESS_ENVELOPE, STREAM_NDJSON } from "./fixtures.js";

describe("parseEnvelope", () => {
  it("reads the fields a caller decides on", () => {
    const env = parseEnvelope(SUCCESS_ENVELOPE)!;
    expect(env).toMatchObject({
      conversationId: "2c324c36-e9e0-4c15-9202-2097d9d83d35",
      status: "SUCCESS",
      response: "OK\n",
      numTurns: 1,
      deniedActions: [],
    });
    expect(env.usage.totalTokens).toBe(8205);
  });

  it("surfaces denied actions from a run that still reported SUCCESS", () => {
    const env = parseEnvelope(DENIED_ENVELOPE)!;
    expect(env.status).toBe("SUCCESS");
    expect(env.response).not.toBe("");
    expect(env.deniedActions).toEqual([{ action: "command", displayName: "RunCommand" }]);
  });

  it("finds the envelope even though agy prints human error text before it", () => {
    const env = parseEnvelope(ERROR_ENVELOPE)!;
    expect(env.status).toBe("ERROR");
    expect(env.error).toMatch(/invalid model selection/);
    expect(env.conversationId).toBeUndefined(); // agy sends "", not a real id
  });

  it("returns null for text-mode output so the caller can degrade", () => {
    expect(parseEnvelope("just a plain answer\n")).toBeNull();
    expect(parseEnvelope("")).toBeNull();
  });

  it("ignores JSON that is not an envelope", () => {
    expect(parseEnvelope('{"hello":"world"}')).toBeNull();
  });
});

describe("parseStreamEvents", () => {
  it("decodes init, step and result events and holds back a partial line", () => {
    const { events, rest } = parseStreamEvents(STREAM_NDJSON + '{"event":"par');
    expect(rest).toBe('{"event":"par');
    expect(events.map((e) => e.kind)).toEqual(["init", "step", "step", "step", "result"]);

    const init = events[0]!;
    if (init.kind !== "init") throw new Error("expected init");
    expect(init.permissionMode).toBe("request-review");
    expect(init.tools).toContain("run_command");

    const result = events.at(-1)!;
    if (result.kind !== "result") throw new Error("expected result");
    expect(result.envelope.response).toBe("OK\n");
  });

  it("accumulates text deltas across step events", () => {
    const { events } = parseStreamEvents(STREAM_NDJSON);
    const text = events
      .filter((e) => e.kind === "step")
      .map((e) => (e.kind === "step" ? e.textDelta : ""))
      .join("");
    expect(text).toBe("OK\n");
  });
});
