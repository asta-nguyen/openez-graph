import { and, count, eq, inArray, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";

import type { NativeDatabase, StreamTimestampHolder } from "./shared-types";
import * as schema from "./schema";

/**
 * Factory for graph edge operations extracted from `createGraphOps()`.
 *
 * Behavior is identical to the original inline implementations — this is a
 * pure code-move. `streamNow` is shared via a mutable holder so that
 * `refreshStreamTimestamp()` (defined in `document-repository.ts`) stays
 * visible to the edge stream methods here.
 */
export function createGraphEdgeOps(native: NativeDatabase, streamNow: StreamTimestampHolder) {
  // SAFETY: drizzle-orm/bun-sqlite expects a BunSqlite.Database instance;
  // NativeDatabase is structurally compatible (exposes the same prepare/exec
  // methods). The `as any` bridges the structural mismatch without affecting
  // runtime behavior.
  const db = drizzle(native as any, { schema });

  return {
    async getEdgeCount(): Promise<number> {
      const row = db.select({ count: count() }).from(schema.graphEdges).get();
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
      // `RETURNING id` yields the autoincrement primary key, which equals
      // the rowid that the original `lastInsertRowid` read exposed. When
      // `ON CONFLICT DO NOTHING` suppresses a duplicate, no row is returned
      // and 0 is used as the fallback (matching the stale-rowid behavior of
      // the original `lastInsertRowid` read in the no-prior-insert case).
      const inserted = db
        .insert(schema.graphEdges)
        .values({
          fromNodeId: input.fromNodeId,
          toNodeId: input.toNodeId,
          type: input.type,
          weight: input.weight ?? 1,
          metadata: input.metadata ?? "{}",
          createdAt: new Date().toISOString(),
        })
        .onConflictDoNothing({
          target: [
            schema.graphEdges.fromNodeId,
            schema.graphEdges.toNodeId,
            schema.graphEdges.type,
          ],
        })
        .returning({ id: schema.graphEdges.id })
        .get();
      return Number(inserted?.id ?? 0);
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
      const BATCH = 2000;
      for (let i = 0; i < inputs.length; i += BATCH) {
        const batch = inputs.slice(i, i + BATCH);
        db.insert(schema.graphEdges)
          .values(
            batch.map((item) => ({
              fromNodeId: item.fromNodeId,
              toNodeId: item.toNodeId,
              type: item.type,
              weight: item.weight ?? 1,
              metadata: item.metadata ?? "{}",
              createdAt: now,
            })),
          )
          .onConflictDoNothing({
            target: [
              schema.graphEdges.fromNodeId,
              schema.graphEdges.toNodeId,
              schema.graphEdges.type,
            ],
          })
          .run();
      }
    },

    async deleteEdgesByNodeIds(nodeIds: number[]) {
      if (nodeIds.length === 0) return;
      db.delete(schema.graphEdges)
        .where(
          or(
            inArray(schema.graphEdges.fromNodeId, nodeIds),
            inArray(schema.graphEdges.toNodeId, nodeIds),
          ),
        )
        .run();
    },

    deleteOutgoingEdges(nodeId: number, types?: string[]) {
      if (types && types.length > 0) {
        db.delete(schema.graphEdges)
          .where(
            and(eq(schema.graphEdges.fromNodeId, nodeId), inArray(schema.graphEdges.type, types)),
          )
          .run();
      } else {
        db.delete(schema.graphEdges).where(eq(schema.graphEdges.fromNodeId, nodeId)).run();
      }
    },

    // ── Streaming inserts (graph edges) ──

    streamEdgesBatch(
      inputs: Array<{
        id: number;
        fromNodeId: number;
        toNodeId: number;
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
        db.insert(schema.graphEdges)
          .values(
            batch.map((e) => ({
              fromNodeId: e.fromNodeId,
              toNodeId: e.toNodeId,
              type: e.type,
              weight: e.weight ?? 1,
              metadata: e.metadata ?? "{}",
              createdAt: now,
            })),
          )
          .run();
      }
    },

    streamEdge(input: {
      id: number;
      fromNodeId: number;
      toNodeId: number;
      type: string;
      weight?: number;
      metadata?: string;
    }): void {
      db.insert(schema.graphEdges)
        .values({
          fromNodeId: input.fromNodeId,
          toNodeId: input.toNodeId,
          type: input.type,
          weight: input.weight ?? 1,
          metadata: input.metadata ?? "{}",
          createdAt: streamNow.value,
        })
        .onConflictDoNothing({
          target: [
            schema.graphEdges.fromNodeId,
            schema.graphEdges.toNodeId,
            schema.graphEdges.type,
          ],
        })
        .run();
    },
  };
}
