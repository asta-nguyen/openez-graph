declare module "better-sqlite3" {
  interface DatabaseOptions {
    nativeBinding?: string;
  }

  interface Statement {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  }

  interface Database {
    pragma(command: string): unknown;
    exec(sql: string): this;
    prepare(sql: string): Statement;
    close(): void;
  }

  interface DatabaseConstructor {
    new (filename: string, options?: DatabaseOptions): Database;
  }

  const Database: DatabaseConstructor;
  namespace Database {
    export { type Database };
  }
  export = Database;
}
