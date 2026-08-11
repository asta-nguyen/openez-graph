import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  closeRegistryDb,
  createRegistryRepository,
  resolveRegistryDbPath,
} from "../packages/db/src/sqlite/index";
import { createNativeDatabase } from "../packages/db/src/sqlite/database-loader";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openez-test-"));
  process.env.AI_MEMORY_REGISTRY_DB_PATH = path.join(tempDir, "registry.sqlite");
  closeRegistryDb();
});

afterEach(() => {
  closeRegistryDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.AI_MEMORY_REGISTRY_DB_PATH;
});

describe("resolveRegistryDbPath", () => {
  it("respects AI_MEMORY_REGISTRY_DB_PATH env override", () => {
    expect(resolveRegistryDbPath()).toBe(path.join(tempDir, "registry.sqlite"));
  });
});

describe("createRegistryRepository", () => {
  it("migrates legacy registries and invalidates pre-existing completed graphs", async () => {
    const dbPath = resolveRegistryDbPath();
    const legacy = createNativeDatabase(dbPath);
    legacy.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        root_path TEXT NOT NULL UNIQUE,
        include_globs TEXT NOT NULL DEFAULT '',
        exclude_globs TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        indexing_status TEXT NOT NULL DEFAULT 'pending',
        graph_status TEXT NOT NULL DEFAULT 'pending',
        last_indexed_at TEXT,
        last_graph_built_at TEXT,
        document_count INTEGER NOT NULL DEFAULT 0,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        node_count INTEGER NOT NULL DEFAULT 0,
        edge_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO workspaces (
        id, name, root_path, include_globs, exclude_globs, status, indexing_status, graph_status,
        last_indexed_at, last_graph_built_at, document_count, chunk_count, node_count, edge_count,
        last_error, created_at, updated_at
      ) VALUES (
        'legacy-ws', 'legacy workspace', '/tmp/legacy-workspace', '**/*.ts', 'node_modules',
        'indexed', 'completed', 'completed', '2026-08-01T00:00:00.000Z',
        '2026-08-01T01:00:00.000Z', 3, 7, 11, 13, NULL,
        '2026-08-01T00:00:00.000Z', '2026-08-01T01:00:00.000Z'
      );
    `);
    legacy.close();

    const expectedWorkspace = {
      id: "legacy-ws",
      name: "legacy workspace",
      rootPath: "/tmp/legacy-workspace",
      includeGlobs: "**/*.ts",
      excludeGlobs: "node_modules",
      status: "indexed",
      indexingStatus: "completed",
      graphStatus: "completed",
      lastIndexedAt: "2026-08-01T00:00:00.000Z",
      lastGraphBuiltAt: "2026-08-01T01:00:00.000Z",
      documentCount: 3,
      chunkCount: 7,
      nodeCount: 11,
      edgeCount: 13,
      lastError: undefined,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T01:00:00.000Z",
      indexGeneration: 0,
      // Migration invalidates old completed graphs by setting graph_generation
      // to -1, forcing a rebuild on next access (picks up parser changes).
      graphGeneration: -1,
    };
    const repository = createRegistryRepository();
    const migrated = await repository.getWorkspace("legacy-ws");
    expect(migrated).toMatchObject(expectedWorkspace);
    const firstInspection = createNativeDatabase(dbPath);
    const columnsAfterFirstOpen = firstInspection
      .prepare("PRAGMA table_info(workspaces)")
      .all() as Array<{ name: string }>;
    firstInspection.close();
    expect(columnsAfterFirstOpen.map((column) => column.name)).toEqual(
      expect.arrayContaining(["index_generation", "graph_generation"]),
    );
    closeRegistryDb();

    const reopened = await createRegistryRepository().getWorkspace("legacy-ws");
    expect(reopened).toMatchObject(expectedWorkspace);
    const secondInspection = createNativeDatabase(dbPath);
    const columnsAfterReopen = secondInspection
      .prepare("PRAGMA table_info(workspaces)")
      .all() as Array<{ name: string }>;
    secondInspection.close();
    expect(columnsAfterReopen.map((column) => column.name)).toEqual(
      expect.arrayContaining(["index_generation", "graph_generation"]),
    );
  });

  it("creates and lists workspaces", async () => {
    const repo = createRegistryRepository();

    const created = await repo.createWorkspace({
      id: "test-ws",
      name: "test-workspace",
      rootPath: "/tmp/test-workspace",
    });

    expect(created.id).toBe("test-ws");
    expect(created.name).toBe("test-workspace");
    expect(created.rootPath).toBe("/tmp/test-workspace");
    expect(created.status).toBe("pending");

    const list = await repo.listWorkspaces();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe("test-ws");
  });

  it("getWorkspace returns null for unknown id", async () => {
    const repo = createRegistryRepository();
    const ws = await repo.getWorkspace("does-not-exist");
    expect(ws).toBeNull();
  });

  it("getWorkspaceByPath finds by root path", async () => {
    const repo = createRegistryRepository();
    await repo.createWorkspace({
      id: "ws1",
      name: "ws1",
      rootPath: "/tmp/abc",
    });

    const found = await repo.getWorkspaceByPath("/tmp/abc");
    expect(found?.id).toBe("ws1");

    const notFound = await repo.getWorkspaceByPath("/tmp/xyz");
    expect(notFound).toBeNull();
  });

  it("resolves filesystem aliases to one workspace", async () => {
    const repo = createRegistryRepository();
    const actualRoot = path.join(tempDir, "actual-workspace");
    const aliasRoot = path.join(tempDir, "workspace-alias");
    fs.mkdirSync(actualRoot);
    fs.symlinkSync(actualRoot, aliasRoot, "dir");

    const created = await repo.ensureWorkspace({ rootPath: aliasRoot });
    expect(created.rootPath).toBe(fs.realpathSync.native(actualRoot));
    expect((await repo.getWorkspaceByPath(actualRoot))?.id).toBe(created.id);
  });

  it("ensureWorkspace is idempotent by path", async () => {
    const repo = createRegistryRepository();

    const first = await repo.ensureWorkspace({ rootPath: "/tmp/proj", name: "proj" });
    const second = await repo.ensureWorkspace({ rootPath: "/tmp/proj", name: "proj" });

    expect(first.id).toBe(second.id);
    const list = await repo.listWorkspaces();
    expect(list).toHaveLength(1);
  });

  it("ensureWorkspace generates unique id when collision occurs", async () => {
    const repo = createRegistryRepository();

    await repo.createWorkspace({
      id: "proj",
      name: "proj",
      rootPath: "/tmp/proj-a",
    });

    const second = await repo.ensureWorkspace({ rootPath: "/tmp/proj-b", name: "proj" });
    expect(second.id).not.toBe("proj");
    expect(second.name).not.toBe("proj");
  });

  it("updateWorkspace mutates fields", async () => {
    const repo = createRegistryRepository();
    await repo.createWorkspace({
      id: "ws1",
      name: "ws1",
      rootPath: "/tmp/ws1",
    });

    await repo.updateWorkspace("ws1", {
      status: "indexed",
      indexingStatus: "completed",
      documentCount: 42,
    });

    const updated = await repo.getWorkspace("ws1");
    expect(updated?.status).toBe("indexed");
    expect(updated?.indexingStatus).toBe("completed");
    expect(updated?.documentCount).toBe(42);
  });

  it("fences stale graph builders by owner token and monotonically increasing epoch", async () => {
    const repo = createRegistryRepository();
    await repo.createWorkspace({ id: "ws1", name: "ws1", rootPath: "/tmp/ws1" });

    const expiredLease = new Date(Date.now() - 1_000).toISOString();
    const futureLease = new Date(Date.now() + 60_000).toISOString();
    const firstEpoch = await repo.tryClaimGraphBuild("ws1", "owner-a", expiredLease);
    const secondEpoch = await repo.tryClaimGraphBuild("ws1", "owner-b", futureLease);

    expect(firstEpoch).toBe(1);
    expect(secondEpoch).toBe(2);
    expect(await repo.refreshGraphBuildLease("ws1", "owner-a", futureLease)).toBe(false);
    expect(
      await repo.completeGraphBuild("ws1", "owner-a", 0, {
        nodeCount: 99,
        edgeCount: 99,
        completedAt: "2026-08-10T00:00:00.000Z",
      }),
    ).toBe(false);
    expect(
      await repo.completeGraphBuild("ws1", "owner-b", 0, {
        nodeCount: 2,
        edgeCount: 1,
        completedAt: "2026-08-10T00:00:00.000Z",
      }),
    ).toBe(true);
  });

  it("keeps an active graph owner while indexing invalidates its generation", async () => {
    const repo = createRegistryRepository();
    await repo.createWorkspace({ id: "ws1", name: "ws1", rootPath: "/tmp/ws1" });
    await repo.tryClaimGraphBuild("ws1", "owner-a", "2099-08-10T00:00:00.000Z");

    await repo.invalidateWorkspaceGraph("ws1");

    const workspace = await repo.getWorkspace("ws1");
    expect(workspace?.graphStatus).toBe("running");
    expect(workspace?.indexGeneration).toBe(1);
    expect(await repo.refreshGraphBuildLease("ws1", "owner-a", "2099-08-10T00:00:00.000Z")).toBe(
      true,
    );
  });

  it("deleteWorkspace removes the workspace", async () => {
    const repo = createRegistryRepository();
    await repo.createWorkspace({
      id: "ws1",
      name: "ws1",
      rootPath: "/tmp/ws1",
    });

    await repo.deleteWorkspace("ws1");
    const list = await repo.listWorkspaces();
    expect(list).toHaveLength(0);
  });

  it("setPinned sets and clears pinnedAt", async () => {
    const repo = createRegistryRepository();
    await repo.createWorkspace({ id: "ws1", name: "ws1", rootPath: "/tmp/ws1" });

    await repo.setPinned("ws1", true);
    expect(typeof (await repo.getWorkspace("ws1"))?.pinnedAt).toBe("string");

    await repo.setPinned("ws1", false);
    expect((await repo.getWorkspace("ws1"))?.pinnedAt).toBeUndefined();
  });

  it("listWorkspaces sorts pinned first (newest pin on top)", async () => {
    const repo = createRegistryRepository();
    await repo.createWorkspace({ id: "a", name: "a", rootPath: "/tmp/a" });
    await repo.createWorkspace({ id: "b", name: "b", rootPath: "/tmp/b" });
    await repo.createWorkspace({ id: "c", name: "c", rootPath: "/tmp/c" });

    await repo.setPinned("a", true);
    await repo.setPinned("c", true);

    expect((await repo.listWorkspaces()).map((w) => w.id)).toEqual(["c", "a", "b"]);

    await repo.setPinned("c", false);
    expect((await repo.listWorkspaces()).map((w) => w.id)[0]).toBe("a");
  });
});
