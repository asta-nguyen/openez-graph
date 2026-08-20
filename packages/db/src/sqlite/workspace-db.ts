import fs from "node:fs";
import path from "node:path";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "./schema";
import { createNativeDatabase } from "./database-loader";
import {
  composeFtsSearchTextSql,
  FTS_SCHEMA_VERSION,
  restoreFtsTriggerDefinitions,
} from "./fts-repository";

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
    // Dev: packages/db/src/sqlite/ → packages/db/<filename> (up 2)
    path.join(__dirname, "..", "..", filename),
    // Fallback: cwd
    path.join(process.cwd(), "packages", "db", filename),
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
  // SAFETY: NativeDatabase wraps bun:sqlite Database driver instance.
  const drizzleDb = drizzle(sqlite as any, { schema });
  return { sqlite, db: drizzleDb };
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

export function initializeWorkspaceSchema(sqlite: ReturnType<typeof createNativeDatabase>) {
  // SAFETY: Query counts table occurrences in sqlite_master.
  const tableExists =
    (
      sqlite
        .prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name='documents'")
        .get() as { c: number }
    ).c > 0;

  if (tableExists) {
    migrateIndexTablesIfLegacy(sqlite);

    // SAFETY: Query counts table occurrences in sqlite_master.
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

    // SAFETY: Query counts table occurrences in sqlite_master.
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
          coalesce(d.language, ''),
          ${composeFtsSearchTextSql("c.metadata", "c.content")}
        FROM chunks c
        INNER JOIN documents d ON d.id = c.document_id;
      `);
    } else {
      // FTS table already exists — but indexing may have been interrupted
      // (triggers were down, process crashed before restore). Backfill any
      // chunks that exist in the chunks table but are missing from FTS,
      // and remove orphaned FTS rows whose chunks were deleted.
      //
      // Quick count check first: if chunks and FTS row counts differ, repair
      // immediately. Equal counts are not sufficient: an interrupted write
      // can replace one chunk while FTS still contains the old ID.
      // SAFETY: Query counts rows in chunks table.
      const chunkCountRow = sqlite.prepare("SELECT count(*) as c FROM chunks").get() as {
        c: number;
      };
      const chunkCount = chunkCountRow.c;
      // SAFETY: Query counts rows in chunks_fts table.
      const ftsCountRow = sqlite.prepare("SELECT count(*) as c FROM chunks_fts").get() as {
        c: number;
      };
      const ftsCount = ftsCountRow.c;
      let ftsInSync = chunkCount === ftsCount;
      if (ftsInSync) {
        // Scan FTS once and use chunks' PRIMARY KEY for the join. This is
        // O(n), unlike the old chunks -> FTS join which scans UNINDEXED
        // chunk_id once per chunk.
        // SAFETY: Query counts distinct chunks and orphans in chunks_fts.
        const ftsIntegrity = sqlite
          .prepare(
            `
            SELECT count(DISTINCT f.chunk_id) AS distinct_count,
              count(*) - count(c.id) AS orphan_count
            FROM chunks_fts f
            LEFT JOIN chunks c ON c.id = f.chunk_id
          `,
          )
          .get() as { distinct_count: number; orphan_count: number };
        ftsInSync = ftsIntegrity.distinct_count === chunkCount && ftsIntegrity.orphan_count === 0;
      }
      if (!ftsInSync) {
        sqlite.exec(`
          INSERT INTO chunks_fts (chunk_id, path, heading, language, search_text)
          SELECT c.id, d.path, coalesce(c.heading, ''),
            coalesce(d.language, ''),
            ${composeFtsSearchTextSql("c.metadata", "c.content")}
          FROM chunks c
          INNER JOIN documents d ON d.id = c.document_id
          LEFT JOIN chunks_fts f ON f.chunk_id = c.id
          WHERE f.chunk_id IS NULL;
        `);
        // Remove FTS rows for chunks that no longer exist (orphaned by
        // interrupted deletes or manual DB edits).
        sqlite.exec(`
          DELETE FROM chunks_fts
          WHERE chunk_id NOT IN (SELECT id FROM chunks);
        `);
      }
    }

    // SAFETY: Query counts index occurrences in sqlite_master.
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
    // SAFETY: Query counts index occurrences in sqlite_master.
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
    migrateEmbeddingToBlob(sqlite);
    migrateEmbeddingDedup(sqlite);
    migrateMemoriesTable(sqlite);
    migrateQueryLogsTable(sqlite);
    migrateRunsTables(sqlite);

    // SAFETY: Query counts table occurrences in sqlite_master.
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
        document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
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
      // SAFETY: PRAGMA table_info returns table columns info.
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
    return;
  }

  sqlite.exec(getFullWorkspaceDdl());
  migrateQueryLogColumns(sqlite);
  migrateEmbeddingColumns(sqlite);
  migrateEmbeddingToBlob(sqlite);
  migrateEmbeddingDedup(sqlite);
  migrateMemoriesTable(sqlite);
  migrateQueryLogsTable(sqlite);
  migrateRunsTables(sqlite);

  // Create FTS triggers — getFullWorkspaceDdl creates the chunks_fts table but
  // not the triggers that auto-populate it on INSERT/DELETE/UPDATE.
  restoreFtsTriggerDefinitions(sqlite);
  sqlite
    .prepare("INSERT OR REPLACE INTO index_meta (key, value) VALUES ('fts_schema_version', ?)")
    .run(FTS_SCHEMA_VERSION);
}

function migrateQueryLogColumns(sqlite: ReturnType<typeof createNativeDatabase>) {
  // SAFETY: PRAGMA table_info returns table columns info.
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
  // SAFETY: PRAGMA table_info returns table columns info.
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
  // SAFETY: PRAGMA table_info returns table columns info.
  const embeddingColumn = (
    sqlite.prepare("PRAGMA table_info(embeddings)").all() as Array<{ name: string; type: string }>
  ).find((column) => column.name === "embedding");
  if (embeddingColumn?.type.toUpperCase() === "TEXT") return;

  // Ensure the provider/model/hash lookup index exists for fast duplicate detection.
  sqlite.exec(
    "CREATE INDEX IF NOT EXISTS idx_embeddings_provider_model_hash ON embeddings(provider, model, input_hash)",
  );
  sqlite.exec("CREATE INDEX IF NOT EXISTS idx_embeddings_chunk_id ON embeddings(chunk_id)");

  // Skip dedup on empty table — window function is expensive even with 0 rows.
  // SAFETY: Query counts rows in embeddings table.
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
  // SAFETY: PRAGMA table_info returns table columns info.
  const info = sqlite.prepare("PRAGMA table_info(embeddings)").all() as Array<{
    name: string;
    type: string;
  }>;
  const embeddingCol = info.find((c) => c.name === "embedding");
  if (embeddingCol && embeddingCol.type.toUpperCase() === "TEXT") {
    // Legacy TEXT embeddings are preserved — do NOT drop or recreate the
    // table on every DB open. Instead, record the legacy format in
    // index_meta so the retrieval layer can skip vector search (defer to
    // FTS) until an explicit `openez reindex` rebuilds embeddings as BLOB.
    // The reindex path calls `resetIndexArtifacts()` which drops all rows
    // and recreates the embeddings table with the current BLOB schema.
    // SAFETY: Query selects value from index_meta table.
    const existing = sqlite
      .prepare("SELECT value FROM index_meta WHERE key = 'embedding_format'")
      .get() as { value: string } | undefined;
    if (!existing) {
      sqlite
        .prepare(
          "INSERT OR REPLACE INTO index_meta (key, value) VALUES ('embedding_format', 'text')",
        )
        .run();
      console.error(
        "[openez] Workspace has legacy TEXT embeddings. Vector search is disabled until 'openez reindex <path>' rebuilds them as BLOB.",
      );
    }
  }
}

function migrateIndexTablesIfLegacy(sqlite: ReturnType<typeof createNativeDatabase>) {
  // SAFETY: Query counts table occurrences in sqlite_master.
  const tableExists =
    (
      sqlite
        .prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name='documents'")
        .get() as { c: number }
    ).c > 0;
  if (!tableExists) return;

  // SAFETY: PRAGMA table_info returns table columns info.
  const info = sqlite.prepare("PRAGMA table_info(documents)").all() as Array<{
    name: string;
    type: string;
  }>;
  const idCol = info.find((c) => c.name === "id");
  if (idCol && !idCol.type.toUpperCase().includes("INT")) {
    // Legacy TEXT primary key detected on documents — recreate index tables with autoincrement schema
    // (memories, query_logs, and index_runs are NOT dropped and remain preserved).
    sqlite.transaction(() => {
      sqlite.exec(`
        DROP TRIGGER IF EXISTS chunks_fts_insert;
        DROP TRIGGER IF EXISTS chunks_fts_delete;
        DROP TRIGGER IF EXISTS chunks_fts_update;
        DROP TABLE IF EXISTS chunks_fts;
        DROP TABLE IF EXISTS embeddings_vec;
        DROP TABLE IF EXISTS embeddings;
        DROP TABLE IF EXISTS graph_edges;
        DROP TABLE IF EXISTS graph_nodes;
        DROP TABLE IF EXISTS parsed_documents;
        DROP TABLE IF EXISTS chunks;
        DROP TABLE IF EXISTS documents;
      `);
      for (const ddl of getWorkspaceTableDefinitions()) {
        sqlite.exec(ddl);
      }
      sqlite.exec(`
        CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON chunks(document_id);
        CREATE INDEX IF NOT EXISTS idx_chunks_content_hash ON chunks(content_hash);
        CREATE INDEX IF NOT EXISTS idx_graph_nodes_type ON graph_nodes(type);
        CREATE INDEX IF NOT EXISTS idx_graph_nodes_label ON graph_nodes(label);
        CREATE INDEX IF NOT EXISTS idx_graph_edges_from ON graph_edges(from_node_id);
        CREATE INDEX IF NOT EXISTS idx_graph_edges_to ON graph_edges(to_node_id);
        CREATE INDEX IF NOT EXISTS idx_graph_edges_type ON graph_edges(type);
        CREATE INDEX IF NOT EXISTS idx_embeddings_chunk_id ON embeddings(chunk_id);
        CREATE INDEX IF NOT EXISTS idx_embeddings_provider_model_hash ON embeddings(provider, model, input_hash);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_embeddings_chunk_provider_model ON embeddings(chunk_id, provider, model);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_nodes_type_label ON graph_nodes(type, label) WHERE type != 'symbol';
        CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_edges_from_to_type ON graph_edges(from_node_id, to_node_id, type);
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(chunk_id UNINDEXED, path, heading, language, search_text, tokenize = 'unicode61');
      `);
      sqlite.exec("DELETE FROM index_meta WHERE key IN ('embedding_format', 'graph_build_epoch')");
    })();
  }
}

function migrateMemoriesTable(sqlite: ReturnType<typeof createNativeDatabase>) {
  // SAFETY: Query counts table occurrences in sqlite_master.
  const tableExists =
    (
      sqlite
        .prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name='memories'")
        .get() as { c: number }
    ).c > 0;
  if (!tableExists) return;

  // SAFETY: PRAGMA table_info returns table columns info.
  const info = sqlite.prepare("PRAGMA table_info(memories)").all() as Array<{
    name: string;
    type: string;
  }>;
  const idCol = info.find((c) => c.name === "id");
  if (!idCol || idCol.type.toUpperCase().includes("INT")) {
    return; // Already integer primary key
  }

  // Migrate legacy TEXT id to INTEGER PRIMARY KEY AUTOINCREMENT while preserving all data and supersedes_id links.
  sqlite.transaction(() => {
    // SAFETY: Query selects rows from memories table.
    const legacyRows = sqlite
      .prepare(
        "SELECT id, title, content, tags, source, supersedes_id, created_at, updated_at FROM memories ORDER BY created_at ASC",
      )
      .all() as Array<{
      id: string;
      title: string;
      content: string;
      tags: string | null;
      source: string;
      supersedes_id: string | null;
      created_at: string;
      updated_at: string;
    }>;

    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS memories_migration_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT,
        source TEXT NOT NULL,
        supersedes_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    const insertStmt = sqlite.prepare(
      "INSERT INTO memories_migration_new (title, content, tags, source, supersedes_id, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?)",
    );
    const legacyToNewId = new Map<string, number>();

    for (const row of legacyRows) {
      const res = insertStmt.run(
        row.title,
        row.content,
        row.tags,
        row.source,
        row.created_at,
        row.updated_at,
      );
      legacyToNewId.set(row.id, Number(res.lastInsertRowid));
    }

    const updateSupersedesStmt = sqlite.prepare(
      "UPDATE memories_migration_new SET supersedes_id = ? WHERE id = ?",
    );
    for (const row of legacyRows) {
      if (row.supersedes_id && legacyToNewId.has(row.supersedes_id)) {
        const newId = legacyToNewId.get(row.id);
        const newSupersedesId = legacyToNewId.get(row.supersedes_id);
        if (newId !== undefined && newSupersedesId !== undefined) {
          updateSupersedesStmt.run(newSupersedesId, newId);
        }
      }
    }

    sqlite.exec(`
      DROP TABLE memories;
      ALTER TABLE memories_migration_new RENAME TO memories;
      CREATE INDEX IF NOT EXISTS idx_memories_title ON memories(title);
      CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
    `);
  })();
}

function migrateQueryLogsTable(sqlite: ReturnType<typeof createNativeDatabase>) {
  // SAFETY: Query counts table occurrences in sqlite_master.
  const tableExists =
    (
      sqlite
        .prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name='query_logs'")
        .get() as { c: number }
    ).c > 0;
  if (!tableExists) return;

  // SAFETY: PRAGMA table_info returns table columns info.
  const info = sqlite.prepare("PRAGMA table_info(query_logs)").all() as Array<{
    name: string;
    type: string;
  }>;
  const idCol = info.find((c) => c.name === "id");
  if (!idCol || idCol.type.toUpperCase().includes("INT")) {
    return; // Already integer primary key
  }

  sqlite.transaction(() => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS query_logs_migration_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'hybrid',
        result_count INTEGER NOT NULL DEFAULT 0,
        tokens_returned INTEGER NOT NULL DEFAULT 0,
        tokens_saved INTEGER NOT NULL DEFAULT 0,
        files_scanned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO query_logs_migration_new (query, mode, result_count, tokens_returned, tokens_saved, files_scanned, created_at)
      SELECT query, coalesce(mode, 'hybrid'), coalesce(result_count, 0), coalesce(tokens_returned, 0), coalesce(tokens_saved, 0), coalesce(files_scanned, 0), created_at FROM query_logs ORDER BY created_at ASC;
      DROP TABLE query_logs;
      ALTER TABLE query_logs_migration_new RENAME TO query_logs;
      CREATE INDEX IF NOT EXISTS idx_query_logs_created ON query_logs(created_at);
    `);
  })();
}

function migrateRunsTables(sqlite: ReturnType<typeof createNativeDatabase>) {
  // Index runs
  // SAFETY: Query counts table occurrences in sqlite_master.
  const indexRunsExists =
    (
      sqlite
        .prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name='index_runs'")
        .get() as { c: number }
    ).c > 0;
  if (indexRunsExists) {
    // SAFETY: PRAGMA table_info returns table columns info.
    const info = sqlite.prepare("PRAGMA table_info(index_runs)").all() as Array<{
      name: string;
      type: string;
    }>;
    const idCol = info.find((c) => c.name === "id");
    if (idCol && !idCol.type.toUpperCase().includes("INT")) {
      sqlite.transaction(() => {
        sqlite.exec(`
          CREATE TABLE IF NOT EXISTS index_runs_migration_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mode TEXT NOT NULL,
            status TEXT NOT NULL,
            files_scanned INTEGER NOT NULL DEFAULT 0,
            files_updated INTEGER NOT NULL DEFAULT 0,
            chunks_written INTEGER NOT NULL DEFAULT 0,
            embeddings_written INTEGER NOT NULL DEFAULT 0,
            error_message TEXT,
            stats TEXT,
            started_at TEXT NOT NULL DEFAULT (datetime('now')),
            finished_at TEXT
          );
          INSERT INTO index_runs_migration_new (mode, status, files_scanned, files_updated, chunks_written, embeddings_written, error_message, stats, started_at, finished_at)
          SELECT mode, status, coalesce(files_scanned, 0), coalesce(files_updated, 0), coalesce(chunks_written, 0), coalesce(embeddings_written, 0), error_message, stats, started_at, finished_at FROM index_runs ORDER BY started_at ASC;
          DROP TABLE index_runs;
          ALTER TABLE index_runs_migration_new RENAME TO index_runs;
          CREATE INDEX IF NOT EXISTS idx_index_runs_started ON index_runs(started_at);
        `);
      })();
    }
  }

  // Graph runs
  // SAFETY: Query counts table occurrences in sqlite_master.
  const graphRunsExists =
    (
      sqlite
        .prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name='graph_runs'")
        .get() as { c: number }
    ).c > 0;
  if (graphRunsExists) {
    // SAFETY: PRAGMA table_info returns table columns info.
    const info = sqlite.prepare("PRAGMA table_info(graph_runs)").all() as Array<{
      name: string;
      type: string;
    }>;
    const idCol = info.find((c) => c.name === "id");
    if (idCol && !idCol.type.toUpperCase().includes("INT")) {
      sqlite.transaction(() => {
        sqlite.exec(`
          CREATE TABLE IF NOT EXISTS graph_runs_migration_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mode TEXT NOT NULL,
            status TEXT NOT NULL,
            nodes_created INTEGER NOT NULL DEFAULT 0,
            edges_created INTEGER NOT NULL DEFAULT 0,
            error_message TEXT,
            stats TEXT,
            started_at TEXT NOT NULL DEFAULT (datetime('now')),
            finished_at TEXT
          );
          INSERT INTO graph_runs_migration_new (mode, status, nodes_created, edges_created, error_message, stats, started_at, finished_at)
          SELECT mode, status, coalesce(nodes_created, 0), coalesce(edges_created, 0), error_message, stats, started_at, finished_at FROM graph_runs ORDER BY started_at ASC;
          DROP TABLE graph_runs;
          ALTER TABLE graph_runs_migration_new RENAME TO graph_runs;
          CREATE INDEX IF NOT EXISTS idx_graph_runs_started ON graph_runs(started_at);
        `);
      })();
    }
  }
}

function getWorkspaceTableDefinitions(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      embedding BLOB NOT NULL,
      input_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS graph_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      label TEXT NOT NULL,
      ref_id INTEGER,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS graph_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_node_id INTEGER NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
      to_node_id INTEGER NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      weight INTEGER NOT NULL DEFAULT 1,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS index_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT NOT NULL,
      mode TEXT NOT NULL,
      result_count INTEGER NOT NULL DEFAULT 0,
      tokens_returned INTEGER NOT NULL DEFAULT 0,
      tokens_saved INTEGER NOT NULL DEFAULT 0,
      files_scanned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    `CREATE TABLE IF NOT EXISTS parsed_documents (
      document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
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
