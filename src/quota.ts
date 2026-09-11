/**
 * Quota detection and cooldown tracking for agy model failover.
 *
 * agy never surfaces RESOURCE_EXHAUSTED to stdout/stderr in print mode — it
 * silently retries until --print-timeout, then exits 0 with empty output.
 * The only reliable signal is the 429 line in its log file, which includes
 * the exact reset time ("Resets in 96h53m25s").
 */

export const DEFAULT_COOLDOWN_SEC = 15 * 60;

const QUOTA_RE = /RESOURCE_EXHAUSTED \(code 429\)/;
const RESET_RE = /Resets in ((?:\d+h)?(?:\d+m)?(?:\d+s)?)\b/;

export interface QuotaInfo {
  resetText?: string;
  resetSeconds?: number;
}

export function parseResetDuration(text: string): number | undefined {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text);
  if (!m || (!m[1] && !m[2] && !m[3])) return undefined;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  let out = "";
  if (h) out += `${h}h`;
  if (m) out += `${m}m`;
  if (sec || !out) out += `${sec}s`;
  return out;
}

export function detectQuota(log: string): QuotaInfo | null {
  if (!QUOTA_RE.test(log)) return null;
  const reset = RESET_RE.exec(log)?.[1];
  const resetSeconds = reset ? parseResetDuration(reset) : undefined;
  return { resetText: resetSeconds !== undefined ? reset : undefined, resetSeconds };
}

export class QuotaError extends Error {
  readonly resetSeconds?: number;
  readonly resetText?: string;

  constructor(
    readonly model: string | undefined,
    info: QuotaInfo,
  ) {
    const who = model ?? "agy's default model";
    const when = info.resetText ? ` Quota resets in ${info.resetText}.` : "";
    super(`Quota exhausted for ${who} (RESOURCE_EXHAUSTED 429).${when}`);
    this.name = "QuotaError";
    this.resetSeconds = info.resetSeconds;
    this.resetText = info.resetText;
  }
}

/**
 * Where cooldowns live between calls. The default keeps them in memory; the file
 * store shares them across every MCP client on the machine, so Claude Code and
 * Cursor do not each re-burn a call rediscovering the same 429.
 */
export interface CooldownStore {
  load(): Record<string, number>;
  /** `entries` is every live cooldown as of `now` (epoch ms); anything older has expired. */
  save(entries: Record<string, number>, now: number): void;
}

export class MemoryCooldownStore implements CooldownStore {
  private entries: Record<string, number> = {};
  load(): Record<string, number> {
    return { ...this.entries };
  }
  save(entries: Record<string, number>): void {
    this.entries = { ...entries };
  }
}

export class CooldownRegistry {
  constructor(
    private readonly store: CooldownStore = new MemoryCooldownStore(),
    private now: () => number = Date.now,
  ) {}

  /** Entries that have not yet expired, as model -> epoch ms. */
  private live(): Record<string, number> {
    const t = this.now();
    return Object.fromEntries(Object.entries(this.store.load()).filter(([, until]) => until > t));
  }

  set(model: string, resetSeconds: number | undefined): void {
    const entries = this.live();
    const t = this.now();
    entries[model] = t + (resetSeconds ?? DEFAULT_COOLDOWN_SEC) * 1000;
    this.store.save(entries, t);
  }

  cooling(model: string): boolean {
    return this.live()[model] !== undefined;
  }

  describe(model: string): string {
    const until = this.live()[model];
    return formatDuration(until === undefined ? 0 : (until - this.now()) / 1000);
  }

  /** Every active cooldown, for the status tool. */
  active(): { model: string; secondsLeft: number }[] {
    const t = this.now();
    return Object.entries(this.live())
      .map(([model, until]) => ({ model, secondsLeft: Math.round((until - t) / 1000) }))
      .sort((a, b) => b.secondsLeft - a.secondsLeft);
  }
}
