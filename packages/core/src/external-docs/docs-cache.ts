import crypto from "node:crypto";

import { getRegistryDb } from "@openez-graph/db";

interface NativeDb {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
}

function getNativeDb(): NativeDb {
  const db = getRegistryDb();
  return (db as unknown as { $client: NativeDb }).$client;
}

export interface CachedDoc {
  content: string;
  tokens: number;
  stale: boolean;
  fetchedAt: number;
}

export interface DocsCache {
  getDocs(input: {
    libraryId: string;
    version: string;
    topic?: string;
    now: number;
  }): Promise<CachedDoc | null>;

  findAnyByQuery(input: {
    query: string;
    topic?: string;
    version: string;
  }): Promise<CachedDoc | null>;

  storeDocs(input: {
    libraryId: string;
    libraryName: string;
    version: string;
    topic?: string;
    content: string;
    tokens: number;
    ttlMs: number;
  }): Promise<void>;

  recordNameMapping(queryName: string, libraryId: string): Promise<void>;
}

interface CacheRow {
  content: string;
  tokens: number;
  fetched_at: number;
  expires_at: number;
}

export function createDocsCache(): DocsCache {
  const native = getNativeDb();

  return {
    async getDocs({ libraryId, version, topic, now }): Promise<CachedDoc | null> {
      const row = native
        .prepare(
          `SELECT content, tokens, fetched_at, expires_at
           FROM library_docs_cache
           WHERE library_id = ? AND version = ? AND topic IS ?`,
        )
        .get(libraryId, version, topic ?? null) as CacheRow | undefined;

      if (!row) return null;

      const stale = row.expires_at <= now;
      native
        .prepare(
          `UPDATE library_docs_cache
           SET hit_count = hit_count + 1, last_accessed_at = ?
           WHERE library_id = ? AND version = ? AND topic IS ?`,
        )
        .run(now, libraryId, version, topic ?? null);

      return {
        content: row.content,
        tokens: row.tokens,
        stale,
        fetchedAt: row.fetched_at,
      };
    },

    async findAnyByQuery({ query, topic, version }): Promise<CachedDoc | null> {
      const mapping = native
        .prepare("SELECT library_id FROM library_docs_name_map WHERE query_name = ?")
        .get(query) as { library_id: string } | undefined;

      if (!mapping) return null;

      return this.getDocs({
        libraryId: mapping.library_id,
        version,
        topic,
        now: Date.now(),
      });
    },

    async storeDocs({
      libraryId,
      libraryName,
      version,
      topic,
      content,
      tokens,
      ttlMs,
    }): Promise<void> {
      const now = Date.now();
      const contentHash = crypto.createHash("sha256").update(content).digest("hex");
      const expiresAt = now + ttlMs;

      // SQLite treats NULL as distinct in UNIQUE constraints, so ON CONFLICT
      // never fires for NULL-topic rows. Delete the matching row first, then
      // insert — this gives correct upsert semantics for both NULL and
      // non-NULL topics.
      native
        .prepare(
          `DELETE FROM library_docs_cache
           WHERE library_id = ? AND version = ? AND topic IS ?`,
        )
        .run(libraryId, version, topic ?? null);

      native
        .prepare(
          `INSERT INTO library_docs_cache
             (library_id, library_name, version, topic, content, content_hash, tokens,
              fetched_at, expires_at, hit_count, last_accessed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        )
        .run(
          libraryId,
          libraryName,
          version,
          topic ?? null,
          content,
          contentHash,
          tokens,
          now,
          expiresAt,
          now,
        );
    },

    async recordNameMapping(queryName, libraryId): Promise<void> {
      const now = Date.now();
      native
        .prepare(
          `INSERT INTO library_docs_name_map (query_name, library_id, resolved_at)
           VALUES (?, ?, ?)
           ON CONFLICT(query_name, library_id) DO UPDATE SET resolved_at = excluded.resolved_at`,
        )
        .run(queryName, libraryId, now);
    },
  };
}
