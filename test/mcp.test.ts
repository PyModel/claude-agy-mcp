import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer, VERSION } from "../src/server.js";
import { TOOLS } from "../src/tools.js";

/**
 * Protocol-level checks: what an MCP client actually sees. These never reach agy
 * — listing does not run a tool, and a schema violation is rejected before any
 * process is spawned.
 */
const textOf = (res: unknown) => JSON.stringify((res as { content: unknown }).content);

describe("the server over MCP", () => {
  let client: Client;

  beforeAll(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test", version: "0" });
    await Promise.all([createServer().connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(() => client.close());

  it("advertises every tool with its version", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS.map((t) => t.name).sort());
    expect(client.getServerVersion()?.version).toBe(VERSION);
  });

  it("publishes a JSON Schema for a tool whose schema carries a cross-field rule", async () => {
    const { tools } = await client.listTools();
    const schema = tools.find((t) => t.name === "adversarial_review")!.inputSchema;
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
      "content",
      "cwd",
      "files",
      "focus",
      "model",
    ]);
    // Every field is individually optional; the rule is what makes {} invalid.
    expect(schema.required ?? []).toEqual([]);
  });

  it("rejects a call that violates the cross-field rule as invalid params", async () => {
    const res = await client.callTool({ name: "adversarial_review", arguments: {} });
    expect(res.isError).toBe(true);
    // Only the field names are ours; the surrounding wording is the SDK's and Zod's.
    expect(textOf(res)).toMatch(/content.*files/is);
  });

  it("rejects a call missing a required field as invalid params", async () => {
    const res = await client.callTool({
      name: "analyze_files",
      arguments: { question: "q" },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/files/i);
  });
});
