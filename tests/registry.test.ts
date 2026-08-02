import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  closeRegistryDb,
  createRegistryRepository,
  resolveRegistryDbPath,
} from "../packages/db/src/sqlite/index";

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
});
