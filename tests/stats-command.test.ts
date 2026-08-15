import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createRegistryRepository, createWorkspaceRepository } from "../packages/db/src/sqlite";

describe("openez stats & query metrics", () => {
  let tmpDir: string;
  let workspaceRoot: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openez-stats-test-"));
    workspaceRoot = path.join(tmpDir, "sample-project");
    fs.mkdirSync(workspaceRoot, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("computes zero metrics when no queries have been executed", async () => {
    const repo = createWorkspaceRepository(workspaceRoot);
    const metrics = await repo.getQueryMetrics();

    expect(metrics.totalQueries).toBe(0);
    expect(metrics.totalTokensReturned).toBe(0);
    expect(metrics.totalTokensSaved).toBe(0);
    expect(metrics.totalFilesScanned).toBe(0);
    expect(metrics.avgTokensPerQuery).toBe(0);
    expect(metrics.savingsPercentage).toBe(0);
    expect(metrics.recentQueries).toEqual([]);
  });

  test("accurately aggregates token savings, averages, and recent queries", async () => {
    const repo = createWorkspaceRepository(workspaceRoot);

    await repo.insertQueryLog({
      query: "how does indexing work?",
      mode: "code_query",
      resultCount: 3,
      tokensReturned: 300,
      tokensSaved: 12000,
      filesScanned: 8,
    });

    await repo.insertQueryLog({
      query: "find parser implementation",
      mode: "code_query",
      resultCount: 2,
      tokensReturned: 200,
      tokensSaved: 8000,
      filesScanned: 5,
    });

    const metrics = await repo.getQueryMetrics(5);

    expect(metrics.totalQueries).toBe(2);
    expect(metrics.totalTokensReturned).toBe(500);
    expect(metrics.totalTokensSaved).toBe(20000);
    expect(metrics.totalFilesScanned).toBe(13);
    expect(metrics.avgTokensPerQuery).toBe(250);
    // (20000 / 20500) * 100 = 97.56% -> 97.6%
    expect(metrics.savingsPercentage).toBe(97.6);
    expect(metrics.recentQueries.length).toBe(2);
    expect(metrics.recentQueries[0].query).toBe("find parser implementation");
    expect(metrics.recentQueries[0].tokensSaved).toBe(8000);
    expect(metrics.recentQueries[1].query).toBe("how does indexing work?");
    expect(metrics.recentQueries[1].tokensSaved).toBe(12000);
  });

  test("counts memories accurately via getMemoryCount", async () => {
    const repo = createWorkspaceRepository(workspaceRoot);
    expect(await repo.getMemoryCount()).toBe(0);

    await repo.insertMemory({
      title: "Architecture Rule",
      content: "Use WAL mode for SQLite",
      source: "manual",
    });

    expect(await repo.getMemoryCount()).toBe(1);
  });
});
