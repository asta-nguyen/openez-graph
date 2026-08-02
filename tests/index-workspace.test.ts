import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { closeAllWorkspaceDbs, closeRegistryDb, createRegistryRepository, createWorkspaceRepository } from "../packages/db/src/sqlite";
import { indexWorkspace } from "../packages/indexer/src/index-workspace";
import { codeContext } from "../packages/core/src/graph";

let registryRoot: string;
let workspaceRoot: string;

beforeEach(() => {
  registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-index-registry-"));
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-index-workspace-"));
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

describe("indexWorkspace", () => {
  it("removes deleted files and bounds large code chunks", async () => {
    const sourcePath = path.join(workspaceRoot, "large.ts");
    fs.writeFileSync(sourcePath, `export function helper() { return 1; }\nexport function caller() { return large(); }\nexport function large() {\n  helper();\n${"console.log('bounded');\n".repeat(1000)}}`);
    const workspace = await createRegistryRepository().ensureWorkspace({ rootPath: workspaceRoot });

    await indexWorkspace({ workspaceId: workspace.id });
    const repo = createWorkspaceRepository(workspaceRoot);
    const document = await repo.getDocumentByPath("large.ts");
    const chunks = await repo.getChunksByDocument(document!.id);
    expect(chunks.length).toBeGreaterThan(1);
    expect(Math.max(...chunks.map((chunk) => chunk.tokenCount))).toBeLessThanOrEqual(700);

    const context = await codeContext({ workspaceId: workspace.id, symbolOrPath: "large", hops: 1 });
    expect(context.symbol?.label).toBe("large");
    expect(context.callers).toHaveLength(1);
    expect(context.callees).toHaveLength(1);
    const limitedContext = await codeContext({ workspaceId: workspace.id, symbolOrPath: "large", hops: 1, limit: 2 });
    const limitedCount = Number(Boolean(limitedContext.symbol))
      + limitedContext.files.length
      + limitedContext.callers.length
      + limitedContext.callees.length
      + limitedContext.relatedChunks.length;
    expect(limitedCount).toBeLessThanOrEqual(2);
    const largeEdges = await repo.queryRaw(
      `SELECT e.type, count(*) AS count
       FROM graph_edges e
       JOIN graph_nodes target ON target.id = e.to_node_id
       WHERE target.label = 'large'
       GROUP BY e.type`
    );
    expect(largeEdges.find((edge) => edge.type === "defines")?.count).toBe(1);

    await indexWorkspace({ workspaceId: workspace.id, mode: "full" });
    const runs = await repo.queryRaw("SELECT status FROM index_runs ORDER BY started_at");
    expect(runs.length).toBe(2);
    expect(runs.every((r) => r.status === "completed")).toBe(true);

    fs.unlinkSync(sourcePath);
    await indexWorkspace({ workspaceId: workspace.id });
    expect(await repo.getDocumentByPath("large.ts")).toBeNull();
    expect(await repo.getChunkCount()).toBe(0);
    expect(await repo.getNodeCount()).toBe(0);
  });

  it("rebuilds calls to an unchanged unique symbol during incremental indexing", async () => {
    fs.writeFileSync(path.join(workspaceRoot, "helper.ts"), "export function helper() { return 1; }\n");
    const callerPath = path.join(workspaceRoot, "caller.ts");
    fs.writeFileSync(callerPath, "export function caller() { return helper(); }\n");
    const workspace = await createRegistryRepository().ensureWorkspace({ rootPath: workspaceRoot });

    await indexWorkspace({ workspaceId: workspace.id });
    fs.writeFileSync(callerPath, "export function caller() { return helper() + 1; }\n");
    await indexWorkspace({ workspaceId: workspace.id });

    const context = await codeContext({ workspaceId: workspace.id, symbolOrPath: "helper", hops: 1 });
    expect(context.callers).toHaveLength(1);
  });

  it("preserves inbound call edge when only callee implementation changes", async () => {
    const helperPath = path.join(workspaceRoot, "helper.ts");
    fs.writeFileSync(helperPath, "export function helper() { return 1; }\n");
    fs.writeFileSync(path.join(workspaceRoot, "caller.ts"), "export function caller() { return helper(); }\n");
    const workspace = await createRegistryRepository().ensureWorkspace({ rootPath: workspaceRoot });

    await indexWorkspace({ workspaceId: workspace.id });
    const contextBefore = await codeContext({ workspaceId: workspace.id, symbolOrPath: "helper", hops: 1 });
    expect(contextBefore.callers).toHaveLength(1);

    // Only change helper implementation, not its name/exports
    fs.writeFileSync(helperPath, "export function helper() { return 42; }\n");
    await indexWorkspace({ workspaceId: workspace.id });

    const contextAfter = await codeContext({ workspaceId: workspace.id, symbolOrPath: "helper", hops: 1 });
    expect(contextAfter.callers).toHaveLength(1);
  });

  it("preserves inbound import edge when only imported file content changes", async () => {
    const targetPath = path.join(workspaceRoot, "target.ts");
    fs.writeFileSync(targetPath, "export function target() { return 1; }\n");
    fs.writeFileSync(path.join(workspaceRoot, "importer.ts"), "import { target } from './target';\nexport function useTarget() { return target(); }\n");
    const workspace = await createRegistryRepository().ensureWorkspace({ rootPath: workspaceRoot });

    await indexWorkspace({ workspaceId: workspace.id });
    const repo = createWorkspaceRepository(workspaceRoot);

    const importEdgesBefore = await repo.queryRaw(
      `SELECT count(*) AS c FROM graph_edges e
       JOIN graph_nodes n ON n.id = e.from_node_id
       WHERE e.type = 'imports' AND n.label = 'importer.ts'`
    );
    expect(Number(importEdgesBefore[0].c)).toBe(1);

    // Change only the target file content
    fs.writeFileSync(targetPath, "export function target() { return 2; }\n");
    await indexWorkspace({ workspaceId: workspace.id });

    const importEdgesAfter = await repo.queryRaw(
      `SELECT count(*) AS c FROM graph_edges e
       JOIN graph_nodes n ON n.id = e.from_node_id
       WHERE e.type = 'imports' AND n.label = 'importer.ts'`
    );
    expect(Number(importEdgesAfter[0].c)).toBe(1);
  });

  it("removes inbound call edge when callee symbol is deleted", async () => {
    const helperPath = path.join(workspaceRoot, "helper.ts");
    fs.writeFileSync(helperPath, "export function helper() { return 1; }\n");
    fs.writeFileSync(path.join(workspaceRoot, "caller.ts"), "export function caller() { return helper(); }\n");
    const workspace = await createRegistryRepository().ensureWorkspace({ rootPath: workspaceRoot });

    await indexWorkspace({ workspaceId: workspace.id });
    const contextBefore = await codeContext({ workspaceId: workspace.id, symbolOrPath: "helper", hops: 1 });
    expect(contextBefore.callers).toHaveLength(1);

    // Remove the helper symbol entirely
    fs.writeFileSync(helperPath, "export function otherFunc() { return 1; }\n");
    await indexWorkspace({ workspaceId: workspace.id });

    const contextAfter = await codeContext({ workspaceId: workspace.id, symbolOrPath: "helper", hops: 1 });
    expect(contextAfter.symbol).toBeFalsy();
  });

  it("does not duplicate edges across repeated incremental runs with no changes", async () => {
    fs.writeFileSync(path.join(workspaceRoot, "a.ts"), "export function a() { return 1; }\n");
    fs.writeFileSync(path.join(workspaceRoot, "b.ts"), "import { a } from './a';\nexport function b() { return a(); }\n");
    const workspace = await createRegistryRepository().ensureWorkspace({ rootPath: workspaceRoot });
    const repo = createWorkspaceRepository(workspaceRoot);

    await indexWorkspace({ workspaceId: workspace.id });
    const edgesAfter1 = await repo.getEdgeCount();

    await indexWorkspace({ workspaceId: workspace.id });
    const edgesAfter2 = await repo.getEdgeCount();

    await indexWorkspace({ workspaceId: workspace.id });
    const edgesAfter3 = await repo.getEdgeCount();

    expect(edgesAfter1).toBe(edgesAfter2);
    expect(edgesAfter2).toBe(edgesAfter3);
  });

  it("deduplicates imports that resolve to the same file", async () => {
    fs.writeFileSync(path.join(workspaceRoot, "target.ts"), "export const a = 1;\nexport const b = 2;\n");
    fs.writeFileSync(
      path.join(workspaceRoot, "importer.ts"),
      "import { a } from './target';\nimport { b } from './target';\nexport const value = a + b;\n"
    );
    const workspace = await createRegistryRepository().ensureWorkspace({ rootPath: workspaceRoot });
    const repo = createWorkspaceRepository(workspaceRoot);

    await indexWorkspace({ workspaceId: workspace.id });

    const imports = await repo.queryRaw(
      `SELECT count(*) AS count
       FROM graph_edges edge
       JOIN graph_nodes source ON source.id = edge.from_node_id
       JOIN graph_nodes target ON target.id = edge.to_node_id
       WHERE edge.type = 'imports' AND source.label = 'importer.ts' AND target.label = 'target.ts'`
    );
    expect(imports).toEqual([{ count: 1 }]);
  });

  it("updates file metadata when content is unchanged", async () => {
    const sourcePath = path.join(workspaceRoot, "a.ts");
    fs.writeFileSync(sourcePath, "export const a = 1;\n");
    const workspace = await createRegistryRepository().ensureWorkspace({ rootPath: workspaceRoot });
    const repo = createWorkspaceRepository(workspaceRoot);

    await indexWorkspace({ workspaceId: workspace.id });
    const touchedAt = new Date(Date.now() + 5_000);
    fs.utimesSync(sourcePath, touchedAt, touchedAt);

    const readSpy = vi.spyOn(fsPromises, "readFile");
    const sourceWasRead = () => readSpy.mock.calls.some(([filePath]) => fs.realpathSync(String(filePath)) === fs.realpathSync(sourcePath));
    expect((await indexWorkspace({ workspaceId: workspace.id })).filesUpdated).toBe(0);
    expect(sourceWasRead()).toBe(true);
    expect((await repo.getDocumentByPath("a.ts"))?.mtimeMs).toBe(Math.trunc(fs.statSync(sourcePath).mtimeMs));
    readSpy.mockClear();
    expect((await indexWorkspace({ workspaceId: workspace.id })).filesUpdated).toBe(0);
    expect(sourceWasRead()).toBe(false);
    readSpy.mockRestore();
  });

  it("preserves memories and run history across full reindex", async () => {
    fs.writeFileSync(path.join(workspaceRoot, "a.ts"), "export function a() { return 1; }\n");
    const workspace = await createRegistryRepository().ensureWorkspace({ rootPath: workspaceRoot });
    const repo = createWorkspaceRepository(workspaceRoot);

    await indexWorkspace({ workspaceId: workspace.id });

    await repo.insertMemory({ title: "test-mem", content: "hello", source: "test" });
    await repo.insertQueryLog({ query: "test", mode: "fts", resultCount: 1 });

    expect(await repo.queryRaw("SELECT count(*) AS c FROM memories")).toEqual([{ c: 1 }]);
    expect(await repo.queryRaw("SELECT count(*) AS c FROM query_logs")).toEqual([{ c: 1 }]);
    const runsBefore = await repo.queryRaw("SELECT count(*) AS c FROM index_runs");
    const runsBeforeCount = Number(runsBefore[0].c);

    await indexWorkspace({ workspaceId: workspace.id, mode: "full" });

    expect(await repo.queryRaw("SELECT count(*) AS c FROM memories")).toEqual([{ c: 1 }]);
    expect(await repo.queryRaw("SELECT count(*) AS c FROM query_logs")).toEqual([{ c: 1 }]);
    const runsAfter = await repo.queryRaw("SELECT count(*) AS c FROM index_runs");
    expect(Number(runsAfter[0].c)).toBe(runsBeforeCount + 1);

    const docs = await repo.queryRaw("SELECT count(*) AS c FROM documents");
    expect(Number(docs[0].c)).toBe(1);
  });
});
