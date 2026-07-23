export interface RetrievalCase {
  query: string;
  expectedPaths?: string[];
}

export interface RetrievalQuality {
  evaluated: boolean;
  hitAt5: boolean;
  reciprocalRank: number;
  duplicatePathRate: number;
  firstRelevantRank: number | null;
}

export function parseRetrievalCases(value: unknown): RetrievalCase[] {
  if (!Array.isArray(value)) {
    throw new Error("Benchmark input must be a JSON array.");
  }

  return value.map((item) => {
    if (typeof item === "string" && item.trim()) return { query: item.trim() };
    if (
      typeof item === "object" && item !== null &&
      typeof (item as RetrievalCase).query === "string" &&
      (item as RetrievalCase).query.trim() &&
      Array.isArray((item as RetrievalCase).expectedPaths) &&
      (item as RetrievalCase).expectedPaths!.every((path) => typeof path === "string" && path.length > 0)
    ) {
      return {
        query: (item as RetrievalCase).query.trim(),
        expectedPaths: [...(item as RetrievalCase).expectedPaths!]
      };
    }
    throw new Error("Each benchmark item must be a query string or { query, expectedPaths }.");
  });
}

export function evaluateRetrieval(sourcePaths: string[], expectedPaths?: string[]): RetrievalQuality {
  const duplicatePathRate = sourcePaths.length === 0
    ? 0
    : 1 - new Set(sourcePaths).size / sourcePaths.length;
  if (!expectedPaths?.length) {
    return { evaluated: false, hitAt5: false, reciprocalRank: 0, duplicatePathRate, firstRelevantRank: null };
  }

  const expected = new Set(expectedPaths);
  const firstIndex = sourcePaths.findIndex((path) => expected.has(path));
  const firstRelevantRank = firstIndex === -1 ? null : firstIndex + 1;
  return {
    evaluated: true,
    hitAt5: firstIndex >= 0 && firstIndex < 5,
    reciprocalRank: firstIndex === -1 ? 0 : 1 / (firstIndex + 1),
    duplicatePathRate,
    firstRelevantRank
  };
}

export function summarizeQuality(qualities: RetrievalQuality[]) {
  const evaluated = qualities.filter((quality) => quality.evaluated);
  const divisor = Math.max(evaluated.length, 1);
  return {
    evaluatedRuns: evaluated.length,
    recallAt5: evaluated.reduce((sum, quality) => sum + Number(quality.hitAt5), 0) / divisor,
    mrr: evaluated.reduce((sum, quality) => sum + quality.reciprocalRank, 0) / divisor,
    duplicatePathRate: qualities.reduce((sum, quality) => sum + quality.duplicatePathRate, 0) / Math.max(qualities.length, 1)
  };
}
