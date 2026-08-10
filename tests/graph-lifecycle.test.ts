import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  closeAllWorkspaceDbs,
  closeRegistryDb,
  createRegistryRepository,
  createWorkspaceRepository,
} from "../packages/db/src/sqlite";
import { getRegistryNativeDb } from "../packages/db/src/sqlite/registry-db";
import { codeQuery } from "../packages/core/src/retrieval";
import { createGraphService, ensureGraphReady } from "../packages/indexer/src/graph-service";
import { indexWorkspace } from "../packages/indexer/src/index-workspace";

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
    await ensureGraphReady(workspace.id);
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
    await ensureGraphReady(workspace.id);

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
    await ensureGraphReady(workspace.id);
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
    await ensureGraphReady(workspace.id);
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
    await ensureGraphReady(workspace.id);
    const before = await registry.getWorkspace(workspace.id);

    fs.unlinkSync(deletedSource);
    fs.writeFileSync(changedSource, "export function newName() {}\n");
    await indexWorkspace({ workspaceId: workspace.id, mode: "incremental" });
    closeRegistryDb();

    const reopened = await createRegistryRepository().getWorkspace(workspace.id);
    expect(reopened?.graphStatus).toBe("pending");
    expect(reopened?.indexGeneration).toBe((before?.indexGeneration ?? -1) + 1);
  });

  it("builds graph when code_query is the first graph-aware operation", async () => {
    fs.writeFileSync(path.join(workspaceRoot, "a.ts"), "export function target() {}\n");
    fs.writeFileSync(
      path.join(workspaceRoot, "b.ts"),
      "import { target } from './a';\nexport function caller() { target(); }\n",
    );
    const registry = createRegistryRepository();
    const workspace = await registry.ensureWorkspace({ rootPath: workspaceRoot });
    await indexWorkspace({ workspaceId: workspace.id });

    expect(await createWorkspaceRepository(workspaceRoot).getNodeCount()).toBe(0);
    // codeQuery lazy-builds the graph via the ensureGraph callback —
    // direct consumers of @openez-graph/core get graph expansion too.
    await codeQuery({
      workspaceId: workspace.id,
      query: "target",
      ensureGraph: ensureGraphReady,
    });

    expect(await createWorkspaceRepository(workspaceRoot).getNodeCount()).toBeGreaterThan(0);
  });

  it("codeQuery with skipGraphExpand does not build the graph", async () => {
    fs.writeFileSync(path.join(workspaceRoot, "a.ts"), "export function target() {}\n");
    fs.writeFileSync(
      path.join(workspaceRoot, "b.ts"),
      "import { target } from './a';\nexport function caller() { target(); }\n",
    );
    const registry = createRegistryRepository();
    const workspace = await registry.ensureWorkspace({ rootPath: workspaceRoot });
    await indexWorkspace({ workspaceId: workspace.id });

    expect(await createWorkspaceRepository(workspaceRoot).getNodeCount()).toBe(0);
    // With skipGraphExpand, codeQuery skips graph building but still returns FTS results
    const result = await codeQuery({
      workspaceId: workspace.id,
      query: "target",
      skipGraphExpand: true,
    });
    expect(result.sources.length).toBeGreaterThan(0);
    expect(await createWorkspaceRepository(workspaceRoot).getNodeCount()).toBe(0);
  });

  it("coalesces concurrent graph readiness checks for one workspace", async () => {
    const registry = createRegistryRepository();
    const workspace = await registry.ensureWorkspace({ rootPath: workspaceRoot });
    let builds = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = createGraphService({
      registry,
      async buildGraphGeneration() {
        builds += 1;
        await blocked;
        return { nodeCount: 1, edgeCount: 0 };
      },
      now: () => "2026-08-09T00:00:00.000Z",
    });

    const first = service.ensureGraphReady(workspace.id);
    const second = service.ensureGraphReady(workspace.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(builds).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(builds).toBe(1);
  });

  it("rebuilds the current generation when an older build becomes stale", async () => {
    const registry = createRegistryRepository();
    const workspace = await registry.ensureWorkspace({ rootPath: workspaceRoot });
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const generations: number[] = [];
    const service = createGraphService({
      registry,
      async buildGraphGeneration(_id, _root, generation) {
        generations.push(generation);
        if (generation === 0) await firstBlocked;
        return { nodeCount: generation + 1, edgeCount: generation + 2 };
      },
      now: () => "2026-08-09T00:00:00.000Z",
    });

    const ready = service.ensureGraphReady(workspace.id);
    await Promise.resolve();
    await registry.invalidateWorkspaceGraph(workspace.id);
    releaseFirst();
    await ready;

    const current = await registry.getWorkspace(workspace.id);
    expect(generations).toEqual([0, 1]);
    expect(current?.graphStatus).toBe("completed");
    expect(current?.graphGeneration).toBe(1);
    expect(current?.nodeCount).toBe(2);
    expect(current?.edgeCount).toBe(3);
  });

  it("marks the owned graph build failed when indexing invalidates before a build error", async () => {
    const registry = createRegistryRepository();
    const workspace = await registry.ensureWorkspace({ rootPath: workspaceRoot });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = createGraphService({
      registry,
      async buildGraphGeneration() {
        await blocked;
        throw new Error("parse failed");
      },
      now: () => "2026-08-10T00:00:00.000Z",
    });

    const ready = service.ensureGraphReady(workspace.id);
    await Promise.resolve();
    await registry.invalidateWorkspaceGraph(workspace.id);
    release();

    await expect(ready).rejects.toThrow("parse failed");
    const current = await registry.getWorkspace(workspace.id);
    expect(current?.graphStatus).toBe("failed");
    expect(current?.lastError).toBe("parse failed");
  }, 1_000);

  it("takes over an expired cross-process lease without waiting for the old builder", async () => {
    const registry = createRegistryRepository();
    const workspace = await registry.ensureWorkspace({ rootPath: workspaceRoot });
    let releaseOld!: () => void;
    const oldBlocked = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    let newBuilds = 0;
    const oldService = createGraphService({
      registry,
      async buildGraphGeneration() {
        await oldBlocked;
        return { nodeCount: 99, edgeCount: 99 };
      },
      now: () => "2026-08-10T00:00:00.000Z",
    });
    const newService = createGraphService({
      registry,
      async buildGraphGeneration() {
        newBuilds += 1;
        return { nodeCount: 2, edgeCount: 1 };
      },
      now: () => "2026-08-10T00:00:00.000Z",
    });

    const oldReady = oldService.ensureGraphReady(workspace.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    getRegistryNativeDb()
      .prepare("UPDATE workspaces SET graph_lease_expires_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", workspace.id);

    await newService.ensureGraphReady(workspace.id);
    releaseOld();
    await oldReady;

    const current = await registry.getWorkspace(workspace.id);
    expect(newBuilds).toBe(1);
    expect(current?.graphStatus).toBe("completed");
    expect(current?.nodeCount).toBe(2);
    expect(current?.edgeCount).toBe(1);
  });

  it("keeps graph builds scoped to canonical workspace IDs with matching basenames", async () => {
    const parentA = fs.mkdtempSync(path.join(os.tmpdir(), "openez-graph-a-"));
    const parentB = fs.mkdtempSync(path.join(os.tmpdir(), "openez-graph-b-"));
    const rootA = path.join(parentA, "same-name");
    const rootB = path.join(parentB, "same-name");
    fs.mkdirSync(rootA);
    fs.mkdirSync(rootB);
    try {
      fs.writeFileSync(path.join(rootA, "a.ts"), "export function one() {}\n");
      fs.writeFileSync(path.join(rootB, "b.ts"), "export function two() {}\n");
      const registry = createRegistryRepository();
      const workspaceA = await registry.ensureWorkspace({ rootPath: rootA });
      const workspaceB = await registry.ensureWorkspace({ rootPath: rootB });
      await indexWorkspace({ workspaceId: workspaceA.id });
      await indexWorkspace({ workspaceId: workspaceB.id });

      await ensureGraphReady(workspaceA.id);
      expect(await createWorkspaceRepository(rootA).getNodeCount()).toBeGreaterThan(0);
      expect(await createWorkspaceRepository(rootB).getNodeCount()).toBe(0);

      await ensureGraphReady(workspaceB.id);
      expect(await createWorkspaceRepository(rootB).getNodeCount()).toBeGreaterThan(0);
    } finally {
      fs.rmSync(parentA, { recursive: true, force: true });
      fs.rmSync(parentB, { recursive: true, force: true });
    }
  });
});
