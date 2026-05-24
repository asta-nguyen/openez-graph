import path from "node:path";
import fs from "node:fs";
import module from "node:module";

declare const __non_webpack_require__: typeof require | undefined;

const _require: typeof require = typeof __non_webpack_require__ === "function"
  ? __non_webpack_require__
  : module.createRequire(new URL("file:" + path.resolve(process.cwd(), "packages/db/package.json")));

let resolvedAddon: string | null | undefined;

interface NativeDatabase {
  pragma(command: string): unknown;
  exec(sql: string): unknown;
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  };
}

type NativeDatabaseConstructor = new (
  filename: string,
  options?: { nativeBinding?: string }
) => NativeDatabase;

function tryResolveAddon(): string | null {
  if (resolvedAddon !== undefined) return resolvedAddon;

  try {
    const betterSqlite3Main = _require.resolve("better-sqlite3");
    const addonPath = path.resolve(
      path.dirname(betterSqlite3Main),
      "..",
      "build",
      "Release",
      "better_sqlite3.node"
    );
    if (fs.existsSync(addonPath)) {
      resolvedAddon = addonPath;
      return addonPath;
    }
  } catch {
    // fall through
  }

  resolvedAddon = null;
  return null;
}

export function createNativeDatabase(dbPath: string): NativeDatabase {
  const DatabaseConstructor = _require("better-sqlite3") as NativeDatabaseConstructor;
  const nativeBinding = tryResolveAddon();
  return new DatabaseConstructor(
    dbPath,
    nativeBinding ? { nativeBinding } : {}
  );
}
