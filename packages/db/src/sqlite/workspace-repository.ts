import { eq } from "drizzle-orm";

import type { ChunkStmts } from "./chunk-repository";
import { createDocumentOps } from "./document-repository";
import type { DocumentStmts } from "./document-repository";
import { createEmbeddingOps } from "./embedding-repository";
import type { EmbeddingStmts } from "./embedding-repository";
import { createFtsOps } from "./fts-repository";
import type { FtsStmts } from "./fts-repository";
import { createGraphOps } from "./graph-repository";
import type { GraphStmts } from "./graph-repository";
import { createMemoryOps } from "./memory-repository";
import * as schema from "./schema";
import type { NativeDatabase, StreamTimestampHolder } from "./shared-types";
import type { WorkspaceRepository } from "./types";
import { getWorkspaceDb, getWorkspaceNativeDb } from "./workspace-db";

interface WorkspaceDbPair {
  db: ReturnType<typeof getWorkspaceDb>;
  native: NativeDatabase;
}

type RawSqlValue = string | number | boolean | Uint8Array | null;
type RawSqlRow = Record<string, RawSqlValue>;

function getNativeWorkspaceDb(rootPath: string): WorkspaceDbPair {
  const db = getWorkspaceDb(rootPath);
  const native = getWorkspaceNativeDb(rootPath);
  return { db, native };
}

export function createWorkspaceRepository(rootPath: string): WorkspaceRepository {
  const { db, native } = getNativeWorkspaceDb(rootPath);

  // Legacy TEXT-embedding DBs intentionally lack the
  // idx_embeddings_chunk_provider_model unique index (migrateEmbeddingDedup
  // skips it for TEXT columns), so ON CONFLICT(chunk_id, provider, model)
  // would fail at prepare() time. Detect once and pick the right SQL.
  // SAFETY: Query selects count(*) from sqlite_master to check index existence.
  const countRow = native
    .prepare(
      "SELECT count(*) as c FROM sqlite_master WHERE type='index' AND name='idx_embeddings_chunk_provider_model'",
    )
    .get() as { c: number };
  const hasEmbeddingUniqueIdx = countRow.c > 0;

  // ── Cached prepared statements (prepared once, reused thousands of times) ──
  const stmts: DocumentStmts & ChunkStmts & GraphStmts & FtsStmts & EmbeddingStmts = {
    docByPath: native.prepare("SELECT * FROM documents WHERE path = ?"),
    docById: native.prepare("SELECT * FROM documents WHERE id = ?"),
    insertDoc: native.prepare(
      "INSERT INTO documents (path, absolute_path, kind, language, content_hash, size_bytes, mtime_ms, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    insertDocWithId: native.prepare(
      "INSERT INTO documents (id, path, absolute_path, kind, language, content_hash, size_bytes, mtime_ms, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    chunksByDoc: native.prepare("SELECT * FROM chunks WHERE document_id = ? ORDER BY chunk_index"),
    insertChunk: native.prepare(
      "INSERT INTO chunks (document_id, chunk_index, heading, content, token_count, content_hash, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    insertChunkWithId: native.prepare(
      "INSERT INTO chunks (id, document_id, chunk_index, heading, content, token_count, content_hash, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    deleteChunksByDoc: native.prepare("DELETE FROM chunks WHERE document_id = ?"),
    nodeByTypeLabel: native.prepare("SELECT * FROM graph_nodes WHERE type = ? AND label = ?"),
    nodeByTypeLabelRef: native.prepare(
      "SELECT * FROM graph_nodes WHERE type = ? AND label = ? AND ref_id = ?",
    ),
    insertNode: native.prepare(
      "INSERT INTO graph_nodes (type, label, ref_id, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ),
    insertNodeWithId: native.prepare(
      "INSERT INTO graph_nodes (id, type, label, ref_id, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ),
    // Single-query upsert for non-symbol nodes (type, label is unique via partial index)
    upsertNodeByTypeLabel: native.prepare(
      `INSERT INTO graph_nodes (type, label, ref_id, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(type, label) WHERE type != 'symbol' DO UPDATE SET ref_id = COALESCE(excluded.ref_id, graph_nodes.ref_id), metadata = excluded.metadata, updated_at = excluded.updated_at
       RETURNING id, label`,
    ),
    updateNode: native.prepare(
      "UPDATE graph_nodes SET ref_id = ?, metadata = ?, updated_at = ? WHERE id = ?",
    ),
    deleteNodesByRefId: native.prepare(
      "DELETE FROM graph_nodes WHERE ref_id = ? OR ref_id IN (SELECT id FROM chunks WHERE document_id = ?)",
    ),
    insertEdge: native.prepare(
      `INSERT INTO graph_edges (from_node_id, to_node_id, type, weight, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(from_node_id, to_node_id, type) DO NOTHING`,
    ),
    insertEdgeWithId: native.prepare(
      `INSERT INTO graph_edges (id, from_node_id, to_node_id, type, weight, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(from_node_id, to_node_id, type) DO NOTHING`,
    ),
    insertEmbedding: native.prepare(
      hasEmbeddingUniqueIdx
        ? `INSERT INTO embeddings (chunk_id, provider, model, dimensions, embedding, input_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(chunk_id, provider, model) DO UPDATE SET
             dimensions = excluded.dimensions,
             embedding = excluded.embedding,
             input_hash = excluded.input_hash,
             created_at = excluded.created_at`
        : `INSERT INTO embeddings (chunk_id, provider, model, dimensions, embedding, input_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    insertFtsRow: native.prepare(
      "INSERT INTO chunks_fts (chunk_id, path, heading, language, search_text) VALUES (?, ?, ?, ?, ?)",
    ),
  };

  const streamNow: StreamTimestampHolder = { value: new Date().toISOString() };

  const documentOps = createDocumentOps(db, native, stmts, streamNow);

  const getMeta = (key: string): string | null => {
    // SAFETY: index_meta table returns { value: string } when row exists.
    const row = native.prepare("SELECT value FROM index_meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  };
  const setMeta = (key: string, value: string): void => {
    native.prepare("INSERT OR REPLACE INTO index_meta (key, value) VALUES (?, ?)").run(key, value);
  };

  const graphOps = createGraphOps(native, stmts, streamNow);
  const ftsOps = createFtsOps(native, stmts, { getMeta, setMeta });
  const embeddingOps = createEmbeddingOps(native, stmts);
  const memoryOps = createMemoryOps(db, native, stmts);

  return {
    rootPath,
    ...documentOps,
    ...graphOps,
    ...ftsOps,
    ...embeddingOps,
    ...memoryOps,

    // ── Index Run Operations ──

    async createIndexRun(input): Promise<number> {
      const now = new Date().toISOString();
      const res = db
        .insert(schema.indexRuns)
        .values({
          mode: input.mode,
          status: "running",
          filesScanned: 0,
          filesUpdated: 0,
          chunksWritten: 0,
          embeddingsWritten: 0,
          startedAt: now,
        })
        .returning({ id: schema.indexRuns.id })
        .get();
      return res.id;
    },

    async completeIndexRun(id, updates) {
      const setValues: Partial<typeof schema.indexRuns.$inferInsert> = {
        finishedAt: new Date().toISOString(),
      };
      if (updates.status !== undefined) {
        setValues.status = updates.status;
      }
      if (updates.filesScanned !== undefined) {
        setValues.filesScanned = updates.filesScanned;
      }
      if (updates.filesUpdated !== undefined) {
        setValues.filesUpdated = updates.filesUpdated;
      }
      if (updates.chunksWritten !== undefined) {
        setValues.chunksWritten = updates.chunksWritten;
      }
      if (updates.embeddingsWritten !== undefined) {
        setValues.embeddingsWritten = updates.embeddingsWritten;
      }
      if (updates.errorMessage !== undefined) {
        setValues.errorMessage = updates.errorMessage;
      }
      db.update(schema.indexRuns).set(setValues).where(eq(schema.indexRuns.id, id)).run();
    },

    // ── Query Log Operations ──

    async insertQueryLog(input): Promise<number> {
      const res = db
        .insert(schema.queryLogs)
        .values({
          query: input.query,
          mode: input.mode,
          resultCount: input.resultCount,
          tokensReturned: input.tokensReturned ?? 0,
          tokensSaved: input.tokensSaved ?? 0,
          filesScanned: input.filesScanned ?? 0,
          createdAt: new Date().toISOString(),
        })
        .returning({ id: schema.queryLogs.id })
        .get();
      return res.id;
    },

    // ── Raw SQL queries ──

    async executeRaw(sqlQuery: string, params?: unknown[]) {
      if (params) {
        return native.prepare(sqlQuery).run(...params);
      }
      return native.prepare(sqlQuery).run();
    },

    async queryRaw(sqlQuery: string, params?: unknown[]) {
      if (params) {
        // SAFETY: Raw query interface returns rows matching generic RawSqlRow map.
        return native.prepare(sqlQuery).all(...params) as Array<RawSqlRow>;
      }
      // SAFETY: Raw query interface returns rows matching generic RawSqlRow map.
      return native.prepare(sqlQuery).all() as Array<RawSqlRow>;
    },

    async transaction<T>(fn: () => T | Promise<T>): Promise<T> {
      native.exec("BEGIN");
      try {
        const result = await fn();
        native.exec("COMMIT");
        return result;
      } catch (error) {
        native.exec("ROLLBACK");
        throw error;
      }
    },

    setOptimizedWriteMode(enabled: boolean): void {
      if (enabled) {
        // ponytail: synchronous=OFF trades power-loss durability for bulk-index speed; restore NORMAL below.
        // Keep WAL journal mode so a power loss during indexing stays recoverable.
        // NOTE: locking_mode=EXCLUSIVE and mmap_size are intentionally omitted —
        // they caused SQLITE_BUSY under bun:sqlite (the old better-sqlite3 test
        // adapter skipped them). synchronous=OFF + WAL + temp_store=MEMORY are
        // the main bulk-indexing performance gains.
        native.pragma("journal_mode = WAL");
        native.pragma("synchronous = OFF");
        native.pragma("cache_size = -65536");
        native.pragma("temp_store = MEMORY");
      } else {
        // Switch back to WAL + NORMAL for query-safe access.
        // Restore synchronous first, then re-assert WAL (migrates databases
        // left in MEMORY by the old code), and checkpoint so the WAL doesn't
        // grow unbounded.
        native.pragma("synchronous = NORMAL");
        native.pragma("journal_mode = WAL");
        native.exec("PRAGMA wal_checkpoint(PASSIVE)");
        native.pragma("cache_size = -2000");
        native.pragma("temp_store = DEFAULT");
      }
    },

    walCheckpoint(): void {
      native.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    },

    setMeta(key: string, value: string): void {
      native
        .prepare("INSERT OR REPLACE INTO index_meta (key, value) VALUES (?, ?)")
        .run(key, value);
    },

    getMeta(key: string): string | null {
      // SAFETY: index_meta table returns { value: string } when row exists.
      const row = native.prepare("SELECT value FROM index_meta WHERE key = ?").get(key) as
        | { value: string }
        | undefined;
      return row?.value ?? null;
    },
  };
}
