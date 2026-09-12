import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  carveOuts,
  confinedRoots,
  probeConfinement,
  rootAncestors,
  SANDBOX_EXEC,
  sandboxConfinement,
  sandboxProfile,
  unavailableConfinement,
} from "../src/confine.js";
import { READ_ONLY_TREE_MOVED, READ_ONLY_VIOLATION } from "../src/delegation.js";
import { commandFor } from "../src/runner.js";
import { renderDelegation } from "../src/server.js";
import { WarmSessions, WarmUnavailable, type SessionProcess } from "../src/warm.js";
import { fakeAgy, fullCaps, makeDelegator, testConfig, toolNamed } from "./support.js";

const request = (tool: string, args: Record<string, unknown>) => ({
  tool: toolNamed(tool),
  args,
  cwd: "/repo",
  timeoutSec: 3600,
});

/** Records what it was asked to wrap, without a real sandbox. */
function recordingConfinement() {
  const wrapped: string[][] = [];
  return {
    wrapped,
    confinement: {
      available: true,
      wrap: (file: string, args: string[], roots: string[]) => {
        wrapped.push(roots);
        return { file: "sandbox", args: ["--roots", ...roots, file, ...args] };
      },
    },
  };
}

describe("sandboxProfile", () => {
  it("names roots only by parameter, so no path can change the profile text", () => {
    const profile = sandboxProfile({ roots: 2, ancestors: 1, carveOuts: 1 });
    expect(profile).toContain('(deny file-write* (subpath (param "ROOT_0")))');
    expect(profile).toContain('(deny file-write* (subpath (param "ROOT_1")))');
    expect(profile).toContain('(deny file-write-unlink (literal (param "ANCESTOR_0")))');
    expect(profile).toContain("(allow default)");
    expect(profile.trimEnd().endsWith('(allow file-write* (subpath (param "CARVE_0")))')).toBe(
      true,
    );
  });

  it("passes a hostile root through -D, never into the profile", () => {
    const evil = '/tmp/x")) (allow file-write* (subpath "/etc';
    const { file, args } = sandboxConfinement().wrap("agy", ["-p", "hi"], [evil]);
    expect(file).toBe(SANDBOX_EXEC);
    const profile = args[args.indexOf("-p") + 1]!;
    expect(profile).not.toContain(evil);
    expect(args).toContain(`ROOT_0=${evil}`);
    expect(args.slice(-3)).toEqual(["agy", "-p", "hi"]);
  });
});

describe("confinedRoots", () => {
  it("keeps both the given and the resolved spelling of a symlinked root", () => {
    const base = mkdtempSync(join(tmpdir(), "confine-"));
    const real = join(base, "real");
    mkdirSync(real);
    const link = join(base, "link");
    symlinkSync(real, link);
    const roots = confinedRoots([link]);
    expect(roots).toContain(link);
    expect(roots.some((r) => r.endsWith("/real"))).toBe(true);
  });

  it("keeps a root that does not exist", () => {
    expect(confinedRoots(["/no/such/root"])).toEqual(["/no/such/root"]);
  });

  it("resolves a root that does not exist yet through its nearest existing ancestor", () => {
    const base = mkdtempSync(join(tmpdir(), "confine-"));
    const real = join(base, "real");
    mkdirSync(real);
    const link = join(base, "link");
    symlinkSync(real, link);
    const roots = confinedRoots([join(link, "not", "yet")]);
    expect(roots.some((r) => r.endsWith("/real/not/yet"))).toBe(true);
  });
});

describe("rootAncestors and carveOuts", () => {
  it("lists every directory above a root except the filesystem root", () => {
    expect(rootAncestors(["/a/b/c"]).sort()).toEqual(["/a", "/a/b"]);
  });

  it("carves out a state directory only when a root strictly contains it", () => {
    expect(carveOuts(["/home/u"], ["/home/u/.gemini"])).toEqual(["/home/u/.gemini"]);
    expect(carveOuts(["/home/u/.gemini"], ["/home/u/.gemini"])).toEqual([]);
    expect(carveOuts(["/repo"], ["/home/u/.gemini"])).toEqual([]);
  });
});

describe("probeConfinement", () => {
  it("reports unavailable off macOS without running anything", async () => {
    let ran = false;
    const c = await probeConfinement("linux", async () => {
      ran = true;
    });
    expect(c.available).toBe(false);
    expect(c.reason).toMatch(/linux/);
    expect(ran).toBe(false);
  });

  it("reports unavailable when the sandbox fails its probe, as a nested sandbox does", async () => {
    const c = await probeConfinement("darwin", async () => {
      throw new Error("sandbox_apply: Operation not permitted");
    });
    expect(c.available).toBe(false);
    expect(c.reason).toMatch(/Operation not permitted/);
  });

  it("is available when the probe runs and its write is refused", async () => {
    const c = await probeConfinement("darwin", async (_file, args) => {
      if (args.includes("/usr/bin/touch")) throw new Error("Operation not permitted");
    });
    expect(c.available).toBe(true);
  });

  it("is unavailable when the probe's write is not refused", async () => {
    const c = await probeConfinement("darwin", async () => {});
    expect(c.available).toBe(false);
    expect(c.reason).toMatch(/did not block a write/);
  });
});

describe("commandFor", () => {
  it("leaves an unconfined run alone", () => {
    expect(commandFor({ prompt: "x", cwd: "/r", timeoutSec: 1 }, "agy", ["a"], {})).toEqual({
      file: "agy",
      args: ["a"],
    });
  });

  it("refuses a confined run it cannot confine", () => {
    const req = { prompt: "x", cwd: "/r", timeoutSec: 1, confineTo: ["/r"] };
    expect(() => commandFor(req, "agy", [], {})).toThrow(/Refusing/);
    expect(() =>
      commandFor(req, "agy", [], { confinement: unavailableConfinement("nope") }),
    ).toThrow(/nope/);
  });
});

describe("Delegator read-only enforcement", () => {
  it("confines a plan-mode run against every root and says so", async () => {
    const agy = fakeAgy({ answer: "done" });
    const rec = recordingConfinement();
    const d = await makeDelegator({ spawn: agy.spawn, confinement: rec.confinement }).delegator.run(
      {
        ...request("delegate", { prompt: "x" }),
        dirs: ["/other"],
      },
    );
    expect(agy.files).toEqual(["sandbox"]);
    expect(rec.wrapped).toEqual([["/repo", "/other"]]);
    expect(d.readOnly).toEqual({ enforced: true });
  });

  it("does not confine a run allowed to write", async () => {
    const agy = fakeAgy({ answer: "done" });
    const rec = recordingConfinement();
    const d = await makeDelegator({ spawn: agy.spawn, confinement: rec.confinement }).delegator.run(
      {
        ...request("delegate", { prompt: "x" }),
        write: true,
      },
    );
    expect(agy.files).toEqual(["agy"]);
    expect(d.readOnly).toBeUndefined();
  });

  it("falls back to watching, and names why, when confinement is unavailable", async () => {
    const agy = fakeAgy({ answer: "done" });
    const d = await makeDelegator({
      spawn: agy.spawn,
      confinement: unavailableConfinement("no write confinement is implemented for linux"),
    }).delegator.run(request("delegate", { prompt: "x" }));
    expect(agy.files).toEqual(["agy"]);
    expect(d.readOnly).toEqual({
      enforced: false,
      reason: "no write confinement is implemented for linux",
    });
  });

  it("refuses an unconfinable read-only run under AGY_READ_ONLY_ENFORCEMENT=require", async () => {
    const agy = fakeAgy({ answer: "done" });
    const run = makeDelegator({
      spawn: agy.spawn,
      cfg: { readOnlyEnforcement: "require" },
      confinement: unavailableConfinement("nested sandbox"),
    }).delegator.run(request("delegate", { prompt: "x" }));
    await expect(run).rejects.toThrow(/Refusing a read-only run that cannot be confined/);
    expect(agy.runs).toEqual([]);
  });

  it("does not confine when AGY_READ_ONLY_ENFORCEMENT=off", async () => {
    const agy = fakeAgy({ answer: "done" });
    const rec = recordingConfinement();
    const d = await makeDelegator({
      spawn: agy.spawn,
      cfg: { readOnlyEnforcement: "off" },
      confinement: rec.confinement,
    }).delegator.run(request("delegate", { prompt: "x" }));
    expect(agy.files).toEqual(["agy"]);
    expect(d.readOnly?.enforced).toBe(false);
  });

  it("words a moved tree as another writer when agy was confined", async () => {
    const agy = fakeAgy({ answer: "done" });
    let i = 0;
    const d = await makeDelegator({
      spawn: agy.spawn,
      confinement: recordingConfinement().confinement,
      snapshot: async () => ({ method: "scan" as const, digest: `d${i++}` }),
    }).delegator.run(request("delegate", { prompt: "x" }));
    expect(d.wroteInReadOnlyMode).toBe(true);
    const text = renderDelegation(d, 3600, "n0nce");
    expect(text).toContain(READ_ONLY_TREE_MOVED);
    expect(text).not.toContain(READ_ONLY_VIOLATION);
    expect(text).toContain("read-only: enforced");
  });

  it("reports status of enforcement", () => {
    const status = makeDelegator({ confinement: unavailableConfinement("why") }).delegator.status();
    expect(status.readOnly).toEqual({ policy: "auto", enforced: false, reason: "why" });
  });
});

describe("WarmSessions confinement", () => {
  const cfg = { ...testConfig, warmSessions: true };
  const session = () => {
    const spawned: { file: string; args: string[] }[] = [];
    const spawnSession = (file: string, args: string[]): SessionProcess => {
      spawned.push({ file, args });
      return { write: () => {}, onData: () => {}, onExit: () => {}, kill: () => {} };
    };
    return { spawned, spawnSession };
  };

  it("starts a resident process under confinement and refuses to reuse it unconfined", async () => {
    const s = session();
    const rec = recordingConfinement();
    const warm = new WarmSessions(cfg, fullCaps, {
      spawnSession: s.spawnSession,
      confinement: rec.confinement,
    });
    void warm.turn("c1", "/repo", "q", { timeoutMs: 60_000, confineTo: ["/repo"] }).catch(() => {});
    expect(s.spawned[0]!.file).toBe("sandbox");
    await expect(warm.turn("c1", "/repo", "q2", { timeoutMs: 60_000 })).rejects.toThrow(
      WarmUnavailable,
    );
    warm.shutdown();
  });

  it("does not start a confined process it cannot confine", async () => {
    const s = session();
    const warm = new WarmSessions(cfg, fullCaps, { spawnSession: s.spawnSession });
    await expect(
      warm.turn("c1", "/repo", "q", { timeoutMs: 60_000, confineTo: ["/repo"] }),
    ).rejects.toThrow(/confinement is unavailable/);
    expect(s.spawned).toEqual([]);
  });
});

const run = (file: string, args: string[]) =>
  new Promise<{ code: number }>((resolve) =>
    execFile(file, args, (err) => resolve({ code: err ? ((err.code as number) ?? 1) : 0 })),
  );

describe.runIf(process.platform === "darwin")("the real macOS sandbox", () => {
  it("blocks writes inside a root and allows them outside it", async () => {
    const c = await probeConfinement();
    expect(c.available).toBe(true);
    const inside = mkdtempSync(join(tmpdir(), "confined-"));
    const outside = mkdtempSync(join(tmpdir(), "free-"));
    const script = `echo x > "${inside}/blocked"; mkdir "${inside}/dir"; echo y > "${outside}/allowed"`;
    const cmd = c.wrap("/bin/sh", ["-c", script], [inside]);
    await run(cmd.file, cmd.args);
    expect(existsSync(join(inside, "blocked"))).toBe(false);
    expect(existsSync(join(inside, "dir"))).toBe(false);
    expect(existsSync(join(outside, "allowed"))).toBe(true);
  });

  it("blocks moving the tree out from under a root by renaming an ancestor", async () => {
    const c = await probeConfinement();
    const base = realpathSync(mkdtempSync(join(tmpdir(), "confined-rename-")));
    const root = join(base, "parent", "root");
    mkdirSync(root, { recursive: true });
    const script = `mv "${base}/parent" "${base}/moved" && echo x > "${base}/moved/root/escaped"; mv "${base}/moved" "${base}/parent"`;
    const cmd = c.wrap("/bin/sh", ["-c", script], [root]);
    await run(cmd.file, cmd.args);
    expect(existsSync(join(root, "escaped"))).toBe(false);
    expect(existsSync(join(base, "moved"))).toBe(false);
  });

  it("blocks a root that does not exist yet behind a symlinked parent", async () => {
    const c = await probeConfinement();
    const base = mkdtempSync(join(tmpdir(), "confined-new-"));
    const real = join(base, "real");
    mkdirSync(real);
    symlinkSync(real, join(base, "link"));
    const root = join(base, "link", "new");
    const cmd = c.wrap("/bin/sh", ["-c", `mkdir -p "${root}" && echo x > "${root}/f"`], [root]);
    await run(cmd.file, cmd.args);
    expect(existsSync(join(real, "new", "f"))).toBe(false);
  });

  it("keeps a state directory inside a root writable", async () => {
    const root = mkdtempSync(join(tmpdir(), "confined-home-"));
    const state = join(root, ".gemini");
    mkdirSync(state);
    const cmd = sandboxConfinement([state]).wrap(
      "/bin/sh",
      ["-c", `echo x > "${state}/ok"; echo x > "${root}/blocked"`],
      [root],
    );
    await run(cmd.file, cmd.args);
    expect(existsSync(join(state, "ok"))).toBe(true);
    expect(existsSync(join(root, "blocked"))).toBe(false);
  });

  it("blocks a write that reaches the root through a symlinked spelling", async () => {
    const c = await probeConfinement();
    const base = mkdtempSync(join(tmpdir(), "confined-link-"));
    const real = join(base, "real");
    mkdirSync(real);
    const link = join(base, "link");
    symlinkSync(real, link);
    const cmd = c.wrap(
      "/bin/sh",
      ["-c", `echo x > "${real}/viaReal"; echo x > "${link}/viaLink"`],
      [link],
    );
    await run(cmd.file, cmd.args);
    expect(existsSync(join(real, "viaReal"))).toBe(false);
    expect(existsSync(join(real, "viaLink"))).toBe(false);
  });
});
