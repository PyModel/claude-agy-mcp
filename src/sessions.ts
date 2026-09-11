import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** Where agy records the conversation it last used in each working directory. */
export const SESSIONS_FILE = path.join(
  homedir(),
  ".gemini",
  "antigravity-cli",
  "cache",
  "last_conversations.json",
);

export type ReadSessionsFile = () => Promise<string>;

const readSessionsFile: ReadSessionsFile = () => readFile(SESSIONS_FILE, "utf8");

/**
 * The session agy associates with `cwd` — a *fallback* only.
 *
 * This file is global to the user, not to this server: two concurrent
 * delegations in one directory overwrite each other's entry, and an interactive
 * agy the user happens to be running there wins outright. The run's own
 * `conversation_id` from the JSON envelope is authoritative and is what
 * `Delegator` returns; this is consulted only when agy is too old to report one.
 */
export async function sessionFor(
  cwd: string,
  read: ReadSessionsFile = readSessionsFile,
): Promise<string | undefined> {
  try {
    const map = JSON.parse(await read()) as Record<string, string>;
    const want = path.resolve(cwd);
    return map[want] ?? Object.entries(map).find(([k]) => path.resolve(k) === want)?.[1];
  } catch {
    return undefined;
  }
}
