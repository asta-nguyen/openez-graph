import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "./schema";
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
export function createEmbeddingOps(native: NativeDatabase) {
  // SAFETY: Drizzle's bun-sqlite adapter expects a `Database` instance from
  // `bun:sqlite`; `NativeDatabase` is structurally compatible (exposes the
  // same prepare/exec/pragma methods). The `as any` bridges the structural
  // mismatch without affecting runtime behavior.
  const db = drizzle(native as any, { schema });

  // Legacy TEXT-embedding DBs intentionally lack the
  // idx_embeddings_chunk_provider_model unique index (migrateEmbeddingDedup
  // skips it for TEXT columns), so ON CONFLICT(chunk_id, provider, model)
  // would fail at prepare() time. Detect once at factory creation and pick
  // the right Drizzle insert shape.
  // SAFETY: SELECT count(*) as c FROM sqlite_master returns a single row
  // with an INTEGER `c` column; the cast narrows DatabaseRow to that shape.
  const hasEmbeddingUniqueIdx =
    (
      native
        .prepare(
          "SELECT count(*) as c FROM sqlite_master WHERE type='index' AND name='idx_embeddings_chunk_provider_model'",
        )
        .get() as { c: number }
    ).c > 0;

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
        const insert = db.insert(schema.embeddings).values({
          chunkId: input.chunkId,
          provider: input.provider,
          model: input.model,
          dimensions: input.dimensions,
          embedding: input.embedding,
          inputHash: input.inputHash ?? null,
          createdAt: now,
        });
        if (hasEmbeddingUniqueIdx) {
          // Upsert: replace dimensions/embedding/input_hash/created_at when
          // the (chunk_id, provider, model) tuple already exists.
          insert
            .onConflictDoUpdate({
              target: [
                schema.embeddings.chunkId,
                schema.embeddings.provider,
                schema.embeddings.model,
              ],
              set: {
                dimensions: input.dimensions,
                embedding: input.embedding,
                inputHash: input.inputHash ?? null,
                createdAt: now,
              },
            })
            .run();
        } else {
          insert.run();
        }
      }
    },

    async deleteEmbeddingsByChunkIds(chunkIds: number[]) {
      if (chunkIds.length === 0) return;
      db.delete(schema.embeddings).where(inArray(schema.embeddings.chunkId, chunkIds)).run();
    },
  };
}
