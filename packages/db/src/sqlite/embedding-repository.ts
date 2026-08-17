import crypto from "node:crypto";

import type { NativeDatabase } from "./shared-types";

/**
 * Prepared statements used by the embedding operations.
 *
 * These are prepared once in `createWorkspaceRepository()` (the facade in
 * `workspace-repository.ts`) and reused across thousands of calls. Only the
 * statements needed by this module are declared here; the remaining
 * statements are declared in the other split repository modules
 * (`document-repository.ts`, `graph-ops-shared.ts`, `fts-repository.ts`).
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
        chunkId: number;
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

    async deleteEmbeddingsByChunkIds(chunkIds: number[]) {
      if (chunkIds.length === 0) return;
      const placeholders = chunkIds.map(() => "?").join(",");
      native.prepare(`DELETE FROM embeddings WHERE chunk_id IN (${placeholders})`).run(...chunkIds);
    },
  };
}
