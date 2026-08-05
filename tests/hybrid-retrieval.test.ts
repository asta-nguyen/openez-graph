import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testEmbeddingProvider = {
  provider: "ollama" as const,
  model: "test-model",
  embed: vi.fn(async () => [[1, 0]]),
};

vi.mock("../packages/core/src/embeddings", async () => {
  const actual = await vi.importActual<typeof import("../packages/core/src/embeddings")>(
    "../packages/core/src/embeddings",
  );
  return { ...actual, getEmbeddingProvider: async () => testEmbeddingProvider };
});

import { embeddingStorageModel } from "../packages/core/src/embeddings";
import { codeQuery } from "../packages/core/src/retrieval";
import {
  closeAllWorkspaceDbs,
  closeRegistryDb,
  createRegistryRepository,
  createWorkspaceRepository,
} from "../packages/db/src/sqlite";

let registryRoot: string;
let workspaceRoot: string;

beforeEach(() => {
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
        embedding: JSON.stringify([1, 0]),
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
        embedding: JSON.stringify([1, 0]),
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
