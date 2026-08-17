import type { NativeDatabase, StreamTimestampHolder } from "./shared-types";
import { mapNodeRow, type GraphNodeRawRow, type GraphStmts } from "./graph-ops-shared";

interface UpsertNodeResult {
  id: number;
  label?: string;
}

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
      // SAFETY: Query selects count(*) from graph_nodes table.
      const row = native.prepare("SELECT count(*) AS count FROM graph_nodes").get() as {
        count: number;
      };
      return row?.count ?? 0;
    },

    // ── Graph Node Operations ──

    async upsertGraphNode(input: {
      type: string;
      label: string;
      refId?: number | string | null;
      metadata?: string;
    }): Promise<number> {
      if (input.type === "symbol") {
        if (input.refId !== undefined && input.refId !== null) {
          // SAFETY: Prepared statement queries graph_nodes matching GraphNodeRawRow.
          const existing = stmts.nodeByTypeLabelRef.get(input.type, input.label, input.refId) as
            | GraphNodeRawRow
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
            return Number(existing.id);
          }
        }
        const now = new Date().toISOString();
        const res = stmts.insertNode.run(
          input.type,
          input.label,
          input.refId ?? null,
          input.metadata ?? "{}",
          now,
          now,
        );
        return Number(res.lastInsertRowid);
      }

      // Non-symbol nodes: (type, label) is unique — use ON CONFLICT ... RETURNING (one query)
      const now = new Date().toISOString();
      // SAFETY: RETURNING clause returns id matching UpsertNodeResult.
      const row = stmts.upsertNodeByTypeLabel.get(
        input.type,
        input.label,
        input.refId ?? null,
        input.metadata ?? "{}",
        now,
        now,
      ) as UpsertNodeResult;
      return Number(row.id);
    },

    async insertGraphNodesBatch(
      inputs: Array<{
        type: string;
        label: string;
        refId?: number | string | null;
        metadata?: string;
      }>,
    ): Promise<number[]> {
      if (inputs.length === 0) return [];
      const now = new Date().toISOString();
      const ids: number[] = [];
      const BATCH = 500;
      for (let i = 0; i < inputs.length; i += BATCH) {
        const batch = inputs.slice(i, i + BATCH);
        for (const item of batch) {
          const res = stmts.insertNode.run(
            item.type,
            item.label,
            item.refId ?? null,
            item.metadata ?? "{}",
            now,
            now,
          );
          ids.push(Number(res.lastInsertRowid));
        }
      }
      return ids;
    },

    async upsertGraphNodesBatch(
      inputs: Array<{
        type: string;
        label: string;
        refId?: number | string | null;
        metadata?: string;
      }>,
    ): Promise<Array<{ label: string; id: number }>> {
      if (inputs.length === 0) return [];
      const now = new Date().toISOString();
      const results: Array<{ label: string; id: number }> = [];

      for (const item of inputs) {
        // SAFETY: RETURNING clause returns id and label matching UpsertNodeResult.
        const row = stmts.upsertNodeByTypeLabel.get(
          item.type,
          item.label,
          item.refId ?? null,
          item.metadata ?? "{}",
          now,
          now,
        ) as UpsertNodeResult;
        results.push({ label: row.label ?? item.label, id: Number(row.id) });
      }
      return results;
    },

    async getGraphNode(id: number) {
      // SAFETY: Query selects from graph_nodes table matching GraphNodeRawRow.
      const row = native.prepare("SELECT * FROM graph_nodes WHERE id = ?").get(id) as
        | GraphNodeRawRow
        | undefined;
      return row ? mapNodeRow(row) : null;
    },

    async findGraphNode(type: string, label: string) {
      // SAFETY: Prepared statement queries graph_nodes matching GraphNodeRawRow.
      const row = stmts.nodeByTypeLabel.get(type, label) as GraphNodeRawRow | undefined;
      return row ? mapNodeRow(row) : null;
    },

    async deleteGraphNodesByRefId(refId: number | string) {
      stmts.deleteNodesByRefId.run(refId, refId);
    },

    async findFileNode(relativePath: string) {
      // SAFETY: Prepared statement queries graph_nodes matching GraphNodeRawRow.
      const row = stmts.nodeByTypeLabel.get("file", relativePath) as GraphNodeRawRow | undefined;
      return row ? mapNodeRow(row) : null;
    },

    async getSymbolNodesByFilePath(filePath: string) {
      // SAFETY: Query selects from graph_nodes table matching GraphNodeRawRow.
      const rows = native
        .prepare(
          "SELECT * FROM graph_nodes WHERE type = 'symbol' AND json_extract(metadata, '$.filePath') = ?",
        )
        .all(filePath) as Array<GraphNodeRawRow>;
      return rows.map(mapNodeRow);
    },

    updateSymbolNode(id: number, refId: number | string, metadata: string) {
      stmts.updateNode.run(refId, metadata, new Date().toISOString(), id);
    },

    deleteGraphNodesByIds(ids: number[]) {
      if (ids.length === 0) return;
      const placeholders = ids.map(() => "?").join(",");
      native.prepare(`DELETE FROM graph_nodes WHERE id IN (${placeholders})`).run(...ids);
    },

    deleteChunkNodesByChunkIds(chunkIds: number[]) {
      if (chunkIds.length === 0) return;
      const placeholders = chunkIds.map(() => "?").join(",");
      native
        .prepare(`DELETE FROM graph_nodes WHERE type = 'chunk' AND ref_id IN (${placeholders})`)
        .run(...chunkIds);
    },

    async loadAllSymbolNodes(): Promise<Map<string, number>> {
      // SAFETY: Query selects label and id from graph_nodes table.
      const rows = native
        .prepare("SELECT label, id FROM graph_nodes WHERE type = 'symbol'")
        .all() as Array<{ label: string; id: number }>;
      const map = new Map<string, number>();
      for (const row of rows) {
        if (!map.has(row.label)) map.set(row.label, Number(row.id));
      }
      return map;
    },

    // ── Streaming inserts (graph nodes) ──

    streamGraphNode(input: {
      id?: number;
      type: string;
      label: string;
      refId?: number | string | null;
      metadata?: string;
    }): number {
      const now = streamNow.value;
      if (input.id !== undefined && stmts.insertNodeWithId) {
        stmts.insertNodeWithId.run(
          input.id,
          input.type,
          input.label,
          input.refId ?? null,
          input.metadata ?? "{}",
          now,
          now,
        );
        return input.id;
      }
      const res = stmts.insertNode.run(
        input.type,
        input.label,
        input.refId ?? null,
        input.metadata ?? "{}",
        now,
        now,
      );
      return Number(res.lastInsertRowid);
    },

    streamGraphNodesBatch(
      inputs: Array<{
        id?: number;
        type: string;
        label: string;
        refId?: number | string | null;
        metadata?: string;
      }>,
    ): number[] {
      if (inputs.length === 0) return [];
      const now = streamNow.value;
      const ids: number[] = [];
      for (const n of inputs) {
        if (n.id !== undefined && stmts.insertNodeWithId) {
          stmts.insertNodeWithId.run(
            n.id,
            n.type,
            n.label,
            n.refId ?? null,
            n.metadata ?? "{}",
            now,
            now,
          );
          ids.push(n.id);
        } else {
          const res = stmts.insertNode.run(
            n.type,
            n.label,
            n.refId ?? null,
            n.metadata ?? "{}",
            now,
            now,
          );
          ids.push(Number(res.lastInsertRowid));
        }
      }
      return ids;
    },
  };
}
