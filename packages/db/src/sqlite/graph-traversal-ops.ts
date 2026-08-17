import type { NativeDatabase } from "./shared-types";
import { safeParseJson } from "./utils";
import { type GraphStmts } from "./graph-ops-shared";

/** Graph traversal only. Graph lifecycle and construction live in the indexer. */
export function createGraphTraversalOps(native: NativeDatabase, _stmts: GraphStmts) {
  return {
    async graphNeighbors(labelOrId: string | number, depth: number, limit = 50) {
      const seedNodes = native
        .prepare("SELECT * FROM graph_nodes WHERE id = ? OR label = ? ORDER BY id = ? DESC LIMIT 1")
        .all(labelOrId, String(labelOrId), labelOrId) as Array<Record<string, unknown>>;

      if (seedNodes.length === 0) return { nodes: [], edges: [] };

      const seedId = Number(seedNodes[0].id);
      const visited = new Set<number>();
      const resultNodes: Array<Record<string, unknown>> = [
        {
          ...seedNodes[0],
          id: Number(seedNodes[0].id),
          metadata: safeParseJson(String(seedNodes[0].metadata ?? ""), {}),
        },
      ];
      const resultEdges: Array<Record<string, unknown>> = [];
      const resultEdgeIds = new Set<number>();
      let currentBatch = [seedId];
      visited.add(seedId);

      for (let hop = 0; hop < Math.max(0, depth); hop++) {
        if (currentBatch.length === 0) break;
        const placeholders = currentBatch.map(() => "?").join(",");
        const edges = native
          .prepare(
            `SELECT * FROM graph_edges WHERE (from_node_id IN (${placeholders}) OR to_node_id IN (${placeholders})) LIMIT ?`,
          )
          .all(...currentBatch, ...currentBatch, limit) as Array<Record<string, unknown>>;

        const nextBatch: number[] = [];
        for (const edge of edges) {
          const fromId = Number(edge.from_node_id);
          const toId = Number(edge.to_node_id);
          if (!visited.has(fromId) && visited.size < limit) {
            nextBatch.push(fromId);
            visited.add(fromId);
          }
          if (!visited.has(toId) && visited.size < limit) {
            nextBatch.push(toId);
            visited.add(toId);
          }
          const edgeId = Number(edge.id);
          if (
            visited.has(fromId) &&
            visited.has(toId) &&
            !resultEdgeIds.has(edgeId) &&
            resultEdges.length < limit
          ) {
            resultEdgeIds.add(edgeId);
            resultEdges.push({
              ...edge,
              id: edgeId,
              from_node_id: fromId,
              to_node_id: toId,
            });
          }
        }

        for (const nodeId of nextBatch) {
          const node = native.prepare("SELECT * FROM graph_nodes WHERE id = ?").get(nodeId) as
            | Record<string, unknown>
            | undefined;
          if (node) {
            resultNodes.push({
              ...node,
              id: Number(node.id),
              metadata: safeParseJson(String(node.metadata ?? ""), {}),
            });
          }
        }
        currentBatch = nextBatch;
      }

      return { nodes: resultNodes, edges: resultEdges };
    },

    clearGraphArtifacts(): void {
      native.exec("DELETE FROM graph_edges");
      native.exec("DELETE FROM graph_nodes");
    },

    replaceGraphArtifacts(input: {
      buildEpoch: number;
      nodes: Array<{
        id?: number;
        type: string;
        label: string;
        refId?: number | string;
        metadata?: string;
      }>;
      edges: Array<{
        id?: number;
        fromNodeId: number;
        toNodeId: number;
        type: string;
        weight?: number;
        metadata?: string;
      }>;
    }): boolean {
      let replaced = false;
      if (!Number.isFinite(input.buildEpoch)) {
        throw new Error("Invalid graph build epoch");
      }
      native.exec("BEGIN IMMEDIATE");
      try {
        const epochRow = native
          .prepare("SELECT value FROM index_meta WHERE key = 'graph_build_epoch'")
          .get() as { value: string } | undefined;
        const currentEpoch = epochRow ? Number(epochRow.value) : -1;
        if (epochRow && !Number.isFinite(currentEpoch)) {
          throw new Error("Invalid stored graph build epoch");
        }
        if (Number.isFinite(currentEpoch) && currentEpoch > input.buildEpoch) {
          native.exec("COMMIT");
          return false;
        }

        native.exec("DELETE FROM graph_edges");
        native.exec("DELETE FROM graph_nodes");
        const now = new Date().toISOString();
        const batchSize = 500;
        for (let index = 0; index < input.nodes.length; index += batchSize) {
          const batch = input.nodes.slice(index, index + batchSize);
          const placeholders = batch.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(",");
          const params: unknown[] = [];
          for (const node of batch) {
            params.push(
              typeof node.id === "number" ? node.id : null,
              node.type,
              node.label,
              node.refId ?? null,
              node.metadata ?? "{}",
              now,
              now,
            );
          }
          native
            .prepare(
              `INSERT INTO graph_nodes (id, type, label, ref_id, metadata, created_at, updated_at)
               VALUES ${placeholders}`,
            )
            .run(...params);
        }
        for (let index = 0; index < input.edges.length; index += batchSize) {
          const batch = input.edges.slice(index, index + batchSize);
          const placeholders = batch.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(",");
          const params: unknown[] = [];
          for (const edge of batch) {
            params.push(
              typeof edge.id === "number" ? edge.id : null,
              edge.fromNodeId,
              edge.toNodeId,
              edge.type,
              edge.weight ?? 1,
              edge.metadata ?? "{}",
              now,
            );
          }
          native
            .prepare(
              `INSERT INTO graph_edges (id, from_node_id, to_node_id, type, weight, metadata, created_at)
               VALUES ${placeholders}`,
            )
            .run(...params);
        }
        native
          .prepare(
            `INSERT INTO index_meta (key, value) VALUES ('graph_build_epoch', ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          )
          .run(String(input.buildEpoch));
        native.exec("COMMIT");
        replaced = true;
      } catch (error) {
        try {
          native.exec("ROLLBACK");
        } catch {}
        throw error;
      }
      return replaced;
    },
  };
}
