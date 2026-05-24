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
