import { describe, expect, it } from "vitest";

import { indexMarkdown } from "../packages/indexer/src/markdown";

describe("indexMarkdown", () => {
  it("extracts wikilinks and chunk metadata", () => {
    const result = indexMarkdown({
      content: "# Intro\n\nHello [[Auth Design]]\n\n## Details\n\nMore text",
      targetTokens: 50,
      overlapTokens: 10
    });

    expect(result.wikilinks).toContain("Auth Design");
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.chunks[0]?.metadata.kind).toBe("markdown");
  });
});
