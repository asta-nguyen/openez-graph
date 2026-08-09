import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import { embeddingStorageModel, formatEmbeddingInput } from "../packages/core/src/embeddings";
import {
  cosineSimilarity,
  parseEmbedding,
  rankStoredEmbeddings,
} from "../packages/core/src/retrieval";
import { reciprocalRankFusion } from "../packages/core/src/rrf";
import { closeAllWorkspaceDbs, createWorkspaceRepository } from "../packages/db/src/sqlite";

const roots: string[] = [];

const toBlob = (values: number[]): Uint8Array => new Uint8Array(new Float32Array(values).buffer);

afterEach(() => {
  closeAllWorkspaceDbs();
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});

describe("vector search", () => {
  const ollama = { provider: "ollama" as const, model: "test" };

  it("calculates cosine similarity", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("ranks stored embeddings by cosine and filters provider", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openez-vector-"));
    roots.push(root);
    const repo = createWorkspaceRepository(root);
    const docA = await repo.insertDocument({
      path: "best.ts",
      absolutePath: path.join(root, "best.ts"),
      kind: "code",
      language: "typescript",
      contentHash: "hash-a",
      sizeBytes: 1,
      mtimeMs: 1,
    });
    const docB = await repo.insertDocument({
      path: "worst.ts",
      absolutePath: path.join(root, "worst.ts"),
      kind: "code",
      language: "typescript",
      contentHash: "hash-b",
      sizeBytes: 1,
      mtimeMs: 1,
    });
    const [chunkA] = await repo.insertChunks([
      {
        documentId: docA,
        chunkIndex: 0,
        content: "best",
        tokenCount: 1,
        contentHash: "a",
        metadata: "{}",
      },
    ]);
    const [chunkB] = await repo.insertChunks([
      {
        documentId: docB,
        chunkIndex: 0,
        content: "worst",
        tokenCount: 1,
        contentHash: "b",
        metadata: "{}",
      },
    ]);
    await repo.insertEmbeddings([
      {
        chunkId: chunkA,
        provider: "ollama",
        model: embeddingStorageModel(ollama),
        dimensions: 2,
        embedding: toBlob([1, 0]),
      },
      {
        chunkId: chunkB,
        provider: "ollama",
        model: embeddingStorageModel(ollama),
        dimensions: 2,
        embedding: toBlob([0.9, 0.1]),
      },
    ]);

    const results = await rankStoredEmbeddings(root, ollama, [1, 0], 10);

    expect(results.map((result) => result.content)).toEqual(["best", "worst"]);
    expect(results[0].score).toBeGreaterThan(results[1].score);
    expect(results[1].score).toBeGreaterThanOrEqual(0.3);
  });

  it("filters results below similarity threshold", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openez-vector-threshold-"));
    roots.push(root);
    const repo = createWorkspaceRepository(root);
    const docId = await repo.insertDocument({
      path: "irrelevant.ts",
      absolutePath: path.join(root, "irrelevant.ts"),
      kind: "code",
      language: "typescript",
      contentHash: "hash",
      sizeBytes: 1,
      mtimeMs: 1,
    });
    const [chunkId] = await repo.insertChunks([
      {
        documentId: docId,
        chunkIndex: 0,
        content: "orthogonal",
        tokenCount: 1,
        contentHash: "c",
        metadata: "{}",
      },
    ]);
    await repo.insertEmbeddings([
      {
        chunkId,
        provider: "ollama",
        model: embeddingStorageModel(ollama),
        dimensions: 2,
        embedding: toBlob([0, 1]),
      },
    ]);

    const results = await rankStoredEmbeddings(root, ollama, [1, 0], 10);

    expect(results).toEqual([]);
  });

  it("upserts one embedding per chunk and model", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openez-vector-upsert-"));
    roots.push(root);
    const repo = createWorkspaceRepository(root);
    const docId = await repo.insertDocument({
      path: "duplicate.ts",
      absolutePath: path.join(root, "duplicate.ts"),
      kind: "code",
      language: "typescript",
      contentHash: "hash",
      sizeBytes: 1,
      mtimeMs: 1,
    });
    const [chunkId] = await repo.insertChunks([
      {
        documentId: docId,
        chunkIndex: 0,
        content: "duplicate",
        tokenCount: 1,
        contentHash: "chunk",
        metadata: "{}",
      },
    ]);

    const embedding = {
      chunkId,
      provider: "ollama",
      model: embeddingStorageModel(ollama),
      dimensions: 2,
      embedding: toBlob([1, 0]),
    };
    await repo.insertEmbeddings([embedding]);
    await repo.insertEmbeddings([{ ...embedding, embedding: toBlob([0, 1]) }]);

    const rows = await repo.queryRaw(
      "SELECT embedding FROM embeddings WHERE chunk_id = ? AND provider = ? AND model = ?",
      [chunkId, embedding.provider, embedding.model],
    );
    expect(rows).toHaveLength(1);
    expect(
      Array.from(
        new Float32Array(
          rows[0].embedding.buffer,
          rows[0].embedding.byteOffset,
          rows[0].embedding.byteLength / 4,
        ),
      ),
    ).toEqual([0, 1]);
  });

  it("adds code context and honors fusion weights", () => {
    expect(
      formatEmbeddingInput(
        { provider: "ollama", model: "nomic-embed-text" },
        { path: "src/auth.ts", heading: "authenticate", content: "return true" },
        "document",
      ),
    ).toBe("search_document: path: src/auth.ts\nheading: authenticate\nreturn true");

    const first = { id: "first" };
    const second = { id: "second" };
    const fused = reciprocalRankFusion(
      [[{ item: first, score: 1 }], [{ item: second, score: 1 }]],
      60,
      [2, 1],
    );
    expect(fused.map((entry) => entry.item.id)).toEqual(["first", "second"]);
  });

  it("can fuse different chunks from the same file", () => {
    const fused = reciprocalRankFusion(
      [
        [{ item: { id: "fts-chunk", path: "shared.ts" }, score: 1 }],
        [{ item: { id: "vector-chunk", path: "shared.ts" }, score: 1 }],
      ],
      60,
      [2, 1],
      (item) => item.path,
    );

    expect(fused).toHaveLength(1);
    expect(fused[0].item.id).toBe("fts-chunk");
    expect(fused[0].score).toBeCloseTo(3 / 61);
  });

  it("parseEmbedding handles Float32Array BLOB", () => {
    const original = [0.1, 0.2, 0.3, 0.4, 0.5];
    const blob = new Uint8Array(new Float32Array(original).buffer);
    const parsed = parseEmbedding(blob);
    expect(parsed).toHaveLength(5);
    expect(parsed[0]).toBeCloseTo(0.1, 5);
    expect(parsed[4]).toBeCloseTo(0.5, 5);
  });

  it("parseEmbedding falls back to JSON for old data", () => {
    const parsed = parseEmbedding("[0.1, 0.2, 0.3]");
    expect(parsed).toEqual([0.1, 0.2, 0.3]);
  });

  it("parseEmbedding returns empty for invalid data", () => {
    expect(parseEmbedding("not json")).toEqual([]);
    expect(parseEmbedding(null)).toEqual([]);
  });

  it("isolates results by provider and model dimensions", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openez-vector-iso-"));
    roots.push(root);
    const repo = createWorkspaceRepository(root);
    const docId = await repo.insertDocument({
      path: "multi.ts",
      absolutePath: path.join(root, "multi.ts"),
      kind: "code",
      language: "typescript",
      contentHash: "hash",
      sizeBytes: 1,
      mtimeMs: 1,
    });
    const [chunk768] = await repo.insertChunks([
      {
        documentId: docId,
        chunkIndex: 0,
        content: "768d",
        tokenCount: 1,
        contentHash: "c1",
        metadata: "{}",
      },
    ]);
    const [chunk1536] = await repo.insertChunks([
      {
        documentId: docId,
        chunkIndex: 1,
        content: "1536d",
        tokenCount: 1,
        contentHash: "c2",
        metadata: "{}",
      },
    ]);
    await repo.insertEmbeddings([
      {
        chunkId: chunk768,
        provider: "ollama",
        model: embeddingStorageModel({ model: "bge-m3" }),
        dimensions: 3,
        embedding: toBlob([1, 0, 0]),
      },
      {
        chunkId: chunk1536,
        provider: "openai",
        model: embeddingStorageModel({ model: "text-embedding-3-small" }),
        dimensions: 3,
        embedding: toBlob([0, 1, 0]),
      },
    ]);

    const ollamaResults = await rankStoredEmbeddings(
      root,
      { provider: "ollama", model: "bge-m3" },
      [1, 0, 0],
      10,
    );
    expect(ollamaResults.map((r) => r.content)).toEqual(["768d"]);

    const openaiResults = await rankStoredEmbeddings(
      root,
      { provider: "openai", model: "text-embedding-3-small" },
      [0, 1, 0],
      10,
    );
    expect(openaiResults.map((r) => r.content)).toEqual(["1536d"]);
  });

  it("returns similarity 0 for invalid BLOB length instead of throwing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openez-vector-invalid-"));
    roots.push(root);
    const repo = createWorkspaceRepository(root);
    const docId = await repo.insertDocument({
      path: "invalid.ts",
      absolutePath: path.join(root, "invalid.ts"),
      kind: "code",
      language: "typescript",
      contentHash: "hash",
      sizeBytes: 1,
      mtimeMs: 1,
    });
    const [chunkId] = await repo.insertChunks([
      {
        documentId: docId,
        chunkIndex: 0,
        content: "invalid",
        tokenCount: 1,
        contentHash: "c",
        metadata: "{}",
      },
    ]);
    // Insert a malformed embedding (1 byte — not a valid Float32Array)
    await repo.insertEmbeddings([
      {
        chunkId,
        provider: "ollama",
        model: "bge-m3",
        dimensions: 3,
        embedding: new Uint8Array([42]),
      },
    ]);

    const results = await rankStoredEmbeddings(
      root,
      { provider: "ollama", model: "bge-m3" },
      [1, 0, 0],
      10,
    );
    // Should not throw, should return empty or score 0
    expect(results).toEqual([]);
  });
});
