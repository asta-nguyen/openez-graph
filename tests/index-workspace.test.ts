import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeAllWorkspaceDbs,
  closeRegistryDb,
  createRegistryRepository,
  createWorkspaceRepository,
} from "../packages/db/src/sqlite";
import {
  indexWorkspace,
  buildGraphForWorkspace,
  waitForFts,
} from "../packages/indexer/src/index-workspace";
import { codeContext } from "../packages/core/src/graph";
import { countTokens, setFastTokenCount } from "../packages/core/src/tokenizer";

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
    fs.writeFileSync(
      sourcePath,
      `export function helper() { return 1; }\nexport function caller() { return large(); }\nexport function large() {\n  helper();\n${"console.log('bounded');\n".repeat(1000)}}`,
    );
    const workspace = await createRegistryRepository().ensureWorkspace({ rootPath: workspaceRoot });

    await indexWorkspace({ workspaceId: workspace.id });
    await buildGraphForWorkspace(workspace.id, workspace.rootPath);
    const repo = createWorkspaceRepository(workspaceRoot);
    const document = await repo.getDocumentByPath("large.ts");
    const chunks = await repo.getChunksByDocument(document!.id);
    expect(chunks.length).toBeGreaterThan(1);
    expect(Math.max(...chunks.map((chunk) => chunk.tokenCount))).toBeLessThanOrEqual(1024);

    const context = await codeContext({
      workspaceId: workspace.id,
      symbolOrPath: "large",
      hops: 1,
    });
    expect(context.symbol?.label).toBe("large");
    expect(context.callers).toHaveLength(1);
    expect(context.callees).toHaveLength(1);
    const limitedContext = await codeContext({
      workspaceId: workspace.id,
      symbolOrPath: "large",
      hops: 1,
      limit: 2,
    });
    const limitedCount =
      Number(Boolean(limitedContext.symbol)) +
      limitedContext.files.length +
      limitedContext.callers.length +
      limitedContext.callees.length +
      limitedContext.relatedChunks.length;
    expect(limitedCount).toBeLessThanOrEqual(2);
    const largeEdges = await repo.queryRaw(
      `SELECT e.type, count(*) AS count
       FROM graph_edges e
       JOIN graph_nodes target ON target.id = e.to_node_id
       WHERE target.label = 'large'
       GROUP BY e.type`,
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
    fs.writeFileSync(
      path.join(workspaceRoot, "helper.ts"),
      "export function helper() { return 1; }\n",
    );
    const callerPath = path.join(workspaceRoot, "caller.ts");
    fs.writeFileSync(callerPath, "export function caller() { return helper(); }\n");
    const workspace = await createRegistryRepository().ensureWorkspace({ rootPath: workspaceRoot });

    await indexWorkspace({ workspaceId: workspace.id });
    fs.writeFileSync(callerPath, "export function caller() { return helper() + 1; }\n");
    await indexWorkspace({ workspaceId: workspace.id });
    await buildGraphForWorkspace(workspace.id, workspace.rootPath);

    const context = await codeContext({
      workspaceId: workspace.id,
      symbolOrPath: "helper",
      hops: 1,
    });
    expect(context.callers).toHaveLength(1);
  });

  it("preserves inbound call edge when only callee implementation changes", async () => {
    const helperPath = path.join(workspaceRoot, "helper.ts");
    fs.writeFileSync(helperPath, "export function helper() { return 1; }\n");
    fs.writeFileSync(
      path.join(workspaceRoot, "caller.ts"),
      "export function caller() { return helper(); }\n",
    );
    const workspace = await createRegistryRepository().ensureWorkspace({ rootPath: workspaceRoot });

    await indexWorkspace({ workspaceId: workspace.id });
    await buildGraphForWorkspace(workspace.id, workspace.rootPath);
    const contextBefore = await codeContext({
      workspaceId: workspace.id,
      symbolOrPath: "helper",
      hops: 1,
    });
    expect(contextBefore.callers).toHaveLength(1);

    // Only change helper implementation, not its name/exports
    fs.writeFileSync(helperPath, "export function helper() { return 42; }\n");
    await indexWorkspace({ workspaceId: workspace.id });
    await buildGraphForWorkspace(workspace.id, workspace.rootPath);

    const contextAfter = await codeContext({
      workspaceId: workspace.id,
      symbolOrPath: "helper",
      hops: 1,
    });
    expect(contextAfter.callers).toHaveLength(1);
  });

  it("preserves inbound import edge when only imported file content changes", async () => {
    const targetPath = path.join(workspaceRoot, "target.ts");
    fs.writeFileSync(targetPath, "export function target() { return 1; }\n");
    fs.writeFileSync(
      path.join(workspaceRoot, "importer.ts"),
      "import { target } from './target';\nexport function useTarget() { return target(); }\n",
    );
    const workspace = await createRegistryRepository().ensureWorkspace({ rootPath: workspaceRoot });

    await indexWorkspace({ workspaceId: workspace.id });
    await buildGraphForWorkspace(workspace.id, workspace.rootPath);
    const repo = createWorkspaceRepository(workspaceRoot);

    const importEdgesBefore = await repo.queryRaw(
      `SELECT count(*) AS c FROM graph_edges e
       JOIN graph_nodes n ON n.id = e.from_node_id
       WHERE e.type = 'imports' AND n.label = 'importer.ts'`,
    );
    expect(Number(importEdgesBefore[0].c)).toBe(1);

    // Change only the target file content
    fs.writeFileSync(targetPath, "export function target() { return 2; }\n");
    await indexWorkspace({ workspaceId: workspace.id });
    await buildGraphForWorkspace(workspace.id, workspace.rootPath);

    const importEdgesAfter = await repo.queryRaw(
      `SELECT count(*) AS c FROM graph_edges e
       JOIN graph_nodes n ON n.id = e.from_node_id
       WHERE e.type = 'imports' AND n.label = 'importer.ts'`,
    );
    expect(Number(importEdgesAfter[0].c)).toBe(1);
  });

  it("removes inbound call edge when callee symbol is deleted", async () => {
    const helperPath = path.join(workspaceRoot, "helper.ts");
    fs.writeFileSync(helperPath, "export function helper() { return 1; }\n");
    fs.writeFileSync(
      path.join(workspaceRoot, "caller.ts"),
      "export function caller() { return helper(); }\n",
    );
    const workspace = await createRegistryRepository().ensureWorkspace({ rootPath: workspaceRoot });

    await indexWorkspace({ workspaceId: workspace.id });
    await buildGraphForWorkspace(workspace.id, workspace.rootPath);
    const contextBefore = await codeContext({
      workspaceId: workspace.id,
      symbolOrPath: "helper",
      hops: 1,
    });
    expect(contextBefore.callers).toHaveLength(1);

    // Remove the helper symbol entirely
    fs.writeFileSync(helperPath, "export function otherFunc() { return 1; }\n");
    await indexWorkspace({ workspaceId: workspace.id });
    await buildGraphForWorkspace(workspace.id, workspace.rootPath);

    const contextAfter = await codeContext({
      workspaceId: workspace.id,
      symbolOrPath: "helper",
      hops: 1,
    });
    expect(contextAfter.symbol).toBeFalsy();
  });

  it("does not duplicate edges across repeated incremental runs with no changes", async () => {
    fs.writeFileSync(path.join(workspaceRoot, "a.ts"), "export function a() { return 1; }\n");
    fs.writeFileSync(
      path.join(workspaceRoot, "b.ts"),
      "import { a } from './a';\nexport function b() { return a(); }\n",
    );
    const workspace = await createRegistryRepository().ensureWorkspace({ rootPath: workspaceRoot });
    const repo = createWorkspaceRepository(workspaceRoot);

    await indexWorkspace({ workspaceId: workspace.id });
    await buildGraphForWorkspace(workspace.id, workspace.rootPath);
    const edgesAfter1 = await repo.getEdgeCount();

    await indexWorkspace({ workspaceId: workspace.id });
    await buildGraphForWorkspace(workspace.id, workspace.rootPath);
    const edgesAfter2 = await repo.getEdgeCount();

    await indexWorkspace({ workspaceId: workspace.id });
    await buildGraphForWorkspace(workspace.id, workspace.rootPath);
    const edgesAfter3 = await repo.getEdgeCount();

    expect(edgesAfter1).toBe(edgesAfter2);
    expect(edgesAfter2).toBe(edgesAfter3);
  });

  it("deduplicates imports that resolve to the same file", async () => {
    fs.writeFileSync(
      path.join(workspaceRoot, "target.ts"),
      "export const a = 1;\nexport const b = 2;\n",
    );
    fs.writeFileSync(
      path.join(workspaceRoot, "importer.ts"),
      "import { a } from './target';\nimport { b } from './target';\nexport const value = a + b;\n",
    );
    const workspace = await createRegistryRepository().ensureWorkspace({ rootPath: workspaceRoot });
    const repo = createWorkspaceRepository(workspaceRoot);

    await indexWorkspace({ workspaceId: workspace.id });
    await buildGraphForWorkspace(workspace.id, workspace.rootPath);

    const imports = await repo.queryRaw(
      `SELECT count(*) AS count
       FROM graph_edges edge
       JOIN graph_nodes source ON source.id = edge.from_node_id
       JOIN graph_nodes target ON target.id = edge.to_node_id
       WHERE edge.type = 'imports' AND source.label = 'importer.ts' AND target.label = 'target.ts'`,
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
    const sourceWasRead = () =>
      readSpy.mock.calls.some(
        ([filePath]) => fs.realpathSync(String(filePath)) === fs.realpathSync(sourcePath),
      );
    expect((await indexWorkspace({ workspaceId: workspace.id })).filesUpdated).toBe(0);
    expect(sourceWasRead()).toBe(true);
    expect((await repo.getDocumentByPath("a.ts"))?.mtimeMs).toBe(
      Math.trunc(fs.statSync(sourcePath).mtimeMs),
    );
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

  it("builds TS file and symbol nodes with valid chunk refIds", async () => {
    fs.writeFileSync(
      path.join(workspaceRoot, "helper.ts"),
      "export function helper() { return 1; }\n",
    );
    fs.writeFileSync(
      path.join(workspaceRoot, "caller.ts"),
      "import { helper } from './helper';\nexport function caller() { return helper(); }\n",
    );
    const workspace = await createRegistryRepository().ensureWorkspace({ rootPath: workspaceRoot });
    const repo = createWorkspaceRepository(workspaceRoot);

    await indexWorkspace({ workspaceId: workspace.id });
    await buildGraphForWorkspace(workspace.id, workspace.rootPath);

    // File nodes exist
    const fileNodes = await repo.queryRaw(
      `SELECT label, ref_id FROM graph_nodes WHERE type = 'file' ORDER BY label`,
    );
    expect(fileNodes.map((n: any) => n.label)).toContain("caller.ts");
    expect(fileNodes.map((n: any) => n.label)).toContain("helper.ts");

    // Symbol nodes exist with refId pointing to chunks (not documents)
    const symbolNodes = await repo.queryRaw(
      `SELECT label, ref_id FROM graph_nodes WHERE type = 'symbol' ORDER BY label`,
    );
    const helperNode = symbolNodes.find((n: any) => n.label === "helper");
    const callerNode = symbolNodes.find((n: any) => n.label === "caller");
    expect(helperNode).toBeTruthy();
    expect(callerNode).toBeTruthy();

    // refId should point to a chunk ID, not a document ID
    if (helperNode && helperNode.ref_id) {
      const chunkMatch = await repo.queryRaw(`SELECT count(*) AS c FROM chunks WHERE id = ?`, [
        helperNode.ref_id,
      ]);
      expect(Number(chunkMatch[0].c)).toBe(1);
    }

    // codeContext returns callers with source snippets
    const context = await codeContext({
      workspaceId: workspace.id,
      symbolOrPath: "helper",
      hops: 1,
    });
    expect(context.callers).toContainEqual(expect.objectContaining({ symbol: "caller" }));
    expect(context.symbol?.snippet).toContain("function helper");
  });

  it("creates imports edge from caller to target", async () => {
    fs.writeFileSync(
      path.join(workspaceRoot, "target.ts"),
      "export function target() { return 1; }\n",
    );
    fs.writeFileSync(
      path.join(workspaceRoot, "caller.ts"),
      "import { target } from './target';\nexport function caller() { return target(); }\n",
    );
    const workspace = await createRegistryRepository().ensureWorkspace({ rootPath: workspaceRoot });
    const repo = createWorkspaceRepository(workspaceRoot);

    await indexWorkspace({ workspaceId: workspace.id });
    await buildGraphForWorkspace(workspace.id, workspace.rootPath);

    const importEdges = await repo.queryRaw(
      `SELECT count(*) AS count
       FROM graph_edges edge
       JOIN graph_nodes source ON source.id = edge.from_node_id
       JOIN graph_nodes target ON target.id = edge.to_node_id
       WHERE edge.type = 'imports' AND source.label = 'caller.ts' AND target.label = 'target.ts'`,
    );
    expect(importEdges).toEqual([{ count: 1 }]);
  });

  it("isolates same-basename workspaces in graph cache", async () => {
    // Two workspaces whose root directories have the same basename
    const parentA = fs.mkdtempSync(path.join(os.tmpdir(), "openez-basename-"));
    const parentB = fs.mkdtempSync(path.join(os.tmpdir(), "openez-basename-"));
    const rootA = path.join(parentA, "project");
    const rootB = path.join(parentB, "project");
    fs.mkdirSync(rootA, { recursive: true });
    fs.mkdirSync(rootB, { recursive: true });

    try {
      fs.writeFileSync(path.join(rootA, "mod.ts"), "export function alpha() { return 1; }\n");
      fs.writeFileSync(path.join(rootB, "mod.ts"), "export function beta() { return 1; }\n");

      const wsA = await createRegistryRepository().ensureWorkspace({ rootPath: rootA });
      const wsB = await createRegistryRepository().ensureWorkspace({ rootPath: rootB });

      await indexWorkspace({ workspaceId: wsA.id });
      await indexWorkspace({ workspaceId: wsB.id });
      await buildGraphForWorkspace(wsA.id, wsA.rootPath);
      await buildGraphForWorkspace(wsB.id, wsB.rootPath);

      const repoA = createWorkspaceRepository(rootA);
      const repoB = createWorkspaceRepository(rootB);

      const symbolsA = await repoA.queryRaw(`SELECT label FROM graph_nodes WHERE type = 'symbol'`);
      const symbolsB = await repoB.queryRaw(`SELECT label FROM graph_nodes WHERE type = 'symbol'`);

      expect(symbolsA.map((s: any) => s.label)).toContain("alpha");
      expect(symbolsA.map((s: any) => s.label)).not.toContain("beta");
      expect(symbolsB.map((s: any) => s.label)).toContain("beta");
      expect(symbolsB.map((s: any) => s.label)).not.toContain("alpha");
    } finally {
      closeAllWorkspaceDbs();
      fs.rmSync(parentA, { recursive: true, force: true });
      fs.rmSync(parentB, { recursive: true, force: true });
    }
  });

  it("handles concurrent buildGraphForWorkspace calls without duplicates", async () => {
    fs.writeFileSync(path.join(workspaceRoot, "a.ts"), "export function a() { return 1; }\n");
    fs.writeFileSync(path.join(workspaceRoot, "b.ts"), "export function b() { return a(); }\n");
    const workspace = await createRegistryRepository().ensureWorkspace({ rootPath: workspaceRoot });
    const repo = createWorkspaceRepository(workspaceRoot);

    await indexWorkspace({ workspaceId: workspace.id });

    // Two concurrent calls should share the same build promise
    await Promise.all([
      buildGraphForWorkspace(workspace.id, workspace.rootPath),
      buildGraphForWorkspace(workspace.id, workspace.rootPath),
    ]);

    // One file node per path (no duplicates)
    const fileNodes = await repo.queryRaw(
      `SELECT label FROM graph_nodes WHERE type = 'file' ORDER BY label`,
    );
    expect(fileNodes.filter((n: any) => n.label === "a.ts")).toHaveLength(1);
    expect(fileNodes.filter((n: any) => n.label === "b.ts")).toHaveLength(1);

    // No duplicate symbol nodes
    const symbolNodes = await repo.queryRaw(
      `SELECT label, count(*) AS c FROM graph_nodes WHERE type = 'symbol' GROUP BY label`,
    );
    for (const sym of symbolNodes) {
      expect(Number((sym as any).c)).toBe(1);
    }

    // Every edge references existing nodes
    const edges = await repo.queryRaw(
      `SELECT e.from_node_id, e.to_node_id
       FROM graph_edges e
       WHERE NOT EXISTS (SELECT 1 FROM graph_nodes n WHERE n.id = e.from_node_id)
          OR NOT EXISTS (SELECT 1 FROM graph_nodes n WHERE n.id = e.to_node_id)`,
    );
    expect(edges).toHaveLength(0);
  });

  it("invalidates stale call edge after reindex", async () => {
    const helperPath = path.join(workspaceRoot, "helper.ts");
    fs.writeFileSync(helperPath, "export function helper() { return 1; }\n");
    fs.writeFileSync(
      path.join(workspaceRoot, "caller.ts"),
      "export function caller() { return helper(); }\n",
    );
    const workspace = await createRegistryRepository().ensureWorkspace({ rootPath: workspaceRoot });

    await indexWorkspace({ workspaceId: workspace.id });
    await buildGraphForWorkspace(workspace.id, workspace.rootPath);

    const contextBefore = await codeContext({
      workspaceId: workspace.id,
      symbolOrPath: "helper",
      hops: 1,
    });
    expect(contextBefore.callers).toHaveLength(1);

    // Change caller to call a different function
    fs.writeFileSync(helperPath, "export function renamed() { return 1; }\n");
    fs.writeFileSync(
      path.join(workspaceRoot, "caller.ts"),
      "import { renamed } from './helper';\nexport function caller() { return renamed(); }\n",
    );
    await indexWorkspace({ workspaceId: workspace.id });
    await buildGraphForWorkspace(workspace.id, workspace.rootPath);

    // Old call edge (caller -> helper) should be gone
    const contextAfter = await codeContext({
      workspaceId: workspace.id,
      symbolOrPath: "helper",
      hops: 1,
    });
    expect(contextAfter.symbol).toBeFalsy();

    // New call edge (caller -> renamed) should be present
    const contextRenamed = await codeContext({
      workspaceId: workspace.id,
      symbolOrPath: "renamed",
      hops: 1,
    });
    expect(contextRenamed.callers).toContainEqual(expect.objectContaining({ symbol: "caller" }));
  });

  it("resolves waitForFts for a registered workspace ID", async () => {
    fs.writeFileSync(path.join(workspaceRoot, "a.ts"), "export function a() { return 1; }\n");
    const workspace = await createRegistryRepository().ensureWorkspace({ rootPath: workspaceRoot });

    await indexWorkspace({ workspaceId: workspace.id });
    // waitForFts should resolve immediately (FTS build already completed)
    await expect(waitForFts(workspace.id)).resolves.toBeUndefined();
  });

  it("restores exact token counting after indexing (fast token reset)", async () => {
    // Disable fast mode and record an exact BPE count for text whose count
    // differs from the Math.ceil(length / 4) approximation.
    setFastTokenCount(false);
    const sample = "The tokenizer must leave fast mode after indexing.";
    const exact = countTokens(sample);
    expect(exact).not.toBe(Math.ceil(sample.length / 4));

    fs.writeFileSync(path.join(workspaceRoot, "a.ts"), "export function a() { return 1; }\n");
    const workspace = await createRegistryRepository().ensureWorkspace({ rootPath: workspaceRoot });

    await indexWorkspace({ workspaceId: workspace.id });

    // After indexing, exact BPE counting must be restored — not the fast
    // length/4 approximation used during indexing.
    expect(countTokens(sample)).toBe(exact);
  });

  it("resets fast token flag even when indexing fails early (missing workspace ID)", async () => {
    setFastTokenCount(false);
    const sample = "The tokenizer must leave fast mode after indexing.";
    const exact = countTokens(sample);
    expect(exact).not.toBe(Math.ceil(sample.length / 4));

    // No workspaceId and no rootPath — throws before runId is created.
    await expect(indexWorkspace({})).rejects.toThrow();

    // The finally block must have reset the flag despite the early error.
    expect(countTokens(sample)).toBe(exact);
  });
});
