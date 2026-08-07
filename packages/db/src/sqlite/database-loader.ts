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

let _vecExtensionLoaded = false;

/**
 * Whether the sqlite-vec extension was successfully loaded on the most
 * recently opened database. When false, callers must fall back to a
 * linear scan over the embeddings table.
 */
export function hasVecExtension(): boolean {
  return _vecExtensionLoaded;
}

/**
 * Attempt to load the sqlite-vec native extension onto a database handle.
 *
 * Bun's bundled SQLite is currently compiled without dynamic extension
 * loading support, so under `bun:sqlite` this will always fail and
 * `hasVecExtension()` will remain false. The try/catch keeps that failure
 * silent so retrieval degrades gracefully to a linear scan.
 *
 * When running under a SQLite build that supports extensions (e.g.
 * better-sqlite3, or a future Bun build with extension loading enabled),
 * the sqlite-vec `vec0` module is loaded and `hasVecExtension()` returns
 * true.
 */
function tryLoadVecExtension(db: NativeDatabase): void {
  _vecExtensionLoaded = false;
  try {
    // The sqlite-vec package exposes a `load(db)` helper that resolves the
    // platform-specific native extension and calls `db.loadExtension(path)`.
    const sqliteVec = _require("sqlite-vec") as {
      load: (db: unknown) => void;
      getLoadablePath: () => string;
    };
    try {
      sqliteVec.load(db);
      _vecExtensionLoaded = true;
      return;
    } catch {
      // fall through to SQL-based loading attempt
    }

    // Fallback: some SQLite builds expose load_extension() as a SQL function
    // even when the JS binding doesn't expose loadExtension().
    const extPath = sqliteVec.getLoadablePath();
    db.exec(`SELECT load_extension('${extPath.replace(/'/g, "''")}')`);
    _vecExtensionLoaded = true;
  } catch {
    // Extension loading unavailable (e.g. bun:sqlite) — linear scan fallback.
    _vecExtensionLoaded = false;
  }
}

export function createNativeDatabase(dbPath: string): NativeDatabase {
  const Database = _require("bun:sqlite").Database as NativeDatabaseConstructor;
  const db = new Database(dbPath, { create: true } as { nativeBinding?: string });
  // Add .pragma() shim — bun:sqlite doesn't have it natively
  (db as any).pragma = (cmd: string) => db.exec(`PRAGMA ${cmd}`);

  // Try loading sqlite-vec for vector ANN search. Falls back silently to
  // linear scan when the extension cannot be loaded (e.g. under bun:sqlite).
  tryLoadVecExtension(db as unknown as NativeDatabase);

  return db as unknown as NativeDatabase;
}
