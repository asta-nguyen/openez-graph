import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  closeAllWorkspaceDbs,
  closeRegistryDb,
  createRegistryRepository,
} from "../packages/db/src/sqlite";
import { buildGraphForWorkspace, indexWorkspace } from "../packages/indexer/src/index-workspace";

let registryRoot: string;
let workspaceRoot: string;

beforeEach(() => {
  registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-graph-registry-"));
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-graph-workspace-"));
  process.env.AI_MEMORY_REGISTRY_DB_PATH = path.join(registryRoot, "registry.sqlite");
  process.env.EMBEDDING_PROVIDER = "none";
  closeRegistryDb();
  closeAllWorkspaceDbs();
});

afterEach(() => {
  closeAllWorkspaceDbs();
  closeRegistryDb();
  fs.rmSync(registryRoot, { recursive: true, force: true });
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.AI_MEMORY_REGISTRY_DB_PATH;
  delete process.env.EMBEDDING_PROVIDER;
});

describe("graph lifecycle persistence", () => {
  it("persists graph pending after an incremental symbol change", async () => {
    const source = path.join(workspaceRoot, "symbol.ts");
    fs.writeFileSync(source, "export function oldName() {}\n");
    const registry = createRegistryRepository();
    const workspace = await registry.ensureWorkspace({ rootPath: workspaceRoot });
    await indexWorkspace({ workspaceId: workspace.id });
    await buildGraphForWorkspace(workspace.id, workspace.rootPath);
    const before = await registry.getWorkspace(workspace.id);

    fs.writeFileSync(source, "export function newName() {}\n");
    await indexWorkspace({ workspaceId: workspace.id, mode: "incremental" });
    closeRegistryDb();

    const reopened = await createRegistryRepository().getWorkspace(workspace.id);
    expect(reopened?.graphStatus).toBe("pending");
    expect(reopened?.indexGeneration).toBe((before?.indexGeneration ?? -1) + 1);
  });

  it("preserves completed graph state and generations for a no-op incremental index", async () => {
    const source = path.join(workspaceRoot, "symbol.ts");
    fs.writeFileSync(source, "export function symbol() {}\n");
    const registry = createRegistryRepository();
    const workspace = await registry.ensureWorkspace({ rootPath: workspaceRoot });
    await indexWorkspace({ workspaceId: workspace.id });
    await buildGraphForWorkspace(workspace.id, workspace.rootPath);

    const before = await registry.getWorkspace(workspace.id);
    await indexWorkspace({ workspaceId: workspace.id, mode: "incremental" });
    const after = await registry.getWorkspace(workspace.id);

    expect(after?.graphStatus).toBe("completed");
    expect(after?.indexGeneration).toBe(before?.indexGeneration);
    expect(after?.graphGeneration).toBe(before?.graphGeneration);
  });

  it("persists graph pending after a source deletion", async () => {
    const source = path.join(workspaceRoot, "symbol.ts");
    fs.writeFileSync(source, "export function symbol() {}\n");
    const registry = createRegistryRepository();
    const workspace = await registry.ensureWorkspace({ rootPath: workspaceRoot });
    await indexWorkspace({ workspaceId: workspace.id });
    await buildGraphForWorkspace(workspace.id, workspace.rootPath);
    const before = await registry.getWorkspace(workspace.id);

    fs.unlinkSync(source);
    await indexWorkspace({ workspaceId: workspace.id, mode: "incremental" });
    closeRegistryDb();

    const reopened = await createRegistryRepository().getWorkspace(workspace.id);
    expect(reopened?.graphStatus).toBe("pending");
    expect(reopened?.indexGeneration).toBe((before?.indexGeneration ?? -1) + 1);
  });

  it("persists one graph generation after a full reset", async () => {
    const source = path.join(workspaceRoot, "symbol.ts");
    fs.writeFileSync(source, "export function symbol() {}\n");
    const registry = createRegistryRepository();
    const workspace = await registry.ensureWorkspace({ rootPath: workspaceRoot });
    await indexWorkspace({ workspaceId: workspace.id });
    await buildGraphForWorkspace(workspace.id, workspace.rootPath);
    const before = await registry.getWorkspace(workspace.id);

    await indexWorkspace({ workspaceId: workspace.id, mode: "full" });
    closeRegistryDb();

    const reopened = await createRegistryRepository().getWorkspace(workspace.id);
    expect(reopened?.graphStatus).toBe("pending");
    expect(reopened?.indexGeneration).toBe((before?.indexGeneration ?? -1) + 1);
  });

  it("coalesces deletion and source changes into one graph generation", async () => {
    const deletedSource = path.join(workspaceRoot, "deleted.ts");
    const changedSource = path.join(workspaceRoot, "changed.ts");
    fs.writeFileSync(deletedSource, "export function deleted() {}\n");
    fs.writeFileSync(changedSource, "export function oldName() {}\n");
    const registry = createRegistryRepository();
    const workspace = await registry.ensureWorkspace({ rootPath: workspaceRoot });
    await indexWorkspace({ workspaceId: workspace.id });
    await buildGraphForWorkspace(workspace.id, workspace.rootPath);
    const before = await registry.getWorkspace(workspace.id);

    fs.unlinkSync(deletedSource);
    fs.writeFileSync(changedSource, "export function newName() {}\n");
    await indexWorkspace({ workspaceId: workspace.id, mode: "incremental" });
    closeRegistryDb();

    const reopened = await createRegistryRepository().getWorkspace(workspace.id);
    expect(reopened?.graphStatus).toBe("pending");
    expect(reopened?.indexGeneration).toBe((before?.indexGeneration ?? -1) + 1);
  });
});
