// Token counting is split into two scoped strategies so indexing and
// retrieval never share mutable global state:
//   - fastTokenCounter: chars/4 approximation — 10x faster, used for indexing
//   - exactTokenCounter: GPT BPE encoding — used for retrieval budgeting
// Callers pick the strategy explicitly by passing the relevant TokenCounter.

// Lazy-load gpt-tokenizer — the BPE vocab is ~965KB and only needed for
// exact (retrieval) token counting, never for the fast indexing path.
let _encode: ((text: string) => number[]) | null = null;
let _decode: ((tokens: number[]) => string) | null = null;
let _loadFailed = false;

function loadTokenizer(): void {
  if (_encode || _loadFailed) return;
  try {
    const tokenizer = require("gpt-tokenizer");
    _encode = tokenizer.encode;
    _decode = tokenizer.decode;
  } catch {
    _loadFailed = true;
  }
}

/**
 * Exact token count via GPT BPE encoding. Falls back to the chars/4
 * approximation only when the tokenizer vocab cannot be loaded.
 */
export function countTokens(value: string): number {
  loadTokenizer();
  if (_encode) {
    try {
      return _encode(value).length;
    } catch {
      return Math.ceil(value.length / 4);
    }
  }
  return Math.ceil(value.length / 4);
}

export function truncateToTokenLimit(value: string, maxTokens: number): string {
  if (maxTokens <= 0) {
    return "";
  }

  loadTokenizer();
  if (_encode && _decode) {
    try {
      const tokens = _encode(value);
      if (tokens.length <= maxTokens) {
        return value;
      }

      return _decode(tokens.slice(0, maxTokens));
    } catch {
      const approximateMaxChars = maxTokens * 4;
      if (value.length <= approximateMaxChars) {
        return value;
      }

      return value.slice(0, approximateMaxChars);
    }
  }

  const approximateMaxChars = maxTokens * 4;
  if (value.length <= approximateMaxChars) {
    return value;
  }

  return value.slice(0, approximateMaxChars);
}

/**
 * Split `value` into chunks of at most `maxTokens` BPE tokens, overlapping by
 * `overlapTokens` tokens. Falls back to a chars/4 split when BPE is unavailable.
 */
export function splitToTokenLimit(value: string, maxTokens: number, overlapTokens = 0): string[] {
  if (
    !value ||
    !Number.isInteger(maxTokens) ||
    !Number.isInteger(overlapTokens) ||
    maxTokens <= 0
  ) {
    return [];
  }

  const overlap = Math.min(Math.max(0, overlapTokens), maxTokens - 1);

  loadTokenizer();
  if (_encode && _decode) {
    try {
      const tokens = _encode(value);
      if (tokens.length <= maxTokens) return [value];

      const chunks: string[] = [];
      for (let start = 0; start < tokens.length; start += maxTokens - overlap) {
        chunks.push(_decode(tokens.slice(start, start + maxTokens)));
      }
      return chunks;
    } catch {
      // fall through to approximate
    }
  }

  return splitApproximately(value, maxTokens, overlap);
}

/**
 * Fast approximate split using a chars/4 token budget. No BPE encoding —
 * consistent with `fastTokenCounter.count`.
 */
export function splitApproximately(value: string, maxTokens: number, overlapTokens = 0): string[] {
  if (
    !value ||
    !Number.isInteger(maxTokens) ||
    !Number.isInteger(overlapTokens) ||
    maxTokens <= 0
  ) {
    return [];
  }

  const overlap = Math.min(Math.max(0, overlapTokens), maxTokens - 1);
  const maxChars = maxTokens * 4;
  const overlapChars = overlap * 4;
  const chunks: string[] = [];
  for (let start = 0; start < value.length; start += maxChars - overlapChars) {
    chunks.push(value.slice(start, start + maxChars));
  }
  return chunks;
}

/**
 * Scoped token-counting strategy. Indexing passes `fastTokenCounter` so the
 * hot parse/chunk path avoids BPE; retrieval uses `exactTokenCounter` (via
 * `countTokens`/`splitToTokenLimit` directly) for precise budgeting.
 */
export interface TokenCounter {
  count(value: string): number;
  split(value: string, maxTokens: number, overlapTokens?: number): string[];
}

export const fastTokenCounter: TokenCounter = {
  count: (value) => Math.ceil(value.length / 4),
  split: splitApproximately,
};

export const exactTokenCounter: TokenCounter = {
  count: countTokens,
  split: splitToTokenLimit,
};
