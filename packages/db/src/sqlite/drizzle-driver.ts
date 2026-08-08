import type { NativeDatabase } from "./shared-types";

/**
 * Runtime-detected drizzle constructor. Under Bun, `drizzle-orm/bun-sqlite`
 * is used (Bun's native SQLite is faster and supports features like `.values()`).
 * Under Node, `drizzle-orm/better-sqlite3` is used because `bun:sqlite` is
 * not available.
 *
 * `better-sqlite3` crashes under Bun (NAPI ABI mismatch), and `bun:sqlite`
 * does not exist under Node — so the driver must be selected at runtime.
 */

// Bun detection: `typeof Bun !== "undefined"` works in Bun runtime.
// `process.versions.bun` is also set under Bun.
const isBun =
  typeof (globalThis as any).Bun !== "undefined" ||
  (typeof process !== "undefined" && typeof (process.versions as any)?.bun === "string");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DrizzleConstructor = (db: any, config: { schema: unknown }) => any;

let _drizzle: DrizzleConstructor | null = null;

/**
 * Get the drizzle constructor for the current runtime.
 * Cached after first call.
 */
export function getDrizzle(): DrizzleConstructor {
  if (_drizzle) return _drizzle;

  if (isBun) {
    // Under Bun, use drizzle-orm/bun-sqlite — it wraps bun:sqlite which
    // is Bun's native SQLite driver (faster, no native addon needed).
    _drizzle = require("drizzle-orm/bun-sqlite").drizzle as DrizzleConstructor;
  } else {
    // Under Node, use drizzle-orm/better-sqlite3 — bun:sqlite is not
    // available, and better-sqlite3 is a native Node addon.
    _drizzle = require("drizzle-orm/better-sqlite3").drizzle as DrizzleConstructor;
  }
  return _drizzle;
}

/**
 * Create a drizzle instance wrapping a native database handle.
 * Uses the runtime-appropriate drizzle driver.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createDrizzleInstance(sqlite: NativeDatabase, schema: unknown): any {
  return getDrizzle()(sqlite, { schema });
}
