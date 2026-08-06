import fs from "node:fs";
import path from "node:path";

import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";

import * as schema from "./schema";
import { createNativeDatabase } from "./database-loader";

const WORKSPACE_DB_DIR_NAME = ".openez";
const WORKSPACE_DB_FILE_NAME = "index.sqlite";

const dbCache = new Map<string, ReturnType<typeof drizzle>>();
const nativeCache = new Map<string, ReturnType<typeof createNativeDatabase>>();

// Resolve a bundled file (template.sqlite, registry-template.sqlite) that ships alongside the CLI binary.
export function resolveBundledFile(filename: string): string | null {
  const candidates = [
    // Bundled CLI: dist/apps/cli/src/cli.cjs → dist/<filename> (up 4)
    path.join(__dirname, "..", "..", "..", "..", filename),
    // Bundled CLI alt: relative to process.argv[1]
    path.join(path.dirname(process.argv[1] || __filename), "..", "..", "..", "..", filename),
    // Dev: packages/db/src/sqlite/ → packages/db/<filename> (up 3)
    path.join(__dirname, "..", "..", "..", filename),
    // Fallback: cwd
    path.join(process.cwd(), filename),
    path.join(process.cwd(), "apps", "cli", "dist", filename),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {}
  }
  return null;
}

function getWorkspaceDbRaw(rootPath: string) {
  const dbDir = path.join(rootPath, WORKSPACE_DB_DIR_NAME);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true, mode: 0o755 });
  }
  const dbPath = path.join(dbDir, WORKSPACE_DB_FILE_NAME);

  if (!fs.existsSync(dbPath)) {
    const template = resolveBundledFile("template.sqlite");
    if (template) {
      const tmpPath = `${dbPath}.${process.pid}.tmp`;
      try {
        fs.copyFileSync(template, tmpPath);
        if (!fs.existsSync(dbPath)) fs.renameSync(tmpPath, dbPath);
        else fs.unlinkSync(tmpPath);
      } catch {
        try {
          fs.unlinkSync(tmpPath);
        } catch {}
      }
    }
  }

  const sqlite = createNativeDatabase(dbPath);
  sqlite.pragma("page_size = 16384");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return { sqlite, db: drizzle(sqlite as any, { schema }) };
}

export function getWorkspaceDb(rootPath: string) {
  const cached = dbCache.get(rootPath);
  if (cached) return cached.db;

  const { sqlite, db } = getWorkspaceDbRaw(rootPath);
  initializeWorkspaceSchema(sqlite);
  dbCache.set(rootPath, db);
  nativeCache.set(rootPath, sqlite);
  return db;
}

export function getWorkspaceNativeDb(rootPath: string) {
  const cached = nativeCache.get(rootPath);
  if (cached) return cached;
  getWorkspaceDb(rootPath);
  return nativeCache.get(rootPath)!;
}

export function closeWorkspaceDb(rootPath: string) {
  const native = nativeCache.get(rootPath);
  if (native) {
    try {
      native.close();
    } catch {
      // Already closed or closing in progress
    }
    nativeCache.delete(rootPath);
  }
  dbCache.delete(rootPath);
}

export function closeAllWorkspaceDbs() {
  for (const native of nativeCache.values()) {
    try {
      native.close();
    } catch {
      // Already closed or closing in progress
    }
  }
  nativeCache.clear();
  dbCache.clear();
}

export function getFullWorkspaceDdl(): string {
  return (
    [
      ...getWorkspaceTableDefinitions(),
      "CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON chunks(document_id)",
      "CREATE INDEX IF NOT EXISTS idx_chunks_content_hash ON chunks(content_hash)",
      "CREATE INDEX IF NOT EXISTS idx_graph_nodes_type ON graph_nodes(type)",
      "CREATE INDEX IF NOT EXISTS idx_graph_nodes_label ON graph_nodes(label)",
      "CREATE INDEX IF NOT EXISTS idx_graph_edges_from ON graph_edges(from_node_id)",
      "CREATE INDEX IF NOT EXISTS idx_graph_edges_to ON graph_edges(to_node_id)",
      "CREATE INDEX IF NOT EXISTS idx_graph_edges_type ON graph_edges(type)",
      "CREATE INDEX IF NOT EXISTS idx_embeddings_chunk_id ON embeddings(chunk_id)",
      "CREATE INDEX IF NOT EXISTS idx_embeddings_provider_model_hash ON embeddings(provider, model, input_hash)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_embeddings_chunk_provider_model ON embeddings(chunk_id, provider, model)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_nodes_type_label ON graph_nodes(type, label) WHERE type != 'symbol'",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_edges_from_to_type ON graph_edges(from_node_id, to_node_id, type)",
      "CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(chunk_id UNINDEXED, path, heading, language, search_text, tokenize = 'unicode61')",
    ].join(";\n") + ";"
  );
}

export function initializeWorkspaceSchema(sqlite: ReturnType<typeof createNativeDatabase>) {
  const tableExists =
    (
      sqlite
        .prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name='documents'")
        .get() as { c: number }
    ).c > 0;

  if (tableExists) {
    const hasIndexMeta =
      (
        sqlite
          .prepare(
            "SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name='index_meta'",
          )
          .get() as { c: number }
      ).c > 0;
    if (!hasIndexMeta) {
      sqlite.exec(
        `CREATE TABLE IF NOT EXISTS index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
      );
    }

    const hasFts =
      (
        sqlite
          .prepare(
            "SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name='chunks_fts'",
          )
          .get() as { c: number }
      ).c > 0;
    if (!hasFts) {
      sqlite.exec(
        `CREATE VIRTUAL TABLE chunks_fts USING fts5(chunk_id UNINDEXED, path, heading, language, search_text, tokenize = 'unicode61')`,
      );
    }

    const hasTypeLabelIdx =
      (
        sqlite
          .prepare(
            "SELECT count(*) as c FROM sqlite_master WHERE type='index' AND name='idx_graph_nodes_type_label'",
          )
          .get() as { c: number }
      ).c > 0;
    if (!hasTypeLabelIdx) {
      try {
        sqlite.exec(
          `CREATE UNIQUE INDEX idx_graph_nodes_type_label ON graph_nodes(type, label) WHERE type != 'symbol'`,
        );
      } catch {}
    }
    const hasEdgeIdx =
      (
        sqlite
          .prepare(
            "SELECT count(*) as c FROM sqlite_master WHERE type='index' AND name='idx_graph_edges_from_to_type'",
          )
          .get() as { c: number }
      ).c > 0;
    if (!hasEdgeIdx) {
      sqlite.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_edges_from_to_type ON graph_edges(from_node_id, to_node_id, type)`,
      );
    }

    migrateQueryLogColumns(sqlite);
    migrateEmbeddingColumns(sqlite);
    migrateEmbeddingDedup(sqlite);
    migrateTextPkToInteger(sqlite);
    return;
  }

  sqlite.exec(getFullWorkspaceDdl());
  migrateQueryLogColumns(sqlite);
  migrateEmbeddingColumns(sqlite);
  migrateEmbeddingDedup(sqlite);
  migrateTextPkToInteger(sqlite);
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

function migrateEmbeddingDedup(sqlite: ReturnType<typeof createNativeDatabase>) {
  // Ensure the provider/model/hash lookup index exists for fast duplicate detection.
  sqlite.exec(
    "CREATE INDEX IF NOT EXISTS idx_embeddings_provider_model_hash ON embeddings(provider, model, input_hash)",
  );
  sqlite.exec("CREATE INDEX IF NOT EXISTS idx_embeddings_chunk_id ON embeddings(chunk_id)");

  // Skip dedup on empty table — window function is expensive even with 0 rows.
  const count = (sqlite.prepare("SELECT count(*) as c FROM embeddings").get() as { c: number }).c;
  if (count === 0) {
    sqlite.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_embeddings_chunk_provider_model ON embeddings(chunk_id, provider, model)",
    );
    return;
  }

  // Remove duplicate derived vectors before enforcing their logical identity.
  sqlite.transaction(() => {
    sqlite.exec(`
      DELETE FROM embeddings
      WHERE id NOT IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY chunk_id, provider, model
            ORDER BY (input_hash IS NOT NULL) DESC, created_at DESC, id
          ) AS row_number
          FROM embeddings
        )
        WHERE row_number = 1
      );
    `);
    sqlite.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_embeddings_chunk_provider_model
      ON embeddings(chunk_id, provider, model)
    `);
  })();
}

function migrateTextPkToInteger(sqlite: ReturnType<typeof createNativeDatabase>) {
  // Detect old TEXT PK schema by checking documents.id column type.
  const cols = sqlite.prepare("PRAGMA table_info(documents)").all() as Array<{
    name: string;
    type: string;
  }>;
  const idCol = cols.find((c) => c.name === "id");
  if (!idCol || idCol.type.toUpperCase() === "INTEGER") return;

  // Old TEXT PK DB — drop everything and recreate with INTEGER PK.
  // Data loss is acceptable: indexing is idempotent, user just re-indexes.
  sqlite.exec(`
    DROP TABLE IF EXISTS chunks_fts;
    DROP TABLE IF EXISTS embeddings;
    DROP TABLE IF EXISTS graph_edges;
    DROP TABLE IF EXISTS graph_nodes;
    DROP TABLE IF EXISTS chunks;
    DROP TABLE IF EXISTS documents;
    DROP TABLE IF EXISTS index_runs;
    DROP TABLE IF EXISTS graph_runs;
    DROP TABLE IF EXISTS query_logs;
    DROP TABLE IF EXISTS memories;
  `);
  sqlite.exec(getFullWorkspaceDdl());
}

function getWorkspaceTableDefinitions(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY,
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
      id INTEGER PRIMARY KEY,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
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
      id INTEGER PRIMARY KEY,
      chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      embedding TEXT NOT NULL,
      input_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS graph_nodes (
      id INTEGER PRIMARY KEY,
      type TEXT NOT NULL,
      label TEXT NOT NULL,
      ref_id INTEGER,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS graph_edges (
      id INTEGER PRIMARY KEY,
      from_node_id INTEGER NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
      to_node_id INTEGER NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      weight INTEGER NOT NULL DEFAULT 1,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS index_runs (
      id INTEGER PRIMARY KEY,
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
      id INTEGER PRIMARY KEY,
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
      id INTEGER PRIMARY KEY,
      query TEXT NOT NULL,
      mode TEXT NOT NULL,
      result_count INTEGER NOT NULL DEFAULT 0,
      tokens_returned INTEGER NOT NULL DEFAULT 0,
      tokens_saved INTEGER NOT NULL DEFAULT 0,
      files_scanned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL,
      supersedes_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS index_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
  ];
}
