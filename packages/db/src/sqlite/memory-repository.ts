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

interface MemoryRow {
  id: number;
  title: string;
  content: string;
  tags: string | null;
  source: string;
  supersedes_id: number | null;
  created_at: string;
  updated_at: string;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function mapMemoryRow(row: MemoryRow): StoredMemory {
  return {
    id: Number(row.id),
    title: String(row.title),
    content: String(row.content),
    tags: String(row.tags ?? ""),
    source: String(row.source),
    supersedesId:
      row.supersedes_id !== null && row.supersedes_id !== undefined
        ? Number(row.supersedes_id)
        : null,
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
      supersedesId?: number | null;
    }): Promise<number> {
      const now = new Date().toISOString();
      const res = native
        .prepare(
          "INSERT INTO memories (title, content, tags, source, supersedes_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          input.title,
          input.content,
          input.tags ?? "",
          input.source,
          input.supersedesId ?? null,
          now,
          now,
        );
      return Number(res.lastInsertRowid);
    },

    async getMemory(id: number): Promise<StoredMemory | null> {
      // SAFETY: Query selects directly from memories table matching MemoryRow schema.
      const row = native.prepare("SELECT * FROM memories WHERE id = ?").get(id) as
        | MemoryRow
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
      // SAFETY: Query selects m.* from memories table matching MemoryRow schema.
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
        .all(...termParams, normalized, phrasePattern, limit) as Array<MemoryRow>;
      return rows.map(mapMemoryRow);
    },
  };
}
