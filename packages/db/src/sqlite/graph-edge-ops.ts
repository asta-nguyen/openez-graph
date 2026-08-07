import crypto from "node:crypto";

import type { NativeDatabase, StreamTimestampHolder } from "./shared-types";
import type { GraphStmts } from "./graph-ops-shared";

/**
 * Factory for graph edge operations extracted from `createGraphOps()`.
 *
 * Behavior is identical to the original inline implementations — this is a
 * pure code-move. `streamNow` is shared via a mutable holder so that
 * `refreshStreamTimestamp()` (defined in `document-repository.ts`) stays
 * visible to the edge stream methods here.
 */
export function createGraphEdgeOps(
  native: NativeDatabase,
  stmts: GraphStmts,
  streamNow: StreamTimestampHolder,
) {
  return {
    async getEdgeCount(): Promise<number> {
      const row = native.prepare("SELECT count(*) AS count FROM graph_edges").get() as {
        count: number;
      };
      return row?.count ?? 0;
    },

    // ── Graph Edge Operations ──

    async insertEdge(input: {
      fromNodeId: string;
      toNodeId: string;
      type: string;
      weight?: number;
      metadata?: string;
    }): Promise<string> {
      const id = crypto.randomUUID();
      stmts.insertEdge.run(
        id,
        input.fromNodeId,
        input.toNodeId,
        input.type,
        input.weight ?? 1,
        input.metadata ?? "{}",
        new Date().toISOString(),
      );
      return id;
    },

    async insertEdges(
      inputs: Array<{
        fromNodeId: string;
        toNodeId: string;
        type: string;
        weight?: number;
        metadata?: string;
      }>,
    ): Promise<void> {
      if (inputs.length === 0) return;
      const now = new Date().toISOString();
      const BATCH = 2000;
      for (let i = 0; i < inputs.length; i += BATCH) {
        const batch = inputs.slice(i, i + BATCH);
        const placeholders = batch.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(",");
        const params: unknown[] = [];
        for (const item of batch) {
          params.push(
            crypto.randomUUID(),
            item.fromNodeId,
            item.toNodeId,
            item.type,
            item.weight ?? 1,
            item.metadata ?? "{}",
            now,
          );
        }
        native
          .prepare(
            `INSERT INTO graph_edges (id, from_node_id, to_node_id, type, weight, metadata, created_at) VALUES ${placeholders} ON CONFLICT(from_node_id, to_node_id, type) DO NOTHING`,
          )
          .run(...params);
      }
    },

    async deleteEdgesByNodeIds(nodeIds: string[]) {
      if (nodeIds.length === 0) return;
      const placeholders = nodeIds.map(() => "?").join(",");
      native
        .prepare(
          `DELETE FROM graph_edges WHERE from_node_id IN (${placeholders}) OR to_node_id IN (${placeholders})`,
        )
        .run(...nodeIds, ...nodeIds);
    },

    deleteOutgoingEdges(nodeId: string, types?: string[]) {
      if (types && types.length > 0) {
        const placeholders = types.map(() => "?").join(",");
        native
          .prepare(`DELETE FROM graph_edges WHERE from_node_id = ? AND type IN (${placeholders})`)
          .run(nodeId, ...types);
      } else {
        native.prepare("DELETE FROM graph_edges WHERE from_node_id = ?").run(nodeId);
      }
    },

    // ── Streaming inserts (graph edges) ──

    streamEdgesBatch(
      inputs: Array<{
        id: string;
        fromNodeId: string;
        toNodeId: string;
        type: string;
        weight?: number;
        metadata?: string;
      }>,
    ): void {
      if (inputs.length === 0) return;
      const BATCH = 500;
      const now = streamNow.value;
      for (let i = 0; i < inputs.length; i += BATCH) {
        const batch = inputs.slice(i, i + BATCH);
        const placeholders = batch.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(",");
        const params: unknown[] = [];
        for (const e of batch) {
          params.push(
            e.id,
            e.fromNodeId,
            e.toNodeId,
            e.type,
            e.weight ?? 1,
            e.metadata ?? "{}",
            now,
          );
        }
        native
          .prepare(
            `INSERT INTO graph_edges (id, from_node_id, to_node_id, type, weight, metadata, created_at) VALUES ${placeholders}`,
          )
          .run(...params);
      }
    },

    streamEdge(input: {
      id: string;
      fromNodeId: string;
      toNodeId: string;
      type: string;
      weight?: number;
      metadata?: string;
    }): void {
      stmts.insertEdge.run(
        input.id,
        input.fromNodeId,
        input.toNodeId,
        input.type,
        input.weight ?? 1,
        input.metadata ?? "{}",
        streamNow.value,
      );
    },
  };
}
