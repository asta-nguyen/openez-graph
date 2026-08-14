import { and, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "./schema";
import type { NativeDatabase } from "./shared-types";
import type { StoredMemory } from "./types";

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function mapMemoryRow(row: typeof schema.memories.$inferSelect): StoredMemory {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    tags: row.tags,
    source: row.source,
    supersedesId: row.supersedesId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Factory for memory operations extracted from
 * `createWorkspaceRepository()`.
 *
 * Behavior is identical to the original inline implementations — this is a
 * pure code-move.
 */
export function createMemoryOps(native: NativeDatabase) {
  // SAFETY: Drizzle's bun-sqlite adapter expects a `Database` instance from
  // `bun:sqlite`; `NativeDatabase` is structurally compatible (exposes the
  // same prepare/exec/pragma methods). The `as any` bridges the structural
  // mismatch without affecting runtime behavior.
  const db = drizzle(native as any, { schema });
  return {
    // ── Memory Operations ──

    async insertMemory(input: {
      title: string;
      content: string;
      tags?: string;
      source: string;
      supersedesId?: number;
    }) {
      const now = new Date().toISOString();
      // `RETURNING id` yields the autoincrement primary key, which equals the
      // rowid that the original `lastInsertRowid` read exposed.
      const inserted = db
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
      return inserted.id;
    },

    async getMemory(id: number): Promise<StoredMemory | null> {
      const row = db.select().from(schema.memories).where(eq(schema.memories.id, id)).get();
      return row ? mapMemoryRow(row) : null;
    },

    async searchMemories(query: string, limit: number): Promise<StoredMemory[]> {
      const normalized = query.trim().toLowerCase();
      const terms = [...new Set(normalized.split(/\s+/).filter(Boolean))].slice(0, 8);
      if (terms.length === 0) return [];

      // Exclude memories that have been superseded by a newer row. The outer
      // table is referenced unqualified (Drizzle emits `FROM "memories"`) so
      // the correlated subquery aliases a second reference as `newer`.
      const notSuperseded = sql`NOT EXISTS (SELECT 1 FROM memories newer WHERE newer.supersedes_id = memories.id)`;

      // Each search term must match title, content, or tags (case-insensitive
      // LIKE with backslash escaping). The same pattern is bound three times
      // per term, mirroring the original positional parameter layout.
      const termConditions = terms.map((term) => {
        const pattern = `%${escapeLikePattern(term)}%`;
        return sql`(lower(memories.title) LIKE ${pattern} ESCAPE '\\' OR lower(memories.content) LIKE ${pattern} ESCAPE '\\' OR lower(memories.tags) LIKE ${pattern} ESCAPE '\\')`;
      });
      const phrasePattern = `%${escapeLikePattern(normalized)}%`;

      const rows = db
        .select()
        .from(schema.memories)
        .where(and(notSuperseded, ...termConditions))
        .orderBy(
          sql`CASE WHEN lower(memories.title) = ${normalized} THEN 0 WHEN lower(memories.title) LIKE ${phrasePattern} ESCAPE '\\' THEN 1 ELSE 2 END`,
          desc(schema.memories.updatedAt),
        )
        .limit(limit)
        .all();
      return rows.map(mapMemoryRow);
    },
  };
}
