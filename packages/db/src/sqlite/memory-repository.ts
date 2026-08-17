import { eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "./schema";
import type { NativeDatabase } from "./shared-types";
import type { StoredMemory } from "./types";

export type WorkspaceDrizzleDb = ReturnType<typeof drizzle>;

/**
 * Prepared statements used by the memory operations.
 *
 * These are prepared once in `createWorkspaceRepository()` and reused across
 * calls. The memory module currently prepares its own statements inline (the
 * original implementation did the same), so this interface is intentionally
 * empty for now — it exists so the factory signature matches the other
 * extracted modules and later tasks can hoist statements here without changing
 * call sites.
 */
export interface MemoryStmts {}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function mapMemoryRow(row: typeof schema.memories.$inferSelect): StoredMemory {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    tags: row.tags ?? "",
    source: row.source,
    supersedesId: row.supersedesId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Factory for memory operations extracted from
 * `createWorkspaceRepository()`.
 */
export function createMemoryOps(
  db: WorkspaceDrizzleDb,
  native: NativeDatabase,
  _stmts: MemoryStmts,
) {
  return {
    // ── Memory Operations ──

    async insertMemory(input: {
      title: string;
      content: string;
      tags?: string;
      source: string;
      supersedesId?: number | null;
    }): Promise<number> {
      const now = new Date().toISOString();
      const res = db
        .insert(schema.memories)
        .values({
          title: input.title,
          content: input.content,
          tags: input.tags ?? "",
          source: input.source,
          supersedesId: input.supersedesId ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: schema.memories.id })
        .get();
      return res.id;
    },

    async getMemory(id: number): Promise<StoredMemory | null> {
      const row = db.select().from(schema.memories).where(eq(schema.memories.id, id)).get();
      return row ? mapMemoryRow(row) : null;
    },

    async searchMemories(query: string, limit: number): Promise<StoredMemory[]> {
      const normalized = query.trim().toLowerCase();
      const terms = [...new Set(normalized.split(/\s+/).filter(Boolean))].slice(0, 8);
      if (terms.length === 0) return [];

      const clauses = terms.map(
        () =>
          "(lower(m.title) LIKE ? ESCAPE '\\' OR lower(m.content) LIKE ? ESCAPE '\\' OR lower(m.tags) LIKE ? ESCAPE '\\')",
      );
      const termParams = terms.flatMap((term) => {
        const pattern = `%${escapeLikePattern(term)}%`;
        return [pattern, pattern, pattern];
      });
      const phrasePattern = `%${escapeLikePattern(normalized)}%`;
      // SAFETY: Query selects m.* from memories table matching schema.memories shape.
      const rows = native
        .prepare(
          `SELECT m.*
         FROM memories m
         WHERE NOT EXISTS (SELECT 1 FROM memories newer WHERE newer.supersedes_id = m.id)
           AND ${clauses.join(" AND ")}
         ORDER BY CASE
           WHEN lower(m.title) = ? THEN 0
           WHEN lower(m.title) LIKE ? ESCAPE '\\' THEN 1
           ELSE 2
         END, m.updated_at DESC
         LIMIT ?`,
        )
        .all(...termParams, normalized, phrasePattern, limit) as Array<
        typeof schema.memories.$inferSelect
      >;
      return rows.map(mapMemoryRow);
    },
  };
}
