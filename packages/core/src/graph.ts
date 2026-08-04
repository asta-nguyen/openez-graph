import { createRegistryRepository, createWorkspaceRepository } from "@openez-graph/db";

import { countTokens, truncateToTokenLimit } from "./tokenizer";
import type { CodeContextResult, CodeSymbolContext, GraphNeighborResult } from "./types";

function metadata(node: Record<string, unknown>): Record<string, unknown> {
  return typeof node.metadata === "object" && node.metadata !== null
    ? node.metadata as Record<string, unknown>
    : {};
}

function compactNode(node: Record<string, unknown>): GraphNeighborResult["nodes"][number] {
  const meta = metadata(node);
  const result: GraphNeighborResult["nodes"][number] = {
    id: String(node.id),
    type: String(node.type),
    label: String(node.label)
  };
  const filePath = meta.filePath ?? meta.path;
  if (typeof filePath === "string") result.path = filePath;
  if (typeof meta.startLine === "number") result.startLine = meta.startLine;
  if (typeof meta.endLine === "number") result.endLine = meta.endLine;
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
  const result = await createWorkspaceRepository(workspace.rootPath)
    .graphNeighbors(searchLabel, input.depth ?? 1, limit);
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
      if (typeof edge.weight === "number") compact.weight = edge.weight;
      return [compact];
    })
    .slice(0, limit);

  return { nodes, edges };
}

function parseJson(value: unknown): Record<string, unknown> {
  try {
    return JSON.parse(String(value ?? "{}")) as Record<string, unknown>;
  } catch {
    return {};
  }
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
  const neighbors = await repo.graphNeighbors(input.symbolOrPath, input.hops ?? 1, Math.min(limit * 3, 200));
  const nodesById = new Map(neighbors.nodes.map((node) => [String(node.id), node]));
  const symbol = neighbors.nodes.find(
    (node) => node.type === "symbol" && (node.label === input.symbolOrPath || node.id === input.symbolOrPath)
  );
  const referencedChunkIds = [...new Set(neighbors.nodes
    .filter((node) => node.type === "symbol")
    .map((node) => node.ref_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0))];
  const chunkRows = referencedChunkIds.length === 0 ? [] : await repo.queryRaw(
    `SELECT chunks.id, chunks.content, chunks.heading, chunks.metadata, documents.path
     FROM chunks
     INNER JOIN documents ON documents.id = chunks.document_id
     WHERE chunks.id IN (${referencedChunkIds.map(() => "?").join(",")})`,
    referencedChunkIds
  );
  const chunksById = new Map(chunkRows.map((row) => [String(row.id), row]));

  const describeSymbol = (node: Record<string, unknown>, includeSnippet = true): CodeSymbolContext => {
    const meta = metadata(node);
    const chunk = chunksById.get(String(node.ref_id ?? ""));
    const chunkMeta = parseJson(chunk?.metadata);
    const result: CodeSymbolContext = { symbol: String(node.label), label: String(node.label) };
    const filePath = meta.filePath ?? chunk?.path;
    if (typeof filePath === "string") result.path = filePath;
    if (typeof chunkMeta.startLine === "number") result.startLine = chunkMeta.startLine;
    if (typeof chunkMeta.endLine === "number") result.endLine = chunkMeta.endLine;
    if (includeSnippet && typeof chunk?.content === "string") result.snippet = chunk.content;
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
        const chunk = chunksById.get(String(node.ref_id ?? ""));
        if (!chunk) return [];
        const meta = parseJson(chunk.metadata);
        return [{
          path: String(chunk.path),
          startLine: typeof meta.startLine === "number" ? meta.startLine : undefined,
          endLine: typeof meta.endLine === "number" ? meta.endLine : undefined,
          heading: chunk.heading ? String(chunk.heading) : undefined,
          snippet: String(chunk.content)
        }];
      })
  };

  const maxTokens = input.maxTokens ?? 4000;
  const selected: CodeContextResult = { files: [], callers: [], callees: [], relatedChunks: [] };
  let usedTokens = countTokens(JSON.stringify(selected));
  let selectedCount = 0;
  const take = <T>(items: T[]): T[] => items.filter((item) => {
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
      snippet: truncateToTokenLimit(raw.symbol.snippet ?? "", Math.max(50, Math.floor(maxTokens / 2)))
    };
    const symbolTokens = countTokens(JSON.stringify(budgetedSymbol));
    selected.symbol = symbolTokens + usedTokens <= maxTokens
      ? budgetedSymbol
      : { ...budgetedSymbol, snippet: truncateToTokenLimit(budgetedSymbol.snippet, Math.max(0, maxTokens - usedTokens - 40)) };
    usedTokens += countTokens(JSON.stringify(selected.symbol));
    selectedCount += 1;
  }
  selected.callers = take(raw.callers);
  selected.callees = take(raw.callees);
  selected.files = take(raw.files);
  selected.relatedChunks = take(raw.relatedChunks);
  return selected;
}
