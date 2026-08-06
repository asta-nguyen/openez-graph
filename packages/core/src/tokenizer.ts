// Lazy-load gpt-tokenizer — the BPE vocab is ~965KB and only needed for retrieval, not indexing.
// This keeps the index path fast by avoiding parsing the vocab on startup.
let _encode: ((text: string) => number[]) | null = null;
let _decode: ((tokens: number[]) => string) | null = null;
let _loadFailed = false;
let _fastMode = false;

/** Skip BPE encoding — use length/4 approximation. Call during indexing for speed. */
export function setFastTokenCount(enabled: boolean): void {
  _fastMode = enabled;
}

function loadTokenizer(): void {
  if (_encode || _loadFailed || _fastMode) return;
  try {
    const tokenizer = require("gpt-tokenizer");
    _encode = tokenizer.encode;
    _decode = tokenizer.decode;
  } catch {
    _loadFailed = true;
  }
}

export function countTokens(value: string): number {
  if (_fastMode) return Math.ceil(value.length / 4);
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

export function splitToTokenLimit(value: string, maxTokens: number, overlapTokens = 0): string[] {
  if (!value || maxTokens <= 0) return [];

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

  const maxChars = maxTokens * 4;
  const overlapChars = overlap * 4;
  const chunks: string[] = [];
  for (let start = 0; start < value.length; start += maxChars - overlapChars) {
    chunks.push(value.slice(start, start + maxChars));
  }
  return chunks;
}
