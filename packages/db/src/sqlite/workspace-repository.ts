import { eq } from "drizzle-orm";

import { createDocumentOps } from "./document-repository";
import { createEmbeddingOps } from "./embedding-repository";
import { createFtsOps } from "./fts-repository";
import { createGraphOps } from "./graph-repository";
import { createMemoryOps } from "./memory-repository";
import * as schema from "./schema";
import type { DatabaseValue, NativeDatabase, StreamTimestampHolder } from "./shared-types";
import type { WorkspaceRepository } from "./types";
import { getWorkspaceDb, getWorkspaceNativeDb } from "./workspace-db";

function getNativeWorkspaceDb(rootPath: string) {
  const db = getWorkspaceDb(rootPath);
  const native = getWorkspaceNativeDb(rootPath);
  return { db, native } satisfies { db: ReturnType<typeof getWorkspaceDb>; native: NativeDatabase };
}

export function createWorkspaceRepository(rootPath: string): WorkspaceRepository {
  const { db, native } = getNativeWorkspaceDb(rootPath);

  const streamNow: StreamTimestampHolder = { value: new Date().toISOString() };

  const documentOps = createDocumentOps(native, streamNow);

  const getMeta = (key: string): string | null => {
    const row = db
      .select({ value: schema.indexMeta.value })
      .from(schema.indexMeta)
      .where(eq(schema.indexMeta.key, key))
      .get();
    return row?.value ?? null;
  };
  const setMeta = (key: string, value: string): void => {
    db.insert(schema.indexMeta)
      .values({ key, value })
      .onConflictDoUpdate({ target: schema.indexMeta.key, set: { value } })
      .run();
  };

  const graphOps = createGraphOps(native, streamNow);
  const ftsOps = createFtsOps(native, { getMeta, setMeta });
  const embeddingOps = createEmbeddingOps(native);
  const memoryOps = createMemoryOps(native);

  return {
    rootPath,
    ...documentOps,
    ...graphOps,
    ...ftsOps,
    ...embeddingOps,
    ...memoryOps,

    // ── Index Run Operations ──

    async createIndexRun(input) {
      const now = new Date().toISOString();
      // Drizzle's bun-sqlite adapter types .run() as void, so we assign to
      // unknown first, then narrow to the RunResult shape below.
      const raw: unknown = db
        .insert(schema.indexRuns)
        .values({
          mode: input.mode,
          status: "running",
          filesScanned: 0,
          filesUpdated: 0,
          chunksWritten: 0,
          embeddingsWritten: 0,
          startedAt: now,
        })
        .run();
      // SAFETY: db.insert(...).values(...).run() returns the bun:sqlite
      // RunResult with lastInsertRowid (INTEGER rowid of the inserted row);
      // the cast narrows unknown to that shape.
      const result = raw as { lastInsertRowid: number };
      return Number(result.lastInsertRowid);
    },

    async completeIndexRun(id, updates) {
      const now = new Date().toISOString();
      const set: Partial<typeof schema.indexRuns.$inferInsert> = { finishedAt: now };
      if (updates.status !== undefined) {
        set.status = updates.status;
      }
      if (updates.filesScanned !== undefined) {
        set.filesScanned = updates.filesScanned;
      }
      if (updates.filesUpdated !== undefined) {
        set.filesUpdated = updates.filesUpdated;
      }
      if (updates.chunksWritten !== undefined) {
        set.chunksWritten = updates.chunksWritten;
      }
      if (updates.embeddingsWritten !== undefined) {
        set.embeddingsWritten = updates.embeddingsWritten;
      }
      if (updates.errorMessage !== undefined) {
        set.errorMessage = updates.errorMessage;
      }
      db.update(schema.indexRuns).set(set).where(eq(schema.indexRuns.id, id)).run();
    },

    // ── Query Log Operations ──

    async insertQueryLog(input) {
      const now = new Date().toISOString();
      // Drizzle's bun-sqlite adapter types .run() as void, so we assign to
      // unknown first, then narrow to the RunResult shape below.
      const raw: unknown = db
        .insert(schema.queryLogs)
        .values({
          query: input.query,
          mode: input.mode,
          resultCount: input.resultCount,
          tokensReturned: input.tokensReturned ?? 0,
          tokensSaved: input.tokensSaved ?? 0,
          filesScanned: input.filesScanned ?? 0,
          createdAt: now,
        })
        .run();
      // SAFETY: db.insert(...).values(...).run() returns the bun:sqlite
      // RunResult with lastInsertRowid (INTEGER rowid of the inserted row);
      // the cast narrows unknown to that shape.
      const result = raw as { lastInsertRowid: number };
      return Number(result.lastInsertRowid);
    },

    // ── Raw SQL queries ──

    async executeRaw(sqlQuery: string, params?: unknown[]) {
      if (params) {
        // SAFETY: executeRaw is a raw SQL escape hatch; callers are
        // responsible for passing SQLite-compatible bind values.
        return native.prepare(sqlQuery).run(...(params as DatabaseValue[]));
      }
      return native.prepare(sqlQuery).run();
    },

    async queryRaw(sqlQuery: string, params?: unknown[]) {
      if (params) {
        // SAFETY: queryRaw is a raw SQL escape hatch; callers are responsible
        // for passing SQLite-compatible bind values (DatabaseValue[]).
        return native.prepare(sqlQuery).all(...(params as DatabaseValue[]));
      }
      return native.prepare(sqlQuery).all();
    },

    async transaction<T>(fn: () => T | Promise<T>): Promise<T> {
      native.exec("BEGIN");
      try {
        const result = await fn();
        native.exec("COMMIT");
        return result;
      } catch (error) {
        native.exec("ROLLBACK");
        throw error;
      }
    },

    setOptimizedWriteMode(enabled: boolean): void {
      if (enabled) {
        native.pragma("journal_mode = WAL");
        native.pragma("synchronous = OFF");
        native.pragma("foreign_keys = OFF");
        native.pragma("cache_size = -131072");
        native.pragma("temp_store = MEMORY");
        native.pragma("mmap_size = 268435456");
        native.pragma("wal_autocheckpoint = 0");
        native.pragma("threads = 8");
      } else {
        native.pragma("synchronous = NORMAL");
        native.pragma("foreign_keys = ON");
        native.pragma("journal_mode = WAL");
        native.pragma("cache_size = -2000");
        native.pragma("temp_store = DEFAULT");
        native.pragma("wal_autocheckpoint = 1000");
      }
    },

    walCheckpoint(): void {
      native.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    },

    setMeta(key: string, value: string): void {
      db.insert(schema.indexMeta)
        .values({ key, value })
        .onConflictDoUpdate({ target: schema.indexMeta.key, set: { value } })
        .run();
    },

    getMeta(key: string): string | null {
      const row = db
        .select({ value: schema.indexMeta.value })
        .from(schema.indexMeta)
        .where(eq(schema.indexMeta.key, key))
        .get();
      return row?.value ?? null;
    },
  };
}
