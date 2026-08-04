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

const _require: typeof require = typeof __non_webpack_require__ === "function"
  ? __non_webpack_require__
  : module.createRequire(getRequireUrl());

interface NativeDatabase {
  pragma(command: string): unknown;
  exec(sql: string): unknown;
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  };
  transaction<T>(fn: () => T): () => T;
  close(): void;
}

export function createNativeDatabase(dbPath: string): NativeDatabase {
  const { Database } = _require("bun:sqlite");
  const db = new Database(dbPath, { create: true });
  // Add .pragma() shim — bun:sqlite doesn't have it natively
  (db as any).pragma = (cmd: string) => db.exec(`PRAGMA ${cmd}`);
  return db as unknown as NativeDatabase;
}
