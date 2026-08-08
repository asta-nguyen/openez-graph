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

/**
 * Wrap a better-sqlite3 database to match the bun:sqlite API surface used by
 * the raw repository layer. The key difference is that bun:sqlite prepared
 * statements have a `.values()` method (returns rows as arrays of raw values)
 * which better-sqlite3 lacks natively.
 *
 * The wrapper also proxies unknown methods (like `.raw()`) to the underlying
 * better-sqlite3 statement so drizzle-orm/better-sqlite3 works transparently.
 */
function adaptBetterSqlite3(db: any): NativeDatabase {
  const originalPrepare = db.prepare.bind(db);
  (db as any).prepare = (sql: string): NativeStatement => {
    const stmt = originalPrepare(sql);
    // Wrap the statement to add .values() while preserving all native
    // better-sqlite3 methods (e.g. .raw() used by drizzle-orm).
    // Bind methods to the original statement to avoid "Illegal invocation"
    // errors caused by Proxy losing the `this` context.
    const wrapped: any = new Proxy(stmt, {
      get(target, prop, receiver) {
        if (prop === "values") {
          // bun:sqlite .values() returns rows as arrays — use .raw().all()
          return (...params: unknown[]) => target.raw().all(...params);
        }
        if (prop === "bind") {
          // bun:sqlite .bind() returns a bound statement — wrap it too
          return (...params: unknown[]) => {
            const bound = target.bind(...params);
            return new Proxy(bound, {
              get(bTarget: any, bProp: string) {
                if (bProp === "values") return () => bTarget.raw().all();
                if (bProp === "all") return bTarget.all.bind(bTarget);
                if (bProp === "get") return bTarget.get.bind(bTarget);
                if (bProp === "run") return bTarget.run.bind(bTarget);
                if (bProp === "bind") return (...p: unknown[]) => bTarget.bind(...p);
                if (bProp === "raw") return bTarget.raw.bind(bTarget);
                const val = bTarget[bProp];
                return typeof val === "function" ? val.bind(bTarget) : val;
              },
            });
          };
        }
        const val = Reflect.get(target, prop, receiver);
        // Bind native methods to the original statement to preserve `this`
        if (typeof val === "function") return val.bind(target);
        return val;
      },
    });
    return wrapped;
  };
  // Add .pragma() shim — bun:sqlite doesn't have it natively.
  // Under better-sqlite3, certain pragmas cause "database is locked" errors
  // in single-threaded test runs because they require exclusive locks that
  // conflict with open connections. Skip the ones that are pure performance
  // optimizations for bulk indexing. journal_mode=WAL must NOT be skipped —
  // it is required for crash-recoverable indexing.
  (db as any).pragma = (cmd: string) => {
    if (/locking_mode\s*=\s*EXCLUSIVE/i.test(cmd)) return;
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
    Database = _require("bun:sqlite").Database as NativeDatabaseConstructor;
  } catch {
    // Running under Node (not Bun) — fall back to better-sqlite3.
    // The npm-published CLI targets Node >=20, so this path is used by
    // all npm-installed CLI users. Under Bun, bun:sqlite is used instead.
    Database = _require("better-sqlite3") as unknown as NativeDatabaseConstructor;
    isBetterSqlite3 = true;
  }
  const db = new Database(dbPath, { create: true } as { nativeBinding?: string });
  if (isBetterSqlite3) {
    return adaptBetterSqlite3(db);
  }
  // Add .pragma() shim — bun:sqlite doesn't have it natively
  (db as any).pragma = (cmd: string) => db.exec(`PRAGMA ${cmd}`);

  // Try loading sqlite-vec for vector ANN search. Falls back silently to
  // linear scan when the extension cannot be loaded (e.g. under bun:sqlite).
  tryLoadVecExtension(db as unknown as NativeDatabase);

  return db as unknown as NativeDatabase;
}
