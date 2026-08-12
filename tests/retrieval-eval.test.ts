import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "bun:test";

import { codeQuery } from "../packages/core/src/retrieval";
import {
  closeAllWorkspaceDbs,
  closeRegistryDb,
  createRegistryRepository,
} from "../packages/db/src/sqlite";
import { ensureGraphReady, indexWorkspace } from "../packages/indexer/src";

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

  it("keeps fixture-backed FTS and graph retrieval above their quality gates", async () => {
    const repositoryRoot = path.resolve(import.meta.dir, "..");
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-retrieval-eval-"));
    const registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-retrieval-registry-"));
    const previousRegistryPath = process.env.AI_MEMORY_REGISTRY_DB_PATH;
    const cases = parseRetrievalCases(
      JSON.parse(
        fs.readFileSync(path.join(import.meta.dir, "fixtures", "retrieval-eval.json"), "utf-8"),
      ),
    );

    try {
      for (const relativePath of new Set(cases.flatMap((item) => item.expectedPaths ?? []))) {
        const sourcePath = path.join(repositoryRoot, relativePath);
        if (!fs.existsSync(sourcePath))
          throw new Error(`Stale retrieval fixture path: ${relativePath}`);
        const targetPath = path.join(workspaceRoot, relativePath);
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(sourcePath, targetPath);
      }
      fs.writeFileSync(
        path.join(workspaceRoot, "helper-graph.ts"),
        "export function helperGraph() { return 'related'; }\n",
      );
      fs.writeFileSync(
        path.join(workspaceRoot, "caller-graph.ts"),
        "import { helperGraph } from './helper-graph';\nexport function callerGraph() { return helperGraph(); }\n",
      );

      process.env.AI_MEMORY_REGISTRY_DB_PATH = path.join(registryRoot, "registry.sqlite");
      closeRegistryDb();
      const registry = createRegistryRepository();
      const workspace = await registry.createWorkspace({
        id: "retrieval-quality",
        name: "retrieval-quality",
        rootPath: workspaceRoot,
      });
      await registry.setSetting("embedding.provider", "none");
      await indexWorkspace({ workspaceId: workspace.id });

      const qualities = [];
      for (const item of cases) {
        const result = await codeQuery({
          workspaceId: workspace.id,
          query: item.query,
          limit: 10,
          recordMetrics: false,
          skipGraphExpand: true,
        });
        qualities.push(
          evaluateRetrieval(
            result.sources.map((source) => source.path),
            item.expectedPaths,
          ),
        );
      }
      const quality = summarizeQuality(qualities);
      expect(quality.recallAt5).toBeGreaterThanOrEqual(0.7);
      expect(quality.mrr).toBeGreaterThanOrEqual(0.45);

      const withoutGraph = await codeQuery({
        workspaceId: workspace.id,
        query: "callerGraph",
        limit: 5,
        recordMetrics: false,
        skipGraphExpand: true,
      });
      const withGraph = await codeQuery({
        workspaceId: workspace.id,
        query: "callerGraph",
        limit: 5,
        recordMetrics: false,
        ensureGraph: ensureGraphReady,
      });
      expect(withoutGraph.sources.map((source) => source.path)).not.toContain("helper-graph.ts");
      expect(withGraph.sources.map((source) => source.path)).toContain("helper-graph.ts");
    } finally {
      closeAllWorkspaceDbs();
      closeRegistryDb();
      if (previousRegistryPath === undefined) delete process.env.AI_MEMORY_REGISTRY_DB_PATH;
      else process.env.AI_MEMORY_REGISTRY_DB_PATH = previousRegistryPath;
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      fs.rmSync(registryRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
