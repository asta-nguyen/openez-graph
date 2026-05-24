import crypto from "node:crypto";

import { eq } from "drizzle-orm";

import { getRegistryDb } from "./registry-db";
import * as schema from "./schema";
import type { RegistryRepository, RegistryWorkspace, WorkspaceRepository } from "./types";
import { getWorkspaceDb } from "./workspace-db";

interface NativeDatabase {
  pragma(command: string): unknown;
  exec(sql: string): unknown;
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  };
}

function getNativeDb(db: ReturnType<typeof getRegistryDb>): NativeDatabase {
  return (db as unknown as { $client: NativeDatabase }).$client;
}

function normalizeRootPath(rootPath: string): string {
  return rootPath.trim().replace(/[\\/]+$/, "") || rootPath;
}

function slugifyWorkspaceSegment(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "workspace";
}

function displayNameForSuffix(baseName: string, suffix: number): string {
  return suffix <= 0 ? baseName : `${baseName} (${suffix + 1})`;
}

export function createRegistryRepository(): RegistryRepository {
  const db = getRegistryDb();
  const native = getNativeDb(db);

  return {
    async listWorkspaces(): Promise<RegistryWorkspace[]> {
      const rows = db.select().from(schema.workspaces).all();
      return rows.map(mapWorkspaceRow);
    },

    async getWorkspace(id: string): Promise<RegistryWorkspace | null> {
      const row = db.select().from(schema.workspaces).where(eq(schema.workspaces.id, id)).get();
      return row ? mapWorkspaceRow(row) : null;
    },

    async getWorkspaceByPath(rootPath: string): Promise<RegistryWorkspace | null> {
      const row = db
        .select()
        .from(schema.workspaces)
        .where(eq(schema.workspaces.rootPath, normalizeRootPath(rootPath)))
        .get();
      return row ? mapWorkspaceRow(row) : null;
    },

    async ensureWorkspace(input): Promise<RegistryWorkspace> {
      const normalizedRootPath = normalizeRootPath(input.rootPath);
      const existing = await this.getWorkspaceByPath(normalizedRootPath);
      if (existing) {
        return existing;
      }

      const requestedName = (input.name?.trim() || normalizeRootPath(normalizedRootPath).split(/[\\/]/).pop() || "workspace").trim();
      const baseId = slugifyWorkspaceSegment(requestedName);
      const allWorkspaces = await this.listWorkspaces();
      const takenIds = new Set(allWorkspaces.map((workspace) => workspace.id));
      const takenNames = new Set(allWorkspaces.map((workspace) => workspace.name));

      let suffix = 0;
      let nextId = baseId;
      let nextName = requestedName;

      while (takenIds.has(nextId) || takenNames.has(nextName)) {
        suffix += 1;
        nextId = `${baseId}-${suffix + 1}`;
        nextName = displayNameForSuffix(requestedName, suffix);
      }

      return this.createWorkspace({
        id: nextId,
        name: nextName,
        rootPath: normalizedRootPath,
        includeGlobs: input.includeGlobs,
        excludeGlobs: input.excludeGlobs
      });
    },

    async createWorkspace(input: {
      id: string;
      name: string;
      rootPath: string;
      includeGlobs?: string;
      excludeGlobs?: string;
    }): Promise<RegistryWorkspace> {
      const normalizedRootPath = normalizeRootPath(input.rootPath);
      const existing = await this.getWorkspaceByPath(normalizedRootPath);
      if (existing) {
        return existing;
      }

      const now = new Date().toISOString();
      native
        .prepare(
          `INSERT INTO workspaces (id, name, root_path, include_globs, exclude_globs, status, indexing_status, graph_status, document_count, chunk_count, node_count, edge_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'pending', 'pending', 'pending', 0, 0, 0, 0, ?, ?)`
        )
        .run(input.id, input.name, normalizedRootPath, input.includeGlobs ?? "", input.excludeGlobs ?? "", now, now);

      return (await this.getWorkspace(input.id))!;
    },

    async updateWorkspace(
      id: string,
      updates: Partial<
        Pick<
          RegistryWorkspace,
          | "status"
          | "indexingStatus"
          | "graphStatus"
          | "lastIndexedAt"
          | "lastGraphBuiltAt"
          | "documentCount"
          | "chunkCount"
          | "nodeCount"
          | "edgeCount"
          | "lastError"
        >
      >
    ): Promise<void> {
      const sets: string[] = ["updated_at = ?"];
      const params: unknown[] = [new Date().toISOString()];

      if (updates.status !== undefined) { sets.push("status = ?"); params.push(updates.status); }
      if (updates.indexingStatus !== undefined) { sets.push("indexing_status = ?"); params.push(updates.indexingStatus); }
      if (updates.graphStatus !== undefined) { sets.push("graph_status = ?"); params.push(updates.graphStatus); }
      if (updates.lastIndexedAt !== undefined) { sets.push("last_indexed_at = ?"); params.push(updates.lastIndexedAt); }
      if (updates.lastGraphBuiltAt !== undefined) { sets.push("last_graph_built_at = ?"); params.push(updates.lastGraphBuiltAt); }
      if (updates.documentCount !== undefined) { sets.push("document_count = ?"); params.push(updates.documentCount); }
      if (updates.chunkCount !== undefined) { sets.push("chunk_count = ?"); params.push(updates.chunkCount); }
      if (updates.nodeCount !== undefined) { sets.push("node_count = ?"); params.push(updates.nodeCount); }
      if (updates.edgeCount !== undefined) { sets.push("edge_count = ?"); params.push(updates.edgeCount); }
      if (updates.lastError !== undefined) { sets.push("last_error = ?"); params.push(updates.lastError); }

      params.push(id);
      native.prepare(`UPDATE workspaces SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    },

    async deleteWorkspace(id: string): Promise<void> {
      db.delete(schema.workspaces).where(eq(schema.workspaces.id, id)).run();
    }
  };
}

function mapWorkspaceRow(row: typeof schema.workspaces.$inferSelect): RegistryWorkspace {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.rootPath,
    includeGlobs: row.includeGlobs || "",
    excludeGlobs: row.excludeGlobs || "",
    status: row.status as RegistryWorkspace["status"],
    indexingStatus: row.indexingStatus as RegistryWorkspace["indexingStatus"],
    graphStatus: row.graphStatus as RegistryWorkspace["graphStatus"],
    lastIndexedAt: row.lastIndexedAt ?? undefined,
    lastGraphBuiltAt: row.lastGraphBuiltAt ?? undefined,
    documentCount: row.documentCount,
    chunkCount: row.chunkCount,
    nodeCount: row.nodeCount,
    edgeCount: row.edgeCount,
    lastError: row.lastError ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function getNativeWorkspaceDb(rootPath: string): { db: ReturnType<typeof getWorkspaceDb>; native: NativeDatabase } {
  const db = getWorkspaceDb(rootPath);
  const native = (db as unknown as { $client: NativeDatabase }).$client;
  return { db, native };
}

export function createWorkspaceRepository(rootPath: string): WorkspaceRepository {
  const { db, native } = getNativeWorkspaceDb(rootPath);

  return {
    rootPath,

    async getDocumentCount(): Promise<number> {
      const row = native.prepare("SELECT count(*) AS count FROM documents").get() as { count: number };
      return row?.count ?? 0;
    },

    async getChunkCount(): Promise<number> {
      const row = native.prepare("SELECT count(*) AS count FROM chunks").get() as { count: number };
      return row?.count ?? 0;
    },

    async getNodeCount(): Promise<number> {
      const row = native.prepare("SELECT count(*) AS count FROM graph_nodes").get() as { count: number };
      return row?.count ?? 0;
    },

    async getEdgeCount(): Promise<number> {
      const row = native.prepare("SELECT count(*) AS count FROM graph_edges").get() as { count: number };
      return row?.count ?? 0;
    },

    // ── Document Operations ──

    async getDocument(id: string) {
      const row = native.prepare("SELECT * FROM documents WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      return row ? mapDocumentRow(row) : null;
    },

    async getDocumentByPath(path: string) {
      const row = native.prepare("SELECT * FROM documents WHERE path = ?").get(path) as Record<string, unknown> | undefined;
      return row ? mapDocumentRow(row) : null;
    },

    async insertDocument(input) {
      const id = input.id ?? crypto.randomUUID();
      const now = new Date().toISOString();
      native
        .prepare(
          "INSERT INTO documents (id, path, absolute_path, kind, language, content_hash, size_bytes, mtime_ms, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(id, input.path, input.absolutePath, input.kind, input.language, input.contentHash, input.sizeBytes, input.mtimeMs, now, now);
      return id;
    },

    async updateDocument(id, updates) {
      const sets: string[] = ["updated_at = ?"];
      const params: unknown[] = [new Date().toISOString()];
      if (updates.absolutePath !== undefined) { sets.push("absolute_path = ?"); params.push(updates.absolutePath); }
      if (updates.kind !== undefined) { sets.push("kind = ?"); params.push(updates.kind); }
      if (updates.language !== undefined) { sets.push("language = ?"); params.push(updates.language); }
      if (updates.contentHash !== undefined) { sets.push("content_hash = ?"); params.push(updates.contentHash); }
      if (updates.sizeBytes !== undefined) { sets.push("size_bytes = ?"); params.push(updates.sizeBytes); }
      if (updates.mtimeMs !== undefined) { sets.push("mtime_ms = ?"); params.push(updates.mtimeMs); }
      params.push(id);
      native.prepare(`UPDATE documents SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    },

    async deleteDocument(id: string) {
      native.prepare("DELETE FROM documents WHERE id = ?").run(id);
    },

    async listDocuments() {
      const rows = native.prepare("SELECT * FROM documents ORDER BY path").all() as Array<Record<string, unknown>>;
      return rows.map(mapDocumentRow);
    },

    // ── Chunk Operations ──

    async getChunksByDocument(documentId: string) {
      const rows = native.prepare("SELECT * FROM chunks WHERE document_id = ? ORDER BY chunk_index").all(documentId) as Array<Record<string, unknown>>;
      return rows.map(mapChunkRow);
    },

    async insertChunks(inputs) {
      const now = new Date().toISOString();
      const stmt = native.prepare(
        "INSERT INTO chunks (id, document_id, chunk_index, heading, content, token_count, content_hash, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      );
      const ids: string[] = [];
      for (const input of inputs) {
        const id = crypto.randomUUID();
        ids.push(id);
        stmt.run(id, input.documentId, input.chunkIndex, input.heading ?? null, input.content, input.tokenCount, input.contentHash, input.metadata, now, now);
      }
      return ids;
    },

    async deleteChunksByDocument(documentId: string) {
      native.prepare("DELETE FROM chunks WHERE document_id = ?").run(documentId);
    },

    // ── Graph Node Operations ──

    async upsertGraphNode(input) {
      const existing = native
        .prepare("SELECT * FROM graph_nodes WHERE type = ? AND label = ?")
        .get(input.type, input.label) as Record<string, unknown> | undefined;

      if (existing) {
        const nextMetadata = input.metadata ?? String(existing.metadata ?? "{}");
        const nextRefId = input.refId ?? (existing.refId as string | null) ?? null;

        if (nextRefId !== existing.refId || nextMetadata !== existing.metadata) {
          native
            .prepare("UPDATE graph_nodes SET ref_id = ?, metadata = ?, updated_at = ? WHERE id = ?")
            .run(nextRefId, nextMetadata, new Date().toISOString(), existing.id);
        }
        return String(existing.id);
      }

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      native
        .prepare("INSERT INTO graph_nodes (id, type, label, ref_id, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, input.type, input.label, input.refId ?? null, input.metadata ?? "{}", now, now);
      return id;
    },

    async getGraphNode(id: string) {
      const row = native.prepare("SELECT * FROM graph_nodes WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      return row ? mapNodeRow(row) : null;
    },

    async findGraphNode(type: string, label: string) {
      const row = native.prepare("SELECT * FROM graph_nodes WHERE type = ? AND label = ?").get(type, label) as Record<string, unknown> | undefined;
      return row ? mapNodeRow(row) : null;
    },

    async deleteGraphNodesByRefId(refId: string) {
      native.prepare(
        "DELETE FROM graph_nodes WHERE ref_id = ? OR ref_id IN (SELECT id FROM chunks WHERE document_id = ?)"
      ).run(refId, refId);
    },

    // ── Graph Edge Operations ──

    async insertEdge(input) {
      const id = crypto.randomUUID();
      native
        .prepare("INSERT INTO graph_edges (id, from_node_id, to_node_id, type, weight, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, input.fromNodeId, input.toNodeId, input.type, input.weight ?? 1, input.metadata ?? "{}", new Date().toISOString());
      return id;
    },

    async deleteEdgesByNodeIds(nodeIds: string[]) {
      if (nodeIds.length === 0) return;
      const placeholders = nodeIds.map(() => "?").join(",");
      native
        .prepare(`DELETE FROM graph_edges WHERE from_node_id IN (${placeholders}) OR to_node_id IN (${placeholders})`)
        .run(...nodeIds, ...nodeIds);
    },

    // ── Embedding Operations ──

    async insertEmbeddings(inputs) {
      const stmt = native.prepare(
        "INSERT INTO embeddings (id, chunk_id, provider, model, dimensions, embedding, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      );
      const now = new Date().toISOString();
      for (const input of inputs) {
        stmt.run(crypto.randomUUID(), input.chunkId, input.provider, input.model, input.dimensions, input.embedding, now);
      }
    },

    async deleteEmbeddingsByChunkIds(chunkIds: string[]) {
      if (chunkIds.length === 0) return;
      const placeholders = chunkIds.map(() => "?").join(",");
      native.prepare(`DELETE FROM embeddings WHERE chunk_id IN (${placeholders})`).run(...chunkIds);
    },

    // ── Full-Text Search ──

    async fullTextSearch(query: string, limit: number) {
      const likePattern = `%${query}%`;
      const rows = native
        .prepare(
          `SELECT chunks.id, chunks.content, chunks.heading, chunks.metadata, documents.path
           FROM chunks
           INNER JOIN documents ON documents.id = chunks.document_id
           WHERE chunks.content LIKE ?
           LIMIT ?`
        )
        .all(likePattern, limit) as Array<Record<string, unknown>>;

      return rows.map((row) => ({
        id: String(row.id),
        path: String(row.path),
        content: String(row.content),
        score: 0.1,
        heading: row.heading ? String(row.heading) : null,
        metadata: safeParseJson(String(row.metadata ?? ""), {}) as Record<string, unknown>
      }));
    },

    // ── Graph Traversal ──

    async graphNeighbors(label: string, depth: number) {
      const seedNodes = native
        .prepare("SELECT * FROM graph_nodes WHERE label = ? LIMIT 1")
        .all(label) as Array<Record<string, unknown>>;

      if (seedNodes.length === 0) {
        return { nodes: [], edges: [] };
      }

      const seedId = String(seedNodes[0].id);
      const visited = new Set<string>();
      const resultNodes: Array<Record<string, unknown>> = [];
      const resultEdges: Array<Record<string, unknown>> = [];
      let currentBatch = [seedId];
      visited.add(seedId);

      for (let hop = 0; hop <= depth; hop++) {
        if (currentBatch.length === 0) break;

        const placeholders = currentBatch.map(() => "?").join(",");
        const edges = native
          .prepare(`SELECT * FROM graph_edges WHERE (from_node_id IN (${placeholders}) OR to_node_id IN (${placeholders}))`)
          .all(...currentBatch, ...currentBatch) as Array<Record<string, unknown>>;

        const nextBatch: string[] = [];
        for (const edge of edges) {
          const fromId = String(edge.from_node_id);
          const toId = String(edge.to_node_id);
          if (!visited.has(fromId)) { nextBatch.push(fromId); visited.add(fromId); }
          if (!visited.has(toId)) { nextBatch.push(toId); visited.add(toId); }
          resultEdges.push(edge);
        }

        for (const nodeId of nextBatch) {
          const node = native.prepare("SELECT * FROM graph_nodes WHERE id = ?").get(nodeId) as Record<string, unknown> | undefined;
          if (node) {
            resultNodes.push({ ...node, metadata: safeParseJson(String(node.metadata ?? ""), {}) });
          }
        }

        currentBatch = nextBatch;
      }

      if (seedNodes[0]) {
        resultNodes.push({ ...seedNodes[0], metadata: safeParseJson(String(seedNodes[0].metadata ?? ""), {}) });
      }

      return { nodes: resultNodes, edges: resultEdges };
    },

    // ── Memory Operations ──

    async insertMemory(input) {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      native
        .prepare("INSERT INTO memories (id, title, content, tags, source, supersedes_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, input.title, input.content, input.tags ?? "", input.source, input.supersedesId ?? null, now, now);
      return id;
    },

    // ── Index Run Operations ──

    async createIndexRun(input) {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      native
        .prepare("INSERT INTO index_runs (id, mode, status, files_scanned, files_updated, chunks_written, embeddings_written, started_at) VALUES (?, ?, 'running', 0, 0, 0, 0, ?)")
        .run(id, input.mode, now);
      return id;
    },

    async completeIndexRun(id, updates) {
      const sets: string[] = ["finished_at = ?"];
      const params: unknown[] = [new Date().toISOString()];
      if (updates.status !== undefined) { sets.push("status = ?"); params.push(updates.status); }
      if (updates.filesScanned !== undefined) { sets.push("files_scanned = ?"); params.push(updates.filesScanned); }
      if (updates.filesUpdated !== undefined) { sets.push("files_updated = ?"); params.push(updates.filesUpdated); }
      if (updates.chunksWritten !== undefined) { sets.push("chunks_written = ?"); params.push(updates.chunksWritten); }
      if (updates.embeddingsWritten !== undefined) { sets.push("embeddings_written = ?"); params.push(updates.embeddingsWritten); }
      if (updates.errorMessage !== undefined) { sets.push("error_message = ?"); params.push(updates.errorMessage); }
      params.push(id);
      native.prepare(`UPDATE index_runs SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    },

    // ── Query Log Operations ──

    async insertQueryLog(input) {
      const id = crypto.randomUUID();
      native
        .prepare("INSERT INTO query_logs (id, query, mode, result_count, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(id, input.query, input.mode, input.resultCount, new Date().toISOString());
      return id;
    },

    // ── Raw SQL queries ──

    async executeRaw(sqlQuery: string, params?: unknown[]) {
      if (params) {
        return native.prepare(sqlQuery).run(...params);
      }
      return native.prepare(sqlQuery).run();
    },

    async queryRaw(sqlQuery: string, params?: unknown[]) {
      if (params) {
        return native.prepare(sqlQuery).all(...params) as Array<Record<string, unknown>>;
      }
      return native.prepare(sqlQuery).all() as Array<Record<string, unknown>>;
    },

    // ── Reset ──

    async resetAll() {
      native.exec("DELETE FROM memories");
      native.exec("DELETE FROM query_logs");
      native.exec("DELETE FROM graph_edges");
      native.exec("DELETE FROM graph_nodes");
      native.exec("DELETE FROM embeddings");
      native.exec("DELETE FROM chunks");
      native.exec("DELETE FROM documents");
      native.exec("DELETE FROM index_runs");
      native.exec("DELETE FROM graph_runs");
    }
  };
}

function mapDocumentRow(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    path: String(row.path),
    absolutePath: String(row.absolute_path),
    kind: String(row.kind),
    language: row.language ? String(row.language) : null,
    contentHash: String(row.content_hash),
    sizeBytes: Number(row.size_bytes),
    mtimeMs: Number(row.mtime_ms),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapChunkRow(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    documentId: String(row.document_id),
    chunkIndex: Number(row.chunk_index),
    heading: row.heading ? String(row.heading) : null,
    content: String(row.content),
    tokenCount: Number(row.token_count),
    contentHash: String(row.content_hash),
    metadata: String(row.metadata ?? "{}"),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapNodeRow(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    type: String(row.type),
    label: String(row.label),
    refId: row.ref_id ? String(row.ref_id) : null,
    metadata: String(row.metadata ?? "{}"),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function safeParseJson(value: string | undefined, fallback: Record<string, unknown>): Record<string, unknown> {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return fallback;
  }
}
