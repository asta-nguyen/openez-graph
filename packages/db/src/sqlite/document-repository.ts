import { drizzle } from "drizzle-orm/bun-sqlite";
import { asc, count, eq, inArray, sql } from "drizzle-orm";

import { createChunkOps } from "./chunk-repository";
import * as schema from "./schema";
import type { NativeDatabase, StreamTimestampHolder } from "./shared-types";

/**
 * Prepared statements used by the document operations.
 *
 * These are prepared once in `createWorkspaceRepository()` and reused across
 * thousands of calls. Chunk statements live in `ChunkStmts`
 * (see `chunk-repository.ts`); the two interfaces are intentionally kept
 * separate so each module only declares what it needs.
 *
 * NOTE: After migration to the Drizzle query builder, the prepared statements
 * are no longer used directly by the document ops. They remain in the interface
 * for backwards compatibility with `createWorkspaceRepository()` which still
 * prepares them.
 */
export interface DocumentStmts {
  docByPath: ReturnType<NativeDatabase["prepare"]>;
  docById: ReturnType<NativeDatabase["prepare"]>;
  insertDoc: ReturnType<NativeDatabase["prepare"]>;
  insertParsedDoc: ReturnType<NativeDatabase["prepare"]>;
}

type DocumentRow = typeof schema.documents.$inferSelect;

function mapDocumentRow(row: any) {
  return {
    id: Number(row.id),
    path: String(row.path),
    absolutePath: String(row.absolutePath ?? row.absolute_path),
    kind: String(row.kind),
    language: row.language ? String(row.language) : null,
    contentHash: String(row.contentHash ?? row.content_hash),
    sizeBytes: Number(row.sizeBytes ?? row.size_bytes),
    mtimeMs: Number(row.mtimeMs ?? row.mtime_ms),
    createdAt: String(row.createdAt ?? row.created_at),
    updatedAt: String(row.updatedAt ?? row.updated_at),
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
export function createDocumentOps(native: NativeDatabase, streamNow: StreamTimestampHolder) {
  // SAFETY: Drizzle's bun-sqlite adapter expects a `Database` instance from
  // `bun:sqlite`; `NativeDatabase` is structurally compatible (exposes the
  // same prepare/exec/pragma methods). The `as any` bridges the structural
  // mismatch without affecting runtime behavior.
  const db = drizzle(native as any, { schema });

  const chunkOps = createChunkOps(native, streamNow);

  return {
    async getDocumentCount(): Promise<number> {
      const row = db.select({ count: count() }).from(schema.documents).get();
      return row?.count ?? 0;
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
      path: string;
      absolutePath: string;
      kind: string;
      language: string | null;
      contentHash: string;
      sizeBytes: number;
      mtimeMs: number;
    }) {
      const now = new Date().toISOString();
      const row = db
        .insert(schema.documents)
        .values({
          path: input.path,
          absolutePath: input.absolutePath,
          kind: input.kind,
          language: input.language,
          contentHash: input.contentHash,
          sizeBytes: input.sizeBytes,
          mtimeMs: input.mtimeMs,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: schema.documents.id })
        .get();
      return row!.id;
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
      const stmt = native.prepare(
        "INSERT INTO documents (path, absolute_path, kind, language, content_hash, size_bytes, mtime_ms, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const ids: number[] = Array.from({ length: inputs.length });
      for (let i = 0; i < inputs.length; i++) {
        const item = inputs[i];
        const res = stmt.run(
          item.path,
          item.absolutePath,
          item.kind,
          item.language ?? null,
          item.contentHash,
          item.sizeBytes,
          item.mtimeMs,
          now,
          now,
        ) as { lastInsertRowid: number };
        ids[i] = Number(res.lastInsertRowid);
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
      const set: Partial<typeof schema.documents.$inferInsert> = {
        updatedAt: new Date().toISOString(),
      };
      if (updates.absolutePath !== undefined) set.absolutePath = updates.absolutePath;
      if (updates.kind !== undefined) set.kind = updates.kind;
      if (updates.language !== undefined) set.language = updates.language;
      if (updates.contentHash !== undefined) set.contentHash = updates.contentHash;
      if (updates.sizeBytes !== undefined) set.sizeBytes = updates.sizeBytes;
      if (updates.mtimeMs !== undefined) set.mtimeMs = updates.mtimeMs;
      db.update(schema.documents).set(set).where(eq(schema.documents.id, id)).run();
    },

    async deleteDocument(id: number) {
      db.delete(schema.documents).where(eq(schema.documents.id, id)).run();
    },

    async listDocuments() {
      const rows = native
        .query(
          "SELECT id, path, absolute_path, kind, language, content_hash, size_bytes, mtime_ms, created_at, updated_at FROM documents ORDER BY path",
        )
        .all() as Array<Record<string, unknown>>;
      return rows.map(mapDocumentRow);
    },

    // ── Streaming inserts (document) ──

    streamDocument(input: {
      id: number;
      path: string;
      absolutePath: string;
      kind: string;
      language?: string | null;
      contentHash: string;
      sizeBytes: number;
      mtimeMs: number;
    }): void {
      const now = streamNow.value;
      db.insert(schema.documents)
        .values({
          path: input.path,
          absolutePath: input.absolutePath,
          kind: input.kind,
          language: input.language ?? null,
          contentHash: input.contentHash,
          sizeBytes: input.sizeBytes,
          mtimeMs: input.mtimeMs,
          createdAt: now,
          updatedAt: now,
        })
        .run();
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
      this.insertParsedDocumentsBatch([input]);
    },

    insertParsedDocumentsBatch(
      inputs: Array<{
        documentId: number;
        contentHash: string;
        symbols: string;
        imports: string;
        calls: string;
        calledIdentifiers: string;
        parserVersion: string;
      }>,
    ): void {
      if (inputs.length === 0) return;
      const now = Date.now();
      const stmt = native.prepare(
        "INSERT OR REPLACE INTO parsed_documents (document_id, content_hash, symbols, imports, calls, called_identifiers, parser_version, parsed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (let i = 0; i < inputs.length; i++) {
        const doc = inputs[i];
        stmt.run(
          doc.documentId,
          doc.contentHash,
          doc.symbols,
          doc.imports,
          doc.calls,
          doc.calledIdentifiers,
          doc.parserVersion,
          now,
        );
      }
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
        documentId: Number(row.documentId),
        contentHash: String(row.contentHash),
        symbols: row.symbols ?? null,
        imports: row.imports ?? null,
        calls: row.calls ?? null,
        calledIdentifiers: row.calledIdentifiers ?? null,
        parserVersion: row.parserVersion ?? null,
        parsedAt: Number(row.parsedAt),
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
