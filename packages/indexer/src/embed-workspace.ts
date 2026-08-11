import path from "node:path";

import {
  embeddingStorageModel,
  ensureLocalEmbeddingCache,
  formatEmbeddingInput,
  getEmbeddingProvider,
  type EmbeddingProvider,
} from "@openez-graph/core";
import {
  createRegistryRepository,
  createWorkspaceRepository,
  writeLocalWorkspaceConfig,
} from "@openez-graph/db";
import type { RegistryWorkspace, WorkspaceRepository } from "@openez-graph/db";

import { hashContent } from "./hash";

export interface EmbedWorkspaceSummary {
  workspaceId: string;
  provider: string;
  model: string;
  chunksConsidered: number;
  embeddingsWritten: number;
  embeddingFailures: number;
}

export async function writeEmbeddingsToRepo(
  repo: WorkspaceRepository,
  chunkRows: Array<{ id: string; content: string; path: string; heading?: string | null }>,
  provider: EmbeddingProvider | null,
) {
  if (!provider || chunkRows.length === 0) {
    return { written: 0, failedBatches: 0 };
  }

  const existingIds = new Set<string>();
  const LOOKUP_BATCH_SIZE = 500;
  for (let i = 0; i < chunkRows.length; i += LOOKUP_BATCH_SIZE) {
    const batch = chunkRows.slice(i, i + LOOKUP_BATCH_SIZE);
    const existing = await repo.queryRaw(
      `SELECT chunk_id FROM embeddings
       WHERE provider = ? AND model = ? AND chunk_id IN (${batch.map(() => "?").join(",")})`,
      [provider.provider, embeddingStorageModel(provider), ...batch.map((chunk) => chunk.id)],
    );
    for (const row of existing) existingIds.add(String(row.chunk_id));
  }
  const missingRows = chunkRows.filter((chunk) => !existingIds.has(chunk.id));
  if (missingRows.length === 0) return { written: 0, failedBatches: 0 };

  const rowsToEmbed = missingRows.map((chunk) => ({
    chunk,
    hash: hashContent(formatEmbeddingInput(provider, chunk, "document")),
  }));
  const existingHashes = new Set<string>();
  for (let i = 0; i < rowsToEmbed.length; i += LOOKUP_BATCH_SIZE) {
    const batch = rowsToEmbed.slice(i, i + LOOKUP_BATCH_SIZE);
    const existing = await repo.queryRaw(
      `SELECT DISTINCT input_hash FROM embeddings
       WHERE provider = ? AND model = ? AND input_hash IN (${batch.map(() => "?").join(",")})`,
      [provider.provider, embeddingStorageModel(provider), ...batch.map((entry) => entry.hash)],
    );
    for (const row of existing) {
      if (row.input_hash) existingHashes.add(String(row.input_hash));
    }
  }

  const toEmbed = rowsToEmbed.filter((entry) => !existingHashes.has(entry.hash));
  const skipped = rowsToEmbed.filter((entry) => existingHashes.has(entry.hash));
  let reusedWritten = 0;
  if (skipped.length > 0) {
    const hashToVector = new Map<string, { embedding: Uint8Array; dimensions: number }>();
    const uniqueHashes = [...new Set(skipped.map((entry) => entry.hash))];
    for (let i = 0; i < uniqueHashes.length; i += LOOKUP_BATCH_SIZE) {
      const batch = uniqueHashes.slice(i, i + LOOKUP_BATCH_SIZE);
      const rows = await repo.queryRaw(
        `SELECT input_hash, embedding, dimensions FROM embeddings
         WHERE provider = ? AND model = ? AND input_hash IN (${batch.map(() => "?").join(",")})
         GROUP BY input_hash`,
        [provider.provider, embeddingStorageModel(provider), ...batch],
      );
      for (const row of rows) {
        if (!row.input_hash) continue;
        const embedding =
          row.embedding instanceof Uint8Array
            ? row.embedding
            : new Uint8Array(new Float32Array(JSON.parse(String(row.embedding))).buffer);
        hashToVector.set(String(row.input_hash), {
          embedding,
          dimensions: Number(row.dimensions),
        });
      }
    }
    const reuseInputs = skipped.flatMap((entry) => {
      const existing = hashToVector.get(entry.hash);
      return existing
        ? [
            {
              chunkId: entry.chunk.id,
              provider: provider.provider,
              model: embeddingStorageModel(provider),
              dimensions: existing.dimensions,
              embedding: existing.embedding,
              inputHash: entry.hash,
            },
          ]
        : [];
    });
    if (reuseInputs.length > 0) {
      await repo.insertEmbeddings(reuseInputs);
      reusedWritten = reuseInputs.length;
    }
  }

  const BATCH_SIZE = 50;
  let totalWritten = 0;
  let failedBatches = 0;
  for (let i = 0; i < toEmbed.length; i += BATCH_SIZE) {
    const batch = toEmbed.slice(i, i + BATCH_SIZE);
    try {
      const vectors = await provider.embed(
        batch.map((entry) => formatEmbeddingInput(provider, entry.chunk, "document")),
      );
      const dimensions = vectors[0]?.length ?? 0;
      if (
        vectors.length !== batch.length ||
        dimensions === 0 ||
        vectors.some(
          (vector) =>
            vector.length !== dimensions || vector.some((value) => !Number.isFinite(value)),
        )
      ) {
        const reason =
          vectors.length !== batch.length
            ? "vector count mismatch (got " + vectors.length + ", expected " + batch.length + ")"
            : dimensions === 0
              ? "zero dimensions"
              : vectors.some((vector) => vector.length !== dimensions)
                ? "inconsistent vector lengths"
                : "non-finite values";
        console.error(
          "Embedding batch rejected (skipping): " + reason + " for provider " + provider.provider,
        );
        failedBatches += 1;
        continue;
      }
      await repo.insertEmbeddings(
        vectors.map((embedding, index) => ({
          chunkId: batch[index].chunk.id,
          provider: provider.provider,
          model: embeddingStorageModel(provider),
          dimensions,
          embedding: new Uint8Array(new Float32Array(embedding).buffer),
          inputHash: batch[index].hash,
        })),
      );
      totalWritten += vectors.length;
    } catch (error) {
      failedBatches += 1;
      console.error(
        "Embedding batch failed (skipping): " +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
  return { written: totalWritten + reusedWritten, failedBatches };
}

async function resolveWorkspace(input: {
  workspaceId?: string;
  rootPath?: string;
}): Promise<RegistryWorkspace> {
  const registry = createRegistryRepository();
  if (input.workspaceId) {
    const workspace = await registry.getWorkspace(input.workspaceId);
    if (!workspace) throw new Error("Workspace '" + input.workspaceId + "' not found");
    return workspace;
  }
  if (input.rootPath) {
    return registry.ensureWorkspace({ rootPath: path.resolve(input.rootPath) });
  }
  throw new Error("Either workspaceId or rootPath is required");
}

async function collectChunkRows(repo: WorkspaceRepository) {
  const rows: Array<{ id: string; content: string; path: string; heading: string | null }> = [];
  for (const document of await repo.listDocuments()) {
    for (const chunk of await repo.getChunksByDocument(document.id)) {
      rows.push({
        id: chunk.id,
        content: chunk.content,
        path: document.path,
        heading: chunk.heading,
      });
    }
  }
  return rows;
}

export async function embedWorkspace(input: {
  workspaceId?: string;
  rootPath?: string;
  force?: boolean;
  onProgress?: (progress: { message: string; progress: number }) => Promise<void> | void;
}): Promise<EmbedWorkspaceSummary> {
  const workspace = await resolveWorkspace(input);
  await writeLocalWorkspaceConfig(workspace);
  const provider = await getEmbeddingProvider();
  if (!provider) {
    throw new Error("No embedding provider configured; set embedding.provider first");
  }
  if (provider.provider === "local") await ensureLocalEmbeddingCache(provider.model);

  const repo = createWorkspaceRepository(workspace.rootPath);
  const rows = await collectChunkRows(repo);
  const storageModel = embeddingStorageModel(provider);
  await input.onProgress?.({
    message: "Embedding " + rows.length + " chunks via " + provider.provider + "/" + provider.model,
    progress: rows.length === 0 ? 100 : 10,
  });

  if (input.force) {
    await repo.executeRaw("DELETE FROM embeddings WHERE provider = ? AND model = ?", [
      provider.provider,
      storageModel,
    ]);
  }

  const result = await writeEmbeddingsToRepo(repo, rows, provider);
  await input.onProgress?.({ message: "Embedding complete", progress: 100 });
  return {
    workspaceId: workspace.id,
    provider: provider.provider,
    model: provider.model,
    chunksConsidered: rows.length,
    embeddingsWritten: result.written,
    embeddingFailures: result.failedBatches,
  };
}
