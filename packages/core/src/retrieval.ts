import { getDefaultSettings } from "@openez-graph/config";
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

const DOCUMENT_PATH = /\.(?:md|mdx|markdown)$/i;
const MAX_EXACT_SYMBOL_NODES = 5;
const IDENTIFIER_TOKEN = /[A-Za-z_$][\w$]*(?:(?:::|\.)[A-Za-z_$][\w$]*)*/g;

// Plain words ("local", "index") only count when they are the whole query; otherwise a token
// must look like code: `_`, `$`, a `.`/`::` qualifier, or a camelCase transition.
const IDENTIFIER_SHAPE = /[_$]|\.|::|[a-z][A-Z]/;

// Chunks whose symbol label equals a query identifier, in query-token order. Reads the
// already-built graph; an unbuilt graph yields no hits.
async function exactSymbolSearch(rootPath: string, query: string): Promise<ChunkHit[]> {
  const whole = query.trim();
  const tokens = [...new Set(query.match(IDENTIFIER_TOKEN) ?? [])].filter(
    (t) => t.length >= 3 && (t === whole || IDENTIFIER_SHAPE.test(t)),
  );
  const repo = createWorkspaceRepository(rootPath);
  const seenPaths = new Set<string>();
  const hits: ChunkHit[] = [];

  for (const token of tokens) {
    const forms = [token];
    if (token.includes(".")) forms.push(token.replaceAll(".", "::"));
    if (token.includes("::")) forms.push(token.replaceAll("::", "."));
    const rows = await repo.queryRaw(
      `SELECT chunks.id, chunks.content, chunks.heading, chunks.metadata, documents.path
       FROM graph_nodes
       INNER JOIN chunks ON chunks.id = graph_nodes.ref_id
       INNER JOIN documents ON documents.id = chunks.document_id
       WHERE graph_nodes.type = 'symbol'
         AND graph_nodes.label IN (${forms.map(() => "?").join(",")})
       ORDER BY documents.path, chunks.id`,
      forms,
    );
    if (rows.length > MAX_EXACT_SYMBOL_NODES) continue;
    for (const row of rows) {
      const path = String(row.path);
      if (seenPaths.has(path)) continue;
      seenPaths.add(path);
      hits.push({
        id: String(row.id),
        path,
        content: String(row.content),
        score: 1,
        heading: row.heading ? String(row.heading) : null,
        metadata: safeParseJson(String(row.metadata ?? "{}"), {}),
      });
    }
  }
  return hits;
}

const IDENT = String.raw`([A-Za-z_$][\w$]*(?:(?:::|\.)[A-Za-z_$][\w$]*)*)`;
const CALLER_QUERIES = [
  new RegExp(String.raw`^(?:what|who|which \w+) (?:calls|uses|invokes) ${IDENT}\??$`, "i"),
  new RegExp(String.raw`^callers of ${IDENT}\??$`, "i"),
];
const CALLEE_QUERIES = [
  new RegExp(String.raw`^what does ${IDENT} (?:call|use|invoke)\??$`, "i"),
  new RegExp(String.raw`^callees of ${IDENT}\??$`, "i"),
];

// "what calls X" / "what does X call": chunks one `calls` edge away from the unique symbol X,
// excluding X's own file. Anything else, or an ambiguous X, yields no hits.
async function relationSearch(rootPath: string, query: string): Promise<ChunkHit[]> {
  const q = query.trim().replace(/\s+/g, " ");
  const callerMatch = CALLER_QUERIES.map((rx) => q.match(rx)).find(Boolean);
  const calleeMatch = callerMatch ? null : CALLEE_QUERIES.map((rx) => q.match(rx)).find(Boolean);
  const name = (callerMatch ?? calleeMatch)?.[1];
  if (!name) return [];

  const forms = [name, name.replaceAll(".", "::"), name.replaceAll("::", ".")];
  const repo = createWorkspaceRepository(rootPath);
  const targets = await repo.queryRaw(
    `SELECT graph_nodes.id, documents.path
     FROM graph_nodes
     INNER JOIN chunks ON chunks.id = graph_nodes.ref_id
     INNER JOIN documents ON documents.id = chunks.document_id
     WHERE graph_nodes.type = 'symbol' AND graph_nodes.label IN (?, ?, ?)`,
    forms,
  );
  if (targets.length !== 1) return [];

  const [near, far] = callerMatch ? ["from_node_id", "to_node_id"] : ["to_node_id", "from_node_id"];
  const rows = await repo.queryRaw(
    `SELECT chunks.id, chunks.content, chunks.heading, chunks.metadata, documents.path
     FROM graph_edges
     INNER JOIN graph_nodes ON graph_nodes.id = graph_edges.${near}
     INNER JOIN chunks ON chunks.id = graph_nodes.ref_id
     INNER JOIN documents ON documents.id = chunks.document_id
     WHERE graph_edges.type = 'calls' AND graph_edges.${far} = ? AND documents.path <> ?
     ORDER BY documents.path, chunks.id`,
    [String(targets[0]!.id), String(targets[0]!.path)],
  );

  const seenPaths = new Set<string>();
  return rows.flatMap((row) => {
    const path = String(row.path);
    if (seenPaths.has(path)) return [];
    seenPaths.add(path);
    return [
      {
        id: String(row.id),
        path,
        content: String(row.content),
        score: 1,
        heading: row.heading ? String(row.heading) : null,
        metadata: safeParseJson(String(row.metadata ?? "{}"), {}),
      },
    ];
  });
}

export async function graphExpand(
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
      SELECT
        chunks.id,
        MIN(walk.depth) AS distance,
        MIN((
          SELECT COUNT(*) FROM graph_edges
          WHERE graph_edges.from_node_id = graph_nodes.id
            OR graph_edges.to_node_id = graph_nodes.id
        )) AS degree,
        documents.path AS path
      FROM walk
      INNER JOIN graph_nodes ON graph_nodes.id = walk.node_id
      INNER JOIN chunks ON chunks.id = graph_nodes.ref_id
      INNER JOIN documents ON documents.id = chunks.document_id
      WHERE graph_nodes.type = 'symbol'
        AND walk.depth > 0
        AND chunks.id NOT IN (${placeholders})
      GROUP BY chunks.id, documents.path
      ORDER BY distance, degree, documents.path, chunks.id
      LIMIT ?
    )
    SELECT
      chunks.id, chunks.content, chunks.heading, chunks.metadata,
      documents.path,
      1.0 / (candidate_chunks.distance + 1) AS score
    FROM candidate_chunks
    INNER JOIN chunks ON chunks.id = candidate_chunks.id
    INNER JOIN documents ON documents.id = chunks.document_id
    ORDER BY candidate_chunks.distance, candidate_chunks.degree, documents.path, chunks.id`,
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

  const settings = getDefaultSettings();
  const retrieval = settings.retrieval;
  const finalLimit = input.limit ?? retrieval.finalLimit;
  const maxTokens = input.maxTokens ?? retrieval.maxContextTokens;

  const repo = createWorkspaceRepository(workspace.rootPath);
  repo.ensureFtsReady();

  console.error(
    `[retrieval] query: "${input.query}" | fts_limit=${retrieval.textLimit} vector_limit=${retrieval.vectorLimit}`,
  );
  // The graph must be current before the exact-symbol lookup. The callback is injected
  // by the caller (MCP/web) to avoid a core→indexer package cycle.
  if (!input.skipGraphExpand) await input.ensureGraph(input.workspaceId);
  const [ftsResults, vectorResults, exactResults, relationResults] = await Promise.all([
    repo.fullTextSearch(input.query, retrieval.textLimit),
    vectorSearch(workspace.rootPath, input.query, retrieval.vectorLimit),
    exactSymbolSearch(workspace.rootPath, input.query),
    relationSearch(workspace.rootPath, input.query),
  ]);
  console.error(
    `[retrieval] results: fts=${ftsResults.length} vector=${vectorResults.length} exact=${exactResults.length}`,
  );

  // RRF fusion: FTS 2x, vector 1x, exact symbol 3x. Vector can boost files FTS ranked low;
  // a chunk that defines a queried identifier outranks ones that merely mention it.
  const lists = [
    { results: ftsResults, weight: 2 },
    { results: vectorResults, weight: 1 },
    { results: exactResults, weight: 3 },
  ].filter((list) => list.results.length > 0);
  let fused = reciprocalRankFusion(
    lists.map((list) => list.results.map((item) => ({ item, score: item.score }))),
    60,
    lists.map((list) => list.weight),
    (item) => item.path,
  );

  if (!input.skipGraphExpand) {
    const graphResults = await graphExpand(
      workspace.rootPath,
      fused.slice(0, Math.min(finalLimit, 5)).map((entry) => entry.item.id),
      retrieval.graphHops,
      retrieval.maxGraphNeighbors,
    );
    const fusedItemsByPath = new Map(fused.map((entry) => [entry.item.path, entry.item]));
    const beforeGraph = fused;

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

    // RRF ranks by position only, so the graph's small boost lifts any neighbor over the entry
    // above it, however strong that entry's own match. These keep their pre-graph rank: the best
    // text match, files defining a queried symbol, and documents (the graph only links code, so
    // its boost would push every document down). The graph reorders the remaining slots.
    const exactPaths = new Set(exactResults.map((item) => item.path));
    const pinned = beforeGraph.flatMap((entry, index) =>
      index === 0 || exactPaths.has(entry.item.path) || DOCUMENT_PATH.test(entry.item.path)
        ? [{ entry, index }]
        : [],
    );
    if (pinned.length > 0) {
      const pinnedPaths = new Set(pinned.map(({ entry }) => entry.item.path));
      const reordered = fused.filter((entry) => !pinnedPaths.has(entry.item.path));
      for (const { entry, index } of pinned) reordered.splice(index, 0, entry);
      fused = reordered;
    }
  }

  // A relation question is answered by the graph, so its callers/callees lead the ranking.
  if (relationResults.length > 0) {
    const relationPaths = new Set(relationResults.map((item) => item.path));
    const topScore = fused[0]?.score ?? 1;
    fused = [
      ...relationResults.map((item) => ({ item, score: topScore })),
      ...fused.filter((entry) => !relationPaths.has(entry.item.path)),
    ];
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
