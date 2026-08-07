import crypto from "node:crypto";

import type { NativeDatabase, StreamTimestampHolder } from "./shared-types";

/**
 * Prepared statements used by the document/chunk operations.
 *
 * These are prepared once in `createWorkspaceRepository()` and reused across
 * thousands of calls. Only the statements needed by this module are declared
 * here; the remaining statements stay in `repository.ts` and will be split out
 * by later tasks.
 */
export interface DocumentStmts {
  docByPath: ReturnType<NativeDatabase["prepare"]>;
  docById: ReturnType<NativeDatabase["prepare"]>;
  insertDoc: ReturnType<NativeDatabase["prepare"]>;
  chunksByDoc: ReturnType<NativeDatabase["prepare"]>;
  insertChunk: ReturnType<NativeDatabase["prepare"]>;
  deleteChunksByDoc: ReturnType<NativeDatabase["prepare"]>;
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

function mapChunkRow(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    documentId: String(row.document_id),
    chunkIndex: Number(row.chunk_index),
    heading: row.heading ? String(row.heading) : null,
    content: String(row.content),
    tokenCount: Number(row.token_count),
    contentHash: String(row.content_hash),
    metadata: String(row.metadata ?? "{}"),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * Factory for document and chunk operations extracted from
 * `createWorkspaceRepository()`.
 *
 * Behavior is identical to the original inline implementations — this is a
 * pure code-move. `streamNow` is shared via a mutable holder so that
 * `refreshStreamTimestamp()` (defined here) stays visible to the graph/edge/fts
 * stream methods that still live in `repository.ts`.
 */
export function createDocumentOps(
  native: NativeDatabase,
  stmts: DocumentStmts,
  streamNow: StreamTimestampHolder,
) {
  return {
    async getDocumentCount(): Promise<number> {
      const row = native.prepare("SELECT count(*) AS count FROM documents").get() as {
        count: number;
      };
      return row?.count ?? 0;
    },

    async getChunkCount(): Promise<number> {
      const row = native.prepare("SELECT count(*) AS count FROM chunks").get() as { count: number };
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

    // ── Chunk Operations ──

    async getChunksByDocument(documentId: string) {
      const rows = stmts.chunksByDoc.all(documentId) as Array<Record<string, unknown>>;
      return rows.map(mapChunkRow);
    },

    async insertChunks(
      inputs: Array<{
        documentId: string;
        chunkIndex: number;
        heading?: string | null;
        content: string;
        tokenCount: number;
        contentHash: string;
        metadata: string;
      }>,
    ): Promise<string[]> {
      if (inputs.length === 0) return [];
      const now = new Date().toISOString();
      const ids: string[] = inputs.map(() => crypto.randomUUID());
      const BATCH = 2000;
      for (let i = 0; i < inputs.length; i += BATCH) {
        const batch = inputs.slice(i, i + BATCH);
        const placeholders = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(",");
        const params: unknown[] = [];
        for (let j = 0; j < batch.length; j++) {
          const item = batch[j];
          params.push(
            ids[i + j],
            item.documentId,
            item.chunkIndex,
            item.heading ?? null,
            item.content,
            item.tokenCount,
            item.contentHash,
            item.metadata,
            now,
            now,
          );
        }
        native
          .prepare(
            `INSERT INTO chunks (id, document_id, chunk_index, heading, content, token_count, content_hash, metadata, created_at, updated_at) VALUES ${placeholders}`,
          )
          .run(...params);
      }
      return ids;
    },

    async deleteChunksByDocument(documentId: string) {
      stmts.deleteChunksByDoc.run(documentId);
    },

    // ── Streaming inserts (document/chunk) ──

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

    streamChunk(input: {
      id: string;
      documentId: string;
      chunkIndex: number;
      heading: string | null;
      content: string;
      tokenCount: number;
      contentHash: string;
      metadata: string;
    }): void {
      const now = streamNow.value;
      stmts.insertChunk.run(
        input.id,
        input.documentId,
        input.chunkIndex,
        input.heading,
        input.content,
        input.tokenCount,
        input.contentHash,
        input.metadata,
        now,
        now,
      );
    },

    streamChunksBatch(
      inputs: Array<{
        id: string;
        documentId: string;
        chunkIndex: number;
        heading: string | null;
        content: string;
        tokenCount: number;
        contentHash: string;
        metadata: string;
      }>,
    ): void {
      if (inputs.length === 0) return;
      const BATCH = 100;
      const now = streamNow.value;
      for (let i = 0; i < inputs.length; i += BATCH) {
        const batch = inputs.slice(i, i + BATCH);
        const placeholders = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(",");
        const params: unknown[] = [];
        for (const c of batch) {
          params.push(
            c.id,
            c.documentId,
            c.chunkIndex,
            c.heading,
            c.content,
            c.tokenCount,
            c.contentHash,
            c.metadata,
            now,
            now,
          );
        }
        native
          .prepare(
            `INSERT INTO chunks (id, document_id, chunk_index, heading, content, token_count, content_hash, metadata, created_at, updated_at) VALUES ${placeholders}`,
          )
          .run(...params);
      }
    },

    refreshStreamTimestamp(): void {
      streamNow.value = new Date().toISOString();
    },
  };
}
