import crypto from "node:crypto";

import type { NativeDatabase } from "./shared-types";
import type { StoredMemory } from "./types";

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

function mapMemoryRow(row: Record<string, unknown>): StoredMemory {
  return {
    id: String(row.id),
    title: String(row.title),
    content: String(row.content),
    tags: String(row.tags ?? ""),
    source: String(row.source),
    supersedesId: row.supersedes_id ? String(row.supersedes_id) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * Factory for memory operations extracted from
 * `createWorkspaceRepository()`.
 *
 * Behavior is identical to the original inline implementations — this is a
 * pure code-move.
 */
export function createMemoryOps(native: NativeDatabase, _stmts: MemoryStmts) {
  return {
    // ── Memory Operations ──

    async insertMemory(input: {
      title: string;
      content: string;
      tags?: string;
      source: string;
      supersedesId?: string;
    }) {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      native
        .prepare(
          "INSERT INTO memories (id, title, content, tags, source, supersedes_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          input.title,
          input.content,
          input.tags ?? "",
          input.source,
          input.supersedesId ?? null,
          now,
          now,
        );
      return id;
    },

    async getMemory(id: string): Promise<StoredMemory | null> {
      const row = native.prepare("SELECT * FROM memories WHERE id = ?").get(id) as
        | Record<string, unknown>
        | undefined;
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
        .all(...termParams, normalized, phrasePattern, limit) as Array<Record<string, unknown>>;
      return rows.map(mapMemoryRow);
    },

    async getMemoryCount(): Promise<number> {
      const row = native.prepare("SELECT count(*) as c FROM memories").get() as
        | { c: number }
        | undefined;
      return Number(row?.c ?? 0);
    },
  };
}
