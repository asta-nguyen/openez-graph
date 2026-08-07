import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import { embeddingStorageModel, formatEmbeddingInput } from "../packages/core/src/embeddings";
import { cosineSimilarity, rankStoredEmbeddings } from "../packages/core/src/retrieval";
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
});
