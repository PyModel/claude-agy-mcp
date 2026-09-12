import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * `agy models`, with stdin closed: agy reads stdin until EOF even in print mode,
 * so an open stdin pipe hangs it forever.
 */
export function listModels(agyPath: string): Promise<string> {
  const promise = execFileAsync(agyPath, ["models"], {
    cwd: process.cwd(),
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  promise.child.stdin?.end();
  return promise.then(({ stdout }) => stdout);
}

/** One row of `agy models`: the id agy prints and the display name it also accepts. */
export interface ModelInfo {
  id: string;
  name: string;
  /** Vendor + variant with the version and effort stripped, e.g. "gemini-flash". */
  family: string;
  /** Version components, most significant first; empty when the name carries none. */
  version: number[];
  /** The parenthesised tier, lowercased: "high" | "medium" | "low" | "thinking" | undefined. */
  effort?: string;
}

const VERSION_TOKEN = /^\d+(?:\.\d+)*$/;

/** Splits "Gemini 3.8 Flash (High)" into its family, version and effort. */
export function describeModel(id: string, name: string): ModelInfo {
  const paren = /\(([^)]*)\)\s*$/.exec(name);
  const effort = paren?.[1]?.trim().toLowerCase();
  const head = paren ? name.slice(0, paren.index) : name;

  const version: number[] = [];
  const familyWords: string[] = [];
  for (const word of head.trim().split(/\s+/)) {
    if (!word) continue;
    if (VERSION_TOKEN.test(word) && version.length === 0) {
      version.push(...word.split(".").map(Number));
    } else {
      familyWords.push(word.toLowerCase());
    }
  }

  return {
    id,
    name,
    family: familyWords.join("-"),
    version,
    ...(effort ? { effort } : {}),
  };
}

/**
 * Parses `agy models` into rows.
 *
 * The listing is `<id>\t<display name>` per line, preceded by a
 * "Fetching available models..." progress line. The previous parser flattened
 * every column into one list, which let that header through as a model name
 * that passed validation and then failed at agy.
 */
export function parseListing(output: string): ModelInfo[] {
  const rows: ModelInfo[] = [];
  for (const line of output.split("\n")) {
    const parts = line.split("\t").map((s) => s.trim().replace(/\s*\(current\)$/, ""));
    if (parts.length < 2) continue; // header and blank lines have no tab
    const [id, name] = parts;
    if (!id || !name) continue;
    rows.push(describeModel(id, name));
  }
  return rows;
}

/** `family@latest[-effort]` or `family@3.7[-effort]`. */
const SELECTOR = /^([a-z0-9-]+)@(latest|[\d.]+)(?:-(high|medium|low|thinking))?$/i;

function newerThan(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? -1;
    const y = b[i] ?? -1;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * Resolves one chain entry to a display name agy will accept, or undefined.
 * An entry may be an exact display name, an id, or a family selector.
 */
export function resolveEntry(entry: string, available: ModelInfo[]): string | undefined {
  const exact = available.find((m) => m.name === entry || m.id === entry);
  if (exact) return exact.name;

  const sel = SELECTOR.exec(entry);
  if (!sel) return undefined;
  const [, family, versionSpec, effort] = sel;
  const wantVersion =
    versionSpec!.toLowerCase() === "latest" ? null : versionSpec!.split(".").map(Number);

  let best: ModelInfo | undefined;
  for (const m of available) {
    if (m.family !== family!.toLowerCase()) continue;
    if (effort && m.effort !== effort.toLowerCase()) continue;
    if (wantVersion && m.version.join(".") !== wantVersion.join(".")) continue;
    if (!best || newerThan(m.version, best.version)) best = m;
  }
  return best?.name;
}

export type Effort = "low" | "medium" | "high";

/** A model name to pass agy, and the `--effort` to send with it, if any. */
export interface TierPick {
  model: string;
  effort?: Effort;
}

/**
 * Reconciles a requested effort with a model that may carry its own tier.
 *
 * agy 1.2.1 rejects `--effort` for any model whose name carries a tier
 * ("Gemini 3.8 Flash (High)"), and rejects an id whose tier disagrees with
 * `--effort`. So for a tiered model the tier *is* the effort: a different
 * effort selects the sibling at that tier when one is listed, and `--effort`
 * itself only travels with models that have no tier of their own.
 */
export function pickTier(
  name: string,
  effort: Effort | undefined,
  available: ModelInfo[],
): TierPick {
  const info = available.find((m) => m.name === name);
  if (!info || !info.effort) return effort ? { model: name, effort } : { model: name };
  if (!effort || effort === info.effort) return { model: name };
  const sibling = available.find(
    (m) =>
      m.family === info.family &&
      m.version.join(".") === info.version.join(".") &&
      m.effort === effort,
  );
  return { model: sibling?.name ?? name };
}

export interface ResolveOptions {
  explicit?: string;
  chain: string[];
  defaultModel?: string;
}

export interface ChainResolution {
  models: (string | undefined)[];
  note?: string;
}

/** Thrown when the listing is readable but nothing in the chain survives it. */
export class ModelSkewError extends Error {
  constructor(chain: string[], available: ModelInfo[]) {
    super(
      `None of this tool's models are offered by agy any more.\n` +
        `Wanted: ${chain.join(", ")}\n` +
        `Available: ${available.map((m) => m.name).join(", ")}\n` +
        `This is a version-skew signal, not a preference — update the tool's chain.`,
    );
    this.name = "ModelSkewError";
  }
}

export class ModelRegistry {
  private listing: ModelInfo[] | null = null;
  private pending: Promise<ModelInfo[] | null> | null = null;

  constructor(private fetchListing: () => Promise<string>) {}

  /**
   * Discards the cached listing so the next call re-reads `agy models`.
   *
   * The listing is cached for the process lifetime, which is right until agy is
   * upgraded underneath a long-running bridge and renames a model. Every
   * resolve then produces a name agy rejects, and `invalid_model` does not fail
   * over, so the server used to stay bricked until someone restarted it.
   */
  invalidate(): void {
    this.listing = null;
    this.pending = null;
  }

  async available(): Promise<ModelInfo[] | null> {
    if (this.listing) return this.listing;
    // Cache the promise so concurrent first calls share one fetch.
    this.pending ??= this.fetchListing()
      .then(parseListing)
      .catch(() => null);
    const result = await this.pending;
    if (result && result.length) this.listing = result;
    else this.pending = null; // transient failure — retry on the next call
    return result && result.length ? result : null;
  }

  /** `pickTier` against the live listing; passes the effort through when the listing is unreadable. */
  async forEffort(
    name: string | undefined,
    effort: Effort | undefined,
  ): Promise<TierPick | undefined> {
    if (!name) return undefined;
    const available = await this.available();
    if (available === null) return effort ? { model: name, effort } : { model: name };
    return pickTier(name, effort, available);
  }

  /**
   * Every viable model in preference order so callers can fail over.
   * `[undefined]` means "let agy pick", and is only returned when the listing
   * itself could not be read — an unreadable listing is a degraded environment,
   * whereas an empty resolved chain is stale configuration and throws.
   */
  async resolveChain(opts: ResolveOptions): Promise<ChainResolution> {
    const available = await this.available();

    if (opts.explicit) {
      if (available === null) {
        return {
          models: [opts.explicit],
          note: "could not list agy models; passing model through unvalidated",
        };
      }
      const resolved = resolveEntry(opts.explicit, available);
      if (resolved) return { models: [resolved] };
      throw new Error(
        `Model "${opts.explicit}" is not available. Available models:\n` +
          available.map((m) => m.name).join("\n"),
      );
    }

    if (available === null) {
      return {
        models: [undefined],
        note: "could not list agy models; using agy's own default model",
      };
    }

    const wanted = [...opts.chain, ...(opts.defaultModel ? [opts.defaultModel] : [])];
    const models: string[] = [];
    for (const entry of wanted) {
      const name = resolveEntry(entry, available);
      if (name && !models.includes(name)) models.push(name);
    }
    if (models.length === 0) throw new ModelSkewError(wanted, available);
    return { models };
  }
}
