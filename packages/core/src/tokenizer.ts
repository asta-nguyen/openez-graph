import { decode, encode } from "gpt-tokenizer";

export function countTokens(value: string): number {
  try {
    return encode(value).length;
  } catch {
    return Math.ceil(value.length / 4);
  }
}

export function truncateToTokenLimit(value: string, maxTokens: number): string {
  if (maxTokens <= 0) {
    return "";
  }

  try {
    const tokens = encode(value);
    if (tokens.length <= maxTokens) {
      return value;
    }

    return decode(tokens.slice(0, maxTokens));
  } catch {
    const approximateMaxChars = maxTokens * 4;
    if (value.length <= approximateMaxChars) {
      return value;
    }

    return value.slice(0, approximateMaxChars);
  }
}

export function splitToTokenLimit(value: string, maxTokens: number, overlapTokens = 0): string[] {
  if (!value || maxTokens <= 0) return [];

  const overlap = Math.min(Math.max(0, overlapTokens), maxTokens - 1);

  try {
    const tokens = encode(value);
    if (tokens.length <= maxTokens) return [value];

    const chunks: string[] = [];
    for (let start = 0; start < tokens.length; start += maxTokens - overlap) {
      chunks.push(decode(tokens.slice(start, start + maxTokens)));
    }
    return chunks;
  } catch {
    const maxChars = maxTokens * 4;
    const overlapChars = overlap * 4;
    const chunks: string[] = [];
    for (let start = 0; start < value.length; start += maxChars - overlapChars) {
      chunks.push(value.slice(start, start + maxChars));
    }
    return chunks;
  }
}
