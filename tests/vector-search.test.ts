import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { embeddingStorageModel, formatEmbeddingInput } from "../packages/core/src/embeddings";
import { cosineSimilarity, rankStoredEmbeddings } from "../packages/core/src/retrieval";
import { reciprocalRankFusion } from "../packages/core/src/rrf";
import { closeAllWorkspaceDbs, createWorkspaceRepository } from "../packages/db/src/sqlite";

const roots: string[] = [];

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
    const documentId = await repo.insertDocument({
      path: "vectors.ts",
      absolutePath: path.join(root, "vectors.ts"),
      kind: "code",
      language: "typescript",
      contentHash: "hash",
      sizeBytes: 1,
      mtimeMs: 1
    });
    const chunkIds = await repo.insertChunks([
      { documentId, chunkIndex: 0, content: "best", tokenCount: 1, contentHash: "a", metadata: "{}" },
      { documentId, chunkIndex: 1, content: "worst", tokenCount: 1, contentHash: "b", metadata: "{}" },
      { documentId, chunkIndex: 2, content: "other provider", tokenCount: 2, contentHash: "c", metadata: "{}" }
    ]);
    await repo.insertEmbeddings([
      { chunkId: chunkIds[0], provider: "ollama", model: embeddingStorageModel(ollama), dimensions: 2, embedding: "[1,0]" },
      { chunkId: chunkIds[1], provider: "ollama", model: embeddingStorageModel(ollama), dimensions: 2, embedding: "[0,1]" },
      { chunkId: chunkIds[2], provider: "openai", model: "test", dimensions: 2, embedding: "[1,0]" }
    ]);

    const results = await rankStoredEmbeddings(root, ollama, [1, 0], 10);

    expect(results.map((result) => result.content)).toEqual(["best", "worst"]);
    expect(results.map((result) => result.score)).toEqual([1, 0]);
  });

  it("adds code context and honors fusion weights", () => {
    expect(formatEmbeddingInput(
      { provider: "ollama", model: "nomic-embed-text" },
      { path: "src/auth.ts", heading: "authenticate", content: "return true" },
      "document"
    )).toBe("search_document: path: src/auth.ts\nheading: authenticate\nreturn true");

    const first = { id: "first" };
    const second = { id: "second" };
    const fused = reciprocalRankFusion([
      [{ item: first, score: 1 }],
      [{ item: second, score: 1 }]
    ], 60, [2, 1]);
    expect(fused.map((entry) => entry.item.id)).toEqual(["first", "second"]);
  });
});
