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
import { getRegistryNativeDb } from "../packages/db/src/sqlite/registry-db";

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
  it("waits for a concurrent registry write lock when opening the database", async () => {
    await createRegistryRepository().createWorkspace({
      id: "lock-ws",
      name: "lock-ws",
      rootPath: path.join(tempDir, "workspace"),
    });
    closeRegistryDb();
    const dbPath = resolveRegistryDbPath();
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const { Database } = require("bun:sqlite");
         const db = new Database(${JSON.stringify(dbPath)});
         db.exec("BEGIN IMMEDIATE");
         console.log("locked");
         setTimeout(() => { db.exec("COMMIT"); db.close(); }, 500);`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toContain("locked");

    const startedAt = performance.now();
    let openError: unknown;
    try {
      await createRegistryRepository().listWorkspaces();
    } catch (error) {
      openError = error;
    }
    const elapsedMs = performance.now() - startedAt;

    expect(await child.exited).toBe(0);
    expect(openError).toBeUndefined();
    expect(elapsedMs).toBeGreaterThanOrEqual(400);
  });

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
    expect(columnsAfterFirstOpen.map((column) => column.name)).toEqual(
      expect.arrayContaining(["index_generation", "graph_generation"]),
    );
    firstInspection
      .prepare("UPDATE workspaces SET graph_generation = 0 WHERE id = ?")
      .run("legacy-ws");
    firstInspection.close();
    closeRegistryDb();

    const reopened = await createRegistryRepository().getWorkspace("legacy-ws");
    expect(reopened).toMatchObject({ ...expectedWorkspace, graphGeneration: 0 });
    expect(reopened?.graphGeneration).toBe(0);
    const secondInspection = createNativeDatabase(dbPath);
    const columnsAfterReopen = secondInspection
      .prepare("PRAGMA table_info(workspaces)")
      .all() as Array<{ name: string }>;
    secondInspection.close();
    expect(columnsAfterReopen.map((column) => column.name)).toEqual(
      expect.arrayContaining(["index_generation", "graph_generation"]),
    );
  });

  it("maps an expired indexing lease to failed without mutating the stored row", async () => {
    const repo = createRegistryRepository();
    await repo.createWorkspace({
      id: "expired-ws",
      name: "expired-ws",
      rootPath: "/tmp/expired-ws",
    });
    expect(
      await repo.tryClaimIndexing(
        "expired-ws",
        "owner-a",
        new Date(Date.now() - 60_000).toISOString(),
      ),
    ).toBe(true);

    const native = getRegistryNativeDb();
    const before = native.prepare("SELECT * FROM workspaces WHERE id = ?").get("expired-ws");
    const workspace = await repo.getWorkspace("expired-ws");
    const after = native.prepare("SELECT * FROM workspaces WHERE id = ?").get("expired-ws");

    expect(workspace).toMatchObject({
      status: "error",
      indexingStatus: "failed",
      lastError: "Index lease expired; the previous index run was interrupted.",
    });
    expect(after).toEqual(before);
    expect(
      await repo.tryClaimIndexing(
        "expired-ws",
        "owner-b",
        new Date(Date.now() + 60_000).toISOString(),
      ),
    ).toBe(true);
  });

  it("keeps a running workspace unchanged while its index lease is live", async () => {
    const repo = createRegistryRepository();
    await repo.createWorkspace({ id: "live-ws", name: "live-ws", rootPath: "/tmp/live-ws" });
    const leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
    expect(await repo.tryClaimIndexing("live-ws", "owner-a", leaseExpiresAt)).toBe(true);

    expect(await repo.getWorkspace("live-ws")).toMatchObject({
      status: "indexing",
      indexingStatus: "running",
      indexLeaseExpiresAt: leaseExpiresAt,
    });
  });

  it("reports a running workspace with a NULL index lease as failed", async () => {
    const repo = createRegistryRepository();
    await repo.createWorkspace({
      id: "null-lease-ws",
      name: "null-lease-ws",
      rootPath: "/tmp/null-lease-ws",
    });
    expect(
      await repo.tryClaimIndexing(
        "null-lease-ws",
        "owner-a",
        new Date(Date.now() + 60_000).toISOString(),
      ),
    ).toBe(true);
    getRegistryNativeDb()
      .prepare("UPDATE workspaces SET index_lease_expires_at = NULL WHERE id = ?")
      .run("null-lease-ws");

    expect(await repo.getWorkspace("null-lease-ws")).toMatchObject({
      status: "error",
      indexingStatus: "failed",
      lastError: "Index lease expired; the previous index run was interrupted.",
    });
  });

  it("keeps a stored error when an indexing lease has expired", async () => {
    const repo = createRegistryRepository();
    await repo.createWorkspace({
      id: "stored-error-ws",
      name: "stored-error-ws",
      rootPath: "/tmp/stored-error-ws",
    });
    await repo.tryClaimIndexing(
      "stored-error-ws",
      "owner-a",
      new Date(Date.now() - 60_000).toISOString(),
    );
    getRegistryNativeDb()
      .prepare("UPDATE workspaces SET last_error = ? WHERE id = ?")
      .run("previous indexing error", "stored-error-ws");

    expect(await repo.getWorkspace("stored-error-ws")).toMatchObject({
      indexingStatus: "failed",
      status: "error",
      lastError: "previous indexing error",
    });
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

  it("atomically serializes workspace index claims", async () => {
    const repo = createRegistryRepository();
    await repo.createWorkspace({ id: "ws1", name: "ws1", rootPath: "/tmp/ws1" });

    const firstExpiry = new Date(Date.now() + 60_000).toISOString();
    expect(await repo.tryClaimIndexing("ws1", "owner-a", firstExpiry)).toBe(true);
    expect(await repo.tryClaimIndexing("ws1", "owner-b", firstExpiry)).toBe(false);
    expect(await repo.refreshIndexingLease("ws1", "owner-b", firstExpiry)).toBe(false);
    expect(await repo.releaseIndexing("ws1", "owner-b", "aborted")).toBe(false);
    expect(await repo.releaseIndexing("ws1", "owner-a", "aborted")).toBe(true);
    expect(await repo.tryClaimIndexing("ws1", "owner-b", firstExpiry)).toBe(true);
  });

  it("allows a new owner to take over an expired indexing lease", async () => {
    const repo = createRegistryRepository();
    await repo.createWorkspace({ id: "ws1", name: "ws1", rootPath: "/tmp/ws1" });
    const firstExpiry = new Date(Date.now() + 60_000).toISOString();

    expect(
      await repo.tryClaimIndexing("ws1", "owner-a", new Date(Date.now() - 1_000).toISOString()),
    ).toBe(true);
    expect(await repo.tryClaimIndexing("ws1", "owner-b", firstExpiry)).toBe(true);
    expect(await repo.refreshIndexingLease("ws1", "owner-a", firstExpiry)).toBe(false);
  });

  it("fences stale index completions and failures by owner token", async () => {
    const repo = createRegistryRepository();
    await repo.createWorkspace({ id: "ws1", name: "ws1", rootPath: "/tmp/ws1" });

    const expiredLease = new Date(Date.now() - 1_000).toISOString();
    const futureLease = new Date(Date.now() + 60_000).toISOString();

    expect(await repo.tryClaimIndexing("ws1", "owner-a", expiredLease)).toBe(true);
    expect(await repo.tryClaimIndexing("ws1", "owner-b", futureLease)).toBe(true);

    // Stale owner cannot complete or fail
    expect(
      await repo.completeIndexing("ws1", "owner-a", {
        documentCount: 99,
        chunkCount: 99,
        nodeCount: 99,
        edgeCount: 99,
        completedAt: "2026-08-11T00:00:00.000Z",
      }),
    ).toBe(false);
    expect(await repo.failIndexing("ws1", "owner-a", "stale error")).toBe(false);

    // Current owner can complete
    expect(
      await repo.completeIndexing("ws1", "owner-b", {
        documentCount: 2,
        chunkCount: 5,
        nodeCount: 3,
        edgeCount: 1,
        completedAt: "2026-08-11T00:00:00.000Z",
      }),
    ).toBe(true);

    const ws = await repo.getWorkspace("ws1");
    expect(ws?.status).toBe("indexed");
    expect(ws?.indexingStatus).toBe("completed");
    expect(ws?.documentCount).toBe(2);
    expect(ws?.indexBuildOwner).toBeUndefined();
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
