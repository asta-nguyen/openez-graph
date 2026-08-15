/**
 * Shared types used across the SQLite repository modules.
 *
 * `repository.ts` is being progressively split into focused modules
 * (document-repository, graph-repository, …). These shared types avoid
 * circular imports between the split modules and the original file.
 */

/** SQLite scalar values that can be bound as statement parameters or returned from queries. */
export type DatabaseValue = string | number | bigint | boolean | null | Uint8Array;

/** A row returned by a SQLite query — column names mapped to their scalar values. */
export interface DatabaseRow {
  [key: string]: DatabaseValue;
}

/** Result of a `run()` call on a prepared statement. */
export interface RunResult {
  lastInsertRowid: number | bigint;
  changes: number;
}

/** A JSON-compatible value tree (used for parsed metadata columns). */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * A graph node row whose `metadata` has been parsed from a JSON string into
 * an object. Used by `graphNeighbors` where metadata is deserialized before
 * returning to the caller.
 */
export interface GraphNeighborNode {
  [key: string]: DatabaseValue | Record<string, JsonValue>;
}

export interface NativeDatabase {
  pragma(command: string): void;
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: DatabaseValue[]): DatabaseRow[];
    get(...params: DatabaseValue[]): DatabaseRow | undefined;
    run(...params: DatabaseValue[]): RunResult;
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
