import { describe, expect, it } from "vitest";

import {
  evaluateRetrieval,
  parseRetrievalCases,
  summarizeQuality,
} from "../packages/indexer/src/retrieval-eval";

describe("retrieval evaluation", () => {
  it("parses legacy strings and quality cases", () => {
    expect(parseRetrievalCases(["query", { query: "target", expectedPaths: ["a.ts"] }])).toEqual([
      { query: "query" },
      { query: "target", expectedPaths: ["a.ts"] },
    ]);
  });

  it("calculates rank and duplicate metrics", () => {
    const hit = evaluateRetrieval(["other.ts", "target.ts", "target.ts"], ["target.ts"]);
    const miss = evaluateRetrieval(["other.ts"], ["target.ts"]);
    const summary = summarizeQuality([hit, miss]);

    expect(hit).toMatchObject({ hitAt5: true, reciprocalRank: 0.5, firstRelevantRank: 2 });
    expect(hit.duplicatePathRate).toBeCloseTo(1 / 3);
    expect(summary).toMatchObject({ evaluatedRuns: 2, recallAt5: 0.5, mrr: 0.25 });
  });
});
