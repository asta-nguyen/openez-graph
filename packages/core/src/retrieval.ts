import { getBrainSettings } from "@openez-graph/config";
import { createRegistryRepository, createWorkspaceRepository } from "@openez-graph/db";
import type { JsonValue } from "@openez-graph/db";

import { embeddingStorageModel, formatEmbeddingInput, getEmbeddingProvider } from "./embeddings";
import type { EmbeddingProvider } from "./embeddings";
import { reciprocalRankFusion } from "./rrf";
import { countTokens } from "./tokenizer";
import type { CodeQueryResult, QuerySource } from "./types";

/** Concrete chunk metadata fields stored in the `chunks.metadata` JSON column. */
export interface ChunkMetadata {
  startLine?: number;
  endLine?: number;
  kind?: string;
  language?: string;
  section?: string;
  path?: string;
  filePath?: string;
  symbolType?: string;
  symbolName?: string;
}

function isJsonNumber(value: JsonValue): value is number {
  return Number.isFinite(value);
}

function isJsonValueString(value: JsonValue): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

/** Parse and validate a `chunks.metadata` JSON string into a typed ChunkMetadata at the I/O boundary. */
export function parseChunkMetadata(raw: string | undefined): ChunkMetadata {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return {
      startLine: isJsonNumber(parsed.startLine) ? parsed.startLine : undefined,
      endLine: isJsonNumber(parsed.endLine) ? parsed.endLine : undefined,
      kind: isJsonValueString(parsed.kind) ? parsed.kind : undefined,
      language: isJsonValueString(parsed.language) ? parsed.language : undefined,
      section: isJsonValueString(parsed.section) ? parsed.section : undefined,
      path: isJsonValueString(parsed.path) ? parsed.path : undefined,
      filePath: isJsonValueString(parsed.filePath) ? parsed.filePath : undefined,
      symbolType: isJsonValueString(parsed.symbolType) ? parsed.symbolType : undefined,
      symbolName: isJsonValueString(parsed.symbolName) ? parsed.symbolName : undefined,
    };
  } catch {
    /* malformed metadata — treat as empty */
    return {};
  }
}

interface ChunkHit {
  id: number;
  path: string;
  content: string;
  score: number;
  heading: string | null;
  metadata: ChunkMetadata;
}

function sourceFromChunk(chunk: ChunkHit, reason: string): QuerySource {
  return {
    path: chunk.path,
    startLine: chunk.metadata.startLine,
    endLine: chunk.metadata.endLine,
    score: chunk.score,
    reason,
  };
}

function formatContextBlock(chunk: ChunkHit): string {
  const startLine = chunk.metadata.startLine ?? "?";
  const endLine = chunk.metadata.endLine ?? "?";

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

export function parseEmbedding(value: Uint8Array | string): number[] {
  if (value instanceof Uint8Array) {
    return Array.from(new Float32Array(value.buffer, value.byteOffset, value.byteLength / 4));
  }
  // Legacy JSON TEXT embeddings (pre-BLOB migration)
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) && parsed.every((item) => Number.isFinite(item)) ? parsed : [];
  } catch {
    /* malformed embedding — treat as empty */
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

  // Skip vector search when the workspace has legacy TEXT embeddings.
  // They cannot be used with BLOB cosine search. Defer to FTS until the
  // user runs `openez reindex` to rebuild embeddings as BLOB.
  if (repo.hasLegacyEmbeddings()) {
    return [];
  }

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
      // SAFETY: embeddings.embedding is a BLOB (Uint8Array) or legacy TEXT (string) per the schema; parseEmbedding handles both.
      const baseScore = cosineSimilarity(
        queryEmbedding,
        parseEmbedding(row.embedding as Uint8Array | string),
      );
      return {
        id: Number(row.id),
        path,
        content: String(row.content),
        score: isCodeFile(path) ? baseScore + CODE_FILE_BOOST : baseScore,
        heading: row.heading ? String(row.heading) : null,
        metadata: parseChunkMetadata(String(row.metadata ?? "{}")),
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

async function vectorSearch(rootPath: string, query: string, limit: number): Promise<ChunkHit[]> {
  try {
    const provider = await getEmbeddingProvider();
    if (!provider) {
      console.error("[retrieval] vector search: disabled (no embedding provider)");
      return [];
    }

    console.error(`[retrieval] vector search: using ${provider.provider}/${provider.model}`);

    const repo = createWorkspaceRepository(rootPath);

    // Skip vector search entirely when the workspace has legacy TEXT
    // embeddings. They cannot be used with BLOB cosine search and calling
    // provider.embed would waste an API call before rankStoredEmbeddings
    // discards the results. Defer to FTS until `openez reindex` rebuilds
    // embeddings as BLOB.
    if (repo.hasLegacyEmbeddings()) {
      console.error("[retrieval] vector search: disabled (legacy TEXT embeddings)");
      return [];
    }

    // Preflight: skip the embedding API call when the workspace has no
    // vectors stored for the active provider/model. This avoids unnecessary
    // provider calls (and costs) for workspaces that haven't been embedded
    // yet or have legacy embeddings under a different model key.
    const stored = await repo.queryRaw(
      "SELECT 1 FROM embeddings WHERE provider = ? AND model = ? LIMIT 1",
      [provider.provider, embeddingStorageModel(provider)],
    );
    if (stored.length === 0) {
      console.error("[retrieval] vector search: disabled (no active-model vectors)");
      return [];
    }

    const [queryEmbedding] = await provider.embed([
      formatEmbeddingInput(provider, { content: query }, "query"),
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
  seedIds: number[],
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
      id: Number(row.id),
      path: String(row.path),
      content: String(row.content),
      score: Number(row.score ?? 0),
      heading: row.heading ? String(row.heading) : null,
      metadata: parseChunkMetadata(String(row.metadata ?? "{}")),
    }))
    .filter((row) => {
      if (seenPaths.has(row.path)) return false;
      seenPaths.add(row.path);
      return true;
    })
    .slice(0, limit);
}

interface CodeQueryBaseInput {
  workspaceId: string;
  query: string;
  limit?: number;
  maxTokens?: number;
  recordMetrics?: boolean;
}

export type CodeQueryInput = CodeQueryBaseInput &
  (
    | {
        skipGraphExpand: true;
        ensureGraph?: never;
      }
    | {
        skipGraphExpand?: false;
        ensureGraph: (workspaceId: string) => Promise<void>;
      }
  );

export async function codeQuery(input: CodeQueryInput): Promise<CodeQueryResult> {
  if (!input.skipGraphExpand && !input.ensureGraph) {
    throw new Error(
      "codeQuery: ensureGraph callback is required when skipGraphExpand is false. " +
        "Pass ensureGraphReady from @openez-graph/indexer, or set skipGraphExpand: true.",
    );
  }

  const registry = createRegistryRepository();
  const workspace = await registry.getWorkspace(input.workspaceId);
  if (!workspace) {
    throw new Error(`Workspace '${input.workspaceId}' not found`);
  }

  const settings = await getBrainSettings(workspace.rootPath);
  const retrieval = settings.retrieval;
  const finalLimit = input.limit ?? retrieval.finalLimit;
  const maxTokens = input.maxTokens ?? retrieval.maxContextTokens;

  const repo = createWorkspaceRepository(workspace.rootPath);
  repo.ensureFtsReady();

  console.error(
    `[retrieval] query: "${input.query}" | fts_limit=${retrieval.textLimit} vector_limit=${retrieval.vectorLimit}`,
  );
  const [ftsResultsRaw, vectorResults] = await Promise.all([
    repo.fullTextSearch(input.query, retrieval.textLimit),
    vectorSearch(workspace.rootPath, input.query, retrieval.vectorLimit),
  ]);
  // fullTextSearch returns metadata already parsed by the DB layer; re-validate it through
  // parseChunkMetadata so every ChunkHit carries a typed ChunkMetadata at the I/O boundary.
  const ftsResults: ChunkHit[] = ftsResultsRaw.map((hit) => ({
    id: hit.id,
    path: hit.path,
    content: hit.content,
    score: hit.score,
    heading: hit.heading,
    metadata: parseChunkMetadata(JSON.stringify(hit.metadata)),
  }));
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
    await input.ensureGraph(input.workspaceId);
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
