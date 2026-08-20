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
import type { SqliteRow, SymbolDefinitionMatch, WorkspaceRepository } from "./types";
import { getWorkspaceDb, getWorkspaceNativeDb } from "./workspace-db";

interface WorkspaceDbPair {
  db: ReturnType<typeof getWorkspaceDb>;
  native: NativeDatabase;
}

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

    async getSymbolDefinitions(symbolName: string): Promise<SymbolDefinitionMatch[]> {
      const trimmed = symbolName.trim();
      if (!trimmed) return [];

      const matches: SymbolDefinitionMatch[] = [];
      const escaped = trimmed.replace(/[%_\\]/g, "\\$&");

      // SAFETY: Query fetches parsed document symbol JSON strings and paths.
      const parsedRows = native
        .prepare(
          `SELECT d.id as doc_id, d.path, p.symbols
           FROM parsed_documents p
           JOIN documents d ON d.id = p.document_id
           WHERE p.symbols LIKE ? ESCAPE '\\'`,
        )
        .all(`%"name":"%${escaped}%`) as Array<{ doc_id: number; path: string; symbols: string }>;

      const nodeStmt = native.prepare(
        "SELECT id, ref_id FROM graph_nodes WHERE type = 'symbol' AND json_extract(metadata, '$.filePath') = ? AND (label = ? OR label LIKE ? ESCAPE '\\') LIMIT 1",
      );
      const chunkByIdStmt = native.prepare("SELECT content FROM chunks WHERE id = ?");
      const chunkByHeadingStmt = native.prepare(
        "SELECT content FROM chunks WHERE document_id = ? AND (heading = ? OR heading LIKE ? ESCAPE '\\') LIMIT 1",
      );
      const chunksByDocStmt = native.prepare(
        "SELECT heading, metadata FROM chunks WHERE document_id = ? ORDER BY chunk_index ASC",
      );
      const callersStmt = native.prepare(
        "SELECT COUNT(*) as c FROM graph_edges WHERE to_node_id = ? AND type = 'calls'",
      );
      const calleesStmt = native.prepare(
        "SELECT COUNT(*) as c FROM graph_edges WHERE from_node_id = ? AND type = 'calls'",
      );

      for (const row of parsedRows) {
        try {
          const rawSymbols = JSON.parse(row.symbols);
          if (Array.isArray(rawSymbols)) {
            let chunkMetaMap: Map<string, { startLine: number; endLine: number }> | null = null;

            for (const s of rawSymbols) {
              const sName = String(s.name || "");
              if (
                sName === trimmed ||
                sName.endsWith(`::${trimmed}`) ||
                sName.endsWith(`.${trimmed}`)
              ) {
                let sourceCode: string | undefined;
                let callerCount = 0;
                let calleeCount = 0;

                const escapedSName = sName.replace(/[%_\\]/g, "\\$&");
                // SAFETY: Query fetches node id and ref_id.
                const node = nodeStmt.get(row.path, sName, `%::${escapedSName}`) as
                  | { id: number; ref_id: number | null }
                  | undefined;

                if (node?.ref_id) {
                  // SAFETY: Query fetches chunk content by id.
                  const chunkRow = chunkByIdStmt.get(node.ref_id) as
                    | { content: string }
                    | undefined;
                  if (chunkRow?.content) sourceCode = chunkRow.content;
                }

                if (!sourceCode) {
                  // SAFETY: Query fetches chunk content by heading.
                  const chunkHeadingRow = chunkByHeadingStmt.get(
                    row.doc_id,
                    sName,
                    `%${escapedSName}%`,
                  ) as { content: string } | undefined;
                  if (chunkHeadingRow?.content) sourceCode = chunkHeadingRow.content;
                }

                if (node?.id) {
                  // SAFETY: Query counts incoming callers.
                  const callers = callersStmt.get(node.id) as { c: number } | undefined;
                  // SAFETY: Query counts outgoing callees.
                  const callees = calleesStmt.get(node.id) as { c: number } | undefined;
                  callerCount = Number(callers?.c ?? 0);
                  calleeCount = Number(callees?.c ?? 0);
                }

                let startLine = Number(s.startLine || 0);
                let endLine = Number(s.endLine || 0);

                if (startLine <= 0) {
                  if (!chunkMetaMap) {
                    chunkMetaMap = new Map();
                    // SAFETY: Query fetches doc chunks heading and metadata.
                    const docChunks = chunksByDocStmt.all(row.doc_id) as Array<{
                      heading: string | null;
                      metadata: string;
                    }>;
                    for (const dc of docChunks) {
                      try {
                        const meta = JSON.parse(dc.metadata || "{}");
                        const name = meta.symbolName || dc.heading;
                        if (name && meta.startLine) {
                          chunkMetaMap.set(String(name), {
                            startLine: Number(meta.startLine),
                            endLine: Number(meta.endLine || meta.startLine),
                          });
                        }
                      } catch {}
                    }
                  }
                  const fromChunk =
                    chunkMetaMap.get(sName) ||
                    chunkMetaMap.get(sName.split(".").pop() || "") ||
                    chunkMetaMap.get(sName.split("::").pop() || "");
                  if (fromChunk) {
                    startLine = fromChunk.startLine;
                    endLine = fromChunk.endLine;
                  }
                } else if (endLine <= 0) {
                  endLine = startLine;
                }

                matches.push({
                  name: sName,
                  kind: String(s.symbolType || s.kind || s.type || "symbol"),
                  filePath: row.path,
                  startLine: startLine > 0 ? startLine : undefined,
                  endLine: endLine > 0 ? endLine : undefined,
                  exported: Boolean(s.exported),
                  parentSymbol: s.parentSymbol ? String(s.parentSymbol) : undefined,
                  sourceCode,
                  callerCount,
                  calleeCount,
                });
              }
            }
          }
        } catch {}
      }

      if (matches.length === 0) {
        // SAFETY: Query fetches matching nodes from graph_nodes.
        const nodes = native
          .prepare(
            `SELECT n.id, n.type, n.label, n.ref_id, n.metadata
             FROM graph_nodes n
             WHERE n.label = ? OR n.label LIKE ? OR n.label LIKE ?`,
          )
          .all(trimmed, `%::${trimmed}`, `%.${trimmed}`) as Array<{
          id: number;
          type: string;
          label: string;
          ref_id: number | null;
          metadata: string;
        }>;

        for (const n of nodes) {
          interface NodeMetaPayload {
            path?: string;
            filePath?: string;
            startLine?: number;
            endLine?: number;
            exported?: boolean;
          }
          let meta: NodeMetaPayload = {};
          try {
            meta = JSON.parse(n.metadata || "{}");
          } catch {}

          let sourceCode: string | undefined;
          if (n.ref_id) {
            // SAFETY: Query fetches chunk content by id.
            const chunkRow = chunkByIdStmt.get(n.ref_id) as { content: string } | undefined;
            if (chunkRow?.content) sourceCode = chunkRow.content;
          }

          // SAFETY: Query counts incoming callers.
          const callers = callersStmt.get(n.id) as { c: number } | undefined;
          // SAFETY: Query counts outgoing callees.
          const callees = calleesStmt.get(n.id) as { c: number } | undefined;

          matches.push({
            name: n.label,
            kind: n.type,
            filePath: String(meta.path || meta.filePath || ""),
            startLine: Number(meta.startLine || 1),
            endLine: Number(meta.endLine || meta.startLine || 1),
            exported: Boolean(meta.exported),
            sourceCode,
            callerCount: Number(callers?.c ?? 0),
            calleeCount: Number(callees?.c ?? 0),
          });
        }
      }

      return matches;
    },

    // ── Raw SQL queries ──

    async executeRaw(sqlQuery: string, params?: unknown[]) {
      if (params) {
        native.prepare(sqlQuery).run(...params);
        return;
      }
      native.prepare(sqlQuery).run();
    },

    async queryRaw<T = SqliteRow>(sqlQuery: string, params?: unknown[]): Promise<T[]> {
      if (params) {
        // SAFETY: Raw query interface returns rows matching generic T.
        return native.prepare(sqlQuery).all(...params) as T[];
      }
      // SAFETY: Raw query interface returns rows matching generic T.
      return native.prepare(sqlQuery).all() as T[];
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
