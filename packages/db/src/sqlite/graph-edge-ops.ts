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
      fromNodeId: number;
      toNodeId: number;
      type: string;
      weight?: number;
      metadata?: string;
    }): Promise<number> {
      const now = new Date().toISOString();
      const res = stmts.insertEdge.run(
        input.fromNodeId,
        input.toNodeId,
        input.type,
        input.weight ?? 1,
        input.metadata ?? "{}",
        now,
      );
      return Number(res.lastInsertRowid);
    },

    async insertEdges(
      inputs: Array<{
        fromNodeId: number;
        toNodeId: number;
        type: string;
        weight?: number;
        metadata?: string;
      }>,
    ): Promise<void> {
      if (inputs.length === 0) return;
      const now = new Date().toISOString();
      const BATCH = 500;
      for (let i = 0; i < inputs.length; i += BATCH) {
        const batch = inputs.slice(i, i + BATCH);
        for (const item of batch) {
          stmts.insertEdge.run(
            item.fromNodeId,
            item.toNodeId,
            item.type,
            item.weight ?? 1,
            item.metadata ?? "{}",
            now,
          );
        }
      }
    },

    async deleteEdgesByNodeIds(nodeIds: number[]) {
      if (nodeIds.length === 0) return;
      const placeholders = nodeIds.map(() => "?").join(",");
      native
        .prepare(
          `DELETE FROM graph_edges WHERE from_node_id IN (${placeholders}) OR to_node_id IN (${placeholders})`,
        )
        .run(...nodeIds, ...nodeIds);
    },

    deleteOutgoingEdges(nodeId: number, types?: string[]) {
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
        id?: number;
        fromNodeId: number;
        toNodeId: number;
        type: string;
        weight?: number;
        metadata?: string;
      }>,
    ): void {
      if (inputs.length === 0) return;
      const now = streamNow.value;
      for (const e of inputs) {
        if (e.id !== undefined && stmts.insertEdgeWithId) {
          stmts.insertEdgeWithId.run(
            e.id,
            e.fromNodeId,
            e.toNodeId,
            e.type,
            e.weight ?? 1,
            e.metadata ?? "{}",
            now,
          );
        } else {
          stmts.insertEdge.run(
            e.fromNodeId,
            e.toNodeId,
            e.type,
            e.weight ?? 1,
            e.metadata ?? "{}",
            now,
          );
        }
      }
    },

    streamEdge(input: {
      id?: number;
      fromNodeId: number;
      toNodeId: number;
      type: string;
      weight?: number;
      metadata?: string;
    }): number {
      const now = streamNow.value;
      if (input.id !== undefined && stmts.insertEdgeWithId) {
        stmts.insertEdgeWithId.run(
          input.id,
          input.fromNodeId,
          input.toNodeId,
          input.type,
          input.weight ?? 1,
          input.metadata ?? "{}",
          now,
        );
        return input.id;
      }
      const res = stmts.insertEdge.run(
        input.fromNodeId,
        input.toNodeId,
        input.type,
        input.weight ?? 1,
        input.metadata ?? "{}",
        now,
      );
      return Number(res.lastInsertRowid);
    },
  };
}
