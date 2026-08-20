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
  insertChunkWithId?: ReturnType<NativeDatabase["prepare"]>;
  deleteChunksByDoc: ReturnType<NativeDatabase["prepare"]>;
}

function mapChunkRow(row: Record<string, unknown>) {
  return {
    id: Number(row.id),
    documentId: Number(row.document_id),
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

    async getChunksByDocument(documentId: number) {
      const rows = stmts.chunksByDoc.all(documentId) as Array<Record<string, unknown>>;
      return rows.map(mapChunkRow);
    },

    async insertChunks(
      inputs: Array<{
        documentId: number;
        chunkIndex: number;
        heading?: string | null;
        content: string;
        tokenCount: number;
        contentHash: string;
        metadata: string;
      }>,
    ): Promise<number[]> {
      if (inputs.length === 0) return [];
      const now = new Date().toISOString();
      const ids: number[] = [];
      const runInsert = () => {
        for (const item of inputs) {
          const res = stmts.insertChunk.run(
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
          ids.push(Number(res.lastInsertRowid));
        }
      };
      if (typeof native.transaction === "function") {
        native.transaction(runInsert)();
      } else {
        runInsert();
      }
      return ids;
    },

    async deleteChunksByDocument(documentId: number) {
      stmts.deleteChunksByDoc.run(documentId);
    },

    // ── Streaming inserts (chunk) ──

    streamChunk(input: {
      id?: number;
      documentId: number;
      chunkIndex: number;
      heading: string | null;
      content: string;
      tokenCount: number;
      contentHash: string;
      metadata: string;
    }): number {
      const now = streamNow.value;
      if (input.id !== undefined && stmts.insertChunkWithId) {
        stmts.insertChunkWithId.run(
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
        return input.id;
      }
      const res = stmts.insertChunk.run(
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
      return Number(res.lastInsertRowid);
    },

    streamChunksBatch(
      inputs: Array<{
        id?: number;
        documentId: number;
        chunkIndex: number;
        heading: string | null;
        content: string;
        tokenCount: number;
        contentHash: string;
        metadata: string;
      }>,
    ): number[] {
      if (inputs.length === 0) return [];
      const now = streamNow.value;
      const ids: number[] = [];
      for (const c of inputs) {
        if (c.id !== undefined && stmts.insertChunkWithId) {
          stmts.insertChunkWithId.run(
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
          ids.push(c.id);
        } else {
          const res = stmts.insertChunk.run(
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
          ids.push(Number(res.lastInsertRowid));
        }
      }
      return ids;
    },
  };
}
