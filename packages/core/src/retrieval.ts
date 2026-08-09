import { getBrainSettings } from "@openez-graph/config";
import { createRegistryRepository, createWorkspaceRepository } from "@openez-graph/db";

import { embeddingStorageModel, formatEmbeddingInput, getEmbeddingProvider } from "./embeddings";
import type { EmbeddingProvider } from "./embeddings";
import { reciprocalRankFusion } from "./rrf";
import { countTokens } from "./tokenizer";
import type { CodeQueryResult, QuerySource } from "./types";

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
    reason,
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

export function parseEmbedding(value: unknown): number[] {
  if (value instanceof Uint8Array) {
    return Array.from(new Float32Array(value.buffer, value.byteOffset, value.byteLength / 4));
  }
  if (value instanceof ArrayBuffer) {
    return Array.from(new Float32Array(value));
  }
  // Legacy JSON TEXT embeddings (pre-BLOB migration)
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "number") ? parsed : [];
  } catch {
    return [];
  }
}

const MIN_COSINE_SIMILARITY = 0.3;
const CODE_FILE_BOOST = 0.05;

function isCodeFile(path: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs)$/.test(path);
}

export async function rankStoredEmbeddings(
  rootPath: string,
  provider: Pick<EmbeddingProvider, "provider" | "model">,
  queryEmbedding: number[],
  limit: number,
): Promise<ChunkHit[]> {
  if (queryEmbedding.length === 0) return [];

  const repo = createWorkspaceRepository(rootPath);

  // BLOB cosine linear scan — the supported local vector search path.
  // Sufficient for local SQLite workspaces; no native extension required.
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
    [provider.provider, embeddingStorageModel(provider), queryEmbedding.length],
  );

  const seenPaths = new Set<string>();
  return results
    .map((row) => {
      const path = String(row.path);
      const baseScore = cosineSimilarity(queryEmbedding, parseEmbedding(row.embedding));
      return {
        id: String(row.id),
        path,
        content: String(row.content),
        score: isCodeFile(path) ? baseScore + CODE_FILE_BOOST : baseScore,
        heading: row.heading ? String(row.heading) : null,
        metadata: safeParseJson(String(row.metadata ?? "{}"), {}),
      };
    })
    .filter((hit) => hit.score >= MIN_COSINE_SIMILARITY)
    .sort((left, right) => right.score - left.score)
    .filter((hit) => {
      if (seenPaths.has(hit.path)) return false;
      seenPaths.add(hit.path);
      return true;
    })
    .slice(0, limit);
}

const QUERY_EXPANSIONS: Array<[RegExp, string]> = [
  [/encrypt|secret|key|password/i, "encrypt decrypt AES cipher key security"],
  [/similar|distance|vector|number/i, "embedding cosine similarity vector dot product"],
  [/config|setting|option/i, "config setting registry database store"],
  [/chunk|split|piece|part/i, "chunk index parse split token"],
  [/model|inference|AI|LLM/i, "embedding provider model inference"],
  [/store|save|write|persist/i, "insert store database repository"],
  [/search|find|query|lookup/i, "search query retrieval FTS vector"],
  [/index|build|process/i, "index workspace scan parse"],
];

function expandQuery(query: string): string {
  const expansions = QUERY_EXPANSIONS.filter(([pattern]) => pattern.test(query)).map(
    ([, expansion]) => expansion,
  );
  return expansions.length > 0 ? `${query} ${expansions.join(" ")}` : query;
}

async function vectorSearch(rootPath: string, query: string, limit: number): Promise<ChunkHit[]> {
  try {
    const provider = await getEmbeddingProvider();
    if (!provider) {
      console.error("[retrieval] vector search: disabled (no embedding provider)");
      return [];
    }

    console.error(`[retrieval] vector search: using ${provider.provider}/${provider.model}`);
    const expandedQuery = expandQuery(query);
    const [queryEmbedding] = await provider.embed([
      formatEmbeddingInput(provider, { content: expandedQuery }, "query"),
    ]);
    const hits = await rankStoredEmbeddings(rootPath, provider, queryEmbedding ?? [], limit);
    console.error(`[retrieval] vector search: ${hits.length} hits`);
    return hits;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Vector search failed (deferring to FTS): ${msg}`);
    return [];
  }
}

async function graphExpand(
  rootPath: string,
  seedIds: string[],
  depth: number,
  limit: number,
): Promise<ChunkHit[]> {
  if (seedIds.length === 0) return [];

  const repo = createWorkspaceRepository(rootPath);
  const placeholders = seedIds.map(() => "?").join(",");

  const results = await repo.queryRaw(
    `WITH RECURSIVE walk(node_id, depth) AS (
      SELECT id, 0
      FROM graph_nodes
      WHERE type = 'symbol'
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
      WHERE graph_nodes.type = 'symbol'
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
    [...seedIds, depth, ...seedIds, limit * 5],
  );

  const seenPaths = new Set<string>();
  return results
    .map((row) => ({
      id: String(row.id),
      path: String(row.path),
      content: String(row.content),
      score: Number(row.score ?? 0),
      heading: row.heading ? String(row.heading) : null,
      metadata: safeParseJson(String(row.metadata ?? "{}"), {}),
    }))
    .filter((row) => {
      if (seenPaths.has(row.path)) return false;
      seenPaths.add(row.path);
      return true;
    })
    .slice(0, limit);
}

export async function codeQuery(input: {
  workspaceId: string;
  query: string;
  limit?: number;
  maxTokens?: number;
  skipGraphExpand?: boolean;
  recordMetrics?: boolean;
  /**
   * Optional callback to ensure the graph is built before graph expansion.
   * MCP/web pass `ensureGraphReady` from `@openez-graph/indexer`. When omitted
   * and `skipGraphExpand` is false, graph expansion runs against whatever
   * graph state currently exists (may be empty on a fresh workspace).
   */
  ensureGraph?: (workspaceId: string) => Promise<void>;
}): Promise<CodeQueryResult> {
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
  repo.ensureFtsReady();

  console.error(
    `[retrieval] query: "${input.query}" | fts_limit=${retrieval.textLimit} vector_limit=${retrieval.vectorLimit}`,
  );
  const [ftsResults, vectorResults] = await Promise.all([
    repo.fullTextSearch(input.query, retrieval.textLimit),
    vectorSearch(workspace.rootPath, input.query, retrieval.vectorLimit),
  ]);
  console.error(`[retrieval] results: fts=${ftsResults.length} vector=${vectorResults.length}`);

  // RRF fusion: FTS weighted 2x, vector weighted 1x. Vector can boost files FTS ranked low.
  let fused = reciprocalRankFusion(
    [ftsResults, vectorResults]
      .filter((results) => results.length > 0)
      .map((results) => results.map((item) => ({ item, score: item.score }))),
    60,
    [2, 1],
    (item) => item.path,
  );

  if (!input.skipGraphExpand) {
    // Ensure the graph is built before expansion. The callback is injected
    // by the caller (MCP/web) to avoid a core→indexer package cycle.
    if (input.ensureGraph) {
      await input.ensureGraph(input.workspaceId);
    }
    const graphResults = await graphExpand(
      workspace.rootPath,
      fused.slice(0, Math.min(finalLimit, 5)).map((entry) => entry.item.id),
      retrieval.graphHops,
      retrieval.maxGraphNeighbors,
    );
    const fusedItemsByPath = new Map(fused.map((entry) => [entry.item.path, entry.item]));

    fused = reciprocalRankFusion(
      [
        fused,
        graphResults.map((item) => ({
          item: fusedItemsByPath.get(item.path) ?? item,
          score: item.score,
        })),
      ],
      60,
      [1, 0.25],
      (item) => item.path,
    );
  }

  const selected: ChunkHit[] = [];
  let usedTokens = 0;
  const seenPaths = new Set<string>();

  for (const entry of fused) {
    if (selected.length >= finalLimit) break;

    const tokenCount = countTokens(entry.item.content);
    if (usedTokens + tokenCount > maxTokens) continue;
    if (seenPaths.has(entry.item.path)) continue;

    selected.push({ ...entry.item, score: entry.score });
    usedTokens += tokenCount;
    seenPaths.add(entry.item.path);
  }

  const sources = selected.map((chunk) => sourceFromChunk(chunk, "retrieved-context"));
  const uniquePaths = new Set(selected.map((s) => s.path));
  const allCandidatePaths = new Set(fused.map((e) => e.item.path));
  const answerContext = selected.map(formatContextBlock).join("\n\n");
  const retrievalTokens = countTokens(JSON.stringify({ answerContext, sources }));
  const selectedFullFileTokens =
    uniquePaths.size === 0
      ? 0
      : Number(
          (
            await repo.queryRaw(
              `SELECT coalesce(sum(chunks.token_count), 0) AS tokens
         FROM chunks
         INNER JOIN documents ON documents.id = chunks.document_id
         WHERE documents.path IN (${[...uniquePaths].map(() => "?").join(",")})`,
              [...uniquePaths],
            )
          )[0]?.tokens ?? 0,
        );
  const estimatedTokensSaved = Math.max(0, selectedFullFileTokens - retrievalTokens);
  const metrics: CodeQueryResult["metrics"] = {
    retrievalTokens,
    selectedFullFileTokens,
    estimatedTokensSaved,
    candidateFiles: allCandidatePaths.size,
    selectedFiles: uniquePaths.size,
    method: "selected-full-files-minus-retrieval-payload",
  };

  if (input.recordMetrics !== false) {
    await repo.insertQueryLog({
      query: input.query,
      mode: "code_query",
      resultCount: selected.length,
      tokensReturned: retrievalTokens,
      tokensSaved: estimatedTokensSaved,
      // Legacy column name; this is the number of ranked candidate files.
      filesScanned: allCandidatePaths.size,
    });
  }

  return { answerContext, sources, metrics };
}

/** @deprecated Use codeQuery. */
export const memoryQuery = codeQuery;

function safeParseJson(
  value: string | undefined,
  fallback: Record<string, unknown>,
): Record<string, unknown> {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return fallback;
  }
}
