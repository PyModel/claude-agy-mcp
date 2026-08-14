export function parseModels(output: string): string[] {
  return output
    .split("\n")
    .flatMap((l) => l.split("\t"))
    .map((s) => s.trim().replace(/\s*\(current\)$/, ""))
    .filter((s) => s.length > 0);
}

export class ModelRegistry {
  private listing: string[] | null = null;
  private pending: Promise<string[] | null> | null = null;

  constructor(private fetchListing: () => Promise<string>) {}

  async available(): Promise<string[] | null> {
    if (this.listing) return this.listing;
    // Cache the promise so concurrent first calls share one fetch.
    this.pending ??= this.fetchListing()
      .then(parseModels)
      .catch(() => null);
    const result = await this.pending;
    if (result) this.listing = result;
    else this.pending = null; // transient failure — retry on the next call
    return result;
  }
}
