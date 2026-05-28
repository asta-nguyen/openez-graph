"use server";

import { memoryQuery } from "@openez-graph/core";
import { createRegistryRepository, createWorkspaceRepository } from "@openez-graph/db";

export async function runQuery(
  _previousState: {
    answerContext: string;
    sources: Array<{ path: string; startLine?: number; endLine?: number; score: number; reason: string }>;
    graphNodes: Array<{ id: string; type: string; label: string; metadata: Record<string, unknown> }>;
    graphEdges: Array<{ from_node_id: string; to_node_id: string; type: string }>;
    error: string | null;
  },
  formData: FormData
) {
  const workspaceId = String(formData.get("workspaceId") ?? "").trim();
  const query = String(formData.get("query") ?? "");

  if (!workspaceId) {
    return {
      answerContext: "",
      sources: [],
      graphNodes: [],
      graphEdges: [],
      error: "Workspace ID is required."
    };
  }

  if (!query.trim()) {
    return {
      answerContext: "",
      sources: [],
      graphNodes: [],
      graphEdges: [],
      error: "Query is required."
    };
  }

  try {
    const registry = createRegistryRepository();
    const workspace = await registry.getWorkspace(workspaceId);

    const [result, neighborResults] = await Promise.all([
      memoryQuery({ workspaceId, query, skipGraphExpand: true }),
      (async () => {
        if (!workspace) return [];
        const repo = createWorkspaceRepository(workspace.rootPath);
        const ftsHits = await repo.fullTextSearch(query, 3);
        const paths = [...new Set(ftsHits.map((h) => h.path))];
        return Promise.all(paths.map((p) => repo.graphNeighbors(p, 1)));
      })()
    ]);

    const allGraphNodes: Array<{ id: string; type: string; label: string; metadata: Record<string, unknown> }> = [];
    const allGraphEdges: Array<{ from_node_id: string; to_node_id: string; type: string }> = [];
    const visitedNodeIds = new Set<string>();
    const edgeSet = new Set<string>();

    for (const neighbors of neighborResults) {
      for (const node of neighbors.nodes) {
        const nodeId = String(node.id);
        if (!visitedNodeIds.has(nodeId)) {
          visitedNodeIds.add(nodeId);
          allGraphNodes.push({
            id: nodeId,
            type: String(node.type),
            label: String(node.label),
            metadata: typeof node.metadata === "object" && node.metadata !== null
              ? node.metadata as Record<string, unknown>
              : {}
          });
        }
      }

      for (const edge of neighbors.edges) {
        const key = `${edge.from_node_id}:${edge.to_node_id}:${edge.type}`;
        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          allGraphEdges.push({
            from_node_id: String(edge.from_node_id),
            to_node_id: String(edge.to_node_id),
            type: String(edge.type)
          });
        }
      }
    }

    return {
      ...result,
      graphNodes: allGraphNodes,
      graphEdges: allGraphEdges,
      error: null
    };
  } catch (error) {
    return {
      answerContext: "",
      sources: [],
      graphNodes: [],
      graphEdges: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
