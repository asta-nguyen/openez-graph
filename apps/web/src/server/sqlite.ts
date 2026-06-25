

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(
  typeof import.meta !== "undefined" && import.meta.url
    ? import.meta.url
    : `file://${__filename}`
);

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}

interface SqliteDb {
  pragma(command: string): unknown;
  exec(sql: string): this;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

type SqliteConstructor = new (filename: string, options?: { nativeBinding?: string }) => SqliteDb;

const Database = require("better-sqlite3") as SqliteConstructor;

let registryDb: SqliteDb | null = null;
const workspaceDbs = new Map<string, SqliteDb>();

export interface WebRegistryWorkspace {
  id: string;
  name: string;
  rootPath: string;
  includeGlobs: string;
  excludeGlobs: string;
  status: string;
  indexingStatus: string;
  graphStatus: string;
  lastIndexedAt?: string;
  lastGraphBuiltAt?: string;
  documentCount: number;
  chunkCount: number;
  nodeCount: number;
  edgeCount: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WebRunRow {
  id: string;
  mode: string;
  status: string;
  filesScanned: number;
  filesUpdated: number;
  chunksWritten: number;
  embeddingsWritten: number;
  nodesCreated: number;
  edgesCreated: number;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface WebDocumentRow {
  id: string;
  path: string;
  kind: string;
  language?: string;
  updatedAt?: string;
}

export interface WebGraphNode {
  id: string;
  label: string;
  type: string;
  refId: string | null;
  metadata: Record<string, unknown>;
}

export interface WebGraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  weight: number;
}

function safeParseJson<T>(value: string | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeRootPath(rootPath: string): string {
  return rootPath.trim().replace(/[\\/]+$/, "") || rootPath;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "workspace";
}

function ensureDirForFile(filePath: string) {
  const directory = path.dirname(filePath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
  }
}

function openSqlite(dbPath: string): SqliteDb {
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return sqlite;
}

export function resolveRegistryDbPath(): string {
  const envPath = process.env.AI_MEMORY_REGISTRY_DB_PATH?.trim();
  if (envPath) {
    return envPath;
  }

  const homeDir = [os.homedir(), process.env.HOME, process.env.USERPROFILE, process.cwd()].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0
  );

  if (!homeDir) {
    throw new Error("Cannot resolve home directory for registry DB path");
  }

  return path.join(homeDir, ".openez", "registry.sqlite");
}

function initializeRegistrySchema(db: SqliteDb) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      root_path TEXT NOT NULL UNIQUE,
      include_globs TEXT NOT NULL DEFAULT '',
      exclude_globs TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      indexing_status TEXT NOT NULL DEFAULT 'pending',
      graph_status TEXT NOT NULL DEFAULT 'pending',
      last_indexed_at TEXT,
      last_graph_built_at TEXT,
      document_count INTEGER NOT NULL DEFAULT 0,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      node_count INTEGER NOT NULL DEFAULT 0,
      edge_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_root_path ON workspaces(root_path);
  `);
}

export function getRegistryDb(): SqliteDb {
  if (!registryDb) {
    const dbPath = resolveRegistryDbPath();
    ensureDirForFile(dbPath);
    registryDb = openSqlite(dbPath);
    initializeRegistrySchema(registryDb);
  }

  return registryDb;
}

function resolveWorkspaceDbPath(rootPath: string): string {
  return path.join(rootPath, ".openez", "index.sqlite");
}

function initializeWorkspaceSchema(db: SqliteDb) {
  const tables = [
    `CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      absolute_path TEXT NOT NULL,
      kind TEXT NOT NULL,
      language TEXT,
      content_hash TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      heading TEXT,
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS embeddings (
      id TEXT PRIMARY KEY,
      chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      embedding TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS graph_nodes (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      label TEXT NOT NULL,
      ref_id TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS graph_edges (
      id TEXT PRIMARY KEY,
      from_node_id TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
      to_node_id TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      weight INTEGER NOT NULL DEFAULT 1,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS index_runs (
      id TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      files_scanned INTEGER NOT NULL DEFAULT 0,
      files_updated INTEGER NOT NULL DEFAULT 0,
      chunks_written INTEGER NOT NULL DEFAULT 0,
      embeddings_written INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      stats TEXT DEFAULT '{}',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS graph_runs (
      id TEXT PRIMARY KEY,
      mode TEXT NOT NULL DEFAULT 'incremental',
      status TEXT NOT NULL DEFAULT 'pending',
      nodes_created INTEGER NOT NULL DEFAULT 0,
      edges_created INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      stats TEXT DEFAULT '{}',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS query_logs (
      id TEXT PRIMARY KEY,
      query TEXT NOT NULL,
      mode TEXT NOT NULL,
      result_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL,
      supersedes_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`
  ];
  for (const ddl of tables) {
    db.exec(ddl);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON chunks(document_id);
    CREATE INDEX IF NOT EXISTS idx_chunks_content_hash ON chunks(content_hash);
    CREATE INDEX IF NOT EXISTS idx_graph_nodes_type ON graph_nodes(type);
    CREATE INDEX IF NOT EXISTS idx_graph_nodes_label ON graph_nodes(label);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_from ON graph_edges(from_node_id);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_to ON graph_edges(to_node_id);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_type ON graph_edges(type);
    CREATE INDEX IF NOT EXISTS idx_embeddings_chunk_id ON embeddings(chunk_id);
  `);
}

function getWorkspaceDb(rootPath: string): SqliteDb {
  const normalized = normalizeRootPath(rootPath);
  const cached = workspaceDbs.get(normalized);
  if (cached) {
    return cached;
  }

  const dbPath = resolveWorkspaceDbPath(normalized);
  ensureDirForFile(dbPath);
  const db = openSqlite(dbPath);
  initializeWorkspaceSchema(db);
  workspaceDbs.set(normalized, db);
  return db;
}

function mapWorkspace(row: Record<string, unknown>): WebRegistryWorkspace {
  return {
    id: String(row.id),
    name: String(row.name),
    rootPath: String(row.root_path),
    includeGlobs: String(row.include_globs ?? ""),
    excludeGlobs: String(row.exclude_globs ?? ""),
    status: String(row.status),
    indexingStatus: String(row.indexing_status),
    graphStatus: String(row.graph_status),
    lastIndexedAt: row.last_indexed_at ? String(row.last_indexed_at) : undefined,
    lastGraphBuiltAt: row.last_graph_built_at ? String(row.last_graph_built_at) : undefined,
    documentCount: Number(row.document_count ?? 0),
    chunkCount: Number(row.chunk_count ?? 0),
    nodeCount: Number(row.node_count ?? 0),
    edgeCount: Number(row.edge_count ?? 0),
    lastError: row.last_error ? String(row.last_error) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

export function listRegistryWorkspaces(): WebRegistryWorkspace[] {
  const rows = getRegistryDb().prepare("SELECT * FROM workspaces ORDER BY created_at DESC").all() as Array<Record<string, unknown>>;
  return rows.map(mapWorkspace);
}

export function getRegistryWorkspace(id: string): WebRegistryWorkspace | null {
  const row = getRegistryDb().prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? mapWorkspace(row) : null;
}

export function getRegistryWorkspaceByPath(rootPath: string): WebRegistryWorkspace | null {
  const row = getRegistryDb()
    .prepare("SELECT * FROM workspaces WHERE root_path = ?")
    .get(normalizeRootPath(rootPath)) as Record<string, unknown> | undefined;
  return row ? mapWorkspace(row) : null;
}

export function ensureRegistryWorkspace(input: {
  name?: string;
  rootPath: string;
  includeGlobs?: string;
  excludeGlobs?: string;
}): WebRegistryWorkspace {
  const existing = getRegistryWorkspaceByPath(input.rootPath);
  if (existing) {
    return existing;
  }

  const all = listRegistryWorkspaces();
  const baseName = (input.name?.trim() || path.basename(normalizeRootPath(input.rootPath)) || "workspace").trim();
  const baseId = slugify(baseName);
  const takenIds = new Set(all.map((workspace) => workspace.id));
  const takenNames = new Set(all.map((workspace) => workspace.name));

  let suffix = 0;
  let nextId = baseId;
  let nextName = baseName;

  while (takenIds.has(nextId) || takenNames.has(nextName)) {
    suffix += 1;
    nextId = `${baseId}-${suffix + 1}`;
    nextName = `${baseName} (${suffix + 1})`;
  }

  const now = new Date().toISOString();
  getRegistryDb().prepare(
    `INSERT INTO workspaces
      (id, name, root_path, include_globs, exclude_globs, status, indexing_status, graph_status, document_count, chunk_count, node_count, edge_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', 'pending', 'pending', 0, 0, 0, 0, ?, ?)`
  ).run(nextId, nextName, normalizeRootPath(input.rootPath), input.includeGlobs ?? "", input.excludeGlobs ?? "", now, now);

  return getRegistryWorkspace(nextId)!;
}

export function updateRegistryWorkspace(
  id: string,
  updates: Partial<{
    status: string;
    indexingStatus: string;
    graphStatus: string;
    lastIndexedAt: string | null;
    lastGraphBuiltAt: string | null;
    documentCount: number;
    chunkCount: number;
    nodeCount: number;
    edgeCount: number;
    lastError: string | null;
  }>
) {
  const sets: string[] = ["updated_at = ?"];
  const values: unknown[] = [new Date().toISOString()];

  if (updates.status !== undefined) { sets.push("status = ?"); values.push(updates.status); }
  if (updates.indexingStatus !== undefined) { sets.push("indexing_status = ?"); values.push(updates.indexingStatus); }
  if (updates.graphStatus !== undefined) { sets.push("graph_status = ?"); values.push(updates.graphStatus); }
  if (updates.lastIndexedAt !== undefined) { sets.push("last_indexed_at = ?"); values.push(updates.lastIndexedAt); }
  if (updates.lastGraphBuiltAt !== undefined) { sets.push("last_graph_built_at = ?"); values.push(updates.lastGraphBuiltAt); }
  if (updates.documentCount !== undefined) { sets.push("document_count = ?"); values.push(updates.documentCount); }
  if (updates.chunkCount !== undefined) { sets.push("chunk_count = ?"); values.push(updates.chunkCount); }
  if (updates.nodeCount !== undefined) { sets.push("node_count = ?"); values.push(updates.nodeCount); }
  if (updates.edgeCount !== undefined) { sets.push("edge_count = ?"); values.push(updates.edgeCount); }
  if (updates.lastError !== undefined) { sets.push("last_error = ?"); values.push(updates.lastError); }

  values.push(id);
  getRegistryDb().prepare(`UPDATE workspaces SET ${sets.join(", ")} WHERE id = ?`).run(...values);
}

export function deleteRegistryWorkspace(id: string) {
  getRegistryDb().prepare("DELETE FROM workspaces WHERE id = ?").run(id);
}

function mapRunRow(row: Record<string, unknown>, kind: "index" | "graph"): WebRunRow {
  return {
    id: String(row.id),
    mode: String(row.mode ?? "incremental"),
    status: String(row.status),
    filesScanned: kind === "index" ? Number(row.files_scanned ?? 0) : 0,
    filesUpdated: kind === "index" ? Number(row.files_updated ?? 0) : 0,
    chunksWritten: kind === "index" ? Number(row.chunks_written ?? 0) : 0,
    embeddingsWritten: kind === "index" ? Number(row.embeddings_written ?? 0) : 0,
    nodesCreated: kind === "graph" ? Number(row.nodes_created ?? 0) : 0,
    edgesCreated: kind === "graph" ? Number(row.edges_created ?? 0) : 0,
    errorMessage: row.error_message ? String(row.error_message) : null,
    startedAt: String(row.started_at),
    finishedAt: row.finished_at ? String(row.finished_at) : null
  };
}

export function getWorkspaceCounts(rootPath: string) {
  const db = getWorkspaceDb(rootPath);
  const documents = Number((db.prepare("SELECT COUNT(*) AS count FROM documents").get() as { count: number } | undefined)?.count ?? 0);
  const chunks = Number((db.prepare("SELECT COUNT(*) AS count FROM chunks").get() as { count: number } | undefined)?.count ?? 0);
  const nodes = Number((db.prepare("SELECT COUNT(*) AS count FROM graph_nodes").get() as { count: number } | undefined)?.count ?? 0);
  const edges = Number((db.prepare("SELECT COUNT(*) AS count FROM graph_edges").get() as { count: number } | undefined)?.count ?? 0);
  const memories = Number((db.prepare("SELECT COUNT(*) AS count FROM memories").get() as { count: number } | undefined)?.count ?? 0);
  return { documents, chunks, nodes, edges, memories };
}

export function listWorkspaceDocuments(rootPath: string, limit = 50, offset = 0): WebDocumentRow[] {
  const rows = getWorkspaceDb(rootPath)
    .prepare("SELECT * FROM documents ORDER BY updated_at DESC, path ASC LIMIT ? OFFSET ?")
    .all(limit, offset) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    path: String(row.path),
    kind: String(row.kind),
    language: row.language ? String(row.language) : undefined,
    updatedAt: row.updated_at ? String(row.updated_at) : undefined
  }));
}

export function countWorkspaceDocuments(rootPath: string): number {
  const row = getWorkspaceDb(rootPath)
    .prepare("SELECT COUNT(*) as count FROM documents")
    .get() as { count: number } | undefined;
  return row?.count ?? 0;
}

export function getLatestIndexRun(rootPath: string): WebRunRow | null {
  const row = getWorkspaceDb(rootPath)
    .prepare("SELECT * FROM index_runs ORDER BY started_at DESC LIMIT 1")
    .get() as Record<string, unknown> | undefined;
  return row ? mapRunRow(row, "index") : null;
}

export function getLatestGraphRun(rootPath: string): WebRunRow | null {
  const row = getWorkspaceDb(rootPath)
    .prepare("SELECT * FROM graph_runs ORDER BY started_at DESC LIMIT 1")
    .get() as Record<string, unknown> | undefined;
  return row ? mapRunRow(row, "graph") : null;
}

export function getRecentIndexRuns(rootPath: string, limit = 5): WebRunRow[] {
  const rows = getWorkspaceDb(rootPath)
    .prepare("SELECT * FROM index_runs ORDER BY started_at DESC LIMIT ?")
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((row) => mapRunRow(row, "index"));
}

export function getRecentGraphRuns(rootPath: string, limit = 5): WebRunRow[] {
  const rows = getWorkspaceDb(rootPath)
    .prepare("SELECT * FROM graph_runs ORDER BY started_at DESC LIMIT ?")
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((row) => mapRunRow(row, "graph"));
}

export function listGraphNodes(rootPath: string, limit = 500): WebGraphNode[] {
  const rows = getWorkspaceDb(rootPath)
    .prepare("SELECT * FROM graph_nodes ORDER BY created_at DESC LIMIT ?")
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    label: String(row.label),
    type: String(row.type),
    refId: row.ref_id ? String(row.ref_id) : null,
    metadata: safeParseJson(String(row.metadata ?? "{}"), {})
  }));
}

export function countGraphNodes(rootPath: string): number {
  const row = getWorkspaceDb(rootPath)
    .prepare("SELECT COUNT(*) AS count FROM graph_nodes")
    .get() as { count: number };
  return row.count;
}

const CURATED_TYPE_ORDER = [
  "file",
  "symbol",
  "document",
  "entity",
  "class",
  "function",
  "method",
  "variable",
  "chunk",
  "memory"
];

const typeOrderCase = CURATED_TYPE_ORDER
  .map((t, i) => `WHEN '${t}' THEN ${i}`)
  .join(" ");

export function listGraphNodesCurated(rootPath: string, limit = 300): WebGraphNode[] {
  const rows = getWorkspaceDb(rootPath)
    .prepare(`
      SELECT * FROM graph_nodes
      ORDER BY
        CASE type ${typeOrderCase} ELSE 999 END,
        created_at DESC
      LIMIT ?
    `)
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    label: String(row.label),
    type: String(row.type),
    refId: row.ref_id ? String(row.ref_id) : null,
    metadata: safeParseJson(String(row.metadata ?? "{}"), {})
  }));
}

export function listGraphEdges(rootPath: string, limit = 1000): WebGraphEdge[] {
  const rows = getWorkspaceDb(rootPath)
    .prepare("SELECT * FROM graph_edges LIMIT ?")
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    source: String(row.from_node_id),
    target: String(row.to_node_id),
    type: String(row.type),
    weight: Number(row.weight ?? 1)
  }));
}

export function getGraphNodeById(rootPath: string, nodeId: string): WebGraphNode | null {
  const row = getWorkspaceDb(rootPath)
    .prepare("SELECT * FROM graph_nodes WHERE id = ?")
    .get(nodeId) as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }
  return {
    id: String(row.id),
    label: String(row.label),
    type: String(row.type),
    refId: row.ref_id ? String(row.ref_id) : null,
    metadata: safeParseJson(String(row.metadata ?? "{}"), {})
  };
}

export function searchGraphNodesByLabel(rootPath: string, query: string, nodeTypes?: string[]): WebGraphNode[] {
  const db = getWorkspaceDb(rootPath);
  const likeQuery = `%${query.toLowerCase()}%`;

  let rows: Array<Record<string, unknown>>;
  if (nodeTypes && nodeTypes.length > 0) {
    const placeholders = nodeTypes.map(() => "?").join(",");
    rows = db.prepare(`SELECT * FROM graph_nodes WHERE lower(label) LIKE ? AND type IN (${placeholders}) LIMIT 50`)
      .all(likeQuery, ...nodeTypes) as Array<Record<string, unknown>>;
  } else {
    rows = db.prepare("SELECT * FROM graph_nodes WHERE lower(label) LIKE ? LIMIT 50")
      .all(likeQuery) as Array<Record<string, unknown>>;
  }

  return rows.map((row) => ({
    id: String(row.id),
    label: String(row.label),
    type: String(row.type),
    refId: row.ref_id ? String(row.ref_id) : null,
    metadata: safeParseJson(String(row.metadata ?? "{}"), {})
  }));
}

// Optimized combined query for graph page - fetches nodes and edges in parallel
export function getWorkspaceGraphOptimized(
  rootPath: string,
  maxNodes: number,
  maxEdges: number
): { nodes: WebGraphNode[]; edges: WebGraphEdge[]; totalNodeCount: number } {
  const db = getWorkspaceDb(rootPath);

  // Use prepared statements for better performance
  const countStmt = db.prepare("SELECT COUNT(*) AS count FROM graph_nodes");
  const nodesStmt = db.prepare(`
    SELECT * FROM graph_nodes
    ORDER BY
      CASE type ${typeOrderCase} ELSE 999 END,
      created_at DESC
    LIMIT ?
  `);
  const edgesStmt = db.prepare("SELECT * FROM graph_edges LIMIT ?");

  // Execute all queries
  const countResult = countStmt.get() as { count: number };
  const nodeRows = nodesStmt.all(maxNodes) as Array<Record<string, unknown>>;
  const edgeRows = edgesStmt.all(maxEdges) as Array<Record<string, unknown>>;

  return {
    totalNodeCount: countResult.count,
    nodes: nodeRows.map((row) => ({
      id: String(row.id),
      label: String(row.label),
      type: String(row.type),
      refId: row.ref_id ? String(row.ref_id) : null,
      metadata: safeParseJson(String(row.metadata ?? "{}"), {})
    })),
    edges: edgeRows.map((row) => ({
      id: String(row.id),
      source: String(row.from_node_id),
      target: String(row.to_node_id),
      type: String(row.type),
      weight: Number(row.weight ?? 1)
    }))
  };
}
