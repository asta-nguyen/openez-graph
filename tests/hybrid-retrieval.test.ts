import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";

import * as embeddings from "../packages/core/src/embeddings";
import { embeddingStorageModel } from "../packages/core/src/embeddings";
import { codeQuery } from "../packages/core/src/retrieval";
import {
  closeAllWorkspaceDbs,
  closeRegistryDb,
  createRegistryRepository,
  createWorkspaceRepository,
} from "../packages/db/src/sqlite";

const testEmbeddingProvider = {
  provider: "ollama" as const,
  model: "test-model",
  embed: mock(async () => [[1, 0]]),
};

const toBlob = (values: number[]): Uint8Array => new Uint8Array(new Float32Array(values).buffer);

// Bun's mock.module is process-global and cannot be restored in bun 1.3.14
// (neither mock.restore() nor re-mocking reverts the cached namespace). Use
// spyOn instead so the spy can be reverted in afterAll, preventing the mock
// from leaking into other test files that run in the same `bun test` process.
const getEmbeddingProviderSpy = spyOn(embeddings, "getEmbeddingProvider").mockImplementation(
  async () => testEmbeddingProvider,
);

let registryRoot: string;
let workspaceRoot: string;

beforeEach(() => {
  testEmbeddingProvider.embed.mockClear();
  registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-hybrid-registry-"));
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-hybrid-workspace-"));
  process.env.AI_MEMORY_REGISTRY_DB_PATH = path.join(registryRoot, "registry.sqlite");
  closeRegistryDb();
  closeAllWorkspaceDbs();
});

afterEach(() => {
  closeAllWorkspaceDbs();
  closeRegistryDb();
  fs.rmSync(registryRoot, { recursive: true, force: true });
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.AI_MEMORY_REGISTRY_DB_PATH;
});

describe("codeQuery hybrid retrieval", () => {
  it("does not embed a query when the workspace has no active-model vectors", async () => {
    const workspace = await createRegistryRepository().createWorkspace({
      id: "empty-vector-test",
      name: "empty-vector-test",
      rootPath: workspaceRoot,
    });

    await codeQuery({
      workspaceId: workspace.id,
      query: "maintain",
      limit: 5,
      skipGraphExpand: true,
    });

    expect(testEmbeddingProvider.embed).not.toHaveBeenCalled();
  });

  it("keeps both FTS and vector-only results", async () => {
    const workspace = await createRegistryRepository().createWorkspace({
      id: "hybrid-test",
      name: "hybrid-test",
      rootPath: workspaceRoot,
    });
    const repo = createWorkspaceRepository(workspaceRoot);

    const textDocumentId = await repo.insertDocument({
      path: "text.ts",
      absolutePath: path.join(workspaceRoot, "text.ts"),
      kind: "code",
      language: "typescript",
      contentHash: "text",
      sizeBytes: 10,
      mtimeMs: 1,
    });
    await repo.insertChunks([
      {
        documentId: textDocumentId,
        chunkIndex: 0,
        heading: null,
        content: "needle appears in this source",
        tokenCount: 6,
        contentHash: "text-chunk",
        metadata: "{}",
      },
    ]);

    const vectorDocumentId = await repo.insertDocument({
      path: "vector.ts",
      absolutePath: path.join(workspaceRoot, "vector.ts"),
      kind: "code",
      language: "typescript",
      contentHash: "vector",
      sizeBytes: 10,
      mtimeMs: 1,
    });
    const [vectorChunkId] = await repo.insertChunks([
      {
        documentId: vectorDocumentId,
        chunkIndex: 0,
        heading: null,
        content: "semantic-only result",
        tokenCount: 3,
        contentHash: "vector-chunk",
        metadata: "{}",
      },
    ]);
    await repo.insertEmbeddings([
      {
        chunkId: vectorChunkId,
        provider: testEmbeddingProvider.provider,
        model: embeddingStorageModel(testEmbeddingProvider),
        dimensions: 2,
        embedding: toBlob([1, 0]),
      },
    ]);

    const result = await codeQuery({
      workspaceId: workspace.id,
      query: "needle",
      limit: 5,
      skipGraphExpand: true,
    });
    expect(result.sources.map((source) => source.path)).toEqual(
      expect.arrayContaining(["text.ts", "vector.ts"]),
    );
  });

  it("fuses FTS and vector hits by path when they select different chunks", async () => {
    const workspace = await createRegistryRepository().createWorkspace({
      id: "hybrid-path-test",
      name: "hybrid-path-test",
      rootPath: workspaceRoot,
    });
    const repo = createWorkspaceRepository(workspaceRoot);
    const documentId = await repo.insertDocument({
      path: "shared.ts",
      absolutePath: path.join(workspaceRoot, "shared.ts"),
      kind: "code",
      language: "typescript",
      contentHash: "shared",
      sizeBytes: 20,
      mtimeMs: 1,
    });
    const [, vectorChunkId] = await repo.insertChunks([
      {
        documentId,
        chunkIndex: 0,
        heading: null,
        content: "needle is in this chunk",
        tokenCount: 5,
        contentHash: "fts-chunk",
        metadata: "{}",
      },
      {
        documentId,
        chunkIndex: 1,
        heading: null,
        content: "semantic context lives here",
        tokenCount: 4,
        contentHash: "vector-chunk",
        metadata: "{}",
      },
    ]);
    await repo.insertEmbeddings([
      {
        chunkId: vectorChunkId,
        provider: testEmbeddingProvider.provider,
        model: embeddingStorageModel(testEmbeddingProvider),
        dimensions: 2,
        embedding: toBlob([1, 0]),
      },
    ]);

    const result = await codeQuery({
      workspaceId: workspace.id,
      query: "needle",
      limit: 5,
      skipGraphExpand: true,
    });

    expect(result.sources.map((source) => source.path)).toEqual(["shared.ts"]);
    expect(result.answerContext).toContain("needle is in this chunk");
  });
});

afterAll(() => {
  // Restore the real getEmbeddingProvider so the mock does not leak into
  // other test files that run in the same `bun test` process.
  getEmbeddingProviderSpy.mockRestore();
});
