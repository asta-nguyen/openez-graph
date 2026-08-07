import crypto from "node:crypto";

import { hasVecExtension } from "./database-loader";
import type { NativeDatabase } from "./shared-types";

/**
 * Prepared statements used by the embedding operations.
 *
 * These are prepared once in `createWorkspaceRepository()` and reused across
 * thousands of calls. Only the statements needed by this module are declared
 * here.
 */
export interface EmbeddingStmts {
  insertEmbedding: ReturnType<NativeDatabase["prepare"]>;
}

/**
 * Factory for embedding operations extracted from
 * `createWorkspaceRepository()`.
 *
 * Behavior is identical to the original inline implementations — this is a
 * pure code-move.
 */
export function createEmbeddingOps(native: NativeDatabase, stmts: EmbeddingStmts) {
  return {
    // ── Embedding Operations ──

    async insertEmbeddings(
      inputs: Array<{
        chunkId: string;
        provider: string;
        model: string;
        dimensions: number;
        embedding: Uint8Array;
        inputHash?: string | null;
      }>,
    ) {
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

      // Sync to sqlite-vec virtual table for ANN search when the extension is
      // loaded. Failures (missing table, dimension mismatch) are swallowed so
      // the linear-scan path remains authoritative.
      if (hasVecExtension()) {
        for (const input of inputs) {
          try {
            native
              .prepare("INSERT OR REPLACE INTO embeddings_vec (chunk_id, embedding) VALUES (?, ?)")
              .run(Number(input.chunkId), input.embedding);
          } catch {
            // Vec table might not exist or dimension mismatch — skip
          }
        }
      }
    },

    async deleteEmbeddingsByChunkIds(chunkIds: string[]) {
      if (chunkIds.length === 0) return;
      const placeholders = chunkIds.map(() => "?").join(",");
      native.prepare(`DELETE FROM embeddings WHERE chunk_id IN (${placeholders})`).run(...chunkIds);

      // Keep the sqlite-vec virtual table in sync on delete.
      if (hasVecExtension()) {
        try {
          const numIds = chunkIds.map((id) => Number(id));
          const numPlaceholders = numIds.map(() => "?").join(",");
          native
            .prepare(`DELETE FROM embeddings_vec WHERE chunk_id IN (${numPlaceholders})`)
            .run(...numIds);
        } catch {
          // Vec table might not exist — skip
        }
      }
    },
  };
}
