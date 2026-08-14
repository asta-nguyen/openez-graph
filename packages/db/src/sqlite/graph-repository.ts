import type { NativeDatabase, StreamTimestampHolder } from "./shared-types";
import { createGraphEdgeOps } from "./graph-edge-ops";
import { createGraphNodeOps } from "./graph-node-ops";
import { createGraphTraversalOps } from "./graph-traversal-ops";

export type { GraphStmts } from "./graph-ops-shared";
export { createGraphEdgeOps } from "./graph-edge-ops";
export { createGraphNodeOps } from "./graph-node-ops";
export { createGraphTraversalOps } from "./graph-traversal-ops";

/**
 * Factory for graph node/edge/traversal operations extracted from
 * `createWorkspaceRepository()`.
 *
 * This facade composes the three sub-module factories (`createGraphNodeOps`,
 * `createGraphEdgeOps`, `createGraphTraversalOps`) so callers can keep using
 * the original `createGraphOps` entry point. Behavior is identical to the
 * original inline implementation — this is a pure code-move.
 *
 * `streamNow` is shared via a mutable holder so that
 * `refreshStreamTimestamp()` (defined in `document-repository.ts`) stays
 * visible to the graph/edge stream methods in the sub-modules.
 *
 */
export function createGraphOps(native: NativeDatabase, streamNow: StreamTimestampHolder) {
  const nodeOps = createGraphNodeOps(native, streamNow);
  const edgeOps = createGraphEdgeOps(native, streamNow);
  const traversalOps = createGraphTraversalOps(native);
  return { ...nodeOps, ...edgeOps, ...traversalOps };
}
