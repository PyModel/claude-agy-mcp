export function parseModels(output: string): string[] {
  return output
    .split("\n")
    .flatMap((l) => l.split("\t"))
    .map((s) => s.trim().replace(/\s*\(current\)$/, ""))
    .filter((s) => s.length > 0);
}
