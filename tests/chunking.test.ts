import { describe, expect, it } from "vitest";

import { indexMarkdown } from "../packages/indexer/src/markdown";
import { countTokens, splitToTokenLimit } from "../packages/core/src/tokenizer";

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
});
