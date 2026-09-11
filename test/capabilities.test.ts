import { describe, it, expect } from "vitest";
import {
  degradedCapabilities,
  parseFlags,
  parseVersion,
  probeCapabilities,
  WANTED_FLAGS,
} from "../src/capabilities.js";

const HELP = `Usage of agy:
  --add-dir                       Add a directory to the workspace (repeatable)
  --conversation                  Resume a previous conversation by ID
  --dangerously-skip-permissions  Auto-approve all tool permission requests
  --disable-slash-commands        Disable slash command and skill expansion
  --effort                        Reasoning effort (low|medium|high)
  --input-format                  Input format for print mode (text, stream-json)
  --json-schema                   Optional JSON schema string
  --log-file                      Override CLI log file path
  --mode                          Set the agent execution mode
  --output-format                 Output format for print mode
  --print-timeout                 Timeout for print mode wait
  --sandbox                       Run in a sandbox
`;

describe("parseFlags", () => {
  it("collects every long flag agy advertises", () => {
    const flags = parseFlags(HELP);
    expect(flags.has("--output-format")).toBe(true);
    expect(flags.has("--json-schema")).toBe(true);
    expect(flags.has("--nonsense")).toBe(false);
  });
});

describe("parseVersion", () => {
  it("takes the first line", () => {
    expect(parseVersion("1.2.0\n")).toBe("1.2.0");
  });
});

describe("probeCapabilities", () => {
  it("reports nothing missing when agy advertises everything the bridge uses", async () => {
    const caps = await probeCapabilities("agy", async (args) =>
      args[0] === "--version" ? "1.2.0\n" : HELP,
    );
    expect(caps.version).toBe("1.2.0");
    expect(caps.missing).toEqual([]);
    expect(caps.has("--mode")).toBe(true);
  });

  it("names the flags an older agy lacks instead of failing", async () => {
    const caps = await probeCapabilities("agy", async (args) =>
      args[0] === "--version" ? "1.0.0\n" : "Usage of agy:\n  --add-dir  x\n  --log-file  y\n",
    );
    expect(caps.missing).toContain("--output-format");
    expect(caps.has("--add-dir")).toBe(true);
  });

  it("degrades to the always-present flags when the probe itself fails", async () => {
    const caps = await probeCapabilities("agy", () => Promise.reject(new Error("no agy")));
    expect(caps.version).toMatch(/unknown/);
    expect(caps.has("--print-timeout")).toBe(true);
    expect(caps.has("--output-format")).toBe(false);
  });

  it("degrades when --help produces no flags at all", async () => {
    const caps = await probeCapabilities("agy", async () => "");
    expect(caps.version).toMatch(/no flags/);
  });
});

describe("degradedCapabilities", () => {
  it("claims only flags that predate --output-format", () => {
    const caps = degradedCapabilities("test");
    for (const flag of WANTED_FLAGS) {
      if (["--print-timeout", "--log-file", "--add-dir", "--conversation"].includes(flag)) continue;
      expect(caps.has(flag)).toBe(false);
    }
  });
});
