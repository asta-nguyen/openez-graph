import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";

import type { DatabaseRow, GraphNeighborNode, JsonValue, NativeDatabase } from "./shared-types";
import { safeParseJson } from "./utils";
import * as schema from "./schema";

/** Graph traversal only. Graph lifecycle and construction live in the indexer. */
export function createGraphTraversalOps(native: NativeDatabase) {
  // SAFETY: drizzle-orm/bun-sqlite expects a BunSqlite.Database instance;
  // NativeDatabase is structurally compatible (exposes the same prepare/exec
  // methods). The `as any` bridges the structural mismatch without affecting
  // runtime behavior.
  const db = drizzle(native as any, { schema });

  return {
    async graphNeighbors(labelOrId: string, depth: number, limit = 50) {
      // This is a multi-hop BFS traversal whose result rows (snake_case
      // column keys) are spread directly into the `GraphNeighborNode`
      // index-signature shape consumed by callers in `packages/core`. The
      // traversal issues many small queries inside a loop; converting the
      // individual lookups to Drizzle would change the returned column
      // naming (camelCase) and break downstream consumers, so the raw SQL
      // path is retained here.
      const seedNodes = native
        .prepare("SELECT * FROM graph_nodes WHERE id = ? OR label = ? ORDER BY id = ? DESC LIMIT 1")
        .all(labelOrId, labelOrId, labelOrId);

      if (seedNodes.length === 0) return { nodes: [], edges: [] };

      const seedId = String(seedNodes[0].id);
      const visited = new Set<string>();
      const resultNodes: GraphNeighborNode[] = [
        {
          ...seedNodes[0],
          metadata: safeParseJson<Record<string, JsonValue>>(
            String(seedNodes[0].metadata ?? ""),
            {},
          ),
        },
      ];
      const resultEdges: DatabaseRow[] = [];
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
          .all(...currentBatch, ...currentBatch, limit);

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
          const node = native.prepare("SELECT * FROM graph_nodes WHERE id = ?").get(nodeId);
          if (node) {
            resultNodes.push({
              ...node,
              metadata: safeParseJson<Record<string, JsonValue>>(String(node.metadata ?? ""), {}),
            });
          }
        }
        currentBatch = nextBatch;
      }

      return { nodes: resultNodes, edges: resultEdges };
    },

    clearGraphArtifacts(): void {
      db.delete(schema.graphEdges).run();
      db.delete(schema.graphNodes).run();
    },

    replaceGraphArtifacts(input: {
      buildEpoch: number;
      nodes: Array<{
        id: number;
        type: string;
        label: string;
        refId?: string;
        metadata?: string;
      }>;
      edges: Array<{
        id: number;
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
        const epochRow = db
          .select({ value: schema.indexMeta.value })
          .from(schema.indexMeta)
          .where(eq(schema.indexMeta.key, "graph_build_epoch"))
          .get();
        const currentEpoch = epochRow ? Number(epochRow.value) : -1;
        if (epochRow && !Number.isFinite(currentEpoch)) {
          throw new Error("Invalid stored graph build epoch");
        }
        if (Number.isFinite(currentEpoch) && currentEpoch > input.buildEpoch) {
          native.exec("COMMIT");
          return false;
        }

        db.delete(schema.graphEdges).run();
        db.delete(schema.graphNodes).run();
        const now = new Date().toISOString();
        const batchSize = 500;
        const idMap = new Map<number, number>();
        for (let index = 0; index < input.nodes.length; index += batchSize) {
          const batch = input.nodes.slice(index, index + batchSize);
          const rows = db
            .insert(schema.graphNodes)
            .values(
              batch.map((node) => ({
                type: node.type,
                label: node.label,
                refId: node.refId ?? null,
                metadata: node.metadata ?? "{}",
                createdAt: now,
                updatedAt: now,
              })),
            )
            .returning({ id: schema.graphNodes.id })
            .all();
          for (let j = 0; j < rows.length; j++) {
            idMap.set(batch[j].id, Number(rows[j].id));
          }
        }
        for (let index = 0; index < input.edges.length; index += batchSize) {
          const batch = input.edges.slice(index, index + batchSize);
          db.insert(schema.graphEdges)
            .values(
              batch.map((edge) => ({
                fromNodeId: idMap.get(edge.fromNodeId) ?? edge.fromNodeId,
                toNodeId: idMap.get(edge.toNodeId) ?? edge.toNodeId,
                type: edge.type,
                weight: edge.weight ?? 1,
                metadata: edge.metadata ?? "{}",
                createdAt: now,
              })),
            )
            .run();
        }
        db.insert(schema.indexMeta)
          .values({ key: "graph_build_epoch", value: String(input.buildEpoch) })
          .onConflictDoUpdate({
            target: schema.indexMeta.key,
            set: { value: String(input.buildEpoch) },
          })
          .run();
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
