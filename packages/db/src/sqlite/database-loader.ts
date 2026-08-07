import module from "node:module";

declare const __non_webpack_require__: typeof require | undefined;

function getRequireUrl(): string {
  try {
    if (typeof import.meta !== "undefined" && import.meta.url) {
      return import.meta.url;
    }
  } catch {
    // import.meta not available (CJS)
  }
  return `file://${__filename}`;
}

const _require: typeof require =
  typeof __non_webpack_require__ === "function"
    ? __non_webpack_require__
    : module.createRequire(getRequireUrl());

interface NativeStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
  values(...params: unknown[]): unknown[];
  bind(...params: unknown[]): NativeStatement;
}

interface NativeDatabase {
  pragma(command: string): unknown;
  exec(sql: string): unknown;
  prepare(sql: string): NativeStatement;
  transaction<T>(fn: () => T): () => T;
  close(): void;
}

type NativeDatabaseConstructor = new (
  filename: string,
  options?: { nativeBinding?: string },
) => NativeDatabase;

/**
 * Wrap a better-sqlite3 database to match the bun:sqlite API surface used by
 * drizzle-orm/bun-sqlite and the raw repository layer. The key difference is
 * that bun:sqlite prepared statements have a `.values()` method (returns rows
 * as arrays of raw values) which better-sqlite3 lacks natively.
 */
function adaptBetterSqlite3(db: any): NativeDatabase {
  const originalPrepare = db.prepare.bind(db);
  (db as any).prepare = (sql: string): NativeStatement => {
    const stmt = originalPrepare(sql);
    return {
      all: (...params: unknown[]) => stmt.all(...params),
      get: (...params: unknown[]) => stmt.get(...params),
      run: (...params: unknown[]) => stmt.run(...params),
      values: (...params: unknown[]) => stmt.raw().all(...params),
      bind: (...params: unknown[]) => {
        const bound = stmt.bind(...params);
        return {
          all: () => bound.all(),
          get: () => bound.get(),
          run: () => bound.run(),
          values: () => bound.raw().all(),
          bind: (...p: unknown[]) => bound.bind(...p),
        };
      },
    };
  };
  // Add .pragma() shim — bun:sqlite doesn't have it natively.
  // Under better-sqlite3, certain pragmas cause "database is locked" errors
  // in single-threaded test runs because they require exclusive locks or
  // WAL→MEMORY journal transitions that conflict with open connections.
  // Skip the ones that are pure performance optimizations for bulk indexing.
  (db as any).pragma = (cmd: string) => {
    if (/locking_mode\s*=\s*EXCLUSIVE/i.test(cmd)) return;
    if (/journal_mode\s*=\s*MEMORY/i.test(cmd)) return;
    if (/mmap_size/i.test(cmd)) return;
    try {
      db.exec(`PRAGMA ${cmd}`);
    } catch {
      // Ignore pragma errors under better-sqlite3 (e.g. wal_checkpoint
      // when there is no WAL file) — they are non-critical for tests.
    }
  };
  return db as unknown as NativeDatabase;
}

export function createNativeDatabase(dbPath: string): NativeDatabase {
  let Database: NativeDatabaseConstructor;
  let isBetterSqlite3 = false;
  try {
    Database = _require("bun:sqlite").Database;
  } catch {
    // Running under Node/vitest (not Bun) — fall back to better-sqlite3.
    Database = _require("better-sqlite3");
    isBetterSqlite3 = true;
  }
  const db = new Database(dbPath, { create: true });
  if (isBetterSqlite3) {
    return adaptBetterSqlite3(db);
  }
  // Add .pragma() shim — bun:sqlite doesn't have it natively
  (db as any).pragma = (cmd: string) => db.exec(`PRAGMA ${cmd}`);
  return db as unknown as NativeDatabase;
}
