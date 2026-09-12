#!/usr/bin/env node
/**
 * Installs the skills bundled with claude-agy-mcp into an agent's skills directory.
 *
 * The MCP server gives an agent the *tools*; a skill tells it when and how to
 * use them. Shipping both in one package means installing the server is enough,
 * instead of asking every user to find and vendor the skill separately.
 *
 *   npx @pymodel/claude-agy-mcp install-skills            # detected agents
 *   npx @pymodel/claude-agy-mcp install-skills --dir DIR  # an explicit directory
 *   npx @pymodel/claude-agy-mcp install-skills --list     # show what would happen
 */
import { cp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(HERE, "..", "skills");

/**
 * Where the agents on this machine keep skills.
 *
 * Only directories that already exist are written to: creating `~/.claude` for
 * someone who does not use Claude Code would be litter, not installation.
 */
const TARGETS = [
  { name: "Claude Code", dir: path.join(homedir(), ".claude", "skills") },
  { name: "agents hub", dir: path.join(homedir(), ".agents", "skills") },
  { name: "Pi", dir: path.join(homedir(), ".pi", "agent", "skills") },
  { name: "zcode", dir: path.join(homedir(), ".zcode", "skills") },
];

async function isDir(p) {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** The skills this package ships, read from disk rather than hardcoded. */
async function bundledSkills() {
  const names = (await readdir(SOURCE, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  return Promise.all(
    names.map(async (name) => {
      const text = await readFile(path.join(SOURCE, name, "SKILL.md"), "utf8");
      const described = /^description:\s*(?:>-\s*)?([\s\S]*?)(?=\n\w+:|\n---)/m.exec(text);
      const summary = (described?.[1] ?? "").replace(/\s+/g, " ").trim();
      return { name, summary: summary.slice(0, 100) };
    }),
  );
}

async function install(skill, parent) {
  const dest = path.join(parent, skill.name);
  // Replace rather than merge: a half-updated skill whose SKILL.md is new and
  // whose references are stale is worse than either version on its own.
  await rm(dest, { recursive: true, force: true });
  await mkdir(parent, { recursive: true });
  await cp(path.join(SOURCE, skill.name), dest, { recursive: true });
  return dest;
}

const args = process.argv.slice(2);
const explicit = args.includes("--dir") ? args[args.indexOf("--dir") + 1] : undefined;
const listOnly = args.includes("--list");

const skills = await bundledSkills();
if (listOnly) {
  console.log("Skills bundled with claude-agy-mcp:\n");
  for (const s of skills) console.log(`  ${s.name}\n    ${s.summary}\n`);
}

const targets = explicit
  ? [{ name: "explicit", dir: path.resolve(explicit) }]
  : (await Promise.all(TARGETS.map(async (t) => ((await isDir(t.dir)) ? t : null)))).filter(
      Boolean,
    );

if (listOnly) {
  console.log(
    targets.length
      ? `Would install into:\n${targets.map((t) => `  ${t.dir} (${t.name})`).join("\n")}`
      : "No agent skills directory found. Pass --dir to name one.",
  );
  process.exit(0);
}

if (!targets.length) {
  console.error(
    "No agent skills directory found on this machine.\n" +
      "Pass --dir <path> to install somewhere explicitly, or --list to see what is bundled.",
  );
  process.exit(1);
}

let failed = false;
for (const target of targets) {
  for (const skill of skills) {
    try {
      console.log(`installed ${skill.name} -> ${await install(skill, target.dir)}`);
    } catch (err) {
      failed = true;
      console.error(`failed ${skill.name} -> ${target.dir}: ${err.message}`);
    }
  }
}
if (failed) process.exit(1);
console.log("\nRestart your agent so it picks the skills up.");
