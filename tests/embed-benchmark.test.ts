import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { getEmbeddingConfig } from "../packages/core/src/embeddings";
import { codeQuery } from "../packages/core/src/retrieval";
import {
  closeAllWorkspaceDbs,
  closeRegistryDb,
  createRegistryRepository,
  createWorkspaceRepository,
} from "../packages/db/src/sqlite";
import { embedWorkspace, ensureGraphReady, indexWorkspace } from "../packages/indexer/src";
import {
  evaluateRetrieval,
  parseRetrievalCases,
  summarizeQuality,
} from "../packages/indexer/src/retrieval-eval";

const RUN_BENCHMARK = process.env.OPENEZ_RUN_BENCHMARK === "1";
const COMPARE_EMBEDDINGS = process.env.OPENEZ_BENCHMARK_EMBEDDINGS === "1";
const FTS_RECALL_FLOOR = 0.7;
const FTS_MRR_FLOOR = 0.45;
const benchmarkRoot = path.resolve(process.env.OPENEZ_BENCHMARK_WORKSPACE_PATH ?? process.cwd());
const workspaceId = process.env.OPENEZ_BENCHMARK_WORKSPACE ?? "openez-benchmark";
const loadSuite = (file: string) =>
  parseRetrievalCases(
    JSON.parse(fs.readFileSync(path.join(import.meta.dir, "fixtures", file), "utf-8")),
  );
const suites = {
  concept: loadSuite("retrieval-eval.json"),
  identifiers: loadSuite("retrieval-eval-identifiers.json"),
  relations: loadSuite("retrieval-eval-relations.json"),
  docs: loadSuite("retrieval-eval-docs.json"),
};
const cases = suites.concept;

async function runEvaluation(suiteCases: typeof cases, graph: boolean) {
  const qualities = [];
  const misses: Array<{ query: string; firstRelevantRank: number | null }> = [];
  let latencyMs = 0;
  for (const item of suiteCases) {
    const startedAt = performance.now();
    const result = await codeQuery({
      workspaceId,
      query: item.query,
      limit: 10,
      recordMetrics: false,
      ...(graph ? { ensureGraph: ensureGraphReady } : { skipGraphExpand: true as const }),
    });
    latencyMs += performance.now() - startedAt;
    const quality = evaluateRetrieval(
      result.sources.map((source) => source.path),
      item.expectedPaths,
    );
    qualities.push(quality);
    if (quality.firstRelevantRank !== 1) {
      misses.push({ query: item.query, firstRelevantRank: quality.firstRelevantRank });
    }
  }
  return { ...summarizeQuality(qualities), avgLatencyMs: latencyMs / suiteCases.length, misses };
}

describe("retrieval benchmark", () => {
  let registryDir: string | null = null;
  let savedRegistryPath: string | undefined;
  let benchmarkStarted = false;
  let realEmbeddingSettings: Record<string, string> = {};

  beforeAll(async () => {
    if (!RUN_BENCHMARK) return;
    benchmarkStarted = true;

    const expectedPaths = [
      ...new Set(
        Object.values(suites)
          .flat()
          .flatMap((item) => item.expectedPaths ?? []),
      ),
    ];
    const missing = expectedPaths.filter(
      (relativePath) => !fs.existsSync(path.join(benchmarkRoot, relativePath)),
    );
    if (missing.length > 0) throw new Error(`Stale retrieval fixture paths: ${missing.join(", ")}`);
  }, 120_000);

  beforeAll(async () => {
    if (!RUN_BENCHMARK) return;

    savedRegistryPath = process.env.AI_MEMORY_REGISTRY_DB_PATH;
    delete process.env.AI_MEMORY_REGISTRY_DB_PATH;
    closeRegistryDb();
    realEmbeddingSettings = await createRegistryRepository().getAllSettings();
    closeRegistryDb();

    registryDir = fs.mkdtempSync(path.join(os.tmpdir(), "openez-benchmark-"));
    process.env.AI_MEMORY_REGISTRY_DB_PATH = path.join(registryDir, "registry.sqlite");
    const registry = createRegistryRepository();
    await registry.createWorkspace({ id: workspaceId, name: workspaceId, rootPath: benchmarkRoot });
    if (COMPARE_EMBEDDINGS) {
      for (const [key, value] of Object.entries(realEmbeddingSettings)) {
        if (key.startsWith("embedding.")) await registry.setSetting(key, value);
      }
      if (process.env.EMBEDDING_PROVIDER) {
        await registry.setSetting("embedding.provider", process.env.EMBEDDING_PROVIDER);
      }
      if (process.env.OPENEZ_LOCAL_EMBEDDING_MODEL) {
        await registry.setSetting(
          "embedding.local_model",
          process.env.OPENEZ_LOCAL_EMBEDDING_MODEL,
        );
      }
    } else {
      await registry.setSetting("embedding.provider", "none");
    }
    closeRegistryDb();
    await indexWorkspace({ workspaceId });
    if (COMPARE_EMBEDDINGS) {
      const embedded = await embedWorkspace({ workspaceId });
      if (embedded.embeddingsWritten === 0 && embedded.chunksConsidered > 0) {
        const repo = createWorkspaceRepository(benchmarkRoot);
        const [rows] = await repo.queryRaw("SELECT count(*) AS c FROM embeddings");
        if (Number(rows?.c ?? 0) === 0) throw new Error("Embedding benchmark produced no vectors");
      }
    }
  }, 120_000);

  afterAll(() => {
    if (!benchmarkStarted) return;
    closeAllWorkspaceDbs();
    closeRegistryDb();
    if (savedRegistryPath === undefined) delete process.env.AI_MEMORY_REGISTRY_DB_PATH;
    else process.env.AI_MEMORY_REGISTRY_DB_PATH = savedRegistryPath;
    if (registryDir) fs.rmSync(registryDir, { recursive: true, force: true });
  });

  it.skipIf(!RUN_BENCHMARK)(
    "meets the FTS quality floor and optionally compares embeddings",
    async () => {
      const config = await getEmbeddingConfig();
      const runAll = async (graph: boolean) => {
        const out = {} as Record<keyof typeof suites, Awaited<ReturnType<typeof runEvaluation>>>;
        for (const [name, suiteCases] of Object.entries(suites)) {
          out[name as keyof typeof suites] = await runEvaluation(suiteCases, graph);
        }
        return out;
      };
      const report: Record<string, Awaited<ReturnType<typeof runAll>>> = {};

      const withEmbeddings = COMPARE_EMBEDDINGS && config.provider !== "none";
      const embeddingsReport: typeof report = {};
      if (withEmbeddings) {
        embeddingsReport.hybrid = await runAll(false);
        embeddingsReport["hybrid+graph"] = await runAll(true);
      }

      const registry = createRegistryRepository();
      const savedProvider = await registry.getSetting("embedding.provider");
      await registry.setSetting("embedding.provider", "none");
      closeRegistryDb();
      report.lexical = await runAll(false);
      report["lexical+graph"] = await runAll(true);
      const restore = createRegistryRepository();
      if (savedProvider === null) await restore.deleteSetting("embedding.provider");
      else await restore.setSetting("embedding.provider", savedProvider);
      closeRegistryDb();

      const repo = createWorkspaceRepository(benchmarkRoot);
      const [stats] = await repo.queryRaw(
        "SELECT (SELECT count(*) FROM documents) AS files, (SELECT count(*) FROM chunks) AS chunks",
      );
      console.log(
        JSON.stringify(
          {
            workspaceId,
            files: Number(stats?.files ?? 0),
            chunks: Number(stats?.chunks ?? 0),
            queries: Object.fromEntries(Object.entries(suites).map(([k, v]) => [k, v.length])),
            ...report,
            ...embeddingsReport,
          },
          null,
          2,
        ),
      );

      const fts = report.lexical.concept;
      expect(fts.evaluatedRuns).toBe(cases.length);
      expect(fts.recallAt5).toBeGreaterThanOrEqual(FTS_RECALL_FLOOR);
      expect(fts.mrr).toBeGreaterThanOrEqual(FTS_MRR_FLOOR);
      if (withEmbeddings) {
        expect(embeddingsReport.hybrid.concept.recallAt5).toBeGreaterThanOrEqual(
          fts.recallAt5 - 0.02,
        );
      }
    },
    120_000,
  );
});
