import fs from "node:fs";
import path from "node:path";

import { drizzle } from "drizzle-orm/better-sqlite3";

import * as workspaceSchema from "./schema";
import { createNativeDatabase } from "./database-loader";

const WORKSPACE_DB_DIR_NAME = ".openez";
const WORKSPACE_DB_FILE_NAME = "index.sqlite";

const dbCache = new Map<string, ReturnType<typeof drizzle>>();

export function getWorkspaceDb(rootPath: string) {
  const cached = dbCache.get(rootPath);
  if (cached) {
    return cached;
  }

  const dbDir = path.join(rootPath, WORKSPACE_DB_DIR_NAME);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true, mode: 0o755 });
  }

  const dbPath = path.join(dbDir, WORKSPACE_DB_FILE_NAME);
  const sqlite = createNativeDatabase(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  // Tuning for faster bulk indexing:
  // - synchronous=NORMAL: in WAL mode, skips fsync on each COMMIT.
  //   Safe against crashes (WAL guarantees consistency), just not against
  //   power loss. Acceptable for a local dev tool.
  // - temp_store=MEMORY: temp tables and indices in RAM
  // - cache_size=-64000: 64MB page cache (default 16MB)
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("temp_store = MEMORY");
  sqlite.pragma("cache_size = -64000");

  const db = drizzle(sqlite as never, { schema: workspaceSchema });
  initializeWorkspaceSchema(sqlite);
  dbCache.set(rootPath, db);
  return db;
}

export function closeWorkspaceDb(rootPath: string) {
  dbCache.delete(rootPath);
}

export function closeAllWorkspaceDbs() {
  dbCache.clear();
}

function initializeWorkspaceSchema(sqlite: ReturnType<typeof createNativeDatabase>) {
  const tables = getWorkspaceTableDefinitions();
  for (const ddl of tables) {
    sqlite.exec(ddl);
  }

  migrateQueryLogsColumns(sqlite);

  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON chunks(document_id);
    CREATE INDEX IF NOT EXISTS idx_chunks_content_hash ON chunks(content_hash);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_nodes_type_label ON graph_nodes(type, label);
    CREATE INDEX IF NOT EXISTS idx_graph_nodes_type ON graph_nodes(type);
    CREATE INDEX IF NOT EXISTS idx_graph_nodes_label ON graph_nodes(label);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_from ON graph_edges(from_node_id);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_to ON graph_edges(to_node_id);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_type ON graph_edges(type);
  `);
}

function getWorkspaceTableDefinitions(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      absolute_path TEXT NOT NULL,
      kind TEXT NOT NULL,
      language TEXT,
      content_hash TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
      path,
      content_rowid UNINDEXED,
      tokenize = 'porter unicode61'
    )`,
    `CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      heading TEXT,
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    // FTS5 virtual table for full-text search on chunk content + heading.
    // content_rowid points to chunks.rowid; external content table pattern
    // keeps the FTS index in sync without duplicating text.
    `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      content,
      heading,
      path UNINDEXED,
      content_rowid UNINDEXED,
      tokenize = 'porter unicode61'
    )`,
    `CREATE TABLE IF NOT EXISTS graph_nodes (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      label TEXT NOT NULL,
      ref_id TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS graph_nodes_fts USING fts5(
      label,
      type UNINDEXED,
      content_rowid UNINDEXED,
      tokenize = 'porter unicode61'
    )`,
    `CREATE TABLE IF NOT EXISTS graph_edges (
      id TEXT PRIMARY KEY,
      from_node_id TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
      to_node_id TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      weight INTEGER NOT NULL DEFAULT 1,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS index_runs (
      id TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      files_scanned INTEGER NOT NULL DEFAULT 0,
      files_updated INTEGER NOT NULL DEFAULT 0,
      chunks_written INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      stats TEXT DEFAULT '{}',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS graph_runs (
      id TEXT PRIMARY KEY,
      mode TEXT NOT NULL DEFAULT 'incremental',
      status TEXT NOT NULL DEFAULT 'pending',
      nodes_created INTEGER NOT NULL DEFAULT 0,
      edges_created INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      stats TEXT DEFAULT '{}',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS query_logs (
      id TEXT PRIMARY KEY,
      query TEXT NOT NULL,
      mode TEXT NOT NULL,
      result_count INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER,
      retrieved_chunks TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL,
      supersedes_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(title, content, tags, content='memories', content_rowid='rowid')`,
    `CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, title, content, tags) VALUES (new.rowid, new.title, new.content, new.tags);
    END`,
    `CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, title, content, tags) VALUES ('delete', old.rowid, old.title, old.content, old.tags);
    END`,
    `CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, title, content, tags) VALUES ('delete', old.rowid, old.title, old.content, old.tags);
      INSERT INTO memories_fts(rowid, title, content, tags) VALUES (new.rowid, new.title, new.content, new.tags);
    END`
  ];
}

/**
 * Idempotent migration: add `latency_ms` and `retrieved_chunks` columns to
 * existing `query_logs` tables created before plan 08-01. Uses PRAGMA
 * table_info to check presence so re-running on an already-migrated DB is
 * a no-op. Each ALTER is guarded individually so a partially-migrated DB
 * does not throw.
 */
function migrateQueryLogsColumns(sqlite: ReturnType<typeof createNativeDatabase>): void {
  const columns = sqlite.prepare("PRAGMA table_info(query_logs)").all() as Array<{ name: string }>;
  const existing = new Set(columns.map((col) => col.name));

  if (!existing.has("latency_ms")) {
    try {
      sqlite.exec("ALTER TABLE query_logs ADD COLUMN latency_ms INTEGER");
    } catch {
      // Column may have been added concurrently; ignore.
    }
  }

  if (!existing.has("retrieved_chunks")) {
    try {
      sqlite.exec("ALTER TABLE query_logs ADD COLUMN retrieved_chunks TEXT NOT NULL DEFAULT '[]'");
    } catch {
      // Column may have been added concurrently; ignore.
    }
  }
}
