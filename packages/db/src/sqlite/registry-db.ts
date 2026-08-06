import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { drizzle } from "drizzle-orm/better-sqlite3";

import * as registrySchema from "./schema";
import { createNativeDatabase } from "./database-loader";

let registryDb: ReturnType<typeof drizzle> | null = null;

export function resolveRegistryDbPath(): string {
  const envPath = process.env.AI_MEMORY_REGISTRY_DB_PATH?.trim();
  if (envPath) {
    return envPath;
  }

  const homeDir = [os.homedir(), process.env.HOME, process.env.USERPROFILE, process.cwd()].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
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
    const dbPath = resolveRegistryDbPath();
    if (typeof dbPath !== "string" || dbPath.trim().length === 0) {
      throw new Error("Registry DB path is not configured");
    }

    ensureRegistryDir(dbPath);

    try {
      const sqlite = createNativeDatabase(dbPath);
      sqlite.pragma("journal_mode = WAL");
      sqlite.pragma("foreign_keys = ON");
      const db = drizzle(sqlite as never, { schema: registrySchema });
      initializeRegistrySchema(sqlite);
      registryDb = db;
    } catch (err) {
      registryDb = null;
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to open registry DB at "${dbPath}": ${message}`);
    }
  }
  return registryDb;
}

export function closeRegistryDb() {
  registryDb = null;
}

function initializeRegistrySchema(sqlite: ReturnType<typeof createNativeDatabase>) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      root_path TEXT NOT NULL UNIQUE,
      include_globs TEXT NOT NULL DEFAULT '',
      exclude_globs TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      indexing_status TEXT NOT NULL DEFAULT 'pending',
      graph_status TEXT NOT NULL DEFAULT 'pending',
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

    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_root_path
    ON workspaces(root_path);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  migrateRegistryColumns(sqlite);
}

function migrateRegistryColumns(sqlite: ReturnType<typeof createNativeDatabase>) {
  const columns = new Set(
    (sqlite.prepare("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  if (!columns.has("pinned_at")) {
    try {
      sqlite.exec("ALTER TABLE workspaces ADD COLUMN pinned_at TEXT");
    } catch (err) {
      // Another process may have added the column concurrently; re-check.
      const recheck = new Set(
        (sqlite.prepare("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>).map(
          (row) => row.name,
        ),
      );
      if (!recheck.has("pinned_at")) {
        throw err;
      }
    }
  }
}
