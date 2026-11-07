import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { closeRegistryDb, createRegistryRepository } from "../packages/db/src/sqlite";
import { getRegistryNativeDb } from "../packages/db/src/sqlite/registry-db";

describe("CLI prune", () => {
  let tempRoot: string;
  const originalRegistryDbPath = process.env.AI_MEMORY_REGISTRY_DB_PATH;

  beforeEach(() => {
    closeRegistryDb();
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-cli-prune-"));
    process.env.AI_MEMORY_REGISTRY_DB_PATH = path.join(tempRoot, "registry.sqlite");
  });

  afterEach(() => {
    closeRegistryDb();
    if (originalRegistryDbPath === undefined) delete process.env.AI_MEMORY_REGISTRY_DB_PATH;
    else process.env.AI_MEMORY_REGISTRY_DB_PATH = originalRegistryDbPath;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const prune = (...args: string[]) =>
    execFileSync(
      process.execPath,
      [path.resolve(import.meta.dir, "../apps/cli/src/cli.ts"), "prune", ...args],
      { encoding: "utf8", env: process.env },
    );

  const registeredIds = async () => {
    const ids = (await createRegistryRepository().listWorkspaces()).map((w) => w.id).sort();
    closeRegistryDb();
    return ids;
  };

  test("lists workspaces with a missing root, and removes them only with -y", async () => {
    const repo = createRegistryRepository();
    for (const id of ["keep", "gone"]) {
      const rootPath = path.join(tempRoot, id);
      fs.mkdirSync(rootPath);
      await repo.createWorkspace({ id, name: id, rootPath });
    }
    fs.rmSync(path.join(tempRoot, "gone"), { recursive: true });
    closeRegistryDb();

    const dryRun = prune();
    expect(dryRun).toContain("(gone)");
    expect(dryRun).not.toContain("(keep)");
    expect(dryRun).toContain("prune -y");
    expect(await registeredIds()).toEqual(["gone", "keep"]);

    expect(prune("-y")).toContain("Pruned 1 of 1");
    expect(await registeredIds()).toEqual(["keep"]);
  });

  test("also removes a legacy filesystem-root entry (issue #43)", async () => {
    getRegistryNativeDb()
      .prepare(
        `INSERT INTO workspaces (id, name, root_path, include_globs, exclude_globs, status, indexing_status, graph_status, document_count, chunk_count, node_count, edge_count, created_at, updated_at)
         VALUES ('workspace', 'workspace', '/', '', '', 'error', 'failed', 'pending', 0, 0, 0, 0, '2026-08-18T00:00:00.000Z', '2026-08-18T00:00:00.000Z')`,
      )
      .run();
    closeRegistryDb();

    expect(prune()).toContain("(workspace)");
    prune("-y");
    expect(await registeredIds()).toEqual([]);
  });

  test("says so when nothing is stale", async () => {
    const rootPath = path.join(tempRoot, "alive");
    fs.mkdirSync(rootPath);
    await createRegistryRepository().createWorkspace({ id: "alive", name: "alive", rootPath });
    closeRegistryDb();

    expect(prune("-y")).toContain("No workspaces with a missing root");
    expect(await registeredIds()).toEqual(["alive"]);
  });
});
