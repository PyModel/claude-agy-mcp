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
