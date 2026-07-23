import { getBrainSettings } from "@openez-graph/config";
import { createRegistryRepository, createWorkspaceRepository } from "@openez-graph/db";

import { embeddingStorageModel, formatEmbeddingInput, getEmbeddingProvider } from "./embeddings";
import type { EmbeddingProvider } from "./embeddings";
import { reciprocalRankFusion } from "./rrf";
import { countTokens } from "./tokenizer";
import type { MemoryQueryResult, QuerySource } from "./types";

interface ChunkHit {
  id: string;
  path: string;
  content: string;
  score: number;
  heading: string | null;
  metadata: Record<string, unknown>;
}

function sourceFromChunk(chunk: ChunkHit, reason: string): QuerySource {
  const meta = chunk.metadata ?? {};
  const startLine = typeof meta.startLine === "number" ? meta.startLine : undefined;
  const endLine = typeof meta.endLine === "number" ? meta.endLine : undefined;

  return {
    path: chunk.path,
    startLine,
    endLine,
    score: chunk.score,
    reason
  };
}

function formatContextBlock(chunk: ChunkHit): string {
  const meta = chunk.metadata ?? {};
  const startLine = typeof meta.startLine === "number" ? meta.startLine : "?";
  const endLine = typeof meta.endLine === "number" ? meta.endLine : "?";

  return `[source: ${chunk.path}:${startLine}-${endLine} | score: ${chunk.score.toFixed(3)}]\n${chunk.content}`;
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }

  return leftNorm === 0 || rightNorm === 0 ? 0 : dot / Math.sqrt(leftNorm * rightNorm);
}

function parseEmbedding(value: unknown): number[] {
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "number") ? parsed : [];
  } catch {
    return [];
  }
}

export async function rankStoredEmbeddings(
  rootPath: string,
  provider: Pick<EmbeddingProvider, "provider" | "model">,
  queryEmbedding: number[],
  limit: number
): Promise<ChunkHit[]> {
  if (queryEmbedding.length === 0) return [];

  const repo = createWorkspaceRepository(rootPath);
  const results = await repo.queryRaw(
    `SELECT
      chunks.id, chunks.content, chunks.heading, chunks.metadata,
      documents.path, embeddings.embedding
    FROM embeddings
    INNER JOIN chunks ON chunks.id = embeddings.chunk_id
    INNER JOIN documents ON documents.id = chunks.document_id
    WHERE embeddings.provider = ?
      AND embeddings.model = ?
      AND embeddings.dimensions = ?`,
    [provider.provider, embeddingStorageModel(provider), queryEmbedding.length]
  );

  // ponytail: linear scan is enough for local SQLite; use sqlite-vec after profiling proves otherwise.
  return results
    .map((row) => ({
      id: String(row.id),
      path: String(row.path),
      content: String(row.content),
      score: cosineSimilarity(queryEmbedding, parseEmbedding(row.embedding)),
      heading: row.heading ? String(row.heading) : null,
      metadata: safeParseJson(String(row.metadata ?? "{}"), {})
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

async function vectorSearch(
  rootPath: string,
  query: string,
  limit: number
): Promise<ChunkHit[]> {
  const provider = getEmbeddingProvider();
  if (!provider) return [];

  const [queryEmbedding] = await provider.embed([
    formatEmbeddingInput(provider, { content: query }, "query")
  ]);
  return rankStoredEmbeddings(rootPath, provider, queryEmbedding ?? [], limit);
}

async function graphExpand(
  rootPath: string,
  seedIds: string[],
  depth: number,
  limit: number
): Promise<ChunkHit[]> {
  if (seedIds.length === 0) return [];

  const repo = createWorkspaceRepository(rootPath);
  const placeholders = seedIds.map(() => "?").join(",");

  const results = await repo.queryRaw(
    `WITH RECURSIVE walk(node_id, depth) AS (
      SELECT id, 0
      FROM graph_nodes
      WHERE type = 'chunk'
        AND ref_id IN (${placeholders})
      UNION
      SELECT
        CASE
          WHEN graph_edges.from_node_id = walk.node_id THEN graph_edges.to_node_id
          ELSE graph_edges.from_node_id
        END,
        walk.depth + 1
      FROM walk
      INNER JOIN graph_edges
        ON graph_edges.from_node_id = walk.node_id
        OR graph_edges.to_node_id = walk.node_id
      WHERE walk.depth < ?
    ),
    candidate_chunks AS (
      SELECT chunks.id, MIN(walk.depth) AS distance
      FROM walk
      INNER JOIN graph_nodes ON graph_nodes.id = walk.node_id
      INNER JOIN chunks ON chunks.id = graph_nodes.ref_id
      WHERE graph_nodes.type = 'chunk'
        AND walk.depth > 0
        AND chunks.id NOT IN (${placeholders})
      GROUP BY chunks.id
      ORDER BY distance
      LIMIT ?
    )
    SELECT
      chunks.id, chunks.content, chunks.heading, chunks.metadata,
      documents.path,
      1.0 / (candidate_chunks.distance + 1) AS score
    FROM candidate_chunks
    INNER JOIN chunks ON chunks.id = candidate_chunks.id
    INNER JOIN documents ON documents.id = chunks.document_id
    ORDER BY candidate_chunks.distance, documents.path`,
    [...seedIds, depth, ...seedIds, limit * 5]
  );

  const seenPaths = new Set<string>();
  return results.map((row) => ({
    id: String(row.id),
    path: String(row.path),
    content: String(row.content),
    score: Number(row.score ?? 0),
    heading: row.heading ? String(row.heading) : null,
    metadata: safeParseJson(String(row.metadata ?? "{}"), {})
  })).filter((row) => {
    if (seenPaths.has(row.path)) return false;
    seenPaths.add(row.path);
    return true;
  }).slice(0, limit);
}

export async function memoryQuery(input: {
  workspaceId: string;
  query: string;
  limit?: number;
  maxTokens?: number;
  skipGraphExpand?: boolean;
}): Promise<MemoryQueryResult> {
  const registry = createRegistryRepository();
  const workspace = await registry.getWorkspace(input.workspaceId);
  if (!workspace) {
    throw new Error(`Workspace '${input.workspaceId}' not found`);
  }

  const settings = await getBrainSettings();
  const retrieval = settings.retrieval;
  const finalLimit = input.limit ?? retrieval.finalLimit;
  const maxTokens = input.maxTokens ?? retrieval.maxContextTokens;

  const repo = createWorkspaceRepository(workspace.rootPath);

  const [ftsResults, vectorResults] = await Promise.all([
    repo.fullTextSearch(input.query, retrieval.textLimit),
    vectorSearch(workspace.rootPath, input.query, retrieval.vectorLimit)
  ]);

  const primaryResults = ftsResults.length > 0 ? ftsResults : vectorResults;
  let fused = reciprocalRankFusion([
    primaryResults.map((item) => ({ item, score: item.score }))
  ]);

  if (!input.skipGraphExpand) {
    const graphResults = await graphExpand(
      workspace.rootPath,
      fused.slice(0, Math.min(finalLimit, 5)).map((entry) => entry.item.id),
      retrieval.graphHops,
      retrieval.maxGraphNeighbors
    );
    const fusedItemsByPath = new Map(fused.map((entry) => [entry.item.path, entry.item]));

    fused = reciprocalRankFusion([
      fused,
      graphResults.map((item) => ({ item: fusedItemsByPath.get(item.path) ?? item, score: item.score }))
    ], 60, [1, 0.25]);
  }

  const selected: ChunkHit[] = [];
  let usedTokens = 0;
  const chunksPerPath = new Map<string, number>();

  for (const entry of fused) {
    if (selected.length >= finalLimit) break;

    const tokenCount = countTokens(entry.item.content);
    if (usedTokens + tokenCount > maxTokens) continue;
    if (chunksPerPath.has(entry.item.path)) continue;

    selected.push({ ...entry.item, score: entry.score });
    usedTokens += tokenCount;
    chunksPerPath.set(entry.item.path, (chunksPerPath.get(entry.item.path) ?? 0) + 1);
  }

  const sources = selected.map((chunk) => sourceFromChunk(chunk, "retrieved-context"));

  await repo.insertQueryLog({
    query: input.query,
    mode: "memory_query",
    resultCount: selected.length
  });

  return {
    answerContext: selected.map(formatContextBlock).join("\n\n"),
    sources
  };
}

function safeParseJson(value: string | undefined, fallback: Record<string, unknown>): Record<string, unknown> {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return fallback;
  }
}
