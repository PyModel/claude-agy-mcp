import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

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
