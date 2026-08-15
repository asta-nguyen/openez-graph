import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { closeAllWorkspaceDbs, createWorkspaceRepository } from "../packages/db/src/sqlite";

describe("embedding BLOB storage", () => {
  let tmpDir: string;
  let repo: ReturnType<typeof createWorkspaceRepository>;
  let chunkId: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openez-blob-test-"));
    repo = createWorkspaceRepository(tmpDir);
    // Insert document + chunk
    const docId = await repo.insertDocument({
      path: "src/foo.ts",
      absolutePath: path.join(tmpDir, "src/foo.ts"),
      kind: "code",
      language: "typescript",
      contentHash: "hash-v1",
      sizeBytes: 100,
      mtimeMs: Date.now(),
    });
    const [id] = await repo.insertChunks([
      {
        documentId: docId,
        chunkIndex: 0,
        heading: null,
        content: "export function foo() { return 1; }",
        tokenCount: 10,
        contentHash: "chunk-hash-v1",
        metadata: "{}",
      },
    ]);
    chunkId = id;
  });

  afterEach(() => {
    closeAllWorkspaceDbs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("insert and retrieve BLOB embedding round-trip", async () => {
    const embedding = [0.1, 0.2, 0.3, 0.4, 0.5];
    const blob = new Uint8Array(new Float32Array(embedding).buffer);

    await repo.insertEmbeddings([
      {
        chunkId,
        provider: "ollama",
        model: "bge-m3",
        dimensions: 5,
        embedding: blob,
        inputHash: "input-hash-v1",
      },
    ]);

    // Retrieve via queryRaw (same path as retrieval.ts)
    const rows = await repo.queryRaw(`SELECT embedding FROM embeddings WHERE chunk_id = ?`, [
      chunkId,
    ]);
    expect(rows.length).toBe(1);

    // Parse BLOB back to number[]
    const raw = rows[0].embedding;
    expect(raw).toBeInstanceOf(Uint8Array);
    // SAFETY: raw is verified as Uint8Array by the assertion above.
    const float32 = new Float32Array((raw as Uint8Array).buffer);
    const parsed = Array.from(float32);
    expect(parsed).toHaveLength(5);
    expect(parsed[0]).toBeCloseTo(0.1, 5);
    expect(parsed[4]).toBeCloseTo(0.5, 5);
  });

  test("delete embeddings by chunk ids", async () => {
    const blob = new Uint8Array(new Float32Array([0.1, 0.2]).buffer);

    await repo.insertEmbeddings([
      {
        chunkId,
        provider: "ollama",
        model: "bge-m3",
        dimensions: 2,
        embedding: blob,
      },
    ]);

    await repo.deleteEmbeddingsByChunkIds([chunkId]);

    const rows = await repo.queryRaw(`SELECT count(*) as c FROM embeddings WHERE chunk_id = ?`, [
      chunkId,
    ]);
    expect(Number(rows[0].c)).toBe(0);
  });
});
