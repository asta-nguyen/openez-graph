import crypto from "node:crypto";

import { createChunkOps, type ChunkStmts } from "./chunk-repository";
import type { NativeDatabase, StreamTimestampHolder } from "./shared-types";

/**
 * Prepared statements used by the document operations.
 *
 * These are prepared once in `createWorkspaceRepository()` and reused across
 * thousands of calls. Chunk statements live in `ChunkStmts`
 * (see `chunk-repository.ts`); the two interfaces are intentionally kept
 * separate so each module only declares what it needs.
 */
export interface DocumentStmts {
  docByPath: ReturnType<NativeDatabase["prepare"]>;
  docById: ReturnType<NativeDatabase["prepare"]>;
  insertDoc: ReturnType<NativeDatabase["prepare"]>;
}

function mapDocumentRow(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    path: String(row.path),
    absolutePath: String(row.absolute_path),
    kind: String(row.kind),
    language: row.language ? String(row.language) : null,
    contentHash: String(row.content_hash),
    sizeBytes: Number(row.size_bytes),
    mtimeMs: Number(row.mtime_ms),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * Factory for document and parsed_documents operations extracted from
 * `createWorkspaceRepository()`.
 *
 * Behavior is identical to the original inline implementations — this is a
 * pure code-move. `streamNow` is shared via a mutable holder so that
 * `refreshStreamTimestamp()` (defined here) stays visible to the graph/edge/fts
 * stream methods that still live in `repository.ts`, and to the chunk stream
 * methods that now live in `chunk-repository.ts`.
 *
 * Chunk operations are composed in from `createChunkOps()` so callers of
 * `createDocumentOps()` continue to receive a single merged ops object.
 */
export function createDocumentOps(
  native: NativeDatabase,
  stmts: DocumentStmts & ChunkStmts,
  streamNow: StreamTimestampHolder,
) {
  const chunkOps = createChunkOps(native, stmts, streamNow);

  return {
    async getDocumentCount(): Promise<number> {
      const row = native.prepare("SELECT count(*) AS count FROM documents").get() as {
        count: number;
      };
      return row?.count ?? 0;
    },

    // ── Document Operations ──

    async getDocument(id: string) {
      const row = stmts.docById.get(id) as Record<string, unknown> | undefined;
      return row ? mapDocumentRow(row) : null;
    },

    async getDocumentByPath(path: string) {
      const row = stmts.docByPath.get(path) as Record<string, unknown> | undefined;
      return row ? mapDocumentRow(row) : null;
    },

    async insertDocument(input: {
      id?: string;
      path: string;
      absolutePath: string;
      kind: string;
      language: string | null;
      contentHash: string;
      sizeBytes: number;
      mtimeMs: number;
    }) {
      const id = input.id ?? crypto.randomUUID();
      const now = new Date().toISOString();
      stmts.insertDoc.run(
        id,
        input.path,
        input.absolutePath,
        input.kind,
        input.language,
        input.contentHash,
        input.sizeBytes,
        input.mtimeMs,
        now,
        now,
      );
      return id;
    },

    async insertDocumentsBatch(
      inputs: Array<{
        path: string;
        absolutePath: string;
        kind: string;
        language?: string | null;
        contentHash: string;
        sizeBytes: number;
        mtimeMs: number;
      }>,
    ): Promise<string[]> {
      if (inputs.length === 0) return [];
      const now = new Date().toISOString();
      const ids: string[] = inputs.map(() => crypto.randomUUID());
      const BATCH = 500;
      for (let i = 0; i < inputs.length; i += BATCH) {
        const batch = inputs.slice(i, i + BATCH);
        const placeholders = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(",");
        const params: unknown[] = [];
        for (let j = 0; j < batch.length; j++) {
          const item = batch[j];
          params.push(
            ids[i + j],
            item.path,
            item.absolutePath,
            item.kind,
            item.language ?? null,
            item.contentHash,
            item.sizeBytes,
            item.mtimeMs,
            now,
            now,
          );
        }
        native
          .prepare(
            `INSERT INTO documents (id, path, absolute_path, kind, language, content_hash, size_bytes, mtime_ms, created_at, updated_at) VALUES ${placeholders}`,
          )
          .run(...params);
      }
      return ids;
    },

    async updateDocument(
      id: string,
      updates: Partial<{
        absolutePath: string;
        kind: string;
        language: string | null;
        contentHash: string;
        sizeBytes: number;
        mtimeMs: number;
      }>,
    ) {
      const sets: string[] = ["updated_at = ?"];
      const params: unknown[] = [new Date().toISOString()];
      if (updates.absolutePath !== undefined) {
        sets.push("absolute_path = ?");
        params.push(updates.absolutePath);
      }
      if (updates.kind !== undefined) {
        sets.push("kind = ?");
        params.push(updates.kind);
      }
      if (updates.language !== undefined) {
        sets.push("language = ?");
        params.push(updates.language);
      }
      if (updates.contentHash !== undefined) {
        sets.push("content_hash = ?");
        params.push(updates.contentHash);
      }
      if (updates.sizeBytes !== undefined) {
        sets.push("size_bytes = ?");
        params.push(updates.sizeBytes);
      }
      if (updates.mtimeMs !== undefined) {
        sets.push("mtime_ms = ?");
        params.push(updates.mtimeMs);
      }
      params.push(id);
      native.prepare(`UPDATE documents SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    },

    async deleteDocument(id: string) {
      native.prepare("DELETE FROM documents WHERE id = ?").run(id);
    },

    async listDocuments() {
      const rows = native.prepare("SELECT * FROM documents ORDER BY path").all() as Array<
        Record<string, unknown>
      >;
      return rows.map(mapDocumentRow);
    },

    // ── Streaming inserts (document) ──

    streamDocument(input: {
      id: string;
      path: string;
      absolutePath: string;
      kind: string;
      language?: string | null;
      contentHash: string;
      sizeBytes: number;
      mtimeMs: number;
    }): void {
      const now = streamNow.value;
      stmts.insertDoc.run(
        input.id,
        input.path,
        input.absolutePath,
        input.kind,
        input.language ?? null,
        input.contentHash,
        input.sizeBytes,
        input.mtimeMs,
        now,
        now,
      );
    },

    refreshStreamTimestamp(): void {
      streamNow.value = new Date().toISOString();
    },

    // ── parsed_documents cache ──

    insertParsedDocument(input: {
      documentId: string;
      contentHash: string;
      symbols: string;
      imports: string;
      calls: string;
    }): void {
      const now = Date.now();
      native
        .prepare(
          `INSERT OR REPLACE INTO parsed_documents (document_id, content_hash, symbols, imports, calls, parsed_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(input.documentId, input.contentHash, input.symbols, input.imports, input.calls, now);
    },

    getParsedDocument(documentId: string): {
      documentId: string;
      contentHash: string;
      symbols: string | null;
      imports: string | null;
      calls: string | null;
      parsedAt: number;
    } | null {
      const row = native
        .prepare("SELECT * FROM parsed_documents WHERE document_id = ?")
        .get(documentId) as any;
      if (!row) return null;
      return {
        documentId: String(row.document_id),
        contentHash: String(row.content_hash),
        symbols: row.symbols ? String(row.symbols) : null,
        imports: row.imports ? String(row.imports) : null,
        calls: row.calls ? String(row.calls) : null,
        parsedAt: Number(row.parsed_at),
      };
    },

    deleteParsedDocumentsByDocumentIds(documentIds: string[]): void {
      if (documentIds.length === 0) return;
      const placeholders = documentIds.map(() => "?").join(",");
      native
        .prepare(`DELETE FROM parsed_documents WHERE document_id IN (${placeholders})`)
        .run(...documentIds);
    },

    // ── Chunk operations (composed from chunk-repository.ts) ──

    ...chunkOps,
  };
}
