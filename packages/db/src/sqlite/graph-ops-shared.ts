import type { NativeDatabase } from "./shared-types";

/**
 * Prepared statements used by the graph node/edge operations.
 *
 * These are prepared once in `createWorkspaceRepository()` (the facade in
 * `workspace-repository.ts`) and reused across thousands of calls. Only the
 * statements needed by this module are declared here; the remaining
 * statements are declared in the other split repository modules
 * (`document-repository.ts`, `fts-repository.ts`, `embedding-repository.ts`).
 */
export interface GraphStmts {
  nodeByTypeLabel: ReturnType<NativeDatabase["prepare"]>;
  nodeByTypeLabelRef: ReturnType<NativeDatabase["prepare"]>;
  insertNode: ReturnType<NativeDatabase["prepare"]>;
  insertNodeWithId?: ReturnType<NativeDatabase["prepare"]>;
  upsertNodeByTypeLabel: ReturnType<NativeDatabase["prepare"]>;
  updateNode: ReturnType<NativeDatabase["prepare"]>;
  deleteNodesByRefId: ReturnType<NativeDatabase["prepare"]>;
  insertEdge: ReturnType<NativeDatabase["prepare"]>;
  insertEdgeWithId?: ReturnType<NativeDatabase["prepare"]>;
}

export interface GraphNodeRawRow {
  id: number | string;
  type: string;
  label: string;
  ref_id?: number | string | null;
  metadata?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

/**
 * Maps a raw graph node row into the normalized shape returned by the
 * repository. Shared by node and traversal operations.
 */
export function mapNodeRow(row: GraphNodeRawRow) {
  const refIdRaw = row.ref_id;
  let refId: string | number | null = null;
  if (refIdRaw !== null && refIdRaw !== undefined) {
    const num = Number(refIdRaw);
    refId = Number.isNaN(num) ? String(refIdRaw) : num;
  }
  return {
    id: Number(row.id),
    type: String(row.type),
    label: String(row.label),
    refId,
    metadata: String(row.metadata ?? "{}"),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}
