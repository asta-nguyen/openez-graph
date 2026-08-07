// Test stub for `bun:sqlite`.
//
// The codebase imports `bun:sqlite` at module load time (via
// `@openez-graph/db` -> `drizzle-orm/bun-sqlite`). Under vitest's default
// node ESM loader the `bun:` scheme is unsupported, which breaks test
// collection for every test that transitively imports the indexer package.
// This stub lets modules load; it is only instantiated by tests that actually
// open a database, which the parser tests never do.

export class Database {
  constructor(_filename?: string | unknown, _options?: unknown) {}
  exec(_sql: string): this {
    return this;
  }
  prepare(_sql: string): {
    all(..._params: unknown[]): unknown[];
    get(..._params: unknown[]): unknown;
    run(..._params: unknown[]): unknown;
  } {
    return {
      all: () => [],
      get: () => null,
      run: () => ({ changes: 0, lastInsertRowid: 0 }),
    };
  }
  close(): void {}
}

export default { Database };
