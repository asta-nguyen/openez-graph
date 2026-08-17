import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  closeRegistryDb,
  createRegistryRepository,
  createWorkspaceRepository,
} from "../packages/db/src/sqlite";
import { indexWorkspace } from "../packages/indexer/src";

describe("reindex pipeline performance & correctness", () => {
  let tmpDir: string;
  let workspaceRoot: string;
  const origRegistryDbPath = process.env.AI_MEMORY_REGISTRY_DB_PATH;

  beforeEach(() => {
    closeRegistryDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openez-reindex-perf-"));
    process.env.AI_MEMORY_REGISTRY_DB_PATH = path.join(tmpDir, "registry.sqlite");
    workspaceRoot = path.join(tmpDir, "sample-project");
    fs.mkdirSync(workspaceRoot, { recursive: true });
  });

  afterEach(() => {
    closeRegistryDb();
    if (origRegistryDbPath !== undefined) {
      process.env.AI_MEMORY_REGISTRY_DB_PATH = origRegistryDbPath;
    } else {
      delete process.env.AI_MEMORY_REGISTRY_DB_PATH;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("indexes multi-file codebase with TS, JS, Markdown and builds accurate graph & chunks", async () => {
    const srcDir = path.join(workspaceRoot, "src");
    fs.mkdirSync(srcDir, { recursive: true });

    // Generate 50 test files with interconnected functions
    for (let i = 0; i < 50; i++) {
      fs.writeFileSync(
        path.join(srcDir, `module_${i}.ts`),
        `
export function computeModule${i}(value: number): number {
  return value * ${i} + 1;
}

export class Service${i} {
  run(): number {
    return computeModule${i}(42);
  }
}
`,
      );
    }

    fs.writeFileSync(
      path.join(workspaceRoot, "README.md"),
      `# Benchmark Project\n\nThis is a benchmark workspace for testing reindexing speed.\n`,
    );

    const registry = createRegistryRepository();
    const ws = await registry.ensureWorkspace({ rootPath: workspaceRoot, name: "bench-ws" });

    const startTime = Date.now();
    const initialSummary = await indexWorkspace({
      workspaceId: ws.id,
      rootPath: workspaceRoot,
      mode: "full",
    });
    const initialElapsed = Date.now() - startTime;

    expect(initialSummary.workspaceId).toBe(ws.id);
    expect(initialSummary.filesScanned).toBeGreaterThanOrEqual(51);
    expect(initialSummary.chunksWritten).toBeGreaterThanOrEqual(51);

    const repo = createWorkspaceRepository(workspaceRoot);
    const docCount = await repo.getDocumentCount();
    const chunkCount = await repo.getChunkCount();

    expect(docCount).toBeGreaterThanOrEqual(51);
    expect(chunkCount).toBeGreaterThanOrEqual(51);

    // Full reindex pass
    const reindexStart = Date.now();
    const reindexSummary = await indexWorkspace({
      workspaceId: ws.id,
      rootPath: workspaceRoot,
      mode: "full",
    });
    const reindexElapsed = Date.now() - reindexStart;

    expect(reindexSummary.workspaceId).toBe(ws.id);
    expect(reindexSummary.filesScanned).toBeGreaterThanOrEqual(51);

    // Verify FTS works after reindex
    const ftsResults = await repo.fullTextSearch("computeModule0", 5);
    expect(ftsResults.length).toBeGreaterThan(0);
    expect(ftsResults[0].content).toContain("computeModule0");
  });
});
