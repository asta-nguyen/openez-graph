import { and, count, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";

import type { NativeDatabase, StreamTimestampHolder } from "./shared-types";
import { mapNodeRow } from "./graph-ops-shared";
import * as schema from "./schema";

/**
 * Factory for graph node operations extracted from `createGraphOps()`.
 *
 * Behavior is identical to the original inline implementations — this is a
 * pure code-move. `streamNow` is shared via a mutable holder so that
 * `refreshStreamTimestamp()` (defined in `document-repository.ts`) stays
 * visible to the node stream methods here.
 */
export function createGraphNodeOps(native: NativeDatabase, streamNow: StreamTimestampHolder) {
  // SAFETY: drizzle-orm/bun-sqlite expects a BunSqlite.Database instance;
  // NativeDatabase is structurally compatible (exposes the same prepare/exec
  // methods). The `as any` bridges the structural mismatch without affecting
  // runtime behavior.
  const db = drizzle(native as any, { schema });

  return {
    async getNodeCount(): Promise<number> {
      const row = db.select({ count: count() }).from(schema.graphNodes).get();
      return row?.count ?? 0;
    },

    // ── Graph Node Operations ──

    async upsertGraphNode(input: {
      type: string;
      label: string;
      refId?: string;
      metadata?: string;
    }): Promise<number> {
      if (input.type === "symbol") {
        if (input.refId) {
          const existing = db
            .select()
            .from(schema.graphNodes)
            .where(
              and(
                eq(schema.graphNodes.type, input.type),
                eq(schema.graphNodes.label, input.label),
                eq(schema.graphNodes.refId, input.refId),
              ),
            )
            .get();
          if (existing) {
            const nextMetadata = input.metadata ?? String(existing.metadata ?? "{}");
            if (nextMetadata !== existing.metadata) {
              db.update(schema.graphNodes)
                .set({
                  refId: input.refId,
                  metadata: nextMetadata,
                  updatedAt: new Date().toISOString(),
                })
                .where(eq(schema.graphNodes.id, existing.id))
                .run();
            }
            return Number(existing.id);
          }
        }
        const now = new Date().toISOString();
        // `RETURNING id` yields the autoincrement primary key, which equals
        // the rowid that the original `lastInsertRowid` read exposed.
        const inserted = db
          .insert(schema.graphNodes)
          .values({
            type: input.type,
            label: input.label,
            refId: input.refId ?? null,
            metadata: input.metadata ?? "{}",
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: schema.graphNodes.id })
          .get();
        return Number(inserted?.id ?? 0);
      }

      const now = new Date().toISOString();
      // SAFETY: INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING id always
      // returns exactly one row (either the inserted or the updated row);
      // the non-null assertion narrows away the undefined case that Drizzle's
      // `.get()` return type includes.
      const row = db
        .insert(schema.graphNodes)
        .values({
          type: input.type,
          label: input.label,
          refId: input.refId ?? null,
          metadata: input.metadata ?? "{}",
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [schema.graphNodes.type, schema.graphNodes.label],
          targetWhere: sql`${schema.graphNodes.type} != 'symbol'`,
          set: {
            refId: sql`COALESCE(excluded.ref_id, graph_nodes.ref_id)`,
            metadata: sql`excluded.metadata`,
            updatedAt: sql`excluded.updated_at`,
          },
        })
        .returning({ id: schema.graphNodes.id })
        .get()!;
      return Number(row.id);
    },

    async insertGraphNodesBatch(
      inputs: Array<{ type: string; label: string; refId?: string; metadata?: string }>,
    ): Promise<number[]> {
      if (inputs.length === 0) return [];
      const now = new Date().toISOString();
      const ids: number[] = Array.from({ length: inputs.length });
      const BATCH = 2000;
      for (let i = 0; i < inputs.length; i += BATCH) {
        const batch = inputs.slice(i, i + BATCH);
        const rows = db
          .insert(schema.graphNodes)
          .values(
            batch.map((item) => ({
              type: item.type,
              label: item.label,
              refId: item.refId ?? null,
              metadata: item.metadata ?? "{}",
              createdAt: now,
              updatedAt: now,
            })),
          )
          .onConflictDoUpdate({
            target: [schema.graphNodes.type, schema.graphNodes.label],
            targetWhere: sql`${schema.graphNodes.type} != 'symbol'`,
            set: {
              metadata: sql`excluded.metadata`,
              updatedAt: sql`excluded.updated_at`,
            },
          })
          .returning({ id: schema.graphNodes.id })
          .all();
        for (let j = 0; j < rows.length; j++) {
          ids[i + j] = Number(rows[j].id);
        }
      }
      return ids;
    },

    async upsertGraphNodesBatch(
      inputs: Array<{ type: string; label: string; refId?: string; metadata?: string }>,
    ): Promise<Array<{ label: string; id: number }>> {
      if (inputs.length === 0) return [];
      const now = new Date().toISOString();
      const BATCH = 500;
      const results: Array<{ label: string; id: number }> = [];

      for (let i = 0; i < inputs.length; i += BATCH) {
        const batch = inputs.slice(i, i + BATCH);
        const rows = db
          .insert(schema.graphNodes)
          .values(
            batch.map((item) => ({
              type: item.type,
              label: item.label,
              refId: item.refId ?? null,
              metadata: item.metadata ?? "{}",
              createdAt: now,
              updatedAt: now,
            })),
          )
          .onConflictDoUpdate({
            target: [schema.graphNodes.type, schema.graphNodes.label],
            targetWhere: sql`${schema.graphNodes.type} != 'symbol'`,
            set: {
              refId: sql`COALESCE(excluded.ref_id, graph_nodes.ref_id)`,
              metadata: sql`excluded.metadata`,
              updatedAt: sql`excluded.updated_at`,
            },
          })
          .returning({ id: schema.graphNodes.id, label: schema.graphNodes.label })
          .all();
        results.push(...rows.map((r) => ({ label: r.label, id: Number(r.id) })));
      }
      return results;
    },

    async getGraphNode(id: number) {
      const row = db.select().from(schema.graphNodes).where(eq(schema.graphNodes.id, id)).get();
      return row ? mapNodeRow(row) : null;
    },

    async findGraphNode(type: string, label: string) {
      const row = db
        .select()
        .from(schema.graphNodes)
        .where(and(eq(schema.graphNodes.type, type), eq(schema.graphNodes.label, label)))
        .get();
      return row ? mapNodeRow(row) : null;
    },

    async deleteGraphNodesByRefId(refId: string) {
      db.delete(schema.graphNodes)
        .where(
          sql`${schema.graphNodes.refId} = ${refId} OR ${schema.graphNodes.refId} IN (SELECT ${schema.chunks.id} FROM ${schema.chunks} WHERE ${schema.chunks.documentId} = ${refId})`,
        )
        .run();
    },

    async findFileNode(relativePath: string) {
      const row = db
        .select()
        .from(schema.graphNodes)
        .where(and(eq(schema.graphNodes.type, "file"), eq(schema.graphNodes.label, relativePath)))
        .get();
      return row ? mapNodeRow(row) : null;
    },

    async getSymbolNodesByFilePath(filePath: string) {
      const rows = db
        .select()
        .from(schema.graphNodes)
        .where(
          and(
            eq(schema.graphNodes.type, "symbol"),
            sql`json_extract(${schema.graphNodes.metadata}, '$.filePath') = ${filePath}`,
          ),
        )
        .all();
      return rows.map(mapNodeRow);
    },

    updateSymbolNode(id: number, refId: string, metadata: string) {
      db.update(schema.graphNodes)
        .set({ refId, metadata, updatedAt: new Date().toISOString() })
        .where(eq(schema.graphNodes.id, id))
        .run();
    },

    deleteGraphNodesByIds(ids: number[]) {
      if (ids.length === 0) return;
      db.delete(schema.graphNodes).where(inArray(schema.graphNodes.id, ids)).run();
    },

    deleteChunkNodesByChunkIds(chunkIds: number[]) {
      if (chunkIds.length === 0) return;
      db.delete(schema.graphNodes)
        .where(
          and(
            eq(schema.graphNodes.type, "chunk"),
            inArray(schema.graphNodes.refId, chunkIds.map(String)),
          ),
        )
        .run();
    },

    async loadAllSymbolNodes(): Promise<Map<string, number>> {
      const rows = db
        .select({ label: schema.graphNodes.label, id: schema.graphNodes.id })
        .from(schema.graphNodes)
        .where(eq(schema.graphNodes.type, "symbol"))
        .all();
      const map = new Map<string, number>();
      for (const row of rows) {
        if (!map.has(row.label)) map.set(row.label, Number(row.id));
      }
      return map;
    },

    // ── Streaming inserts (graph nodes) ──

    streamGraphNode(input: {
      id: number;
      type: string;
      label: string;
      refId?: string | null;
      metadata?: string;
    }): void {
      const now = streamNow.value;
      db.insert(schema.graphNodes)
        .values({
          type: input.type,
          label: input.label,
          refId: input.refId ?? null,
          metadata: input.metadata ?? "{}",
          createdAt: now,
          updatedAt: now,
        })
        .run();
    },

    streamGraphNodesBatch(
      inputs: Array<{
        id: number;
        type: string;
        label: string;
        refId?: string | null;
        metadata?: string;
      }>,
    ): void {
      if (inputs.length === 0) return;
      const BATCH = 500;
      const now = streamNow.value;
      for (let i = 0; i < inputs.length; i += BATCH) {
        const batch = inputs.slice(i, i + BATCH);
        db.insert(schema.graphNodes)
          .values(
            batch.map((n) => ({
              type: n.type,
              label: n.label,
              refId: n.refId ?? null,
              metadata: n.metadata ?? "{}",
              createdAt: now,
              updatedAt: now,
            })),
          )
          .run();
      }
    },
  };
}
