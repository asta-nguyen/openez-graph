import { createRegistryRepository, createWorkspaceRepository } from "@openez-graph/db";

import { countTokens } from "./tokenizer";
import type { CodeContextResult, GraphNeighborResult } from "./types";

export async function graphNeighbors(input: {
  workspaceId: string;
  nodeId?: string;
  label?: string;
  edgeTypes?: string[];
  depth?: number;
}): Promise<GraphNeighborResult> {
  const registry = createRegistryRepository();
  const workspace = await registry.getWorkspace(input.workspaceId);
  if (!workspace) {
    throw new Error(`Workspace '${input.workspaceId}' not found`);
  }

  const repo = createWorkspaceRepository(workspace.rootPath);
  const searchLabel = input.label ?? input.nodeId;
  const depth = input.depth ?? 1;

  if (!searchLabel) {
    throw new Error("Either nodeId or label is required");
  }

  const result = await repo.graphNeighbors(searchLabel, depth);

  let edges = result.edges;
  if (input.edgeTypes && input.edgeTypes.length > 0) {
    const edgeTypeSet = new Set(input.edgeTypes);
    edges = result.edges.filter((edge) => edgeTypeSet.has(String(edge.type)));
  }

  return {
    nodes: result.nodes,
    edges
  };
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
  if (!workspace) {
    throw new Error(`Workspace '${input.workspaceId}' not found`);
  }

  const repo = createWorkspaceRepository(workspace.rootPath);
  const neighbors = await repo.graphNeighbors(input.symbolOrPath, input.hops ?? 1);

  const files = neighbors.nodes.filter((node) => node.type === "file");
  const edges = neighbors.edges.filter((edge) => edge.type === "calls");
  const relatedChunks = neighbors.nodes.filter((node) => node.type === "chunk");
  const symbol = neighbors.nodes.find(
    (node) => node.type === "symbol" && (node.label === input.symbolOrPath || node.id === input.symbolOrPath)
  );
  const symbolId = symbol ? String(symbol.id) : "";
  const rawCallers = edges.filter((edge) => String(edge.to_node_id) === symbolId);
  const rawCallees = edges.filter((edge) => String(edge.from_node_id) === symbolId);
  const limit = input.limit ?? 50;
  const maxTokens = input.maxTokens ?? 4000;
  let selectedCount = 0;
  let usedTokens = 0;

  const takeWithinBudget = (records: Record<string, unknown>[]) => records.filter((record) => {
    if (selectedCount >= limit) return false;
    const tokens = countTokens(JSON.stringify(record));
    if (usedTokens + tokens > maxTokens) return false;
    selectedCount += 1;
    usedTokens += tokens;
    return true;
  });

  const selectedSymbol = symbol ? takeWithinBudget([symbol])[0] : undefined;
  const callers = takeWithinBudget(rawCallers);
  const callees = takeWithinBudget(rawCallees);
  const selectedFiles = takeWithinBudget(files);
  const selectedChunks = takeWithinBudget(relatedChunks);

  return {
    symbol: selectedSymbol,
    files: selectedFiles,
    callers,
    callees,
    relatedChunks: selectedChunks
  };
}
