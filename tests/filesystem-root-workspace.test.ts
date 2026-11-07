import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { autoIndexAndSync } from "../apps/mcp/src/mcp-core";
import { createWebServer } from "../apps/web/src/server/index";
import { closeRegistryDb as closeWebRegistryDb } from "../apps/web/src/server/sqlite";
import {
  closeAllWorkspaceDbs,
  closeRegistryDb,
  createRegistryRepository,
  getWorkspaceDb,
  writeLocalWorkspaceConfig,
} from "../packages/db/src/sqlite/index";
import { getRegistryNativeDb } from "../packages/db/src/sqlite/registry-db";
import { indexWorkspace } from "../packages/indexer/src";

// Issue #43: a workspace whose rootPath is the filesystem root ("/") must never be registered,
// and a legacy "/" row must not be picked as the active workspace.

let tempDir: string;
const app = createWebServer();

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openez-fsroot-"));
  process.env.AI_MEMORY_REGISTRY_DB_PATH = path.join(tempDir, "registry.sqlite");
  closeRegistryDb();
  closeWebRegistryDb();
  closeAllWorkspaceDbs();
});

afterEach(() => {
  closeAllWorkspaceDbs();
  closeWebRegistryDb();
  closeRegistryDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.AI_MEMORY_REGISTRY_DB_PATH;
});

/** Inserts a "/" row the way a pre-fix registry holds it, bypassing the repository guard. */
function insertLegacyRootRow() {
  const now = "2999-01-01T00:00:00.000Z"; // newest first, so list-order pickers hit it first
  getRegistryNativeDb()
    .prepare(
      `INSERT INTO workspaces (id, name, root_path, include_globs, exclude_globs, status, indexing_status, graph_status, document_count, chunk_count, node_count, edge_count, created_at, updated_at)
       VALUES ('workspace', 'workspace', '/', '', '', 'error', 'failed', 'pending', 0, 0, 0, 0, ?, ?)`,
    )
    .run(now, now);
}

async function createIndexedRealWorkspace() {
  const root = path.join(tempDir, "real");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "a.ts"), "export const answer = 42;\n");
  await indexWorkspace({ rootPath: root });
  return (await createRegistryRepository().getWorkspaceByPath(root))!;
}

describe("registry", () => {
  it("refuses to register a filesystem root", async () => {
    const repo = createRegistryRepository();
    await expect(repo.ensureWorkspace({ rootPath: "/" })).rejects.toThrow(/filesystem root/);
    await expect(repo.createWorkspace({ id: "r", name: "r", rootPath: "/" })).rejects.toThrow(
      /filesystem root/,
    );
    expect(await repo.listWorkspaces()).toEqual([]);
  });

  it("refuses to open a workspace db or write the local hint at a filesystem root", async () => {
    expect(() => getWorkspaceDb("/")).toThrow(/filesystem root/);
    await expect(
      writeLocalWorkspaceConfig({ id: "workspace", name: "workspace", rootPath: "/" }),
    ).rejects.toThrow(/filesystem root/);
  });

  it("still registers an ordinary directory", async () => {
    const ws = await createRegistryRepository().ensureWorkspace({ rootPath: tempDir });
    expect(ws.rootPath).toBe(fs.realpathSync.native(tempDir));
  });
});

describe("MCP autoIndexAndSync", () => {
  it("does not register a filesystem root and does not throw", async () => {
    await autoIndexAndSync("/");
    expect(await createRegistryRepository().listWorkspaces()).toEqual([]);
  });
});

describe("web server", () => {
  it("rejects a filesystem root in validate-path and workspace creation", async () => {
    const post = (url: string) =>
      app.request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rootPath: "/" }),
      });

    expect((await (await post("/api/validate-path")).json()).valid).toBe(false);
    expect((await (await post("/api/workspaces")).json()).success).toBe(false);
    expect(await createRegistryRepository().listWorkspaces()).toEqual([]);
  });

  it("ignores a legacy '/' row when choosing the active workspace", async () => {
    await createIndexedRealWorkspace();
    insertLegacyRootRow();

    const created = await app.request("/api/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "t", content: "c" }),
    });
    expect((await created.json()).ok).toBe(true);

    const memories = await (await app.request("/api/memories")).json();
    expect(memories.totalCount).toBe(1);

    const documents = await (await app.request("/api/documents")).json();
    expect(documents.totalCount).toBeGreaterThan(0);
  });
});
