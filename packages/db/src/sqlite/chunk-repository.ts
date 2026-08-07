import crypto from "node:crypto";

import type { NativeDatabase, StreamTimestampHolder } from "./shared-types";

/**
 * Prepared statements used by the chunk operations.
 *
 * These are prepared once in `createWorkspaceRepository()` and reused across
 * thousands of calls. Document statements live in `DocumentStmts`
 * (see `document-repository.ts`); the two interfaces are intentionally kept
 * separate so each module only declares what it needs.
 */
export interface ChunkStmts {
  chunksByDoc: ReturnType<NativeDatabase["prepare"]>;
  insertChunk: ReturnType<NativeDatabase["prepare"]>;
  deleteChunksByDoc: ReturnType<NativeDatabase["prepare"]>;
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
 * Factory for chunk operations extracted from `createDocumentOps()`.
 *
 * Behavior is identical to the original inline implementations — this is a
 * pure code-move. `streamNow` is shared via a mutable holder so that the
 * chunk stream methods use the same timestamp as the document stream methods
 * that still live in `document-repository.ts`.
 */
export function createChunkOps(
  native: NativeDatabase,
  stmts: ChunkStmts,
  streamNow: StreamTimestampHolder,
) {
  return {
    async getChunkCount(): Promise<number> {
      const row = native.prepare("SELECT count(*) AS count FROM chunks").get() as { count: number };
      return row?.count ?? 0;
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

    // ── Streaming inserts (chunk) ──

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
  };
}
