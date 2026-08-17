import { asc, count, eq, inArray } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "./schema";
import { createChunkOps, type ChunkStmts } from "./chunk-repository";
import type { NativeDatabase, StreamTimestampHolder } from "./shared-types";

export type WorkspaceDrizzleDb = ReturnType<typeof drizzle>;

/**
 * Prepared statements used by the document operations.
 *
 * These are prepared once in `createWorkspaceRepository()` and reused across
 * thousands of calls. Chunk statements live in `ChunkStmts`
 * (see `chunk-repository.ts`); the two interfaces are intentionally kept
 * separate so each module only declares what it needs.
 */
export interface DocumentStmts {
  docByPath: ReturnType<NativeDatabase["prepare"]>;
  docById: ReturnType<NativeDatabase["prepare"]>;
  insertDoc: ReturnType<NativeDatabase["prepare"]>;
  insertDocWithId: ReturnType<NativeDatabase["prepare"]>;
}

function mapDocumentRow(row: typeof schema.documents.$inferSelect) {
  return {
    id: row.id,
    path: row.path,
    absolutePath: row.absolutePath,
    kind: row.kind,
    language: row.language,
    contentHash: row.contentHash,
    sizeBytes: row.sizeBytes,
    mtimeMs: row.mtimeMs,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Factory for document and parsed_documents operations extracted from
 * `createWorkspaceRepository()`.
 *
 * Behavior is identical to the original inline implementations — this is a
 * pure code-move. `streamNow` is shared via a mutable holder so that
 * `refreshStreamTimestamp()` (defined here) stays visible to the graph/edge/fts
 * stream methods that now live in their respective split modules
 * (`graph-repository.ts`, `fts-repository.ts`), and to the chunk stream
 * methods that live in `chunk-repository.ts`.
 *
 * Chunk operations are composed in from `createChunkOps()` so callers of
 * `createDocumentOps()` continue to receive a single merged ops object.
 */
export function createDocumentOps(
  db: WorkspaceDrizzleDb,
  native: NativeDatabase,
  stmts: DocumentStmts & ChunkStmts,
  streamNow: StreamTimestampHolder,
) {
  const chunkOps = createChunkOps(db, native, stmts, streamNow);

  return {
    async getDocumentCount(): Promise<number> {
      const res = db.select({ count: count() }).from(schema.documents).get();
      return res?.count ?? 0;
    },

    // ── Document Operations ──

    async getDocument(id: number) {
      const row = db.select().from(schema.documents).where(eq(schema.documents.id, id)).get();
      return row ? mapDocumentRow(row) : null;
    },

    async getDocumentByPath(path: string) {
      const row = db.select().from(schema.documents).where(eq(schema.documents.path, path)).get();
      return row ? mapDocumentRow(row) : null;
    },

    async insertDocument(input: {
      id?: number;
      path: string;
      absolutePath: string;
      kind: string;
      language: string | null;
      contentHash: string;
      sizeBytes: number;
      mtimeMs: number;
    }): Promise<number> {
      const now = new Date().toISOString();
      if (input.id !== undefined) {
        stmts.insertDocWithId.run(
          input.id,
          input.path,
          input.absolutePath,
          input.kind,
          input.language,
          input.contentHash,
          input.sizeBytes,
          input.mtimeMs,
          now,
          now,
        );
        return input.id;
      }
      const res = stmts.insertDoc.run(
        input.path,
        input.absolutePath,
        input.kind,
        input.language,
        input.contentHash,
        input.sizeBytes,
        input.mtimeMs,
        now,
        now,
      );
      return Number(res.lastInsertRowid);
    },

    async insertDocumentsBatch(
      inputs: Array<{
        path: string;
        absolutePath: string;
        kind: string;
        language?: string | null;
        contentHash: string;
        sizeBytes: number;
        mtimeMs: number;
      }>,
    ): Promise<number[]> {
      if (inputs.length === 0) return [];
      const now = new Date().toISOString();
      const ids: number[] = [];
      const BATCH = 500;
      for (let i = 0; i < inputs.length; i += BATCH) {
        const batch = inputs.slice(i, i + BATCH);
        for (const item of batch) {
          const res = stmts.insertDoc.run(
            item.path,
            item.absolutePath,
            item.kind,
            item.language ?? null,
            item.contentHash,
            item.sizeBytes,
            item.mtimeMs,
            now,
            now,
          );
          ids.push(Number(res.lastInsertRowid));
        }
      }
      return ids;
    },

    async updateDocument(
      id: number,
      updates: Partial<{
        absolutePath: string;
        kind: string;
        language: string | null;
        contentHash: string;
        sizeBytes: number;
        mtimeMs: number;
      }>,
    ) {
      const sets: string[] = ["updated_at = ?"];
      const params: unknown[] = [new Date().toISOString()];
      if (updates.absolutePath !== undefined) {
        sets.push("absolute_path = ?");
        params.push(updates.absolutePath);
      }
      if (updates.kind !== undefined) {
        sets.push("kind = ?");
        params.push(updates.kind);
      }
      if (updates.language !== undefined) {
        sets.push("language = ?");
        params.push(updates.language);
      }
      if (updates.contentHash !== undefined) {
        sets.push("content_hash = ?");
        params.push(updates.contentHash);
      }
      if (updates.sizeBytes !== undefined) {
        sets.push("size_bytes = ?");
        params.push(updates.sizeBytes);
      }
      if (updates.mtimeMs !== undefined) {
        sets.push("mtime_ms = ?");
        params.push(updates.mtimeMs);
      }
      params.push(id);
      native.prepare(`UPDATE documents SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    },

    async deleteDocument(id: number) {
      db.delete(schema.parsedDocuments).where(eq(schema.parsedDocuments.documentId, id)).run();
      db.delete(schema.documents).where(eq(schema.documents.id, id)).run();
    },

    async listDocuments() {
      const rows = db.select().from(schema.documents).orderBy(asc(schema.documents.path)).all();
      return rows.map(mapDocumentRow);
    },

    // ── Streaming inserts (document) ──

    streamDocument(input: {
      id?: number;
      path: string;
      absolutePath: string;
      kind: string;
      language?: string | null;
      contentHash: string;
      sizeBytes: number;
      mtimeMs: number;
    }): void {
      const now = streamNow.value;
      if (input.id !== undefined) {
        stmts.insertDocWithId.run(
          input.id,
          input.path,
          input.absolutePath,
          input.kind,
          input.language ?? null,
          input.contentHash,
          input.sizeBytes,
          input.mtimeMs,
          now,
          now,
        );
        return;
      }
      stmts.insertDoc.run(
        input.path,
        input.absolutePath,
        input.kind,
        input.language ?? null,
        input.contentHash,
        input.sizeBytes,
        input.mtimeMs,
        now,
        now,
      );
    },

    refreshStreamTimestamp(): void {
      streamNow.value = new Date().toISOString();
    },

    // ── parsed_documents cache ──

    insertParsedDocument(input: {
      documentId: number;
      contentHash: string;
      symbols: string;
      imports: string;
      calls: string;
      calledIdentifiers: string;
      parserVersion: string;
    }): void {
      const now = Date.now();
      native
        .prepare(
          `INSERT OR REPLACE INTO parsed_documents (document_id, content_hash, symbols, imports, calls, called_identifiers, parser_version, parsed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.documentId,
          input.contentHash,
          input.symbols,
          input.imports,
          input.calls,
          input.calledIdentifiers,
          input.parserVersion,
          now,
        );
    },

    getParsedDocument(documentId: number): {
      documentId: number;
      contentHash: string;
      symbols: string | null;
      imports: string | null;
      calls: string | null;
      calledIdentifiers: string | null;
      parserVersion: string | null;
      parsedAt: number;
    } | null {
      const row = db
        .select()
        .from(schema.parsedDocuments)
        .where(eq(schema.parsedDocuments.documentId, documentId))
        .get();
      if (!row) return null;
      return {
        documentId: row.documentId,
        contentHash: row.contentHash,
        symbols: row.symbols,
        imports: row.imports,
        calls: row.calls,
        calledIdentifiers: row.calledIdentifiers,
        parserVersion: row.parserVersion,
        parsedAt: row.parsedAt,
      };
    },

    /**
     * Explicit delete for parsed_documents entries. Normally not needed because
     * the `parsed_documents` table has `ON DELETE CASCADE` referencing `documents(id)`.
     * Kept for manual cleanup scenarios.
     */
    deleteParsedDocumentsByDocumentIds(documentIds: number[]): void {
      if (documentIds.length === 0) return;
      db.delete(schema.parsedDocuments)
        .where(inArray(schema.parsedDocuments.documentId, documentIds))
        .run();
    },

    // ── Chunk operations (composed from chunk-repository.ts) ──

    ...chunkOps,
  };
}
