export function parseModels(output: string): string[] {
  return output
    .split("\n")
    .flatMap((l) => l.split("\t"))
    .map((s) => s.trim().replace(/\s*\(current\)$/, ""))
    .filter((s) => s.length > 0);
}

export class ModelRegistry {
  private listing: string[] | null = null;

  constructor(private fetchListing: () => Promise<string>) {}

  async available(): Promise<string[] | null> {
    if (this.listing) return this.listing;
    try {
      this.listing = parseModels(await this.fetchListing());
    } catch {
      return null;
    }
    return this.listing;
  }
}
