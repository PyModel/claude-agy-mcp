import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const SKILLS = path.join(import.meta.dirname, "..", "skills");
const names = readdirSync(SKILLS, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

/**
 * The package ships these, so a malformed one reaches users as a broken install
 * rather than a failing build. The installer parses the same frontmatter.
 */
describe("bundled skills", () => {
  it("ships at least the delegation routing skill and the delegate workflow", () => {
    expect(names).toContain("agy-delegate");
    expect(names).toContain("agy-delegation");
  });

  it.each(names)("%s has parseable frontmatter with a name and description", (name) => {
    const file = path.join(SKILLS, name, "SKILL.md");
    expect(existsSync(file), `${name}/SKILL.md must exist`).toBe(true);
    const text = readFileSync(file, "utf8");
    expect(text.startsWith("---\n"), "must open with YAML frontmatter").toBe(true);
    const end = text.indexOf("\n---", 4);
    expect(end).toBeGreaterThan(0);
    const front = text.slice(4, end);
    expect(front).toMatch(/^name:\s*\S+/m);
    expect(front).toMatch(/^description:\s*\S/m);
    // The directory is the skill's address for every agent that loads it.
    expect(/^name:\s*(\S+)/m.exec(front)?.[1]).toBe(name);
  });

  it.each(names)("%s references only files it actually ships", (name) => {
    const dir = path.join(SKILLS, name);
    const text = readFileSync(path.join(dir, "SKILL.md"), "utf8");
    for (const [, rel] of text.matchAll(/\]\((references\/[^)]+|scripts\/[^)]+)\)/g)) {
      expect(existsSync(path.join(dir, rel)), `${name} links missing ${rel}`).toBe(true);
    }
  });
});

const run = promisify(execFile);
const INSTALLER = path.join(import.meta.dirname, "..", "scripts", "install-skills.mjs");

/**
 * The installer replaces a skill directory outright. A symlink there means the
 * user pointed that skill at a checkout they edit, so replacing it would cut
 * their source of truth loose without saying so — the same silent-clobber class
 * the bridge's own release notes warn about.
 */
describe("install-skills", () => {
  it("refuses to replace a symlinked skill, and replaces it under --force", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agy-skills-"));
    const linked = path.join(dir, "agy-delegate");
    symlinkSync(path.join(SKILLS, "agy-delegate"), linked, "dir");

    const guarded = await run(process.execPath, [INSTALLER, "--dir", dir]);
    expect(guarded.stdout).toContain("skipped agy-delegate");
    expect(lstatSync(linked).isSymbolicLink()).toBe(true);

    const forced = await run(process.execPath, [INSTALLER, "--dir", dir, "--force"]);
    expect(forced.stdout).toContain("installed agy-delegate");
    expect(lstatSync(linked).isSymbolicLink()).toBe(false);
  });

  it("installs every bundled skill into a directory that has none", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agy-skills-"));
    const { stdout } = await run(process.execPath, [INSTALLER, "--dir", dir]);
    for (const name of names) {
      expect(stdout).toContain(`installed ${name}`);
      expect(existsSync(path.join(dir, name, "SKILL.md"))).toBe(true);
    }
  });
});

/**
 * The bin is a package selection, not a subcommand, and v3.0.0 documented it
 * both wrong ways: `npx @pymodel/claude-agy-mcp-install-skills` is a package
 * name to npx and 404s, and `npx @pymodel/claude-agy-mcp install-skills` starts
 * the stdio server with a stray argument and hangs.
 */
describe("documented install command", () => {
  const ROOT = path.join(import.meta.dirname, "..");
  const WORKING = "npx --package @pymodel/claude-agy-mcp claude-agy-mcp-install-skills";

  /** Invocations only: prose naming the broken forms as broken is allowed. */
  const invocations = (rel: string) =>
    readFileSync(path.join(ROOT, rel), "utf8")
      .split("\n")
      .map((line) => line.replace(/^\s*\*?\s*/, ""))
      .filter((line) => line.startsWith("npx") && line.includes("install-skills"));

  it.each(["README.md", "scripts/install-skills.mjs"])("%s never invokes a broken form", (rel) => {
    for (const line of invocations(rel)) {
      expect(line).not.toMatch(/^npx\s+(?:-y\s+)?@pymodel\/claude-agy-mcp-install-skills/);
      expect(line).not.toMatch(/^npx\s+(?:-y\s+)?@pymodel\/claude-agy-mcp\s+install-skills/);
    }
  });

  it("documents the working form, and the bin it names exists", () => {
    expect(readFileSync(path.join(ROOT, "README.md"), "utf8")).toContain(WORKING);
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    expect(pkg.bin["claude-agy-mcp-install-skills"]).toBe("scripts/install-skills.mjs");
  });
});
