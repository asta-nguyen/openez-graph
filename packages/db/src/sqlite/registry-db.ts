import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "./schema";
import { createNativeDatabase } from "./database-loader";
import type { DatabaseRow, DatabaseValue, RunResult } from "./shared-types";
import { resolveBundledFile } from "./workspace-db";

let registryDb: ReturnType<typeof getRegistryDbRaw> | null = null;

/**
 * Minimal SQLite interface accepted by shared migration helpers. Both the
 * native bun:sqlite Database and the web server's SqliteDb wrapper satisfy
 * this interface, allowing the db package to own all schema migration logic.
 */
export interface SqliteLike {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: DatabaseValue[]): DatabaseRow[];
    get(...params: DatabaseValue[]): DatabaseRow | undefined;
    run(...params: DatabaseValue[]): RunResult;
  };
}

/**
 * Shared registry schema migration: adds missing columns, creates the
 * registry_meta table, and runs the one-shot graph invalidation backfill.
 * Callers should run `getRegistryDdl()` first to create the base tables.
 */
export function migrateRegistrySchema(sqlite: SqliteLike): void {
  const getColumns = () =>
    new Set(
      // SAFETY: PRAGMA table_info returns rows with a `name` column (TEXT);
      // the cast narrows DatabaseRow to the specific column shape we read.
      (sqlite.prepare("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );

  const addColumnIfMissing = (name: string, definition: string) => {
    if (getColumns().has(name)) return;
    try {
      sqlite.exec(`ALTER TABLE workspaces ADD COLUMN ${definition}`);
    } catch (err) {
      if (!getColumns().has(name)) throw err;
    }
  };

  addColumnIfMissing("pinned_at", "pinned_at TEXT");
  addColumnIfMissing("pin_order", "pin_order INTEGER");
  addColumnIfMissing("index_build_owner", "index_build_owner TEXT");
  addColumnIfMissing("index_lease_expires_at", "index_lease_expires_at TEXT");
  addColumnIfMissing("index_generation", "index_generation INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing("graph_generation", "graph_generation INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing("graph_build_owner", "graph_build_owner TEXT");
  addColumnIfMissing("graph_build_epoch", "graph_build_epoch INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing("graph_lease_expires_at", "graph_lease_expires_at TEXT");

  // Backfill pin_order for pre-existing pinned workspaces that lack it.
  // SAFETY: SELECT id FROM workspaces returns rows with a TEXT `id` column;
  // the cast narrows DatabaseRow to the specific shape we iterate.
  const unbackfilled = sqlite
    .prepare(
      "SELECT id FROM workspaces WHERE pinned_at IS NOT NULL AND pin_order IS NULL ORDER BY pinned_at DESC",
    )
    .all() as Array<{ id: string }>;
  if (unbackfilled.length > 0) {
    // SAFETY: SELECT MAX(pin_order) returns a single row with an INTEGER
    // max_order column (or NULL when no rows match); the cast narrows
    // DatabaseRow | undefined to the specific shape we read.
    const maxRow = sqlite
      .prepare("SELECT MAX(pin_order) AS max_order FROM workspaces WHERE pin_order IS NOT NULL")
      .get() as { max_order: number | null } | undefined;
    let next = (maxRow?.max_order ?? 0) + 1;
    const stmt = sqlite.prepare("UPDATE workspaces SET pin_order = ? WHERE id = ?");
    for (const row of unbackfilled) {
      stmt.run(next, row.id);
      next += 1;
    }
  }

  // One-shot graph invalidation for workspaces that existed before generation
  // tracking. Uses a migration version marker in a settings-like table so the
  // backfill only runs once, not on every registry open.
  sqlite.exec(`CREATE TABLE IF NOT EXISTS registry_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);
  const getMeta = (key: string): string | null => {
    // SAFETY: SELECT value FROM registry_meta returns a single row with a
    // TEXT `value` column (or undefined when the key is absent); the cast
    // narrows DatabaseRow | undefined to the specific shape we read.
    const row = sqlite.prepare("SELECT value FROM registry_meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  };
  const setMeta = (key: string, value: string) => {
    sqlite
      .prepare("INSERT OR REPLACE INTO registry_meta (key, value) VALUES (?, ?)")
      .run(key, value);
  };

  const GRAPH_INVALIDATION_MARKER = "graph_invalidation_v1";
  if (getColumns().has("graph_generation")) {
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      if (getMeta(GRAPH_INVALIDATION_MARKER) === null) {
        sqlite
          .prepare(
            "UPDATE workspaces SET graph_generation = -1 WHERE graph_status = 'completed' AND graph_generation = 0 AND index_generation = 0",
          )
          .run();
        setMeta(GRAPH_INVALIDATION_MARKER, "done");
      }
      sqlite.exec("COMMIT");
    } catch (error) {
      try {
        sqlite.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }
}

export function getRegistryDdl(): string {
  return `
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      root_path TEXT NOT NULL UNIQUE,
      include_globs TEXT NOT NULL DEFAULT '',
      exclude_globs TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      indexing_status TEXT NOT NULL DEFAULT 'pending',
      index_build_owner TEXT,
      index_lease_expires_at TEXT,
      graph_status TEXT NOT NULL DEFAULT 'pending',
      index_generation INTEGER NOT NULL DEFAULT 0,
      graph_generation INTEGER NOT NULL DEFAULT 0,
      graph_build_owner TEXT,
      graph_build_epoch INTEGER NOT NULL DEFAULT 0,
      graph_lease_expires_at TEXT,
      last_indexed_at TEXT,
      last_graph_built_at TEXT,
      document_count INTEGER NOT NULL DEFAULT 0,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      node_count INTEGER NOT NULL DEFAULT 0,
      edge_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      pinned_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_root_path ON workspaces(root_path);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `;
}

function getRegistryDbRaw() {
  const dbPath = resolveRegistryDbPath();
  ensureRegistryDir(dbPath);

  let usedTemplate = false;
  if (!fs.existsSync(dbPath)) {
    const template = resolveBundledFile("registry-template.sqlite");
    if (template) {
      const tmpPath = `${dbPath}.${process.pid}.tmp`;
      try {
        fs.copyFileSync(template, tmpPath);
        if (!fs.existsSync(dbPath)) {
          fs.renameSync(tmpPath, dbPath);
          usedTemplate = true;
        } else {
          fs.unlinkSync(tmpPath);
        }
      } catch {
        try {
          fs.unlinkSync(tmpPath);
        } catch {}
      }
    }
  }

  const sqlite = createNativeDatabase(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  if (!usedTemplate) initializeRegistrySchema(sqlite);
  else migrateRegistrySchema(sqlite);
  // SAFETY: drizzle-orm/bun-sqlite expects a BunSqlite.Database instance;
  // our NativeDatabase interface is structurally compatible (exec, prepare,
  // pragma) but the drizzle typings require the concrete BunSqlite type.
  return { sqlite, db: drizzle(sqlite as any, { schema }) };
}

export function resolveRegistryDbPath(): string {
  const envPath = process.env.AI_MEMORY_REGISTRY_DB_PATH?.trim();
  if (envPath) {
    return envPath;
  }

  const homeDir = [os.homedir(), process.env.HOME, process.env.USERPROFILE, process.cwd()].find(
    (value): value is string => value !== undefined && value.trim().length > 0,
  );

  if (!homeDir) {
    throw new Error("Cannot resolve home directory for registry DB path");
  }

  return path.join(homeDir, ".openez", "registry.sqlite");
}

function ensureRegistryDir(dbPath: string) {
  const registryDir = path.dirname(dbPath);
  if (!fs.existsSync(registryDir)) {
    fs.mkdirSync(registryDir, { recursive: true, mode: 0o755 });
  }
}

export function getRegistryDb() {
  if (!registryDb) {
    registryDb = getRegistryDbRaw();
  }
  return registryDb.db;
}

export function getRegistryNativeDb() {
  if (!registryDb) {
    registryDb = getRegistryDbRaw();
  }
  return registryDb.sqlite;
}

export function closeRegistryDb() {
  if (registryDb) {
    try {
      registryDb.sqlite.close();
    } catch {}
  }
  registryDb = null;
}

function initializeRegistrySchema(sqlite: ReturnType<typeof createNativeDatabase>) {
  sqlite.exec(getRegistryDdl());
  migrateRegistrySchema(sqlite);
}
