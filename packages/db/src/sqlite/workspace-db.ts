import fs from "node:fs";
import path from "node:path";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "./schema";
import { createNativeDatabase, hasVecExtension } from "./database-loader";
import { restoreFtsTriggerDefinitions } from "./fts-repository";

const WORKSPACE_DB_DIR_NAME = ".openez";
const WORKSPACE_DB_FILE_NAME = "index.sqlite";

const dbCache = new Map<string, ReturnType<typeof drizzle>>();
const nativeCache = new Map<string, ReturnType<typeof createNativeDatabase>>();

// Resolve a bundled file (template.sqlite, registry-template.sqlite) that ships alongside the CLI binary.
export function resolveBundledFile(filename: string): string | null {
  const candidates = [
    // Bundled CLI: __dirname is dist/ → template sits next to cli.cjs
    path.join(__dirname, filename),
    // Bundled CLI alt: relative to process.argv[1] (same dir as cli.cjs)
    path.join(path.dirname(process.argv[1] || __filename), filename),
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
  if (cached) return cached;

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

export function initializeWorkspaceSchema(
  sqlite: ReturnType<typeof createNativeDatabase>,
  dimensions: number = 768,
) {
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
      // Backfill existing chunks into the newly created FTS table.
      sqlite.exec(`
        INSERT INTO chunks_fts (chunk_id, path, heading, language, search_text)
        SELECT c.id, d.path, coalesce(c.heading, ''),
          coalesce(d.language, ''), substr(c.content, 1, 400)
        FROM chunks c
        INNER JOIN documents d ON d.id = c.document_id;
      `);
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
      // Deduplicate legacy edges before creating the unique index.
      sqlite.exec(`
        DELETE FROM graph_edges
        WHERE id NOT IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (
              PARTITION BY from_node_id, to_node_id, type
              ORDER BY created_at DESC, id
            ) AS rn
            FROM graph_edges
          )
          WHERE rn = 1
        );
      `);
      sqlite.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_edges_from_to_type ON graph_edges(from_node_id, to_node_id, type)`,
      );
    }

    migrateQueryLogColumns(sqlite);
    migrateEmbeddingColumns(sqlite);
    migrateEmbeddingDedup(sqlite);
    migrateEmbeddingToBlob(sqlite);

    const hasParsedDocs =
      (
        sqlite
          .prepare(
            "SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name='parsed_documents'",
          )
          .get() as { c: number }
      ).c > 0;
    if (!hasParsedDocs) {
      sqlite.exec(`CREATE TABLE IF NOT EXISTS parsed_documents (
        document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
        content_hash TEXT NOT NULL,
        symbols TEXT,
        imports TEXT,
        calls TEXT,
        called_identifiers TEXT,
        parser_version TEXT,
        parsed_at INTEGER NOT NULL
      )`);
    } else {
      // Add called_identifiers and parser_version columns to existing
      // parsed_documents tables created before these fields existed.
      const parsedCols = new Set(
        (
          sqlite.prepare("PRAGMA table_info(parsed_documents)").all() as Array<{ name: string }>
        ).map((row) => row.name),
      );
      if (!parsedCols.has("called_identifiers")) {
        sqlite.exec("ALTER TABLE parsed_documents ADD COLUMN called_identifiers TEXT");
      }
      if (!parsedCols.has("parser_version")) {
        sqlite.exec("ALTER TABLE parsed_documents ADD COLUMN parser_version TEXT");
      }
    }

    // Ensure FTS triggers exist (may be missing on DBs created before triggers
    // were added, or on fresh DBs that only ran getFullWorkspaceDdl).
    restoreFtsTriggerDefinitions(sqlite);

    // Try creating the vec0 virtual table for ANN vector search when the
    // sqlite-vec extension is loaded. No-op when the extension is unavailable.
    tryCreateVecTable(sqlite, dimensions);
    return;
  }

  sqlite.exec(getFullWorkspaceDdl());
  migrateQueryLogColumns(sqlite);
  migrateEmbeddingColumns(sqlite);
  migrateEmbeddingDedup(sqlite);
  migrateEmbeddingToBlob(sqlite);

  // Create FTS triggers — getFullWorkspaceDdl creates the chunks_fts table but
  // not the triggers that auto-populate it on INSERT/DELETE/UPDATE.
  restoreFtsTriggerDefinitions(sqlite);

  // Try creating the vec0 virtual table for ANN vector search when the
  // sqlite-vec extension is loaded. When the extension is unavailable (e.g.
  // under bun:sqlite), this is skipped and retrieval falls back to linear scan.
  tryCreateVecTable(sqlite, dimensions);
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

function migrateEmbeddingToBlob(sqlite: ReturnType<typeof createNativeDatabase>) {
  const info = sqlite.prepare("PRAGMA table_info(embeddings)").all() as Array<{
    name: string;
    type: string;
  }>;
  const embeddingCol = info.find((c) => c.name === "embedding");
  if (embeddingCol && embeddingCol.type.toUpperCase() === "TEXT") {
    console.error(
      "[openez] Migrating embeddings from TEXT to BLOB — existing embeddings will be dropped, full reindex required.",
    );
    // Drop and recreate — full reindex required
    sqlite.exec("DELETE FROM embeddings");
    sqlite.exec("DROP TABLE embeddings");
    sqlite.exec(`CREATE TABLE IF NOT EXISTS embeddings (
      id TEXT PRIMARY KEY,
      chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      embedding BLOB NOT NULL,
      input_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    // Recreate indexes
    sqlite.exec("CREATE INDEX IF NOT EXISTS idx_embeddings_chunk_id ON embeddings(chunk_id)");
    sqlite.exec(
      "CREATE INDEX IF NOT EXISTS idx_embeddings_provider_model_hash ON embeddings(provider, model, input_hash)",
    );
    sqlite.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_embeddings_chunk_provider_model ON embeddings(chunk_id, provider, model)",
    );
  }
}

/**
 * Create the vec0 virtual table for ANN vector search when the sqlite-vec
 * extension is loaded. The dimension defaults to 768 (bge-m3 / Ollama
 * nomic-embed-text) but can be overridden via `dimensions` to match the
 * embedding model in use. When the extension is unavailable (e.g. under
 * bun:sqlite, which is compiled without dynamic extension loading), this
 * is a no-op and retrieval falls back to a linear scan over `embeddings`.
 */
function tryCreateVecTable(
  sqlite: ReturnType<typeof createNativeDatabase>,
  dimensions: number = 768,
) {
  if (!hasVecExtension()) return;
  try {
    sqlite.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS embeddings_vec USING vec0(chunk_id TEXT PRIMARY KEY, embedding float[${dimensions}])`,
    );
  } catch {
    // Table creation failed (e.g. dimension mismatch, extension quirks) —
    // linear scan fallback remains available via the embeddings table.
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
      embedding BLOB NOT NULL,
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
    `CREATE TABLE IF NOT EXISTS index_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS parsed_documents (
      document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
      content_hash TEXT NOT NULL,
      symbols TEXT,
      imports TEXT,
      calls TEXT,
      called_identifiers TEXT,
      parser_version TEXT,
      parsed_at INTEGER NOT NULL
    )`,
  ];
}
