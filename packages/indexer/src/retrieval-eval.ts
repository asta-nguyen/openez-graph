import type { JsonValue } from "@openez-graph/db";

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

function isJsonString(v: JsonValue): v is string {
  return String(v) === v;
}

function isJsonObject(v: JsonValue): v is { [key: string]: JsonValue } {
  return v !== null && v instanceof Object && !Array.isArray(v);
}

export function parseRetrievalCases(value: JsonValue): RetrievalCase[] {
  if (!Array.isArray(value)) {
    throw new Error("Benchmark input must be a JSON array.");
  }

  return value.map((item) => {
    if (isJsonString(item) && item.trim()) return { query: item.trim() };
    if (isJsonObject(item)) {
      const query = item.query;
      const expectedPaths = item.expectedPaths;
      if (isJsonString(query) && query.trim() && Array.isArray(expectedPaths)) {
        const paths = expectedPaths.filter((p): p is string => isJsonString(p) && p.length > 0);
        if (paths.length === expectedPaths.length) {
          return {
            query: query.trim(),
            expectedPaths: [...paths],
          };
        }
      }
    }
    throw new Error("Each benchmark item must be a query string or { query, expectedPaths }.");
  });
}

export function evaluateRetrieval(
  sourcePaths: string[],
  expectedPaths?: string[],
): RetrievalQuality {
  const duplicatePathRate =
    sourcePaths.length === 0 ? 0 : 1 - new Set(sourcePaths).size / sourcePaths.length;
  if (!expectedPaths?.length) {
    return {
      evaluated: false,
      hitAt5: false,
      reciprocalRank: 0,
      duplicatePathRate,
      firstRelevantRank: null,
    };
  }

  const expected = new Set(expectedPaths);
  const firstIndex = sourcePaths.findIndex((path) => expected.has(path));
  const firstRelevantRank = firstIndex === -1 ? null : firstIndex + 1;
  return {
    evaluated: true,
    hitAt5: firstIndex >= 0 && firstIndex < 5,
    reciprocalRank: firstIndex === -1 ? 0 : 1 / (firstIndex + 1),
    duplicatePathRate,
    firstRelevantRank,
  };
}

export function summarizeQuality(qualities: RetrievalQuality[]) {
  const evaluated = qualities.filter((quality) => quality.evaluated);
  const divisor = Math.max(evaluated.length, 1);
  return {
    evaluatedRuns: evaluated.length,
    recallAt5: evaluated.reduce((sum, quality) => sum + Number(quality.hitAt5), 0) / divisor,
    mrr: evaluated.reduce((sum, quality) => sum + quality.reciprocalRank, 0) / divisor,
    duplicatePathRate:
      qualities.reduce((sum, quality) => sum + quality.duplicatePathRate, 0) /
      Math.max(qualities.length, 1),
  };
}
