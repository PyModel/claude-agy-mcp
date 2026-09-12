import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { VERSION } from "../src/server.js";
import { TOOLS } from "../src/tools.js";

/**
 * The built server over real stdio, driving a fake agy executable. Unit tests
 * swap the spawn seam; this suite proves what they cannot: the bundle starts,
 * speaks JSON-RPC on stdout without pollution, reaps the processes it spawns,
 * and exits when its client goes away.
 */
const ROOT = path.join(import.meta.dirname, "..");
const SERVER = path.join(ROOT, "dist", "index.js");
const FAKE_AGY = path.join(ROOT, "test", "fixtures", "fake-agy.mjs");

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

function sandbox() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "agy-e2e-")));
  const pids = path.join(dir, "pids");
  const work = path.join(dir, "work");
  execFileSync("mkdir", ["-p", pids, work]);
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    // Inherited from an agent host, this depth would make the server refuse to
    // delegate at all; the suite is the top of its own chain.
    AGY_DELEGATION_DEPTH: "0",
    AGY_PATH: FAKE_AGY,
    AGY_ASK_MODEL: "false",
    AGY_WARM_SESSIONS: "false",
    XDG_CONFIG_HOME: path.join(dir, "config"),
    XDG_CACHE_HOME: path.join(dir, "cache"),
    FAKE_AGY_PIDS: pids,
  };
  const agyPids = () => readdirSync(pids).map(Number);
  return { dir, work, env, agyPids };
}

const textOf = (res: unknown): string =>
  ((res as { content: { text: string }[] }).content ?? []).map((c) => c.text).join("\n");

describe("the built server over stdio", () => {
  beforeAll(() => {
    // Always rebuild: a stale bundle would let this suite pass against old code.
    execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "ignore" });
  }, 60_000);

  const clients: Client[] = [];
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
  });

  async function connect(env: Record<string, string>): Promise<Client> {
    const client = new Client({ name: "e2e", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [SERVER],
        env,
        stderr: "ignore",
      }),
    );
    clients.push(client);
    return client;
  }

  it("handshakes with the package version and lists every tool", async () => {
    const client = await connect(sandbox().env);
    expect(client.getServerVersion()?.version).toBe(VERSION);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS.map((t) => t.name).sort());
  });

  it("delegates, then continues the same session without a resume warning", async () => {
    const s = sandbox();
    const client = await connect(s.env);
    const first = await client.callTool({
      name: "delegate",
      arguments: { prompt: "say hello", cwd: s.work },
    });
    expect(first.isError).toBeFalsy();
    expect(textOf(first)).toContain("session: conv-e2e-1");

    const next = await client.callTool({
      name: "follow_up",
      arguments: { session_id: "conv-e2e-1", question: "and again", cwd: s.work },
    });
    expect(next.isError).toBeFalsy();
    expect(textOf(next)).not.toContain("SESSION NOT RESUMED");
  });

  it("warns when agy answers a follow_up from a different conversation", async () => {
    const s = sandbox();
    const client = await connect(s.env);
    const res = await client.callTool({
      name: "follow_up",
      arguments: { session_id: "never-issued", question: "@@FORK", cwd: s.work },
    });
    expect(textOf(res)).toContain("SESSION NOT RESUMED");
    expect(textOf(res)).toContain("never-issued");
    expect(textOf(res)).toContain("forked-new");
  });

  it("names a missing working directory, not a missing agy", async () => {
    const s = sandbox();
    const client = await connect(s.env);
    const res = await client.callTool({
      name: "delegate",
      arguments: { prompt: "hi", cwd: path.join(s.dir, "does-not-exist") },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/does-not-exist/);
    expect(textOf(res)).not.toMatch(/agy CLI not found/);
  });

  it("reports a missing agy binary as not installed", async () => {
    const s = sandbox();
    const client = await connect({ ...s.env, AGY_PATH: path.join(s.dir, "no-agy-here") });
    const res = await client.callTool({
      name: "delegate",
      arguments: { prompt: "hi", cwd: s.work },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/agy CLI not found/);
  });

  it("refuses a working directory outside AGY_ALLOWED_ROOTS before spawning", async () => {
    const s = sandbox();
    const client = await connect({ ...s.env, AGY_ALLOWED_ROOTS: s.work });
    const res = await client.callTool({
      name: "delegate",
      arguments: { prompt: "@@SLEEP", cwd: s.dir },
    });
    expect(res.isError).toBe(true);
    expect(s.agyPids()).toEqual([]);
  });

  it("refuses a prompt agy would parse as a flag", async () => {
    const s = sandbox();
    const client = await connect(s.env);
    const res = await client.callTool({
      name: "delegate",
      arguments: { prompt: "--version", cwd: s.work },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/starts with '-'/);
  });

  it("kills agy when the client cancels the call, even one that ignores SIGTERM", async () => {
    const s = sandbox();
    const client = await connect(s.env);
    const abort = new AbortController();
    const call = client
      .callTool({ name: "delegate", arguments: { prompt: "@@SLEEP", cwd: s.work } }, undefined, {
        signal: abort.signal,
      })
      .catch((e: Error) => e);
    expect(await until(() => s.agyPids().length === 1, 10_000)).toBe(true);
    abort.abort();
    expect(await call).toBeInstanceOf(Error);
    const [pid] = s.agyPids();
    expect(await until(() => !alive(pid!), 15_000)).toBe(true);
  }, 30_000);

  describe("when the client goes away mid-run", () => {
    let server: ChildProcess | undefined;
    afterEach(() => {
      if (server?.pid && alive(server.pid)) server.kill("SIGKILL");
    });

    /** Handshake by hand, so the test controls exactly how the pipe closes. */
    async function startRaw(env: Record<string, string>, work: string) {
      const child = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "ignore"] });
      server = child;
      let out = "";
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      const send = (msg: object) => child.stdin.write(`${JSON.stringify(msg)}\n`);
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "raw", version: "0" },
        },
      });
      expect(await until(() => out.includes('"id":1'), 10_000)).toBe(true);
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "delegate", arguments: { prompt: "@@SLEEP", cwd: work } },
      });
      // Every line on stdout must be JSON-RPC: anything else corrupts the stream.
      for (const line of out.split("\n").filter(Boolean))
        expect(() => JSON.parse(line)).not.toThrow();
      return child;
    }

    it("exits and reaps agy when stdin closes", async () => {
      const s = sandbox();
      const child = await startRaw(s.env, s.work);
      expect(await until(() => s.agyPids().length === 1, 10_000)).toBe(true);
      child.stdin.end();
      expect(await until(() => child.exitCode !== null || child.signalCode !== null, 15_000)).toBe(
        true,
      );
      const [pid] = s.agyPids();
      expect(await until(() => !alive(pid!), 5_000)).toBe(true);
    }, 40_000);

    it("reaps agy when the server is sent SIGTERM", async () => {
      const s = sandbox();
      const child = await startRaw(s.env, s.work);
      expect(await until(() => s.agyPids().length === 1, 10_000)).toBe(true);
      child.kill("SIGTERM");
      expect(await until(() => child.exitCode !== null || child.signalCode !== null, 10_000)).toBe(
        true,
      );
      const [pid] = s.agyPids();
      expect(await until(() => !alive(pid!), 5_000)).toBe(true);
    }, 30_000);
  });
});
