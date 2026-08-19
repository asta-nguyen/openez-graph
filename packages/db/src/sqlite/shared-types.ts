/**
 * Shared types used across the SQLite repository modules.
 *
 * `repository.ts` is being progressively split into focused modules
 * (document-repository, graph-repository, …). These shared types avoid
 * circular imports between the split modules and the original file.
 */

export interface NativeDatabase {
  pragma(command: string): unknown;
  exec(sql: string): unknown;
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  };
}

/**
 * Mutable holder for the shared "stream now" timestamp.
 *
 * The streaming insert methods (`streamDocument`, `streamChunk`,
 * `streamGraphNode`, `streamEdge`, …) all read a single timestamp that is
 * refreshed once per batch via `refreshStreamTimestamp()`. Because the stream
 * methods now live across multiple modules, the timestamp is shared through
 * this holder so a refresh in one module is visible to all of them.
 */
export interface StreamTimestampHolder {
  value: string;
}
