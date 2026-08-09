import type { NativeDatabase } from "./shared-types";
import { safeParseJson, sanitizeFtsQuery } from "./utils";

export const FTS_SCHEMA_VERSION = "2";

export function composeFtsSearchText(content: string, metadata: string): string {
  const parsed = safeParseJson(metadata, {}) as { searchText?: unknown };
  const searchText = typeof parsed.searchText === "string" ? parsed.searchText.trim() : "";
  return searchText ? `${searchText}\n${content}` : content;
}

export function composeFtsSearchTextSql(metadata: string, content: string): string {
  return `CASE
    WHEN json_valid(${metadata}) THEN CASE
      WHEN json_type(${metadata}, '$.searchText') = 'text'
        THEN trim(json_extract(${metadata}, '$.searchText'))
      ELSE ''
    END
    ELSE ''
  END || char(10) || ${content}`;
}

/**
 * Prepared statements used by the FTS operations.
 *
 * These are prepared once in `createWorkspaceRepository()` (the facade in
 * `workspace-repository.ts`) and reused across thousands of calls. Only the
 * statements needed by this module are declared here; the remaining
 * statements are declared in the other split repository modules
 * (`document-repository.ts`, `graph-ops-shared.ts`, `embedding-repository.ts`).
 */
export interface FtsStmts {
  insertFtsRow: ReturnType<NativeDatabase["prepare"]>;
}

/**
 * Dependencies that the FTS lifecycle methods need from the parent repository.
 *
 * `ensureFtsReady` reads/writes the `index_meta` table via `getMeta`/`setMeta`
 * (which are defined in the `workspace-repository.ts` facade). Passing them in
 * keeps the FTS module decoupled from the meta/lifecycle operations.
 */
export interface FtsOpsDeps {
  getMeta: (key: string) => string | null;
  setMeta: (key: string, value: string) => void;
}

/**
 * Factory for full-text-search and FTS lifecycle operations extracted from
 * `createWorkspaceRepository()`.
 *
 * Behavior is identical to the original inline implementations — this is a
 * pure code-move. `ensureFtsReady` and `restoreFtsTriggers` depend on
 * `getMeta`/`setMeta` from the parent repository; those are passed in via
 * `deps` to avoid a circular dependency on the meta/lifecycle module.
 */
export function createFtsOps(native: NativeDatabase, stmts: FtsStmts, deps: FtsOpsDeps) {
  return {
    // ── Chunk Operations (FTS bulk insert) ──

    async bulkInsertFts(
      inputs: Array<{
        chunkId: string;
        path: string;
        heading: string | null;
        language: string | null;
        content: string;
        metadata: string;
      }>,
    ): Promise<void> {
      if (inputs.length === 0) return;
      const BATCH = 2000;
      for (let i = 0; i < inputs.length; i += BATCH) {
        const batch = inputs.slice(i, i + BATCH);
        const placeholders = batch.map(() => "(?, ?, ?, ?, ?)").join(",");
        const params: unknown[] = [];
        for (const item of batch) {
          const searchText = composeFtsSearchText(item.content, item.metadata);
          params.push(item.chunkId, item.path, item.heading ?? "", item.language ?? "", searchText);
        }
        native
          .prepare(
            `INSERT INTO chunks_fts (chunk_id, path, heading, language, search_text) VALUES ${placeholders}`,
          )
          .run(...params);
      }
    },

    // ── Full-Text Search ──

    async fullTextSearch(query: string, limit: number) {
      const ftsQuery = sanitizeFtsQuery(query);
      if (!ftsQuery) return [];

      this.ensureFtsReady();

      const rows = native
        .prepare(
          `SELECT
            chunks.id, chunks.content, chunks.heading, chunks.metadata,
            documents.path,
            bm25(chunks_fts, 0, 4, 3, 1.5, 2)
              * CASE
                  WHEN documents.path LIKE 'tests/%' OR documents.path LIKE '%/__tests__/%' OR documents.path GLOB '*.test.*' THEN 0.8
                  WHEN documents.kind = 'code' THEN 1.35
                  ELSE 1
                END AS bm25_score
           FROM chunks_fts
           INNER JOIN chunks ON chunks.id = chunks_fts.chunk_id
           INNER JOIN documents ON documents.id = chunks.document_id
           WHERE chunks_fts MATCH ?
           ORDER BY bm25_score ASC
           LIMIT ?`,
        )
        .all(ftsQuery, limit * 5) as Array<Record<string, unknown>>;

      const seenPaths = new Set<string>();
      return rows
        .map((row) => {
          const bm25 = Number(row.bm25_score ?? 0);
          // Convert bm25 (lower = better) to a 0-1 score (higher = better)
          const score = -bm25;
          return {
            id: String(row.id),
            path: String(row.path),
            content: String(row.content),
            score,
            heading: row.heading ? String(row.heading) : null,
            metadata: safeParseJson(String(row.metadata ?? ""), {}) as Record<string, unknown>,
          };
        })
        .filter((row) => {
          if (seenPaths.has(row.path)) return false;
          seenPaths.add(row.path);
          return true;
        })
        .slice(0, limit);
    },

    dropFtsTriggers(): void {
      native.exec("DROP TRIGGER IF EXISTS chunks_fts_insert");
      native.exec("DROP TRIGGER IF EXISTS chunks_fts_delete");
      native.exec("DROP TRIGGER IF EXISTS chunks_fts_update");
    },

    dropNonUniqueIndexes(): void {
      native.exec("DROP INDEX IF EXISTS idx_chunks_document_id");
      native.exec("DROP INDEX IF EXISTS idx_chunks_content_hash");
      native.exec("DROP INDEX IF EXISTS idx_graph_nodes_type");
      native.exec("DROP INDEX IF EXISTS idx_graph_nodes_label");
      native.exec("DROP INDEX IF EXISTS idx_graph_edges_from");
      native.exec("DROP INDEX IF EXISTS idx_graph_edges_to");
      native.exec("DROP INDEX IF EXISTS idx_graph_edges_type");
      native.exec("DROP INDEX IF EXISTS idx_embeddings_chunk_id");
    },

    restoreNonUniqueIndexes(): void {
      native.exec("CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON chunks(document_id)");
      native.exec("CREATE INDEX IF NOT EXISTS idx_chunks_content_hash ON chunks(content_hash)");
      native.exec("CREATE INDEX IF NOT EXISTS idx_graph_nodes_type ON graph_nodes(type)");
      native.exec("CREATE INDEX IF NOT EXISTS idx_graph_nodes_label ON graph_nodes(label)");
      native.exec("CREATE INDEX IF NOT EXISTS idx_graph_edges_from ON graph_edges(from_node_id)");
      native.exec("CREATE INDEX IF NOT EXISTS idx_graph_edges_to ON graph_edges(to_node_id)");
      native.exec("CREATE INDEX IF NOT EXISTS idx_graph_edges_type ON graph_edges(type)");
      native.exec("CREATE INDEX IF NOT EXISTS idx_embeddings_chunk_id ON embeddings(chunk_id)");
    },

    insertFtsBatch(
      rows: Array<{
        chunkId: string;
        path: string;
        heading: string;
        language: string;
        content: string;
        metadata: string;
      }>,
    ): void {
      if (rows.length === 0) return;
      const BATCH = 500;
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        const placeholders = batch.map(() => "(?, ?, ?, ?, ?)").join(",");
        const params: unknown[] = [];
        for (const r of batch) {
          params.push(
            r.chunkId,
            r.path,
            r.heading,
            r.language,
            composeFtsSearchText(r.content, r.metadata),
          );
        }
        native
          .prepare(
            `INSERT INTO chunks_fts (chunk_id, path, heading, language, search_text) VALUES ${placeholders}`,
          )
          .run(...params);
      }
    },

    streamFtsRow(input: {
      chunkId: string;
      path: string;
      heading: string;
      language: string;
      content: string;
      metadata: string;
    }): void {
      stmts.insertFtsRow.run(
        input.chunkId,
        input.path,
        input.heading,
        input.language,
        composeFtsSearchText(input.content, input.metadata),
      );
    },

    ensureFtsReady(): void {
      if (deps.getMeta("fts_schema_version") === FTS_SCHEMA_VERSION) return;
      native.exec("BEGIN IMMEDIATE");
      try {
        if (deps.getMeta("fts_schema_version") === FTS_SCHEMA_VERSION) {
          native.exec("COMMIT");
          return;
        }
        native.exec("DELETE FROM chunks_fts");
        native.exec(`
          INSERT INTO chunks_fts (chunk_id, path, heading, language, search_text)
          SELECT c.id, d.path, coalesce(c.heading, ''), coalesce(d.language, ''),
            ${composeFtsSearchTextSql("c.metadata", "c.content")}
          FROM chunks c
          JOIN documents d ON d.id = c.document_id;
        `);

        restoreFtsTriggerDefinitions(native, { withinTransaction: true });
        deps.setMeta("fts_schema_version", FTS_SCHEMA_VERSION);
        native.exec("COMMIT");
      } catch (error) {
        try {
          native.exec("ROLLBACK");
        } catch {}
        throw error;
      }
    },

    restoreFtsTriggers(): void {
      // Remove orphaned FTS entries
      native.exec("DELETE FROM chunks_fts WHERE chunk_id NOT IN (SELECT id FROM chunks)");

      // Backfill missing FTS entries via SQL (content is uncompressed TEXT)
      native.exec(`
        INSERT INTO chunks_fts (chunk_id, path, heading, language, search_text)
        SELECT c.id, d.path, coalesce(c.heading, ''),
          coalesce(d.language, ''),
          ${composeFtsSearchTextSql("c.metadata", "c.content")}
        FROM chunks c
        INNER JOIN documents d ON d.id = c.document_id
        LEFT JOIN chunks_fts f ON f.chunk_id = c.id
        WHERE f.chunk_id IS NULL;
      `);

      restoreFtsTriggerDefinitions(native);
    },

    restoreFtsTriggersOnly(): void {
      restoreFtsTriggerDefinitions(native);
    },

    // ── Reset ──

    resetIndexArtifacts(): void {
      native.exec("DELETE FROM graph_edges");
      native.exec("DELETE FROM graph_nodes");
      native.exec("DELETE FROM embeddings");
      native.exec("DELETE FROM chunks");
      native.exec("DELETE FROM documents");
    },
  };
}

export function restoreFtsTriggerDefinitions(
  native: NativeDatabase,
  options: { withinTransaction?: boolean } = {},
): void {
  const replaceDefinitions = () => {
    // Recreate rather than IF NOT EXISTS so stale trigger definitions are upgraded.
    native.exec("DROP TRIGGER IF EXISTS chunks_fts_insert");
    native.exec("DROP TRIGGER IF EXISTS chunks_fts_delete");
    native.exec("DROP TRIGGER IF EXISTS chunks_fts_update");
    native.exec(`
      CREATE TRIGGER chunks_fts_insert AFTER INSERT ON chunks
      BEGIN
        INSERT INTO chunks_fts (chunk_id, path, heading, language, search_text)
        SELECT new.id, documents.path, coalesce(new.heading, ''),
          coalesce(documents.language, ''),
          ${composeFtsSearchTextSql("new.metadata", "new.content")}
        FROM documents WHERE documents.id = new.document_id;
      END;
    `);
    native.exec(`
      CREATE TRIGGER chunks_fts_delete AFTER DELETE ON chunks
      BEGIN
        DELETE FROM chunks_fts WHERE chunk_id = old.id;
      END;
    `);
    native.exec(`
      CREATE TRIGGER chunks_fts_update AFTER UPDATE ON chunks
      BEGIN
        DELETE FROM chunks_fts WHERE chunk_id = old.id;
        INSERT INTO chunks_fts (chunk_id, path, heading, language, search_text)
        SELECT new.id, documents.path, coalesce(new.heading, ''),
          coalesce(documents.language, ''),
          ${composeFtsSearchTextSql("new.metadata", "new.content")}
        FROM documents WHERE documents.id = new.document_id;
      END;
    `);
  };

  if (options.withinTransaction) {
    replaceDefinitions();
    return;
  }

  native.exec("BEGIN IMMEDIATE");
  try {
    replaceDefinitions();
    native.exec("COMMIT");
  } catch (error) {
    try {
      native.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}
