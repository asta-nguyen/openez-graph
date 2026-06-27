import { getBrainSettings } from "@openez-graph/config";
import { createRegistryRepository, createWorkspaceRepository } from "@openez-graph/db";

import { reciprocalRankFusion } from "./rrf";
import { countTokens } from "./tokenizer";
import type { MemoryHit, MemoryQueryResult, QuerySource } from "./types";

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

function formatMemoryBlock(memory: MemoryHit): string {
  return `[memory: ${memory.title} | source: ${memory.source} | score: ${memory.score.toFixed(3)}]\n${memory.content}`;
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

  const start = Date.now();

  // Search both chunks (code/docs) and memories (agent-written notes)
  const [ftsResults, memoryResults] = await Promise.all([
    repo.fullTextSearch(input.query, retrieval.textLimit),
    repo.searchMemories(input.query, retrieval.textLimit).catch(() => []),
  ]);

  let fused = reciprocalRankFusion([
    ftsResults.map((item) => ({ item, score: item.score }))
  ]);

  if (!input.skipGraphExpand) {
    const graphResults = await graphExpand(
      workspace.rootPath,
      fused.slice(0, finalLimit).map((entry) => entry.item.id),
      retrieval.maxGraphNeighbors
    );

    fused = reciprocalRankFusion([
      fused,
      graphResults.map((item) => ({ item, score: item.score }))
    ]);
  }

  const selected: ChunkHit[] = [];
  const selectedScores = new Map<string, number>();
  let usedTokens = 0;

  for (const entry of fused) {
    if (selected.length >= finalLimit) break;

    const tokenCount = countTokens(entry.item.content);
    if (usedTokens + tokenCount > maxTokens) continue;

    selected.push(entry.item);
    selectedScores.set(entry.item.id, entry.score);
    usedTokens += tokenCount;
  }

  // Include top memories in the context, reserving ~25% of token budget
  const memoryTokenBudget = Math.floor(maxTokens * 0.25);
  const selectedMemories: MemoryHit[] = [];
  let memoryTokens = 0;
  for (const memory of memoryResults) {
    if (memoryTokens >= memoryTokenBudget) break;
    const tc = countTokens(memory.content);
    if (memoryTokens + tc > memoryTokenBudget) continue;
    selectedMemories.push(memory);
    memoryTokens += tc;
  }

  const latencyMs = Date.now() - start;

  const sources = selected.map((chunk) => sourceFromChunk(chunk, "retrieved-context"));

  const retrievedChunks = selected.map((chunk) => ({
    chunkId: chunk.id,
    score: selectedScores.get(chunk.id) ?? chunk.score,
    documentId: (chunk.metadata?.documentId as string) ?? (chunk.metadata?.document_id as string) ?? "",
    path: chunk.path
  }));

  await repo.insertQueryLog({
    query: input.query,
    mode: "memory_query",
    resultCount: selected.length + selectedMemories.length,
    latencyMs,
    retrievedChunks
  });

  const memoryContext = selectedMemories.length > 0
    ? selectedMemories.map(formatMemoryBlock).join("\n\n")
    : "";
  const chunkContext = selected.map(formatContextBlock).join("\n\n");

  return {
    answerContext: memoryContext
      ? `--- Memories ---\n${memoryContext}\n\n--- Code Context ---\n${chunkContext}`
      : chunkContext,
    sources,
    memories: selectedMemories.length > 0 ? selectedMemories : undefined,
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
