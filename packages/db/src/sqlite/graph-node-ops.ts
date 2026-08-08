import crypto from "node:crypto";

import type { NativeDatabase, StreamTimestampHolder } from "./shared-types";
import { mapNodeRow, type GraphStmts } from "./graph-ops-shared";

/**
 * Factory for graph node operations extracted from `createGraphOps()`.
 *
 * Behavior is identical to the original inline implementations — this is a
 * pure code-move. `streamNow` is shared via a mutable holder so that
 * `refreshStreamTimestamp()` (defined in `document-repository.ts`) stays
 * visible to the node stream methods here.
 */
export function createGraphNodeOps(
  native: NativeDatabase,
  stmts: GraphStmts,
  streamNow: StreamTimestampHolder,
) {
  return {
    async getNodeCount(): Promise<number> {
      const row = native.prepare("SELECT count(*) AS count FROM graph_nodes").get() as {
        count: number;
      };
      return row?.count ?? 0;
    },

    // ── Graph Node Operations ──

    async upsertGraphNode(input: {
      type: string;
      label: string;
      refId?: string;
      metadata?: string;
    }): Promise<string> {
      if (input.type === "symbol") {
        if (input.refId) {
          const existing = stmts.nodeByTypeLabelRef.get(input.type, input.label, input.refId) as
            | Record<string, unknown>
            | undefined;
          if (existing) {
            const nextMetadata = input.metadata ?? String(existing.metadata ?? "{}");
            if (nextMetadata !== existing.metadata) {
              stmts.updateNode.run(
                input.refId,
                nextMetadata,
                new Date().toISOString(),
                existing.id,
              );
            }
            return String(existing.id);
          }
        }
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        stmts.insertNode.run(
          id,
          input.type,
          input.label,
          input.refId ?? null,
          input.metadata ?? "{}",
          now,
          now,
        );
        return id;
      }

      // Non-symbol nodes: (type, label) is unique — use ON CONFLICT ... RETURNING (one query)
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const row = stmts.upsertNodeByTypeLabel.get(
        id,
        input.type,
        input.label,
        input.refId ?? null,
        input.metadata ?? "{}",
        now,
        now,
      ) as { id: string };
      return String(row.id);
    },

    async insertGraphNodesBatch(
      inputs: Array<{ type: string; label: string; refId?: string; metadata?: string }>,
    ): Promise<string[]> {
      if (inputs.length === 0) return [];
      const now = new Date().toISOString();
      const ids: string[] = inputs.map(() => crypto.randomUUID());
      const BATCH = 2000;
      for (let i = 0; i < inputs.length; i += BATCH) {
        const batch = inputs.slice(i, i + BATCH);
        const placeholders = batch.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(",");
        const params: unknown[] = [];
        for (let j = 0; j < batch.length; j++) {
          const item = batch[j];
          params.push(
            ids[i + j],
            item.type,
            item.label,
            item.refId ?? null,
            item.metadata ?? "{}",
            now,
            now,
          );
        }
        native
          .prepare(
            `INSERT INTO graph_nodes (id, type, label, ref_id, metadata, created_at, updated_at) VALUES ${placeholders} ON CONFLICT(type, label) WHERE type != 'symbol' DO UPDATE SET metadata = excluded.metadata, updated_at = excluded.updated_at`,
          )
          .run(...params);
      }
      return ids;
    },

    async upsertGraphNodesBatch(
      inputs: Array<{ type: string; label: string; refId?: string; metadata?: string }>,
    ): Promise<Array<{ label: string; id: string }>> {
      if (inputs.length === 0) return [];
      const now = new Date().toISOString();
      const BATCH = 500;
      const results: Array<{ label: string; id: string }> = [];

      for (let i = 0; i < inputs.length; i += BATCH) {
        const batch = inputs.slice(i, i + BATCH);
        const placeholders = batch.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(",");
        const params: unknown[] = [];
        for (const item of batch) {
          const id = crypto.randomUUID();
          params.push(
            id,
            item.type,
            item.label,
            item.refId ?? null,
            item.metadata ?? "{}",
            now,
            now,
          );
        }
        const rows = native
          .prepare(
            `INSERT INTO graph_nodes (id, type, label, ref_id, metadata, created_at, updated_at) VALUES ${placeholders}
             ON CONFLICT(type, label) WHERE type != 'symbol' DO UPDATE SET ref_id = COALESCE(excluded.ref_id, graph_nodes.ref_id), metadata = excluded.metadata, updated_at = excluded.updated_at
             RETURNING id, label`,
          )
          .all(...params) as Array<{ id: string; label: string }>;
        results.push(...rows.map((r) => ({ label: r.label, id: String(r.id) })));
      }
      return results;
    },

    async getGraphNode(id: string) {
      const row = native.prepare("SELECT * FROM graph_nodes WHERE id = ?").get(id) as
        | Record<string, unknown>
        | undefined;
      return row ? mapNodeRow(row) : null;
    },

    async findGraphNode(type: string, label: string) {
      const row = stmts.nodeByTypeLabel.get(type, label) as Record<string, unknown> | undefined;
      return row ? mapNodeRow(row) : null;
    },

    async deleteGraphNodesByRefId(refId: string) {
      stmts.deleteNodesByRefId.run(refId, refId);
    },

    async findFileNode(relativePath: string) {
      const row = stmts.nodeByTypeLabel.get("file", relativePath) as
        | Record<string, unknown>
        | undefined;
      return row ? mapNodeRow(row) : null;
    },

    async getSymbolNodesByFilePath(filePath: string) {
      const rows = native
        .prepare(
          "SELECT * FROM graph_nodes WHERE type = 'symbol' AND json_extract(metadata, '$.filePath') = ?",
        )
        .all(filePath) as Array<Record<string, unknown>>;
      return rows.map(mapNodeRow);
    },

    updateSymbolNode(id: string, refId: string, metadata: string) {
      stmts.updateNode.run(refId, metadata, new Date().toISOString(), id);
    },

    deleteGraphNodesByIds(ids: string[]) {
      if (ids.length === 0) return;
      const placeholders = ids.map(() => "?").join(",");
      native.prepare(`DELETE FROM graph_nodes WHERE id IN (${placeholders})`).run(...ids);
    },

    deleteChunkNodesByChunkIds(chunkIds: string[]) {
      if (chunkIds.length === 0) return;
      const placeholders = chunkIds.map(() => "?").join(",");
      native
        .prepare(`DELETE FROM graph_nodes WHERE type = 'chunk' AND ref_id IN (${placeholders})`)
        .run(...chunkIds);
    },

    async loadAllSymbolNodes(): Promise<Map<string, string>> {
      const rows = native
        .prepare("SELECT label, id FROM graph_nodes WHERE type = 'symbol'")
        .all() as Array<{ label: string; id: string }>;
      const map = new Map<string, string>();
      for (const row of rows) {
        if (!map.has(row.label)) map.set(row.label, String(row.id));
      }
      return map;
    },

    // ── Streaming inserts (graph nodes) ──

    streamGraphNode(input: {
      id: string;
      type: string;
      label: string;
      refId?: string | null;
      metadata?: string;
    }): void {
      const now = streamNow.value;
      stmts.insertNode.run(
        input.id,
        input.type,
        input.label,
        input.refId ?? null,
        input.metadata ?? "{}",
        now,
        now,
      );
    },

    streamGraphNodesBatch(
      inputs: Array<{
        id: string;
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
        const placeholders = batch.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(",");
        const params: unknown[] = [];
        for (const n of batch) {
          params.push(n.id, n.type, n.label, n.refId ?? null, n.metadata ?? "{}", now, now);
        }
        native
          .prepare(
            `INSERT INTO graph_nodes (id, type, label, ref_id, metadata, created_at, updated_at) VALUES ${placeholders}`,
          )
          .run(...params);
      }
    },
  };
}
