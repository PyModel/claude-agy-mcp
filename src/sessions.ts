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
 * The session agy associates with `cwd`, or undefined when the cache is
 * missing, unreadable, or has no entry. agy stores keys as it received them, so
 * both sides of the comparison are resolved before matching.
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
