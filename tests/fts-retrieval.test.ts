import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  closeAllWorkspaceDbs,
  createWorkspaceRepository,
  type WorkspaceRepository,
} from "../packages/db/src/sqlite/index";

let tempRoot: string;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-fts-"));
});

afterEach(() => {
  closeAllWorkspaceDbs();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

async function insertTestDocument(
  repo: WorkspaceRepository,
  documentPath: string,
): Promise<string> {
  return repo.insertDocument({
    path: documentPath,
    absolutePath: path.join(tempRoot, documentPath),
    kind: "code",
    language: "typescript",
    contentHash: `document:${documentPath}`,
    sizeBytes: 1,
    mtimeMs: 1,
  });
}

describe("FTS retrieval", () => {
  it("finds terms at the beginning, middle, and end of a long chunk", async () => {
    const repo = createWorkspaceRepository(tempRoot);
    const documentId = await insertTestDocument(repo, "src/long.ts");
    const content = `startNeedle ${"padding ".repeat(90)} middleNeedle ${"padding ".repeat(90)} endNeedle`;
    await repo.insertChunks([
      { documentId, chunkIndex: 0, content, tokenCount: 400, contentHash: "long", metadata: "{}" },
    ]);

    expect(await repo.fullTextSearch("startNeedle", 5)).toHaveLength(1);
    expect(await repo.fullTextSearch("middleNeedle", 5)).toHaveLength(1);
    expect(await repo.fullTextSearch("endNeedle", 5)).toHaveLength(1);
  });

  it("indexes normalized symbol metadata that is absent from content", async () => {
    const repo = createWorkspaceRepository(tempRoot);
    const documentId = await insertTestDocument(repo, "src/payment.ts");
    await repo.insertChunks([
      {
        documentId,
        chunkIndex: 0,
        content: "return true",
        tokenCount: 2,
        contentHash: "metadata",
        metadata: JSON.stringify({ searchText: "process payment history" }),
      },
    ]);

    expect(await repo.fullTextSearch("payment", 5)).toHaveLength(1);
  });

  it("uses the composer for bulk and streaming FTS writes", async () => {
    const repo = createWorkspaceRepository(tempRoot);
    repo.dropFtsTriggers();

    const bulkDocumentId = await insertTestDocument(repo, "src/bulk.ts");
    const bulkContent = `${"padding ".repeat(90)} bulkTailNeedle`;
    const [bulkChunkId] = await repo.insertChunks([
      {
        documentId: bulkDocumentId,
        chunkIndex: 0,
        content: bulkContent,
        tokenCount: 200,
        contentHash: "bulk",
        metadata: JSON.stringify({ searchText: "bulk metadata needle" }),
      },
    ]);
    await repo.bulkInsertFts([
      {
        chunkId: bulkChunkId,
        path: "src/bulk.ts",
        heading: null,
        language: "typescript",
        content: bulkContent,
        metadata: JSON.stringify({ searchText: "bulk metadata needle" }),
      },
    ]);

    const streamDocumentId = await insertTestDocument(repo, "src/stream.ts");
    const streamContent = `${"padding ".repeat(90)} streamTailNeedle`;
    repo.streamChunk({
      id: "stream-chunk",
      documentId: streamDocumentId,
      chunkIndex: 0,
      heading: null,
      content: streamContent,
      tokenCount: 200,
      contentHash: "stream",
      metadata: JSON.stringify({ searchText: "stream metadata needle" }),
    });
    repo.streamFtsRow({
      chunkId: "stream-chunk",
      path: "src/stream.ts",
      heading: "",
      language: "typescript",
      content: streamContent,
      metadata: JSON.stringify({ searchText: "stream metadata needle" }),
    });

    expect(await repo.fullTextSearch("metadata", 5)).toHaveLength(2);
    expect(await repo.fullTextSearch("bulkTailNeedle", 5)).toHaveLength(1);
    expect(await repo.fullTextSearch("streamTailNeedle", 5)).toHaveLength(1);
  });

  it("accepts malformed metadata and indexes the content", async () => {
    const repo = createWorkspaceRepository(tempRoot);
    const documentId = await insertTestDocument(repo, "src/malformed.ts");
    await repo.insertChunks([
      {
        documentId,
        chunkIndex: 0,
        content: "malformedMetadataNeedle",
        tokenCount: 2,
        contentHash: "malformed",
        metadata: "not json",
      },
    ]);

    expect(await repo.fullTextSearch("malformedMetadataNeedle", 5)).toHaveLength(1);
  });
});
