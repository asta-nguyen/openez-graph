import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { eq } from "drizzle-orm";

import { createDocumentOps } from "./document-repository";
import { createGraphOps } from "./graph-repository";
import { getRegistryDb, getRegistryNativeDb } from "./registry-db";
import * as schema from "./schema";
import { decryptValue, encryptValue, isSensitiveKey } from "./secure-storage";
import type { NativeDatabase, StreamTimestampHolder } from "./shared-types";
import type { RegistryRepository, RegistryWorkspace, WorkspaceRepository } from "./types";
import { getWorkspaceDb, getWorkspaceNativeDb } from "./workspace-db";

function normalizeRootPath(rootPath: string): string {
  const resolved = path.resolve(rootPath.trim());
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function slugifyWorkspaceSegment(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "workspace";
}

function displayNameForSuffix(baseName: string, suffix: number): string {
  return suffix <= 0 ? baseName : `${baseName} (${suffix + 1})`;
}

export function createRegistryRepository(): RegistryRepository {
  const db = getRegistryDb();
  const native = getRegistryNativeDb();

  return {
    async listWorkspaces(): Promise<RegistryWorkspace[]> {
      const rows = db.select().from(schema.workspaces).all();
      return rows.map(mapWorkspaceRow).sort(compareWorkspaces);
    },

    async getWorkspace(id: string): Promise<RegistryWorkspace | null> {
      const row = db.select().from(schema.workspaces).where(eq(schema.workspaces.id, id)).get();
      return row ? mapWorkspaceRow(row) : null;
    },

    async getWorkspaceByPath(rootPath: string): Promise<RegistryWorkspace | null> {
      const normalizedRootPath = normalizeRootPath(rootPath);
      const row = db
        .select()
        .from(schema.workspaces)
        .where(eq(schema.workspaces.rootPath, normalizedRootPath))
        .get();
      if (row) return mapWorkspaceRow(row);

      const allRows = db.select().from(schema.workspaces).all();
      const legacyRow = allRows.find(
        (candidate) => normalizeRootPath(candidate.rootPath) === normalizedRootPath,
      );
      return legacyRow ? mapWorkspaceRow(legacyRow) : null;
    },

    async ensureWorkspace(input): Promise<RegistryWorkspace> {
      const normalizedRootPath = normalizeRootPath(input.rootPath);
      const existing = await this.getWorkspaceByPath(normalizedRootPath);
      if (existing) {
        return existing;
      }

      const requestedName = (
        input.name?.trim() ||
        normalizeRootPath(normalizedRootPath).split(/[\\/]/).pop() ||
        "workspace"
      ).trim();
      const baseId = slugifyWorkspaceSegment(requestedName);
      const allWorkspaces = await this.listWorkspaces();
      const takenIds = new Set(allWorkspaces.map((workspace) => workspace.id));
      const takenNames = new Set(allWorkspaces.map((workspace) => workspace.name));

      let suffix = 0;
      let nextId = baseId;
      let nextName = requestedName;

      while (takenIds.has(nextId) || takenNames.has(nextName)) {
        suffix += 1;
        nextId = `${baseId}-${suffix + 1}`;
        nextName = displayNameForSuffix(requestedName, suffix);
      }

      return this.createWorkspace({
        id: nextId,
        name: nextName,
        rootPath: normalizedRootPath,
        includeGlobs: input.includeGlobs,
        excludeGlobs: input.excludeGlobs,
      });
    },

    async createWorkspace(input: {
      id: string;
      name: string;
      rootPath: string;
      includeGlobs?: string;
      excludeGlobs?: string;
    }): Promise<RegistryWorkspace> {
      const normalizedRootPath = normalizeRootPath(input.rootPath);
      const existing = await this.getWorkspaceByPath(normalizedRootPath);
      if (existing) {
        return existing;
      }

      const now = new Date().toISOString();
      native
        .prepare(
          `INSERT INTO workspaces (id, name, root_path, include_globs, exclude_globs, status, indexing_status, graph_status, document_count, chunk_count, node_count, edge_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'pending', 'pending', 'pending', 0, 0, 0, 0, ?, ?)`,
        )
        .run(
          input.id,
          input.name,
          normalizedRootPath,
          input.includeGlobs ?? "",
          input.excludeGlobs ?? "",
          now,
          now,
        );

      return (await this.getWorkspace(input.id))!;
    },

    async updateWorkspace(
      id: string,
      updates: Partial<
        Pick<
          RegistryWorkspace,
          | "status"
          | "indexingStatus"
          | "graphStatus"
          | "lastIndexedAt"
          | "lastGraphBuiltAt"
          | "documentCount"
          | "chunkCount"
          | "nodeCount"
          | "edgeCount"
          | "lastError"
        >
      >,
    ): Promise<void> {
      const sets: string[] = ["updated_at = ?"];
      const params: unknown[] = [new Date().toISOString()];

      if (updates.status !== undefined) {
        sets.push("status = ?");
        params.push(updates.status);
      }
      if (updates.indexingStatus !== undefined) {
        sets.push("indexing_status = ?");
        params.push(updates.indexingStatus);
      }
      if (updates.graphStatus !== undefined) {
        sets.push("graph_status = ?");
        params.push(updates.graphStatus);
      }
      if (updates.lastIndexedAt !== undefined) {
        sets.push("last_indexed_at = ?");
        params.push(updates.lastIndexedAt);
      }
      if (updates.lastGraphBuiltAt !== undefined) {
        sets.push("last_graph_built_at = ?");
        params.push(updates.lastGraphBuiltAt);
      }
      if (updates.documentCount !== undefined) {
        sets.push("document_count = ?");
        params.push(updates.documentCount);
      }
      if (updates.chunkCount !== undefined) {
        sets.push("chunk_count = ?");
        params.push(updates.chunkCount);
      }
      if (updates.nodeCount !== undefined) {
        sets.push("node_count = ?");
        params.push(updates.nodeCount);
      }
      if (updates.edgeCount !== undefined) {
        sets.push("edge_count = ?");
        params.push(updates.edgeCount);
      }
      if (updates.lastError !== undefined) {
        sets.push("last_error = ?");
        params.push(updates.lastError);
      }

      params.push(id);
      native.prepare(`UPDATE workspaces SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    },

    async deleteWorkspace(id: string): Promise<void> {
      db.delete(schema.workspaces).where(eq(schema.workspaces.id, id)).run();
    },

    async setPinned(id: string, pinned: boolean): Promise<void> {
      if (pinned) {
        // Assign a monotonic pin_order so ordering is deterministic even when
        // multiple workspaces are pinned within the same millisecond.
        const maxRow = native
          .prepare("SELECT MAX(pin_order) AS max_order FROM workspaces WHERE pin_order IS NOT NULL")
          .get() as { max_order: number | null } | undefined;
        const nextOrder = (maxRow?.max_order ?? 0) + 1;
        native
          .prepare("UPDATE workspaces SET pinned_at = ?, pin_order = ? WHERE id = ?")
          .run(new Date().toISOString(), nextOrder, id);
      } else {
        native
          .prepare("UPDATE workspaces SET pinned_at = NULL, pin_order = NULL WHERE id = ?")
          .run(id);
      }
    },

    async getSetting(key: string): Promise<string | null> {
      const row = native.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
        | { value: string }
        | undefined;
      if (!row) return null;
      if (isSensitiveKey(key)) {
        try {
          return decryptValue(row.value);
        } catch {
          return null;
        }
      }
      return row.value;
    },

    async setSetting(key: string, value: string): Promise<void> {
      const stored = isSensitiveKey(key) ? encryptValue(value) : value;
      const now = new Date().toISOString();
      native
        .prepare(
          `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(key, stored, now);
    },

    async deleteSetting(key: string): Promise<void> {
      native.prepare("DELETE FROM settings WHERE key = ?").run(key);
    },

    async getAllSettings(): Promise<Record<string, string>> {
      const rows = native.prepare("SELECT key, value FROM settings").all() as Array<{
        key: string;
        value: string;
      }>;
      const result: Record<string, string> = {};
      for (const row of rows) {
        if (isSensitiveKey(row.key)) {
          try {
            result[row.key] = decryptValue(row.value);
          } catch {
            // Skip undecryptable values
          }
        } else {
          result[row.key] = row.value;
        }
      }
      return result;
    },
  };
}

function mapWorkspaceRow(row: typeof schema.workspaces.$inferSelect): RegistryWorkspace {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.rootPath,
    includeGlobs: row.includeGlobs || "",
    excludeGlobs: row.excludeGlobs || "",
    status: row.status as RegistryWorkspace["status"],
    indexingStatus: row.indexingStatus as RegistryWorkspace["indexingStatus"],
    graphStatus: row.graphStatus as RegistryWorkspace["graphStatus"],
    lastIndexedAt: row.lastIndexedAt ?? undefined,
    lastGraphBuiltAt: row.lastGraphBuiltAt ?? undefined,
    documentCount: row.documentCount,
    chunkCount: row.chunkCount,
    nodeCount: row.nodeCount,
    edgeCount: row.edgeCount,
    lastError: row.lastError ?? undefined,
    pinnedAt: row.pinnedAt ?? undefined,
    pinOrder: row.pinOrder ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function compareWorkspaces(a: RegistryWorkspace, b: RegistryWorkspace): number {
  if (a.pinnedAt && !b.pinnedAt) return -1;
  if (!a.pinnedAt && b.pinnedAt) return 1;
  if (a.pinnedAt && b.pinnedAt) {
    // Use monotonic pin_order as the primary tiebreaker (deterministic
    // regardless of wall-clock resolution), then pinned_at as a fallback.
    const aOrder = a.pinOrder ?? -Infinity;
    const bOrder = b.pinOrder ?? -Infinity;
    if (aOrder !== bOrder) return bOrder - aOrder;
    if (a.pinnedAt !== b.pinnedAt) return b.pinnedAt.localeCompare(a.pinnedAt);
  }
  return b.createdAt.localeCompare(a.createdAt);
}

function getNativeWorkspaceDb(rootPath: string): {
  db: ReturnType<typeof getWorkspaceDb>;
  native: NativeDatabase;
} {
  const db = getWorkspaceDb(rootPath);
  const native = (db as unknown as { $client: NativeDatabase }).$client;
  return { db, native };
}

export function restoreFtsTriggerDefinitions(native: NativeDatabase): void {
  native.exec(`
    CREATE TRIGGER IF NOT EXISTS chunks_fts_insert AFTER INSERT ON chunks
    BEGIN
      INSERT INTO chunks_fts (chunk_id, path, heading, language, search_text)
      SELECT new.id, documents.path, coalesce(new.heading, ''),
        coalesce(documents.language, ''), substr(new.content, 1, 400)
      FROM documents WHERE documents.id = new.document_id;
    END;
  `);
  native.exec(`
    CREATE TRIGGER IF NOT EXISTS chunks_fts_delete AFTER DELETE ON chunks
    BEGIN
      DELETE FROM chunks_fts WHERE chunk_id = old.id;
    END;
  `);
  native.exec(`
    CREATE TRIGGER IF NOT EXISTS chunks_fts_update AFTER UPDATE ON chunks
    BEGIN
      DELETE FROM chunks_fts WHERE chunk_id = old.id;
      INSERT INTO chunks_fts (chunk_id, path, heading, language, search_text)
      SELECT new.id, documents.path, coalesce(new.heading, ''),
        coalesce(documents.language, ''), substr(new.content, 1, 400)
      FROM documents WHERE documents.id = new.document_id;
    END;
  `);
}

export function createWorkspaceRepository(rootPath: string): WorkspaceRepository {
  const { native } = getNativeWorkspaceDb(rootPath);

  // ── Cached prepared statements (prepared once, reused thousands of times) ──
  const stmts = {
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
      `INSERT INTO embeddings (id, chunk_id, provider, model, dimensions, embedding, input_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chunk_id, provider, model) DO UPDATE SET
         dimensions = excluded.dimensions,
         embedding = excluded.embedding,
         input_hash = excluded.input_hash,
         created_at = excluded.created_at`,
    ),
    insertFtsRow: native.prepare(
      "INSERT INTO chunks_fts (chunk_id, path, heading, language, search_text) VALUES (?, ?, ?, ?, ?)",
    ),
  };

  const streamNow: StreamTimestampHolder = { value: new Date().toISOString() };

  const documentOps = createDocumentOps(native, stmts, streamNow);

  // Meta helpers needed by ensureGraphBuilt (defined below, hoisted via closure).
  const getMeta = (key: string): string | null => {
    const row = native.prepare("SELECT value FROM index_meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  };
  const setMeta = (key: string, value: string): void => {
    native.prepare("INSERT OR REPLACE INTO index_meta (key, value) VALUES (?, ?)").run(key, value);
  };

  const graphOps = createGraphOps(native, stmts, streamNow, { getMeta, setMeta });

  return {
    rootPath,
    ...documentOps,
    ...graphOps,

    // ── Chunk Operations (FTS bulk insert) ──

    async bulkInsertFts(
      inputs: Array<{
        chunkId: string;
        path: string;
        heading: string | null;
        language: string | null;
        content: string;
        metadata: string;
      }>,
    ): Promise<void> {
      if (inputs.length === 0) return;
      const BATCH = 2000;
      for (let i = 0; i < inputs.length; i += BATCH) {
        const batch = inputs.slice(i, i + BATCH);
        const placeholders = batch.map(() => "(?, ?, ?, ?, ?)").join(",");
        const params: unknown[] = [];
        for (const item of batch) {
          const searchText = item.content.slice(0, 400);
          params.push(item.chunkId, item.path, item.heading ?? "", item.language ?? "", searchText);
        }
        native
          .prepare(
            `INSERT INTO chunks_fts (chunk_id, path, heading, language, search_text) VALUES ${placeholders}`,
          )
          .run(...params);
      }
    },

    // ── Embedding Operations ──

    async insertEmbeddings(inputs) {
      const now = new Date().toISOString();
      for (const input of inputs) {
        stmts.insertEmbedding.run(
          crypto.randomUUID(),
          input.chunkId,
          input.provider,
          input.model,
          input.dimensions,
          input.embedding,
          input.inputHash ?? null,
          now,
        );
      }
    },

    async deleteEmbeddingsByChunkIds(chunkIds: string[]) {
      if (chunkIds.length === 0) return;
      const placeholders = chunkIds.map(() => "?").join(",");
      native.prepare(`DELETE FROM embeddings WHERE chunk_id IN (${placeholders})`).run(...chunkIds);
    },

    // ── Full-Text Search ──

    async fullTextSearch(query: string, limit: number) {
      const ftsQuery = sanitizeFtsQuery(query);
      if (!ftsQuery) return [];

      this.ensureFtsReady();

      const rows = native
        .prepare(
          `SELECT
            chunks.id, chunks.content, chunks.heading, chunks.metadata,
            documents.path,
            bm25(chunks_fts, 0, 4, 3, 1.5, 2)
              * CASE
                  WHEN documents.path LIKE 'tests/%' OR documents.path LIKE '%/__tests__/%' OR documents.path GLOB '*.test.*' THEN 0.8
                  WHEN documents.kind = 'code' THEN 1.35
                  ELSE 1
                END AS bm25_score
           FROM chunks_fts
           INNER JOIN chunks ON chunks.id = chunks_fts.chunk_id
           INNER JOIN documents ON documents.id = chunks.document_id
           WHERE chunks_fts MATCH ?
           ORDER BY bm25_score ASC
           LIMIT ?`,
        )
        .all(ftsQuery, limit * 5) as Array<Record<string, unknown>>;

      const seenPaths = new Set<string>();
      return rows
        .map((row) => {
          const bm25 = Number(row.bm25_score ?? 0);
          // Convert bm25 (lower = better) to a 0-1 score (higher = better)
          const score = -bm25;
          return {
            id: String(row.id),
            path: String(row.path),
            content: String(row.content),
            score,
            heading: row.heading ? String(row.heading) : null,
            metadata: safeParseJson(String(row.metadata ?? ""), {}) as Record<string, unknown>,
          };
        })
        .filter((row) => {
          if (seenPaths.has(row.path)) return false;
          seenPaths.add(row.path);
          return true;
        })
        .slice(0, limit);
    },

    // ── Memory Operations ──

    async insertMemory(input) {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      native
        .prepare(
          "INSERT INTO memories (id, title, content, tags, source, supersedes_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          input.title,
          input.content,
          input.tags ?? "",
          input.source,
          input.supersedesId ?? null,
          now,
          now,
        );
      return id;
    },

    async getMemory(id) {
      const row = native.prepare("SELECT * FROM memories WHERE id = ?").get(id) as
        | Record<string, unknown>
        | undefined;
      return row ? mapMemoryRow(row) : null;
    },

    async searchMemories(query, limit) {
      const normalized = query.trim().toLowerCase();
      const terms = [...new Set(normalized.split(/\s+/).filter(Boolean))].slice(0, 8);
      if (terms.length === 0) return [];

      const clauses = terms.map(
        () =>
          "(lower(m.title) LIKE ? ESCAPE '\\' OR lower(m.content) LIKE ? ESCAPE '\\' OR lower(m.tags) LIKE ? ESCAPE '\\')",
      );
      const termParams = terms.flatMap((term) => {
        const pattern = `%${escapeLikePattern(term)}%`;
        return [pattern, pattern, pattern];
      });
      const phrasePattern = `%${escapeLikePattern(normalized)}%`;
      const rows = native
        .prepare(
          `SELECT m.*
         FROM memories m
         WHERE NOT EXISTS (SELECT 1 FROM memories newer WHERE newer.supersedes_id = m.id)
           AND ${clauses.join(" AND ")}
         ORDER BY CASE
           WHEN lower(m.title) = ? THEN 0
           WHEN lower(m.title) LIKE ? ESCAPE '\\' THEN 1
           ELSE 2
         END, m.updated_at DESC
         LIMIT ?`,
        )
        .all(...termParams, normalized, phrasePattern, limit) as Array<Record<string, unknown>>;
      return rows.map(mapMemoryRow);
    },

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

    dropFtsTriggers(): void {
      native.exec("DROP TRIGGER IF EXISTS chunks_fts_insert");
      native.exec("DROP TRIGGER IF EXISTS chunks_fts_delete");
      native.exec("DROP TRIGGER IF EXISTS chunks_fts_update");
    },

    dropNonUniqueIndexes(): void {
      native.exec("DROP INDEX IF EXISTS idx_chunks_document_id");
      native.exec("DROP INDEX IF EXISTS idx_chunks_content_hash");
      native.exec("DROP INDEX IF EXISTS idx_graph_nodes_type");
      native.exec("DROP INDEX IF EXISTS idx_graph_nodes_label");
      native.exec("DROP INDEX IF EXISTS idx_graph_edges_from");
      native.exec("DROP INDEX IF EXISTS idx_graph_edges_to");
      native.exec("DROP INDEX IF EXISTS idx_graph_edges_type");
      native.exec("DROP INDEX IF EXISTS idx_embeddings_chunk_id");
    },

    restoreNonUniqueIndexes(): void {
      native.exec("CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON chunks(document_id)");
      native.exec("CREATE INDEX IF NOT EXISTS idx_chunks_content_hash ON chunks(content_hash)");
      native.exec("CREATE INDEX IF NOT EXISTS idx_graph_nodes_type ON graph_nodes(type)");
      native.exec("CREATE INDEX IF NOT EXISTS idx_graph_nodes_label ON graph_nodes(label)");
      native.exec("CREATE INDEX IF NOT EXISTS idx_graph_edges_from ON graph_edges(from_node_id)");
      native.exec("CREATE INDEX IF NOT EXISTS idx_graph_edges_to ON graph_edges(to_node_id)");
      native.exec("CREATE INDEX IF NOT EXISTS idx_graph_edges_type ON graph_edges(type)");
      native.exec("CREATE INDEX IF NOT EXISTS idx_embeddings_chunk_id ON embeddings(chunk_id)");
    },

    insertFtsBatch(
      rows: Array<{
        chunkId: string;
        path: string;
        heading: string;
        language: string;
        searchText: string;
        content: string;
      }>,
    ): void {
      if (rows.length === 0) return;
      const BATCH = 500;
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        const placeholders = batch.map(() => "(?, ?, ?, ?, ?)").join(",");
        const params: unknown[] = [];
        for (const r of batch) {
          params.push(r.chunkId, r.path, r.heading, r.language, r.searchText);
        }
        native
          .prepare(
            `INSERT INTO chunks_fts (chunk_id, path, heading, language, search_text) VALUES ${placeholders}`,
          )
          .run(...params);
      }
    },

    streamFtsRow(input: {
      chunkId: string;
      path: string;
      heading: string;
      language: string;
      searchText: string;
      content: string;
    }): void {
      stmts.insertFtsRow.run(
        input.chunkId,
        input.path,
        input.heading,
        input.language,
        input.searchText,
        input.content,
      );
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

    ensureFtsReady(): void {
      if (this.getMeta("fts_backfill_pending") !== "1") return;
      native.exec("BEGIN IMMEDIATE");
      try {
        if (this.getMeta("fts_backfill_pending") !== "1") {
          native.exec("COMMIT");
          return;
        }
        // Clean up orphaned FTS rows
        native.exec("DELETE FROM chunks_fts WHERE chunk_id NOT IN (SELECT id FROM chunks)");

        // Backfill missing FTS entries via SQL (content is uncompressed TEXT)
        native.exec(`
          INSERT INTO chunks_fts (chunk_id, path, heading, language, search_text)
          SELECT c.id, d.path, coalesce(c.heading, ''),
            coalesce(d.language, ''), substr(c.content, 1, 400)
          FROM chunks c
          INNER JOIN documents d ON d.id = c.document_id
          LEFT JOIN chunks_fts f ON f.chunk_id = c.id
          WHERE f.chunk_id IS NULL;
        `);

        restoreFtsTriggerDefinitions(native);
        this.setMeta("fts_backfill_pending", "0");
        native.exec("COMMIT");
      } catch (error) {
        try {
          native.exec("ROLLBACK");
        } catch {}
        throw error;
      }
    },

    restoreFtsTriggers(): void {
      // Remove orphaned FTS entries
      native.exec("DELETE FROM chunks_fts WHERE chunk_id NOT IN (SELECT id FROM chunks)");

      // Backfill missing FTS entries via SQL (content is uncompressed TEXT)
      native.exec(`
        INSERT INTO chunks_fts (chunk_id, path, heading, language, search_text)
        SELECT c.id, d.path, coalesce(c.heading, ''),
          coalesce(d.language, ''), substr(c.content, 1, 400)
        FROM chunks c
        INNER JOIN documents d ON d.id = c.document_id
        LEFT JOIN chunks_fts f ON f.chunk_id = c.id
        WHERE f.chunk_id IS NULL;
      `);

      restoreFtsTriggerDefinitions(native);
    },

    restoreFtsTriggersOnly(): void {
      restoreFtsTriggerDefinitions(native);
    },

    // ── Reset ──

    resetIndexArtifacts(): void {
      native.exec("DELETE FROM graph_edges");
      native.exec("DELETE FROM graph_nodes");
      native.exec("DELETE FROM embeddings");
      native.exec("DELETE FROM chunks");
      native.exec("DELETE FROM documents");
    },
  };
}

function mapMemoryRow(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    title: String(row.title),
    content: String(row.content),
    tags: String(row.tags ?? ""),
    source: String(row.source),
    supersedesId: row.supersedes_id ? String(row.supersedes_id) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function safeParseJson(
  value: string | undefined,
  fallback: Record<string, unknown>,
): Record<string, unknown> {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return fallback;
  }
}

/**
 * Sanitize a user query for FTS5 MATCH.
 * Splits into terms, strips FTS5 special characters, and joins with OR
 * so multi-word queries match any term (broader recall for code search).
 * Falls back to prefix matching for partial words.
 */
function sanitizeFtsQuery(query: string): string {
  const stopwords = new Set([
    "a",
    "an",
    "are",
    "does",
    "extracted",
    "how",
    "implement",
    "implementation",
    "implemented",
    "in",
    "is",
    "of",
    "the",
    "to",
    "what",
    "where",
    "work",
  ]);
  const codeVerbs: Record<string, string> = {
    created: "create",
    generated: "generate",
    indexing: "index",
    selected: "select",
    stored: "store",
    written: "write",
  };
  const terms = (query.match(/[\p{L}\p{N}$]+/gu) ?? []).filter(
    (t) => t.length > 1 && !stopwords.has(t.toLowerCase()),
  );

  if (terms.length === 0) return "";

  // Use prefix matching (*) for each term, joined with OR
  return [...new Set(terms.map((term) => codeVerbs[term.toLowerCase()] ?? term))]
    .map((term) => `"${term}"*`)
    .join(" OR ");
}
