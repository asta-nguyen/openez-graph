import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  closeAllWorkspaceDbs,
  createWorkspaceRepository,
} from "../packages/db/src/sqlite/index";

let tempRoot: string;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-ws-"));
});

afterEach(() => {
  closeAllWorkspaceDbs();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("createWorkspaceRepository", () => {
  it("inserts and retrieves documents", async () => {
    const repo = createWorkspaceRepository(tempRoot);

    const docId = await repo.insertDocument({
      path: "src/index.ts",
      absolutePath: path.join(tempRoot, "src/index.ts"),
      kind: "code",
      language: "typescript",
      contentHash: "abc123",
      sizeBytes: 100,
      mtimeMs: Date.now(),
    });

    expect(docId).toBeTruthy();

    const doc = await repo.getDocument(docId);
    expect(doc?.path).toBe("src/index.ts");
    expect(doc?.kind).toBe("code");
    expect(doc?.language).toBe("typescript");

    const byPath = await repo.getDocumentByPath("src/index.ts");
    expect(byPath?.id).toBe(docId);
  });

  it("inserts and retrieves chunks for a document", async () => {
    const repo = createWorkspaceRepository(tempRoot);

    const docId = await repo.insertDocument({
      path: "README.md",
      absolutePath: path.join(tempRoot, "README.md"),
      kind: "markdown",
      language: "markdown",
      contentHash: "hash1",
      sizeBytes: 200,
      mtimeMs: Date.now(),
    });

    const [chunkId] = await repo.insertChunks([
      {
        documentId: docId,
        chunkIndex: 0,
        heading: "Intro",
        content: "Hello world",
        tokenCount: 5,
        contentHash: "chunkhash",
        metadata: JSON.stringify({ kind: "markdown" }),
      },
    ]);

    expect(chunkId).toBeTruthy();

    const chunks = await repo.getChunksByDocument(docId);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toBe("Hello world");
    expect(chunks[0]?.heading).toBe("Intro");
  });

  it("upserts graph nodes and finds them", async () => {
    const repo = createWorkspaceRepository(tempRoot);

    const nodeId = await repo.upsertGraphNode({
      type: "function",
      label: "myFunc",
      refId: "chunk-1",
      metadata: JSON.stringify({ file: "src/index.ts" }),
    });

    expect(nodeId).toBeTruthy();

    const found = await repo.findGraphNode("function", "myFunc");
    expect(found?.id).toBe(nodeId);
    expect(found?.refId).toBe("chunk-1");

    // Upsert again with same type+label should return same id
    const nodeId2 = await repo.upsertGraphNode({
      type: "function",
      label: "myFunc",
      refId: "chunk-2",
    });
    expect(nodeId2).toBe(nodeId);

    const updated = await repo.findGraphNode("function", "myFunc");
    expect(updated?.refId).toBe("chunk-2");

    await repo.upsertGraphNode({ type: "function", label: "myFunc" });
    expect((await repo.findGraphNode("function", "myFunc"))?.refId).toBe("chunk-2");
  });

  it("keeps same-named symbols from different chunks separate", async () => {
    const repo = createWorkspaceRepository(tempRoot);
    const first = await repo.upsertGraphNode({ type: "symbol", label: "main", refId: "chunk-1" });
    const second = await repo.upsertGraphNode({ type: "symbol", label: "main", refId: "chunk-2" });

    expect(second).not.toBe(first);
    expect(await repo.getNodeCount()).toBe(2);
  });

  it("inserts edges and traverses neighbors", async () => {
    const repo = createWorkspaceRepository(tempRoot);

    const nodeA = await repo.upsertGraphNode({ type: "function", label: "funcA" });
    const nodeB = await repo.upsertGraphNode({ type: "function", label: "funcB" });
    const nodeC = await repo.upsertGraphNode({ type: "function", label: "funcC" });

    await repo.insertEdge({ fromNodeId: nodeA, toNodeId: nodeB, type: "calls" });
    await repo.insertEdge({ fromNodeId: nodeB, toNodeId: nodeC, type: "calls" });

    const neighbors = await repo.graphNeighbors("funcA", 1);
    expect(neighbors.nodes.map((node) => node.label)).toEqual(expect.arrayContaining(["funcA", "funcB"]));
    expect(neighbors.nodes.map((node) => node.label)).not.toContain("funcC");
    expect((await repo.graphNeighbors(nodeA, 0)).nodes.map((node) => node.label)).toEqual(["funcA"]);
  });

  it("deduplicates legacy edges before installing the unique index", async () => {
    const repo = createWorkspaceRepository(tempRoot);
    const nodeA = await repo.upsertGraphNode({ type: "function", label: "legacyA" });
    const nodeB = await repo.upsertGraphNode({ type: "function", label: "legacyB" });

    await repo.executeRaw("DROP INDEX idx_graph_edges_from_to_type");
    const insertSql = "INSERT INTO graph_edges (id, from_node_id, to_node_id, type, weight, metadata) VALUES (?, ?, ?, 'calls', 1, '{}')";
    await repo.executeRaw(insertSql, ["legacy-edge-1", nodeA, nodeB]);
    await repo.executeRaw(insertSql, ["legacy-edge-2", nodeA, nodeB]);
    expect(await repo.getEdgeCount()).toBe(2);

    closeAllWorkspaceDbs();
    const reopened = createWorkspaceRepository(tempRoot);
    expect(await reopened.getEdgeCount()).toBe(1);
    expect(await reopened.queryRaw(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_graph_edges_from_to_type'"
    )).toEqual([{ name: "idx_graph_edges_from_to_type" }]);
  });

  it("fullTextSearch finds chunks by content", async () => {
    const repo = createWorkspaceRepository(tempRoot);

    const docId = await repo.insertDocument({
      path: "docs.md",
      absolutePath: path.join(tempRoot, "docs.md"),
      kind: "markdown",
      language: "markdown",
      contentHash: "h1",
      sizeBytes: 50,
      mtimeMs: Date.now(),
    });

    await repo.insertChunks([
      {
        documentId: docId,
        chunkIndex: 0,
        content: "The authentication module handles login",
        tokenCount: 8,
        contentHash: "ch1",
        metadata: "{}",
      },
    ]);

    const results = await repo.fullTextSearch("authentication", 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.content).toContain("authentication");
  });

  it("normalizes natural-language code verbs", async () => {
    const repo = createWorkspaceRepository(tempRoot);
    const docId = await repo.insertDocument({
      path: "writer.ts",
      absolutePath: path.join(tempRoot, "writer.ts"),
      kind: "code",
      language: "typescript",
      contentHash: "writer",
      sizeBytes: 10,
      mtimeMs: 1
    });
    await repo.insertChunks([
      { documentId: docId, chunkIndex: 0, content: "function writeData() {}", tokenCount: 5, contentHash: "writer-chunk", metadata: "{}" }
    ]);

    expect(await repo.fullTextSearch("written?", 5)).toHaveLength(1);
  });

  it("backfills FTS rows when opening an existing database", async () => {
    const repo = createWorkspaceRepository(tempRoot);
    const docId = await repo.insertDocument({
      path: "legacy.md",
      absolutePath: path.join(tempRoot, "legacy.md"),
      kind: "markdown",
      language: "markdown",
      contentHash: "legacy",
      sizeBytes: 10,
      mtimeMs: 1
    });

    await repo.executeRaw("DROP TRIGGER chunks_fts_insert");
    await repo.executeRaw("DROP TRIGGER chunks_fts_delete");
    await repo.executeRaw("DROP TRIGGER chunks_fts_update");
    await repo.executeRaw("DROP TABLE chunks_fts");
    await repo.insertChunks([
      { documentId: docId, chunkIndex: 0, content: "legacy searchable content", tokenCount: 3, contentHash: "chunk", metadata: "{}" }
    ]);

    closeAllWorkspaceDbs();
    const reopened = createWorkspaceRepository(tempRoot);
    expect(await reopened.fullTextSearch("searchable", 5)).toHaveLength(1);
  });

  it("counts documents, chunks, nodes, edges", async () => {
    const repo = createWorkspaceRepository(tempRoot);

    await repo.insertDocument({
      path: "a.ts",
      absolutePath: path.join(tempRoot, "a.ts"),
      kind: "code",
      language: "typescript",
      contentHash: "h",
      sizeBytes: 10,
      mtimeMs: Date.now(),
    });

    expect(await repo.getDocumentCount()).toBe(1);
    expect(await repo.getChunkCount()).toBe(0);
    expect(await repo.getNodeCount()).toBe(0);
    expect(await repo.getEdgeCount()).toBe(0);
  });

  it("inserts and queries memories", async () => {
    const repo = createWorkspaceRepository(tempRoot);

    const memId = await repo.insertMemory({
      title: "Decision: use SQLite",
      content: "We chose SQLite for local-first storage",
      tags: "decision,storage",
      source: "agent",
    });

    expect(memId).toBeTruthy();
  });
});
