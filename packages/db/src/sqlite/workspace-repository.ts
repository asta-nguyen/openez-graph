import crypto from "node:crypto";

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
import type { NativeDatabase, StreamTimestampHolder } from "./shared-types";
import type { WorkspaceQueryMetrics, WorkspaceRepository } from "./types";
import { getWorkspaceDb, getWorkspaceNativeDb } from "./workspace-db";

function getNativeWorkspaceDb(rootPath: string): {
  db: ReturnType<typeof getWorkspaceDb>;
  native: NativeDatabase;
} {
  const db = getWorkspaceDb(rootPath);
  const native = getWorkspaceNativeDb(rootPath);
  return { db, native };
}

export function createWorkspaceRepository(rootPath: string): WorkspaceRepository {
  const { native } = getNativeWorkspaceDb(rootPath);

  // Legacy TEXT-embedding DBs intentionally lack the
  // idx_embeddings_chunk_provider_model unique index (migrateEmbeddingDedup
  // skips it for TEXT columns), so ON CONFLICT(chunk_id, provider, model)
  // would fail at prepare() time. Detect once and pick the right SQL.
  const hasEmbeddingUniqueIdx =
    (
      native
        .prepare(
          "SELECT count(*) as c FROM sqlite_master WHERE type='index' AND name='idx_embeddings_chunk_provider_model'",
        )
        .get() as { c: number }
    ).c > 0;

  // ── Cached prepared statements (prepared once, reused thousands of times) ──
  const stmts: DocumentStmts & ChunkStmts & GraphStmts & FtsStmts & EmbeddingStmts = {
    docByPath: native.prepare("SELECT * FROM documents WHERE path = ?"),
    docById: native.prepare("SELECT * FROM documents WHERE id = ?"),
    insertDoc: native.prepare(
      "INSERT INTO documents (id, path, absolute_path, kind, language, content_hash, size_bytes, mtime_ms, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    chunksByDoc: native.prepare("SELECT * FROM chunks WHERE document_id = ? ORDER BY chunk_index"),
    insertChunk: native.prepare(
      "INSERT INTO chunks (id, document_id, chunk_index, heading, content, token_count, content_hash, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    deleteChunksByDoc: native.prepare("DELETE FROM chunks WHERE document_id = ?"),
    nodeByTypeLabel: native.prepare("SELECT * FROM graph_nodes WHERE type = ? AND label = ?"),
    nodeByTypeLabelRef: native.prepare(
      "SELECT * FROM graph_nodes WHERE type = ? AND label = ? AND ref_id = ?",
    ),
    insertNode: native.prepare(
      "INSERT INTO graph_nodes (id, type, label, ref_id, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ),
    // Single-query upsert for non-symbol nodes (type, label is unique via partial index)
    upsertNodeByTypeLabel: native.prepare(
      `INSERT INTO graph_nodes (id, type, label, ref_id, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(type, label) WHERE type != 'symbol' DO UPDATE SET ref_id = COALESCE(excluded.ref_id, graph_nodes.ref_id), metadata = excluded.metadata, updated_at = excluded.updated_at
       RETURNING id`,
    ),
    updateNode: native.prepare(
      "UPDATE graph_nodes SET ref_id = ?, metadata = ?, updated_at = ? WHERE id = ?",
    ),
    deleteNodesByRefId: native.prepare(
      "DELETE FROM graph_nodes WHERE ref_id = ? OR ref_id IN (SELECT id FROM chunks WHERE document_id = ?)",
    ),
    insertEdge: native.prepare(
      `INSERT INTO graph_edges (id, from_node_id, to_node_id, type, weight, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(from_node_id, to_node_id, type) DO NOTHING`,
    ),
    insertEmbedding: native.prepare(
      hasEmbeddingUniqueIdx
        ? `INSERT INTO embeddings (id, chunk_id, provider, model, dimensions, embedding, input_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(chunk_id, provider, model) DO UPDATE SET
             dimensions = excluded.dimensions,
             embedding = excluded.embedding,
             input_hash = excluded.input_hash,
             created_at = excluded.created_at`
        : `INSERT INTO embeddings (id, chunk_id, provider, model, dimensions, embedding, input_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    insertFtsRow: native.prepare(
      "INSERT INTO chunks_fts (chunk_id, path, heading, language, search_text) VALUES (?, ?, ?, ?, ?)",
    ),
  };

  const streamNow: StreamTimestampHolder = { value: new Date().toISOString() };

  const documentOps = createDocumentOps(native, stmts, streamNow);

  const getMeta = (key: string): string | null => {
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
  const memoryOps = createMemoryOps(native, stmts);

  return {
    rootPath,
    ...documentOps,
    ...graphOps,
    ...ftsOps,
    ...embeddingOps,
    ...memoryOps,

    // ── Index Run Operations ──

    async createIndexRun(input) {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      native
        .prepare(
          "INSERT INTO index_runs (id, mode, status, files_scanned, files_updated, chunks_written, embeddings_written, started_at) VALUES (?, ?, 'running', 0, 0, 0, 0, ?)",
        )
        .run(id, input.mode, now);
      return id;
    },

    async completeIndexRun(id, updates) {
      const sets: string[] = ["finished_at = ?"];
      const params: unknown[] = [new Date().toISOString()];
      if (updates.status !== undefined) {
        sets.push("status = ?");
        params.push(updates.status);
      }
      if (updates.filesScanned !== undefined) {
        sets.push("files_scanned = ?");
        params.push(updates.filesScanned);
      }
      if (updates.filesUpdated !== undefined) {
        sets.push("files_updated = ?");
        params.push(updates.filesUpdated);
      }
      if (updates.chunksWritten !== undefined) {
        sets.push("chunks_written = ?");
        params.push(updates.chunksWritten);
      }
      if (updates.embeddingsWritten !== undefined) {
        sets.push("embeddings_written = ?");
        params.push(updates.embeddingsWritten);
      }
      if (updates.errorMessage !== undefined) {
        sets.push("error_message = ?");
        params.push(updates.errorMessage);
      }
      params.push(id);
      native.prepare(`UPDATE index_runs SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    },

    // ── Query Log Operations ──

    async insertQueryLog(input) {
      const id = crypto.randomUUID();
      native
        .prepare(
          "INSERT INTO query_logs (id, query, mode, result_count, tokens_returned, tokens_saved, files_scanned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          input.query,
          input.mode,
          input.resultCount,
          input.tokensReturned ?? 0,
          input.tokensSaved ?? 0,
          input.filesScanned ?? 0,
          new Date().toISOString(),
        );
      return id;
    },

    async getQueryMetrics(recentLimit = 10): Promise<WorkspaceQueryMetrics> {
      const totals = native
        .prepare(
          `SELECT
          COUNT(*) AS totalQueries,
          COALESCE(SUM(tokens_returned), 0) AS totalTokensReturned,
          COALESCE(SUM(tokens_saved), 0) AS totalTokensSaved,
          COALESCE(SUM(files_scanned), 0) AS totalFilesScanned
         FROM query_logs`,
        )
        .get() as Record<string, number> | undefined;

      const recentRows = native
        .prepare(
          `SELECT id, query, mode, result_count, tokens_returned, tokens_saved, files_scanned, created_at
         FROM query_logs
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
        )
        .all(recentLimit) as Array<Record<string, unknown>>;

      const totalQueries = Number(totals?.totalQueries ?? 0);
      const totalTokensReturned = Number(totals?.totalTokensReturned ?? 0);
      const totalTokensSaved = Number(totals?.totalTokensSaved ?? 0);
      const totalFilesScanned = Number(totals?.totalFilesScanned ?? 0);
      const denominator = totalTokensSaved + totalTokensReturned;
      const savingsPercentage = denominator > 0 ? (totalTokensSaved / denominator) * 100 : 0;

      return {
        totalQueries,
        totalTokensReturned,
        totalTokensSaved,
        totalFilesScanned,
        avgTokensPerQuery: totalQueries > 0 ? Math.round(totalTokensReturned / totalQueries) : 0,
        savingsPercentage: Number(savingsPercentage.toFixed(1)),
        recentQueries: recentRows.map((row) => ({
          id: String(row.id),
          query: String(row.query),
          mode: String(row.mode),
          resultCount: Number(row.result_count ?? 0),
          tokensReturned: Number(row.tokens_returned ?? 0),
          tokensSaved: Number(row.tokens_saved ?? 0),
          filesScanned: Number(row.files_scanned ?? 0),
          createdAt: String(row.created_at),
        })),
      };
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
        return native.prepare(sqlQuery).all(...params) as Array<Record<string, unknown>>;
      }
      return native.prepare(sqlQuery).all() as Array<Record<string, unknown>>;
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
      const row = native.prepare("SELECT value FROM index_meta WHERE key = ?").get(key) as
        | { value: string }
        | undefined;
      return row?.value ?? null;
    },
  };
}
