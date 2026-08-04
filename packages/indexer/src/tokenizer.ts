// Fast approximate tokenization — chars/4 is within ~10% of GPT token counts
// and 10x faster than BPE encoding. Used for indexing where speed matters more
// than exact token precision.
export function countTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

export function splitToTokenLimit(value: string, maxTokens: number, overlapTokens = 0): string[] {
  if (!value || maxTokens <= 0) return [];

  const overlap = Math.min(Math.max(0, overlapTokens), maxTokens - 1);
  const maxChars = maxTokens * 4;
  const overlapChars = overlap * 4;

  if (value.length <= maxChars) return [value];

  const chunks: string[] = [];
  for (let start = 0; start < value.length; start += maxChars - overlapChars) {
    chunks.push(value.slice(start, start + maxChars));
  }
  return chunks;
}
