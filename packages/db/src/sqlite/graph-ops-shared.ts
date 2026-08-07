import type { NativeDatabase } from "./shared-types";

/**
 * Prepared statements used by the graph node/edge operations.
 *
 * These are prepared once in `createWorkspaceRepository()` and reused across
 * thousands of calls. Only the statements needed by this module are declared
 * here; the remaining statements stay in `repository.ts` and will be split out
 * by later tasks.
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
 * Dependencies that `ensureGraphBuilt` needs from the parent repository.
 *
 * `ensureGraphBuilt` reads/writes the `index_meta` table via `getMeta`/`setMeta`
 * (which still live in `repository.ts`). Passing them in keeps the graph module
 * decoupled from the meta/lifecycle operations that will be extracted later.
 */
export interface GraphOpsDeps {
  getMeta: (key: string) => string | null;
  setMeta: (key: string, value: string) => void;
}

/**
 * Maps a raw graph node row into the normalized shape returned by the
 * repository. Shared by node and traversal operations.
 */
export function mapNodeRow(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    type: String(row.type),
    label: String(row.label),
    refId: row.ref_id ? String(row.ref_id) : null,
    metadata: String(row.metadata ?? "{}"),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
