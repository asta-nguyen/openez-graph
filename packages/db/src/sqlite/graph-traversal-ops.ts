import type { NativeDatabase } from "./shared-types";
import { safeParseJson } from "./utils";
import { type GraphStmts } from "./graph-ops-shared";

/** Graph traversal only. Graph lifecycle and construction live in the indexer. */
export function createGraphTraversalOps(native: NativeDatabase, _stmts: GraphStmts) {
  return {
    async graphNeighbors(labelOrId: string, depth: number, limit = 50) {
      const seedNodes = native
        .prepare("SELECT * FROM graph_nodes WHERE id = ? OR label = ? ORDER BY id = ? DESC LIMIT 1")
        .all(labelOrId, labelOrId, labelOrId) as Array<Record<string, unknown>>;

      if (seedNodes.length === 0) return { nodes: [], edges: [] };

      const seedId = String(seedNodes[0].id);
      const visited = new Set<string>();
      const resultNodes: Array<Record<string, unknown>> = [
        { ...seedNodes[0], metadata: safeParseJson(String(seedNodes[0].metadata ?? ""), {}) },
      ];
      const resultEdges: Array<Record<string, unknown>> = [];
      const resultEdgeIds = new Set<string>();
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

        const nextBatch: string[] = [];
        for (const edge of edges) {
          const fromId = String(edge.from_node_id);
          const toId = String(edge.to_node_id);
          if (!visited.has(fromId) && visited.size < limit) {
            nextBatch.push(fromId);
            visited.add(fromId);
          }
          if (!visited.has(toId) && visited.size < limit) {
            nextBatch.push(toId);
            visited.add(toId);
          }
          const edgeId = String(edge.id);
          if (
            visited.has(fromId) &&
            visited.has(toId) &&
            !resultEdgeIds.has(edgeId) &&
            resultEdges.length < limit
          ) {
            resultEdgeIds.add(edgeId);
            resultEdges.push(edge);
          }
        }

        for (const nodeId of nextBatch) {
          const node = native.prepare("SELECT * FROM graph_nodes WHERE id = ?").get(nodeId) as
            | Record<string, unknown>
            | undefined;
          if (node) {
            resultNodes.push({ ...node, metadata: safeParseJson(String(node.metadata ?? ""), {}) });
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
        id: string;
        type: string;
        label: string;
        refId?: string;
        metadata?: string;
      }>;
      edges: Array<{
        id: string;
        fromNodeId: string;
        toNodeId: string;
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
              node.id,
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
              edge.id,
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
              `INSERT INTO graph_edges
                 (id, from_node_id, to_node_id, type, weight, metadata, created_at)
               VALUES ${placeholders}`,
            )
            .run(...params);
        }
        native
          .prepare("INSERT OR REPLACE INTO index_meta (key, value) VALUES ('graph_build_epoch', ?)")
          .run(String(input.buildEpoch));
        replaced = true;
        native.exec("COMMIT");
        return replaced;
      } catch (error) {
        try {
          native.exec("ROLLBACK");
        } catch {}
        throw error;
      }
    },
  };
}
