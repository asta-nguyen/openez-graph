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
      registryDb = drizzle(sqlite as never, { schema: registrySchema });
      initializeRegistrySchema(sqlite);
    } catch (err) {
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

    CREATE TABLE IF NOT EXISTS library_docs_cache (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      library_id       TEXT NOT NULL,
      library_name     TEXT NOT NULL,
      version          TEXT NOT NULL,
      topic            TEXT,
      content          TEXT NOT NULL,
      content_hash     TEXT NOT NULL,
      tokens           INTEGER NOT NULL,
      fetched_at       INTEGER NOT NULL,
      expires_at       INTEGER NOT NULL,
      hit_count        INTEGER NOT NULL DEFAULT 0,
      last_accessed_at INTEGER NOT NULL,
      UNIQUE(library_id, version, topic)
    );

    CREATE INDEX IF NOT EXISTS idx_library_docs_expires
      ON library_docs_cache(expires_at);

    CREATE INDEX IF NOT EXISTS idx_library_docs_lookup
      ON library_docs_cache(library_id, version, topic);

    CREATE TABLE IF NOT EXISTS library_docs_name_map (
      query_name   TEXT NOT NULL,
      library_id   TEXT NOT NULL,
      resolved_at  INTEGER NOT NULL,
      PRIMARY KEY (query_name, library_id)
    );
  `);
}
