import { createRegistryRepository, createWorkspaceRepository } from "@openez-graph/db";

import { parseChunkMetadata } from "./retrieval";
import { countTokens, truncateToTokenLimit } from "./tokenizer";
import type { CodeContextResult, CodeSymbolContext, GraphNeighborResult } from "./types";

/**
 * Row shape returned by the DB layer's `graphNeighbors`. All fields are `unknown`
 * because the DB returns an index-signature row (`GraphNeighborNode`); that type is
 * assignable here, so callers can pass rows straight through without a type assertion.
 */
interface GraphNodeRow {
  id?: unknown;
  type?: unknown;
  label?: unknown;
  ref_id?: unknown;
  metadata?: unknown;
}

function compactNode(node: GraphNodeRow): GraphNeighborResult["nodes"][number] {
  const meta = parseChunkMetadata(JSON.stringify(node.metadata));
  const result: GraphNeighborResult["nodes"][number] = {
    id: String(node.id),
    type: String(node.type),
    label: String(node.label),
  };
  const filePath = meta.filePath ?? meta.path;
  if (filePath !== undefined) result.path = filePath;
  if (meta.startLine !== undefined) result.startLine = meta.startLine;
  if (meta.endLine !== undefined) result.endLine = meta.endLine;
  return result;
}

export async function graphNeighbors(input: {
  workspaceId: string;
  nodeId?: string;
  label?: string;
  edgeTypes?: string[];
  depth?: number;
  limit?: number;
}): Promise<GraphNeighborResult> {
  const registry = createRegistryRepository();
  const workspace = await registry.getWorkspace(input.workspaceId);
  if (!workspace) throw new Error(`Workspace '${input.workspaceId}' not found`);

  const searchLabel = input.label ?? input.nodeId;
  if (!searchLabel) throw new Error("Either nodeId or label is required");

  const limit = input.limit ?? 50;
  const result = await createWorkspaceRepository(workspace.rootPath).graphNeighbors(
    searchLabel,
    input.depth ?? 1,
    limit,
  );
  const nodes = result.nodes.map(compactNode);
  const labels = new Map(nodes.map((node) => [node.id, node.label]));
  const edgeTypes = input.edgeTypes?.length ? new Set(input.edgeTypes) : undefined;
  const edges = result.edges
    .filter((edge) => !edgeTypes || edgeTypes.has(String(edge.type)))
    .flatMap((edge) => {
      const from = labels.get(String(edge.from_node_id));
      const to = labels.get(String(edge.to_node_id));
      if (!from || !to) return [];
      const compact: GraphNeighborResult["edges"][number] = { from, to, type: String(edge.type) };
      const weight = Number.isFinite(edge.weight) ? Number(edge.weight) : undefined;
      if (weight !== undefined) compact.weight = weight;
      return [compact];
    })
    .slice(0, limit);

  return { nodes, edges };
}

export async function codeContext(input: {
  workspaceId: string;
  symbolOrPath: string;
  hops?: number;
  limit?: number;
  maxTokens?: number;
}): Promise<CodeContextResult> {
  const registry = createRegistryRepository();
  const workspace = await registry.getWorkspace(input.workspaceId);
  if (!workspace) throw new Error(`Workspace '${input.workspaceId}' not found`);

  const repo = createWorkspaceRepository(workspace.rootPath);
  const limit = input.limit ?? 50;
  const neighbors = await repo.graphNeighbors(
    input.symbolOrPath,
    input.hops ?? 1,
    Math.min(limit * 3, 200),
  );
  const nodesById = new Map(neighbors.nodes.map((node) => [String(node.id), node]));
  const symbol = neighbors.nodes.find(
    (node) =>
      node.type === "symbol" &&
      (node.label === input.symbolOrPath || node.id === input.symbolOrPath),
  );
  const referencedChunkIds = [
    ...new Set(
      neighbors.nodes
        .filter((node) => node.type === "symbol")
        .map((node) => String(node.ref_id ?? ""))
        .filter((id) => id.length > 0),
    ),
  ];
  const chunkRows =
    referencedChunkIds.length === 0
      ? []
      : await repo.queryRaw(
          `SELECT chunks.id, chunks.content, chunks.heading, chunks.metadata, documents.path
     FROM chunks
     INNER JOIN documents ON documents.id = chunks.document_id
     WHERE chunks.id IN (${referencedChunkIds.map(() => "?").join(",")})`,
          referencedChunkIds,
        );
  const chunksById = new Map(chunkRows.map((row) => [Number(row.id), row]));

  const describeSymbol = (node: GraphNodeRow, includeSnippet = true): CodeSymbolContext => {
    const meta = parseChunkMetadata(JSON.stringify(node.metadata));
    const chunk = chunksById.get(Number(node.ref_id));
    const chunkMeta = parseChunkMetadata(String(chunk?.metadata ?? "{}"));
    const result: CodeSymbolContext = { symbol: String(node.label), label: String(node.label) };
    const chunkPath = chunk?.path;
    const filePath = meta.filePath ?? (chunkPath != null ? String(chunkPath) : undefined);
    if (filePath !== undefined) result.path = filePath;
    if (chunkMeta.startLine !== undefined) result.startLine = chunkMeta.startLine;
    if (chunkMeta.endLine !== undefined) result.endLine = chunkMeta.endLine;
    const content = chunk?.content;
    if (includeSnippet && content != null) result.snippet = String(content);
    return result;
  };

  const callEdges = neighbors.edges.filter((edge) => edge.type === "calls");
  const symbolId = symbol ? String(symbol.id) : "";
  const raw: CodeContextResult = {
    symbol: symbol ? describeSymbol(symbol) : undefined,
    callers: callEdges
      .filter((edge) => String(edge.to_node_id) === symbolId)
      .flatMap((edge) => {
        const node = nodesById.get(String(edge.from_node_id));
        return node?.type === "symbol" ? [describeSymbol(node, false)] : [];
      }),
    callees: callEdges
      .filter((edge) => String(edge.from_node_id) === symbolId)
      .flatMap((edge) => {
        const node = nodesById.get(String(edge.to_node_id));
        return node?.type === "symbol" ? [describeSymbol(node, false)] : [];
      }),
    files: neighbors.nodes
      .filter((node) => node.type === "file")
      .map((node) => ({ path: String(node.label) })),
    relatedChunks: neighbors.nodes
      .filter((node) => node.type === "symbol")
      .flatMap((node) => {
        const chunk = chunksById.get(Number(node.ref_id));
        if (!chunk) return [];
        const meta = parseChunkMetadata(String(chunk.metadata ?? "{}"));
        return [
          {
            path: String(chunk.path),
            startLine: meta.startLine,
            endLine: meta.endLine,
            heading: chunk.heading ? String(chunk.heading) : undefined,
            snippet: String(chunk.content),
          },
        ];
      }),
  };

  const maxTokens = input.maxTokens ?? 4000;
  const selected: CodeContextResult = { files: [], callers: [], callees: [], relatedChunks: [] };
  let usedTokens = countTokens(JSON.stringify(selected));
  let selectedCount = 0;
  const take = <T>(items: T[]): T[] =>
    items.filter((item) => {
      if (selectedCount >= limit || usedTokens >= maxTokens) return false;
      const tokens = countTokens(JSON.stringify(item));
      if (usedTokens + tokens > maxTokens) return false;
      usedTokens += tokens;
      selectedCount += 1;
      return true;
    });

  if (raw.symbol) {
    const budgetedSymbol = {
      ...raw.symbol,
      snippet: truncateToTokenLimit(
        raw.symbol.snippet ?? "",
        Math.max(50, Math.floor(maxTokens / 2)),
      ),
    };
    const symbolTokens = countTokens(JSON.stringify(budgetedSymbol));
    selected.symbol =
      symbolTokens + usedTokens <= maxTokens
        ? budgetedSymbol
        : {
            ...budgetedSymbol,
            snippet: truncateToTokenLimit(
              budgetedSymbol.snippet,
              Math.max(0, maxTokens - usedTokens - 40),
            ),
          };
    usedTokens += countTokens(JSON.stringify(selected.symbol));
    selectedCount += 1;
  }
  selected.callers = take(raw.callers);
  selected.callees = take(raw.callees);
  selected.files = take(raw.files);
  selected.relatedChunks = take(raw.relatedChunks);
  return selected;
}
