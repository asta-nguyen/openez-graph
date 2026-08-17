import { asc, count, eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "./schema";
import type { NativeDatabase, StreamTimestampHolder } from "./shared-types";

export type WorkspaceDrizzleDb = ReturnType<typeof drizzle>;

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

function mapChunkRow(row: typeof schema.chunks.$inferSelect) {
  return {
    id: row.id,
    documentId: row.documentId,
    chunkIndex: row.chunkIndex,
    heading: row.heading ? String(row.heading) : null,
    content: row.content,
    tokenCount: row.tokenCount,
    contentHash: row.contentHash,
    metadata: row.metadata ?? "{}",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
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
  db: WorkspaceDrizzleDb,
  native: NativeDatabase,
  stmts: ChunkStmts,
  streamNow: StreamTimestampHolder,
) {
  return {
    async getChunkCount(): Promise<number> {
      const res = db.select({ count: count() }).from(schema.chunks).get();
      return res?.count ?? 0;
    },

    // ── Chunk Operations ──

    async getChunksByDocument(documentId: number) {
      const rows = db
        .select()
        .from(schema.chunks)
        .where(eq(schema.chunks.documentId, documentId))
        .orderBy(asc(schema.chunks.chunkIndex))
        .all();
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
      if ("transaction" in native && native.transaction) {
        native.transaction(runInsert)();
      } else {
        runInsert();
      }
      return ids;
    },

    async deleteChunksByDocument(documentId: number) {
      db.delete(schema.chunks).where(eq(schema.chunks.documentId, documentId)).run();
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
