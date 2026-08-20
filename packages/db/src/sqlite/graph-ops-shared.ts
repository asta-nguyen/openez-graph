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

/**
 * Maps a raw graph node row into the normalized shape returned by the
 * repository. Shared by node and traversal operations.
 */
export function mapNodeRow(row: Record<string, unknown>) {
  return {
    id: Number(row.id),
    type: String(row.type),
    label: String(row.label),
    refId:
      row.ref_id !== null && row.ref_id !== undefined
        ? typeof row.ref_id === "number"
          ? row.ref_id
          : String(row.ref_id)
        : null,
    metadata: String(row.metadata ?? "{}"),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
