import { drizzle } from "drizzle-orm/bun-sqlite";
import { asc, count, eq } from "drizzle-orm";

import * as schema from "./schema";
import type { NativeDatabase, StreamTimestampHolder } from "./shared-types";

/**
 * Prepared statements used by the chunk operations.
 *
 * These are prepared once in `createWorkspaceRepository()` and reused across
 * thousands of calls. Document statements live in `DocumentStmts`
 * (see `document-repository.ts`); the two interfaces are intentionally kept
 * separate so each module only declares what it needs.
 *
 * NOTE: After migration to the Drizzle query builder, the prepared statements
 * are no longer used directly by the chunk ops. They remain in the interface
 * for backwards compatibility with `createWorkspaceRepository()` which still
 * prepares them.
 */
export interface ChunkStmts {
  chunksByDoc: ReturnType<NativeDatabase["prepare"]>;
  insertChunk: ReturnType<NativeDatabase["prepare"]>;
  deleteChunksByDoc: ReturnType<NativeDatabase["prepare"]>;
}

type ChunkRow = typeof schema.chunks.$inferSelect;

function mapChunkRow(row: ChunkRow) {
  return {
    id: Number(row.id),
    documentId: Number(row.documentId),
    chunkIndex: Number(row.chunkIndex),
    heading: row.heading ?? null,
    content: String(row.content),
    tokenCount: Number(row.tokenCount),
    contentHash: String(row.contentHash),
    metadata: String(row.metadata ?? "{}"),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
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
export function createChunkOps(native: NativeDatabase, streamNow: StreamTimestampHolder) {
  // SAFETY: Drizzle's bun-sqlite adapter expects a `Database` instance from
  // `bun:sqlite`; `NativeDatabase` is structurally compatible (exposes the
  // same prepare/exec/pragma methods). The `as any` bridges the structural
  // mismatch without affecting runtime behavior.
  const db = drizzle(native as any, { schema });

  return {
    async getChunkCount(): Promise<number> {
      const row = db.select({ count: count() }).from(schema.chunks).get();
      return row?.count ?? 0;
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
      const stmt = native.prepare(
        "INSERT INTO chunks (document_id, chunk_index, heading, content, token_count, content_hash, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const ids: number[] = Array.from({ length: inputs.length });
      for (let i = 0; i < inputs.length; i++) {
        const item = inputs[i];
        const res = stmt.run(
          item.documentId,
          item.chunkIndex,
          item.heading ?? null,
          item.content,
          item.tokenCount,
          item.contentHash,
          item.metadata,
          now,
          now,
        ) as { lastInsertRowid: number };
        ids[i] = Number(res.lastInsertRowid);
      }
      return ids;
    },

    async deleteChunksByDocument(documentId: number) {
      db.delete(schema.chunks).where(eq(schema.chunks.documentId, documentId)).run();
    },

    // ── Streaming inserts (chunk) ──

    streamChunk(input: {
      id: number;
      documentId: number;
      chunkIndex: number;
      heading: string | null;
      content: string;
      tokenCount: number;
      contentHash: string;
      metadata: string;
    }): void {
      const now = streamNow.value;
      db.insert(schema.chunks)
        .values({
          documentId: input.documentId,
          chunkIndex: input.chunkIndex,
          heading: input.heading,
          content: input.content,
          tokenCount: input.tokenCount,
          contentHash: input.contentHash,
          metadata: input.metadata,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    },

    streamChunksBatch(
      inputs: Array<{
        id: number;
        documentId: number;
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
        db.insert(schema.chunks)
          .values(
            batch.map((c) => ({
              documentId: c.documentId,
              chunkIndex: c.chunkIndex,
              heading: c.heading,
              content: c.content,
              tokenCount: c.tokenCount,
              contentHash: c.contentHash,
              metadata: c.metadata,
              createdAt: now,
              updatedAt: now,
            })),
          )
          .run();
      }
    },
  };
}
