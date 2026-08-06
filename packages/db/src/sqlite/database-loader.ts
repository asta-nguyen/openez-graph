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
  const { Database } = require("bun:sqlite");
  const db = new Database(dbPath, { create: true });
  // Add .pragma() shim — bun:sqlite doesn't have it natively
  (db as any).pragma = (cmd: string) => db.exec(`PRAGMA ${cmd}`);
  return db as unknown as NativeDatabase;
}
