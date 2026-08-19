import { describe, expect, it } from "bun:test";

import { indexMarkdown } from "../packages/indexer/src/markdown";
import {
  countTokens,
  fastTokenCounter,
  splitApproximately,
  splitToTokenLimit,
} from "../packages/core/src/tokenizer";
import { FallbackParser } from "../packages/indexer/src/parsers/fallback-parser";

describe("indexMarkdown", () => {
  it("extracts wikilinks and chunk metadata", () => {
    const result = indexMarkdown({
      content: "# Intro\n\nHello [[Auth Design]]\n\n## Details\n\nMore text",
      targetTokens: 50,
      overlapTokens: 10,
    });

    expect(result.wikilinks).toContain("Auth Design");
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.chunks[0]?.metadata.kind).toBe("markdown");
  });
});

describe("splitToTokenLimit", () => {
  it("bounds chunks and preserves overlap", () => {
    const chunks = splitToTokenLimit("word ".repeat(200), 40, 5);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => countTokens(chunk) <= 40)).toBe(true);
  });

  it("rejects non-integer token budgets without emitting empty chunks", () => {
    expect(splitToTokenLimit("non-empty", Number.NaN)).toEqual([]);
    expect(splitToTokenLimit("non-empty", 2.5)).toEqual([]);
    expect(splitApproximately("non-empty", Number.NaN)).toEqual([]);
    expect(splitApproximately("non-empty", 2, 0.5)).toEqual([]);
  });
});

describe("FallbackParser", () => {
  it("uses the fast counter when no caller-specific counter is supplied", () => {
    const content = "x".repeat(101);
    const result = new FallbackParser().parse(
      {
        relativePath: "notes.txt",
        absolutePath: "/tmp/notes.txt",
        content,
        targetTokens: 200,
        overlapTokens: 0,
      },
      "text",
      "text",
    );

    expect(result.chunks[0]?.tokenCount).toBe(fastTokenCounter.count(content));
  });
});
