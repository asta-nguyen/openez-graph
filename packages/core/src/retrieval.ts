import { getBrainSettings } from "@openez-graph/config";
import { createRegistryRepository, createWorkspaceRepository } from "@openez-graph/db";

import { getEmbeddingProvider } from "./embeddings";
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

async function vectorSearch(
  rootPath: string,
  query: string,
  limit: number
): Promise<ChunkHit[]> {
  const provider = getEmbeddingProvider();
  if (!provider) return [];

  const [queryEmbedding] = await provider.embed([query]);
  const queryDimensions = queryEmbedding.length;
  const embeddingJson = JSON.stringify(queryEmbedding);

  const repo = createWorkspaceRepository(rootPath);
  const results = await repo.queryRaw(
    `SELECT
      chunks.id, chunks.content, chunks.heading, chunks.metadata,
      documents.path
    FROM embeddings
    INNER JOIN chunks ON chunks.id = embeddings.chunk_id
    INNER JOIN documents ON documents.id = chunks.document_id
    WHERE embeddings.model = ?
      AND embeddings.dimensions = ?
    ORDER BY abs(length(embeddings.embedding) - ?) ASC
    LIMIT ?`,
    [provider.model, queryDimensions, embeddingJson.length, limit]
  );

  return results.map((row) => ({
    id: String(row.id),
    path: String(row.path),
    content: String(row.content),
    score: 0.5,
    heading: row.heading ? String(row.heading) : null,
    metadata: safeParseJson(String(row.metadata ?? "{}"), {})
  }));
}

async function graphExpand(
  rootPath: string,
  seedIds: string[],
  limit: number
): Promise<ChunkHit[]> {
  if (seedIds.length === 0) return [];

  const repo = createWorkspaceRepository(rootPath);
  const placeholders = seedIds.map(() => "?").join(",");

  const results = await repo.queryRaw(
    `WITH seed_nodes AS (
      SELECT id, ref_id
      FROM graph_nodes
      WHERE type = 'chunk'
        AND ref_id IN (${placeholders})
    ),
    neighbor_nodes AS (
      SELECT DISTINCT
        CASE
          WHEN graph_edges.from_node_id = seed_nodes.id THEN graph_edges.to_node_id
          ELSE graph_edges.from_node_id
        END AS node_id
      FROM graph_edges
      INNER JOIN seed_nodes
        ON graph_edges.from_node_id = seed_nodes.id
        OR graph_edges.to_node_id = seed_nodes.id
      LIMIT ?
    )
    SELECT
      chunks.id, chunks.content, chunks.heading, chunks.metadata,
      documents.path,
      0.15 AS score
    FROM graph_nodes
    INNER JOIN neighbor_nodes ON neighbor_nodes.node_id = graph_nodes.id
    INNER JOIN chunks ON chunks.id = graph_nodes.ref_id
    INNER JOIN documents ON documents.id = chunks.document_id
    WHERE graph_nodes.type = 'chunk'`,
    [...seedIds, limit]
  );

  return results.map((row) => ({
    id: String(row.id),
    path: String(row.path),
    content: String(row.content),
    score: Number(row.score ?? 0.15),
    heading: row.heading ? String(row.heading) : null,
    metadata: safeParseJson(String(row.metadata ?? "{}"), {})
  }));
}

export async function memoryQuery(input: {
  workspaceId: string;
  query: string;
  limit?: number;
  maxTokens?: number;
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

  const fused = reciprocalRankFusion([
    ftsResults.map((item) => ({ item, score: item.score })),
    vectorResults.map((item) => ({ item, score: item.score }))
  ]);

  const graphResults = await graphExpand(
    workspace.rootPath,
    fused.slice(0, finalLimit).map((entry) => entry.item.id),
    retrieval.maxGraphNeighbors
  );

  const merged = reciprocalRankFusion([
    fused,
    graphResults.map((item) => ({ item, score: item.score }))
  ]);

  const selected: ChunkHit[] = [];
  let usedTokens = 0;

  for (const entry of merged) {
    if (selected.length >= finalLimit) break;

    const tokenCount = countTokens(entry.item.content);
    if (usedTokens + tokenCount > maxTokens) continue;

    selected.push(entry.item);
    usedTokens += tokenCount;
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
