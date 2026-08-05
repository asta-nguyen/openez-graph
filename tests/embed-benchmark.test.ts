import { describe, expect, it } from "vitest";

import { codeQuery } from "../packages/core/src/retrieval";
import { closeRegistryDb, createRegistryRepository } from "../packages/db/src/sqlite";
import { getEmbeddingConfig } from "../packages/core/src/embeddings";

interface EvalQuery {
  query: string;
  expectedPaths: string[];
  type: "keyword" | "semantic";
}

const evalSet: EvalQuery[] = [
  // Keyword queries — FTS excels here (direct keyword match)
  {
    query: "where is workspace indexing implemented?",
    expectedPaths: ["packages/indexer/src/index-workspace.ts"],
    type: "keyword",
  },
  {
    query: "how does the retrieval pipeline work?",
    expectedPaths: ["packages/core/src/retrieval.ts"],
    type: "keyword",
  },
  {
    query: "where are embeddings written?",
    expectedPaths: ["packages/indexer/src/index-workspace.ts"],
    type: "keyword",
  },
  {
    query: "how does codeQuery work?",
    expectedPaths: ["packages/core/src/retrieval.ts"],
    type: "keyword",
  },
  {
    query: "where is the embedding provider selected?",
    expectedPaths: ["packages/core/src/embeddings.ts"],
    type: "keyword",
  },
  {
    query: "how does vector search run?",
    expectedPaths: ["packages/core/src/retrieval.ts"],
    type: "keyword",
  },
  {
    query: "where is the MCP server implemented?",
    expectedPaths: ["apps/mcp/src/mcp-core.ts"],
    type: "keyword",
  },
  {
    query: "where is the SQLite workspace registry opened?",
    expectedPaths: ["packages/db/src/sqlite/registry-db.ts"],
    type: "keyword",
  },
  {
    query: "how is markdown split into chunks?",
    expectedPaths: ["packages/indexer/src/markdown.ts"],
    type: "keyword",
  },
  {
    query: "where are TypeScript symbols extracted?",
    expectedPaths: ["packages/indexer/src/code.ts"],
    type: "keyword",
  },
  {
    query: "how are YAML JSON and TOML configs chunked?",
    expectedPaths: ["packages/indexer/src/languages.ts"],
    type: "keyword",
  },
  {
    query: "where is the local workspace hint written?",
    expectedPaths: ["packages/db/src/sqlite/local-workspace.ts"],
    type: "keyword",
  },
  {
    query: "how does Codex MCP setup work?",
    expectedPaths: ["apps/cli/src/setup-codex.ts"],
    type: "keyword",
  },
  {
    query: "where are graph neighbors traversed?",
    expectedPaths: ["packages/db/src/sqlite/repository.ts", "packages/core/src/graph.ts"],
    type: "keyword",
  },
  {
    query: "how is the FTS5 chunk index synchronized?",
    expectedPaths: ["packages/db/src/sqlite/workspace-db.ts"],
    type: "keyword",
  },
  {
    query: "how does MCP resolve a workspace path?",
    expectedPaths: ["apps/mcp/src/mcp-core.ts"],
    type: "keyword",
  },
  {
    query: "where is text truncated to a token budget?",
    expectedPaths: ["packages/core/src/tokenizer.ts"],
    type: "keyword",
  },
  // Semantic queries — no keyword overlap, embedding excels here
  {
    query: "convert text to numbers for similarity",
    expectedPaths: ["packages/core/src/embeddings.ts"],
    type: "semantic",
  },
  {
    query: "store secret key safely encrypted",
    expectedPaths: ["packages/db/src/sqlite/secure-storage.ts"],
    type: "semantic",
  },
  {
    query: "measure distance between two vectors",
    expectedPaths: ["packages/core/src/retrieval.ts"],
    type: "semantic",
  },
  {
    query: "save configuration value to database",
    expectedPaths: ["packages/db/src/sqlite/repository.ts"],
    type: "semantic",
  },
  {
    query: "split source code into searchable pieces",
    expectedPaths: ["packages/indexer/src/index-workspace.ts"],
    type: "semantic",
  },
  {
    query: "connect to local AI model for inference",
    expectedPaths: ["packages/core/src/embeddings.ts"],
    type: "semantic",
  },
];

function recallAt5(results: { path: string }[], expected: string[]): boolean {
  const top5 = results.slice(0, 5).map((r) => r.path);
  return expected.some((p) => top5.includes(p));
}

function reciprocalRank(results: { path: string }[], expected: string[]): number {
  for (let i = 0; i < results.length; i++) {
    if (expected.includes(results[i].path)) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

async function runEval(): Promise<{
  recall: number;
  mrr: number;
  avgLatency: number;
  hits: number;
  total: number;
  keywordRecall: number;
  semanticRecall: number;
  keywordHits: number;
  keywordTotal: number;
  semanticHits: number;
  semanticTotal: number;
}> {
  let hits = 0;
  let mrrSum = 0;
  let latencySum = 0;
  let keywordHits = 0;
  let semanticHits = 0;
  const keywordQueries = evalSet.filter((q) => q.type === "keyword");
  const semanticQueries = evalSet.filter((q) => q.type === "semantic");

  for (const item of evalSet) {
    const start = Date.now();
    const result = await codeQuery({
      workspaceId: process.env.OPENEZ_BENCHMARK_WORKSPACE ?? "openez",
      query: item.query,
      limit: 10,
      skipGraphExpand: true,
    });
    latencySum += Date.now() - start;

    const sources = result.sources.map((s) => ({ path: s.path }));
    const hit = recallAt5(sources, item.expectedPaths);
    if (hit) {
      hits++;
      if (item.type === "keyword") keywordHits++;
      else semanticHits++;
    }
    mrrSum += reciprocalRank(sources, item.expectedPaths);
  }

  const total = evalSet.length;
  return {
    recall: hits / total,
    mrr: mrrSum / total,
    avgLatency: latencySum / total,
    hits,
    total,
    keywordRecall: keywordHits / keywordQueries.length,
    semanticRecall: semanticHits / semanticQueries.length,
    keywordHits,
    keywordTotal: keywordQueries.length,
    semanticHits,
    semanticTotal: semanticQueries.length,
  };
}

describe("FTS vs Embedding benchmark", () => {
  it.skipIf(process.env.OPENEZ_RUN_BENCHMARK !== "1")(
    "compares FTS-only vs FTS+embedding retrieval",
    async () => {
      const config = await getEmbeddingConfig();
      const hasEmbedding = config.provider !== "none";

      console.log("\n═══════════════════════════════════════════════════");
      console.log("  Retrieval Benchmark: FTS vs FTS+Embedding");
      console.log("═══════════════════════════════════════════════════");

      // Query actual file/chunk counts from workspace DB
      const { createWorkspaceRepository } = await import("../packages/db/src/sqlite");
      const wsRepo = createWorkspaceRepository(
        process.env.OPENEZ_BENCHMARK_WORKSPACE_PATH ?? process.cwd(),
      );
      const stats = await wsRepo.queryRaw(
        "SELECT (SELECT count(*) FROM documents) as fileCount, (SELECT count(*) FROM chunks) as chunkCount",
      );
      const fileCount = Number(stats[0]?.fileCount ?? 0);
      const chunkCount = Number(stats[0]?.chunkCount ?? 0);
      console.log(`  Workspace: openez (${fileCount} files, ${chunkCount} chunks)`);
      console.log(
        `  Eval set:  ${evalSet.length} queries (${evalSet.filter((q) => q.type === "keyword").length} keyword + ${evalSet.filter((q) => q.type === "semantic").length} semantic)`,
      );
      console.log(
        `  Embedding: ${hasEmbedding ? config.provider + "/" + (config.provider === "openai" ? config.openaiModel : config.ollamaModel) : "disabled"}`,
      );
      console.log("");

      // Run with embedding enabled (current config)
      const withEmbed = await runEval();

      // Disable embedding, close DB to pick up change
      const registry = createRegistryRepository();
      const savedProvider = await registry.getSetting("embedding.provider");
      await registry.setSetting("embedding.provider", "none");
      closeRegistryDb();

      let ftsOnly;
      try {
        ftsOnly = await runEval();
      } finally {
        const restoreRegistry = createRegistryRepository();
        if (savedProvider === null) {
          await restoreRegistry.deleteSetting("embedding.provider");
        } else {
          await restoreRegistry.setSetting("embedding.provider", savedProvider);
        }
        closeRegistryDb();
      }

      console.log("  ┌──────────────────────┬──────────────┬──────────────────┐");
      console.log("  │ Overall              │ FTS only     │ FTS + Embedding  │");
      console.log("  ├──────────────────────┼──────────────┼──────────────────┤");
      console.log(
        `  │ Recall@5             │ ${(ftsOnly.recall * 100).toFixed(2)}%       │ ${(withEmbed.recall * 100).toFixed(2)}%           │`,
      );
      console.log(
        `  │ MRR                  │ ${ftsOnly.mrr.toFixed(4)}       │ ${withEmbed.mrr.toFixed(4)}           │`,
      );
      console.log(
        `  │ Queries hit          │ ${ftsOnly.hits}/${ftsOnly.total}        │ ${withEmbed.hits}/${withEmbed.total}          │`,
      );
      console.log(
        `  │ Avg latency          │ ${ftsOnly.avgLatency.toFixed(0)} ms        │ ${withEmbed.avgLatency.toFixed(0)} ms            │`,
      );
      console.log("  └──────────────────────┴──────────────┴──────────────────┘");
      console.log("");
      console.log("  ┌──────────────────────┬──────────────┬──────────────────┐");
      console.log("  │ Keyword queries      │ FTS only     │ FTS + Embedding  │");
      console.log("  ├──────────────────────┼──────────────┼──────────────────┤");
      console.log(
        `  │ Recall@5             │ ${(ftsOnly.keywordRecall * 100).toFixed(2)}%       │ ${(withEmbed.keywordRecall * 100).toFixed(2)}%           │`,
      );
      console.log(
        `  │ Queries hit          │ ${ftsOnly.keywordHits}/${ftsOnly.keywordTotal}        │ ${withEmbed.keywordHits}/${withEmbed.keywordTotal}          │`,
      );
      console.log("  └──────────────────────┴──────────────┴──────────────────┘");
      console.log("");
      console.log("  ┌──────────────────────┬──────────────┬──────────────────┐");
      console.log("  │ Semantic queries     │ FTS only     │ FTS + Embedding  │");
      console.log("  ├──────────────────────┼──────────────┼──────────────────┤");
      console.log(
        `  │ Recall@5             │ ${(ftsOnly.semanticRecall * 100).toFixed(2)}%       │ ${(withEmbed.semanticRecall * 100).toFixed(2)}%           │`,
      );
      console.log(
        `  │ Queries hit          │ ${ftsOnly.semanticHits}/${ftsOnly.semanticTotal}         │ ${withEmbed.semanticHits}/${withEmbed.semanticTotal}          │`,
      );
      console.log("  └──────────────────────┴──────────────┴──────────────────┘");
      console.log("");

      const semanticDelta = (withEmbed.semanticRecall - ftsOnly.semanticRecall) * 100;
      console.log(
        `  Semantic Recall@5: ${ftsOnly.semanticHits}/${ftsOnly.semanticTotal} → ${withEmbed.semanticHits}/${withEmbed.semanticTotal} (${semanticDelta > 0 ? "+" : ""}${semanticDelta.toFixed(2)}%)`,
      );
      console.log("");

      expect(ftsOnly.total).toBe(evalSet.length);
      expect(withEmbed.total).toBe(evalSet.length);
      // Guard the actual benchmark outcome, not just bookkeeping:
      expect(withEmbed.recall).toBeGreaterThanOrEqual(ftsOnly.recall - 0.02);
      expect(withEmbed.semanticRecall).toBeGreaterThanOrEqual(ftsOnly.semanticRecall);
    },
    120000,
  );
});
