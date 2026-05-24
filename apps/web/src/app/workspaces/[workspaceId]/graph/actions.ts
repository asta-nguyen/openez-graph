"use server";

import {
  getGraphNodeById,
  getRegistryWorkspace,
  listGraphEdges,
  listGraphNodes,
  searchGraphNodesByLabel
} from "../../../../server/sqlite";

export interface GraphNodeData {
  id: string;
  label: string;
  type: string;
  degree: number;
  metadata: Record<string, unknown>;
  path?: string;
  startLine?: number;
  endLine?: number;
  refId?: string | null;
}

export interface GraphEdgeData {
  id: string;
  source: string;
  target: string;
  type: string;
  weight: number;
}

export interface WorkspaceGraphData {
  workspaceId: string;
  workspaceName: string;
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
  nodeTypes: string[];
  edgeTypes: string[];
  totalNodes: number;
  totalEdges: number;
}

export async function getWorkspaceGraph(workspaceId: string): Promise<WorkspaceGraphData | null> {
  const workspace = getRegistryWorkspace(workspaceId);
  if (!workspace) return null;

  const nodeRows = listGraphNodes(workspace.rootPath, 500);
  const edgeRows = listGraphEdges(workspace.rootPath, 1000);

  const degreeMap = new Map<string, number>();
  for (const edge of edgeRows) {
    const fromId = edge.source;
    const toId = edge.target;
    degreeMap.set(fromId, (degreeMap.get(fromId) ?? 0) + 1);
    degreeMap.set(toId, (degreeMap.get(toId) ?? 0) + 1);
  }

  const nodes: GraphNodeData[] = nodeRows.map((node) => {
    const metadata = node.metadata;
    return {
      id: node.id,
      label: node.label,
      type: node.type,
      degree: degreeMap.get(node.id) ?? 0,
      metadata,
      path: typeof metadata?.path === "string" ? metadata.path : undefined,
      startLine: typeof metadata?.startLine === "number" ? metadata.startLine : undefined,
      endLine: typeof metadata?.endLine === "number" ? metadata.endLine : undefined,
      refId: node.refId,
    };
  });

  const validIds = new Set(nodes.map((n) => n.id));
  const edges: GraphEdgeData[] = edgeRows
    .filter((e) => validIds.has(e.source) && validIds.has(e.target))
    .map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: edge.type,
      weight: edge.weight,
    }));

  const nodeTypes = [...new Set(nodes.map((n) => n.type))].sort();
  const edgeTypes = [...new Set(edges.map((e) => e.type))].sort();

  return {
    workspaceId,
    workspaceName: workspace.name,
    nodes,
    edges,
    nodeTypes,
    edgeTypes,
    totalNodes: nodes.length,
    totalEdges: edges.length,
  };
}

export interface NodeNeighbors {
  node: GraphNodeData;
  incoming: GraphEdgeData[];
  outgoing: GraphEdgeData[];
}

export async function getNodeNeighbors(
  workspaceId: string,
  nodeId: string
): Promise<NodeNeighbors | null> {
  const workspace = getRegistryWorkspace(workspaceId);
  if (!workspace) return null;

  const node = getGraphNodeById(workspace.rootPath, nodeId);
  if (!node) return null;

  const allEdges = listGraphEdges(workspace.rootPath, 5000);

  const incoming = allEdges
    .filter((e) => e.target === nodeId)
    .map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      type: e.type,
      weight: e.weight,
    }));

  const outgoing = allEdges
    .filter((e) => e.source === nodeId)
    .map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      type: e.type,
      weight: e.weight,
    }));

  const metadata = node.metadata;
  const graphNodeData: GraphNodeData = {
    id: node.id,
    label: node.label,
    type: node.type,
    degree: incoming.length + outgoing.length,
    metadata,
    path: typeof metadata?.path === "string" ? metadata.path : undefined,
    startLine: typeof metadata?.startLine === "number" ? metadata.startLine : undefined,
      endLine: typeof metadata?.endLine === "number" ? metadata.endLine : undefined,
    refId: node.refId,
  };

  return { node: graphNodeData, incoming, outgoing };
}

export async function searchGraphNodes(
  workspaceId: string,
  query: string,
  nodeTypes?: string[]
): Promise<GraphNodeData[]> {
  const workspace = getRegistryWorkspace(workspaceId);
  if (!workspace) return [];

  const nodeRows = searchGraphNodesByLabel(workspace.rootPath, query, nodeTypes);
  const edgeRows = listGraphEdges(workspace.rootPath, 5000);

  const degreeMap = new Map<string, number>();
  for (const edge of edgeRows) {
    const fromId = edge.source;
    const toId = edge.target;
    degreeMap.set(fromId, (degreeMap.get(fromId) ?? 0) + 1);
    degreeMap.set(toId, (degreeMap.get(toId) ?? 0) + 1);
  }

  return nodeRows.map((node) => {
    const metadata = node.metadata;
    return {
      id: node.id,
      label: node.label,
      type: node.type,
      degree: degreeMap.get(node.id) ?? 0,
      metadata,
      path: typeof metadata?.path === "string" ? metadata.path : undefined,
      startLine: typeof metadata?.startLine === "number" ? metadata.startLine : undefined,
      endLine: typeof metadata?.endLine === "number" ? metadata.endLine : undefined,
      refId: node.refId,
    };
  });
}
