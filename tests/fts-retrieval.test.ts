import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  closeAllWorkspaceDbs,
  createWorkspaceRepository,
  type WorkspaceRepository,
} from "../packages/db/src/sqlite/index";
import {
  composeFtsSearchText,
  composeFtsSearchTextSql,
} from "../packages/db/src/sqlite/fts-repository";

let tempRoot: string;

const ftsTextCases = [
  { name: "empty", metadata: "{}" },
  { name: "malformed", metadata: "not json" },
  { name: "numeric", metadata: JSON.stringify({ searchText: 123 }) },
  { name: "blank", metadata: JSON.stringify({ searchText: "   " }) },
  { name: "ascii whitespace", metadata: JSON.stringify({ searchText: "  ascii needle  " }) },
  {
    name: "unicode whitespace",
    metadata: JSON.stringify({ searchText: "\u00a0unicode needle\u00a0" }),
  },
];

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
): Promise<number> {
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

async function expectStoredSearchText(
  repo: WorkspaceRepository,
  inputs: Array<{ chunkId: number; content: string; metadata: string }>,
): Promise<void> {
  const rows = await repo.queryRaw(
    `SELECT chunk_id, search_text FROM chunks_fts WHERE chunk_id IN (${inputs.map(() => "?").join(", ")})`,
    inputs.map((input) => input.chunkId),
  );
  expect(
    Object.fromEntries(rows.map((row) => [Number(row.chunk_id), String(row.search_text)])),
  ).toEqual(
    Object.fromEntries(
      inputs.map((input) => [input.chunkId, composeFtsSearchText(input.content, input.metadata)]),
    ),
  );
  const unicodeInput = inputs.find((input) => input.metadata.includes("unicode needle"));
  if (unicodeInput) {
    expect(rows.find((row) => Number(row.chunk_id) === unicodeInput.chunkId)?.search_text).toBe(
      `unicode needle\n${unicodeInput.content}`,
    );
  }
}

describe("FTS retrieval", () => {
  it("computes normalized metadata text once in SQL", () => {
    const sql = composeFtsSearchTextSql("metadata", "content");
    expect(sql.match(/json_extract/g)).toHaveLength(1);
  });

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

  it("stores trigger FTS rows with the shared text policy", async () => {
    const repo = createWorkspaceRepository(tempRoot);
    const documentId = await insertTestDocument(repo, "src/trigger.ts");
    const inputs = ftsTextCases.map((testCase, chunkIndex) => ({
      documentId,
      chunkIndex,
      content: `trigger content ${testCase.name}`,
      tokenCount: 4,
      contentHash: `trigger:${testCase.name}`,
      metadata: testCase.metadata,
    }));
    const chunkIds = await repo.insertChunks(inputs);

    await expectStoredSearchText(
      repo,
      inputs.map((input, index) => ({ ...input, chunkId: chunkIds[index] })),
    );
  });

  it("uses the composer for bulk and streaming FTS writes", async () => {
    const repo = createWorkspaceRepository(tempRoot);
    repo.dropFtsTriggers();

    const bulkDocumentId = await insertTestDocument(repo, "src/bulk.ts");
    const bulkInputs = ftsTextCases.map((testCase, chunkIndex) => ({
      documentId: bulkDocumentId,
      chunkIndex,
      content: `bulk content ${testCase.name}`,
      tokenCount: 4,
      contentHash: `bulk:${testCase.name}`,
      metadata: testCase.metadata,
    }));
    const bulkChunkIds = await repo.insertChunks(bulkInputs);
    await repo.bulkInsertFts(
      bulkInputs.map((input, index) => ({
        chunkId: bulkChunkIds[index],
        path: "src/bulk.ts",
        heading: null,
        language: "typescript",
        content: input.content,
        metadata: input.metadata,
      })),
    );
    await expectStoredSearchText(
      repo,
      bulkInputs.map((input, index) => ({ ...input, chunkId: bulkChunkIds[index] })),
    );

    const streamDocumentId = await insertTestDocument(repo, "src/stream.ts");
    const streamInputs = ftsTextCases.map((testCase, chunkIndex) => ({
      chunkId: chunkIndex + 100,
      documentId: streamDocumentId,
      chunkIndex,
      content: `stream content ${testCase.name}`,
      tokenCount: 4,
      contentHash: `stream:${testCase.name}`,
      metadata: testCase.metadata,
    }));
    for (const input of streamInputs) {
      repo.streamChunk({
        id: input.chunkId,
        documentId: input.documentId,
        chunkIndex: input.chunkIndex,
        heading: null,
        content: input.content,
        tokenCount: input.tokenCount,
        contentHash: input.contentHash,
        metadata: input.metadata,
      });
      repo.streamFtsRow({
        chunkId: input.chunkId,
        path: "src/stream.ts",
        heading: "",
        language: "typescript",
        content: input.content,
        metadata: input.metadata,
      });
    }
    await expectStoredSearchText(repo, streamInputs);
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
