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
  upsertNodeByTypeLabel: ReturnType<NativeDatabase["prepare"]>;
  updateNode: ReturnType<NativeDatabase["prepare"]>;
  deleteNodesByRefId: ReturnType<NativeDatabase["prepare"]>;
  insertEdge: ReturnType<NativeDatabase["prepare"]>;
}

/**
 * Shape of a graph node row as returned by Drizzle's query builder
 * (camelCase column keys, matching `schema.graphNodes.$inferSelect`).
 */
export interface GraphNodeRow {
  id: number;
  type: string;
  label: string;
  refId: string | null;
  metadata: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Maps a Drizzle graph node row into the normalized shape returned by the
 * repository. Shared by node and traversal operations.
 */
export function mapNodeRow(row: GraphNodeRow) {
  return {
    id: Number(row.id),
    type: String(row.type),
    label: String(row.label),
    refId: row.refId ? String(row.refId) : null,
    metadata: String(row.metadata ?? "{}"),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}
