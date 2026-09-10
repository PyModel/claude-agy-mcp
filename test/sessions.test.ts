import { describe, it, expect } from "vitest";
import { sessionFor, SESSIONS_FILE } from "../src/sessions.js";

describe("sessionFor", () => {
  it("returns the session agy recorded for the cwd", async () => {
    const r = await sessionFor("/repo", async () => JSON.stringify({ "/repo": "sess-42" }));
    expect(r).toBe("sess-42");
  });

  it("matches a key agy stored with a trailing slash", async () => {
    const r = await sessionFor("/tmp/proj", async () =>
      JSON.stringify({ "/tmp/proj/": "sess-slash" }),
    );
    expect(r).toBe("sess-slash");
  });

  it("returns undefined when the cwd has no entry", async () => {
    const r = await sessionFor("/repo", async () => JSON.stringify({ "/elsewhere": "sess-1" }));
    expect(r).toBeUndefined();
  });

  it("returns undefined when the cache is unreadable", async () => {
    const r = await sessionFor("/repo", async () => {
      throw new Error("no file");
    });
    expect(r).toBeUndefined();
  });

  it("returns undefined when the cache is not valid JSON", async () => {
    expect(await sessionFor("/repo", async () => "not json")).toBeUndefined();
  });

  it("points at agy's conversation cache", () => {
    expect(SESSIONS_FILE).toMatch(/\.gemini\/antigravity-cli\/cache\/last_conversations\.json$/);
  });
});
