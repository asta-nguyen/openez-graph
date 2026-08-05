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

  migrateQueryLogColumns(sqlite);
  migrateEmbeddingColumns(sqlite);

  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON chunks(document_id);
    CREATE INDEX IF NOT EXISTS idx_chunks_content_hash ON chunks(content_hash);
    CREATE INDEX IF NOT EXISTS idx_graph_nodes_type ON graph_nodes(type);
    CREATE INDEX IF NOT EXISTS idx_graph_nodes_label ON graph_nodes(label);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_from ON graph_edges(from_node_id);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_to ON graph_edges(to_node_id);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_type ON graph_edges(type);
    CREATE INDEX IF NOT EXISTS idx_embeddings_chunk_id ON embeddings(chunk_id);
    CREATE INDEX IF NOT EXISTS idx_embeddings_provider_model_hash
      ON embeddings(provider, model, input_hash);
  `);

  // Remove duplicate derived vectors before enforcing their logical identity.
  sqlite.transaction(() => {
    sqlite.exec(`
      DELETE FROM embeddings
      WHERE id NOT IN (
        SELECT MIN(id) FROM embeddings
        GROUP BY chunk_id, provider, model
      );
    `);
    sqlite.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_embeddings_chunk_provider_model
      ON embeddings(chunk_id, provider, model)
    `);
  })();

  // Partial unique index to enable ON CONFLICT upserts for non-symbol nodes.
  // Symbols allow duplicate names across files and are handled separately.
  try {
    sqlite.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_nodes_type_label
      ON graph_nodes(type, label) WHERE type != 'symbol'
    `);
  } catch {
    // Non-fatal if legacy duplicates exist
  }

  // Clean legacy duplicates and install the logical-edge constraint atomically.
  sqlite.transaction(() => {
    sqlite.exec(`
      DELETE FROM graph_edges
      WHERE id NOT IN (
        SELECT MIN(id) FROM graph_edges
        GROUP BY from_node_id, to_node_id, type
      );
    `);
    sqlite.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_edges_from_to_type
      ON graph_edges(from_node_id, to_node_id, type)
    `);
  })();

  // FTS5 includes file and symbol context because code queries often name either one.
  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      chunk_id UNINDEXED,
      path,
      heading,
      language,
      search_text,
      content,
      tokenize = 'porter unicode61'
    );
  `);

  const ftsColumns = sqlite.prepare("PRAGMA table_info(chunks_fts)").all() as Array<{
    name: string;
  }>;
  if (!ftsColumns.some((column) => column.name === "search_text")) {
    sqlite.exec(`
      DROP TRIGGER IF EXISTS chunks_fts_insert;
      DROP TRIGGER IF EXISTS chunks_fts_delete;
      DROP TRIGGER IF EXISTS chunks_fts_update;
      DROP TABLE chunks_fts;
      CREATE VIRTUAL TABLE chunks_fts USING fts5(
        chunk_id UNINDEXED,
        path,
        heading,
        language,
        search_text,
        content,
        tokenize = 'porter unicode61'
      );
    `);
  }

  // Triggers to keep FTS table in sync with chunks
  sqlite.exec(`
    CREATE TRIGGER IF NOT EXISTS chunks_fts_insert AFTER INSERT ON chunks
    BEGIN
      INSERT INTO chunks_fts (chunk_id, path, heading, language, search_text, content)
      SELECT new.id, documents.path, coalesce(new.heading, ''),
        coalesce(documents.language, ''), coalesce(json_extract(new.metadata, '$.searchText'), ''), new.content
      FROM documents WHERE documents.id = new.document_id;
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_fts_delete AFTER DELETE ON chunks
    BEGIN
      DELETE FROM chunks_fts WHERE chunk_id = old.id;
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_fts_update AFTER UPDATE ON chunks
    BEGIN
      DELETE FROM chunks_fts WHERE chunk_id = old.id;
      INSERT INTO chunks_fts (chunk_id, path, heading, language, search_text, content)
      SELECT new.id, documents.path, coalesce(new.heading, ''),
        coalesce(documents.language, ''), coalesce(json_extract(new.metadata, '$.searchText'), ''), new.content
      FROM documents WHERE documents.id = new.document_id;
    END;
  `);

  sqlite.exec(`
    INSERT INTO chunks_fts (chunk_id, path, heading, language, search_text, content)
    SELECT chunks.id, documents.path, coalesce(chunks.heading, ''),
      coalesce(documents.language, ''), coalesce(json_extract(chunks.metadata, '$.searchText'), ''), chunks.content
    FROM chunks
    INNER JOIN documents ON documents.id = chunks.document_id
    WHERE NOT EXISTS (
      SELECT 1 FROM chunks_fts WHERE chunks_fts.chunk_id = chunks.id
    );
  `);
}

function migrateQueryLogColumns(sqlite: ReturnType<typeof createNativeDatabase>) {
  const columns = new Set(
    (sqlite.prepare("PRAGMA table_info(query_logs)").all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );

  if (!columns.has("tokens_returned")) {
    sqlite.exec("ALTER TABLE query_logs ADD COLUMN tokens_returned INTEGER NOT NULL DEFAULT 0");
  }
  if (!columns.has("tokens_saved")) {
    sqlite.exec("ALTER TABLE query_logs ADD COLUMN tokens_saved INTEGER NOT NULL DEFAULT 0");
  }
  if (!columns.has("files_scanned")) {
    sqlite.exec("ALTER TABLE query_logs ADD COLUMN files_scanned INTEGER NOT NULL DEFAULT 0");
  }
}

function migrateEmbeddingColumns(sqlite: ReturnType<typeof createNativeDatabase>) {
  const columns = new Set(
    (sqlite.prepare("PRAGMA table_info(embeddings)").all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );

  if (!columns.has("input_hash")) {
    sqlite.exec("ALTER TABLE embeddings ADD COLUMN input_hash TEXT");
  }
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
    `CREATE TABLE IF NOT EXISTS embeddings (
      id TEXT PRIMARY KEY,
      chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      embedding TEXT NOT NULL,
      input_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
      embeddings_written INTEGER NOT NULL DEFAULT 0,
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
      tokens_returned INTEGER NOT NULL DEFAULT 0,
      tokens_saved INTEGER NOT NULL DEFAULT 0,
      files_scanned INTEGER NOT NULL DEFAULT 0,
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
  ];
}
