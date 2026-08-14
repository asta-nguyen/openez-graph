import module from "node:module";

import type { DatabaseRow, DatabaseValue, RunResult } from "./shared-types";

declare const __non_webpack_require__: typeof require | undefined;

function getRequireUrl(): string {
  try {
    if (import.meta.url) {
      return import.meta.url;
    }
  } catch {
    // import.meta not available (CJS)
  }
  return `file://${__filename}`;
}

let _require: typeof require;
try {
  const r = __non_webpack_require__;
  _require = r !== undefined ? r : module.createRequire(getRequireUrl());
} catch {
  _require = module.createRequire(getRequireUrl());
}

interface NativeStatement {
  all(...params: DatabaseValue[]): DatabaseRow[];
  get(...params: DatabaseValue[]): DatabaseRow | undefined;
  run(...params: DatabaseValue[]): RunResult;
  values(...params: DatabaseValue[]): DatabaseValue[];
  bind(...params: DatabaseValue[]): NativeStatement;
}

interface NativeDatabase {
  pragma(command: string): void;
  exec(sql: string): void;
  prepare(sql: string): NativeStatement;
  transaction<T>(fn: () => T): () => T;
  close(): void;
}

type NativeDatabaseConstructor = new (
  filename: string,
  options?: { create?: boolean; nativeBinding?: string },
) => NativeDatabase;

export function createNativeDatabase(dbPath: string): NativeDatabase {
  // SAFETY: _require("bun:sqlite").Database is the bun:sqlite Database
  // constructor; the cast aligns its dynamic import with the
  // NativeDatabaseConstructor structural interface used by the repository layer.
  const Database = _require("bun:sqlite").Database as NativeDatabaseConstructor;
  const db = new Database(dbPath, { create: true });
  // Add .pragma() shim — bun:sqlite doesn't have it natively
  db.pragma = (cmd: string) => db.exec(`PRAGMA ${cmd}`);

  return db;
}
