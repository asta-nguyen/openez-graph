// Non-cryptographic hash for content deduplication.
// Bun.hash (xxHash64) is ~2x faster than SHA-256 — 1.5s vs 2.8s for 71k files.
// 64-bit is sufficient: birthday collision bound is ~4 billion files.
export function hashContent(content: string): string {
  return Bun.hash(content).toString(16);
}
