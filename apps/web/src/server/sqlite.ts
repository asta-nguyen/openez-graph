

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { QUERY_SORT, QUERY_SORT_OPTIONS, SYMBOL_TYPES, GRAPH_NODE_TYPES } from "../lib/constants";
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

export interface WebQueryLogRow {
  id: string;
  query: string;
  mode: string;
  resultCount: number;
  latencyMs: number | null;
  retrievedChunks: Array<{ chunkId: string; score: number; documentId: string; path: string }>;
  createdAt: string;
}

export interface WebDocumentRowEnriched extends WebDocumentRow {
  sizeBytes: number;
  chunkCount: number;
  symbolCount: number;
  lastIndexedAt?: string;
}

export interface DocumentFilterOpts {
  search?: string;
  kind?: string;
  language?: string;
  sortBy?: string;
  sortDir?: "asc" | "desc";
}

const DOCUMENT_SORT_WHITELIST = new Map<string, string>([
  ["path", "documents.path"],
  ["kind", "documents.kind"],
  ["language", "documents.language"],
  ["size", "documents.size_bytes"],
  ["sizeBytes", "documents.size_bytes"],
  ["updated_at", "documents.updated_at"],
  ["lastIndexed", "documents.updated_at"],
  ["lastIndexedAt", "documents.updated_at"],
  ["chunkCount", "(SELECT COUNT(*) FROM chunks WHERE document_id = documents.id)"],
  ["chunk_count", "(SELECT COUNT(*) FROM chunks WHERE document_id = documents.id)"],
  ["symbolCount", "(SELECT COUNT(*) FROM graph_nodes gn JOIN chunks c ON gn.ref_id = c.id WHERE gn.type = 'symbol' AND c.document_id = documents.id)"],
  ["symbol_count", "(SELECT COUNT(*) FROM graph_nodes gn JOIN chunks c ON gn.ref_id = c.id WHERE gn.type = 'symbol' AND c.document_id = documents.id)"],
]);

function buildDocumentWhere(opts: { search?: string; kind?: string; language?: string }): {
  clause: string;
  params: unknown[];
  useFts?: boolean;
  ftsMatch?: string;
} {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const search = opts.search?.trim();

  // For search, use FTS5 if available; otherwise fall back to LIKE.
  // We return a flag so the caller can use the FTS join path.
  if (search) {
    const sanitized = search.replace(/["'*]/g, " ").trim();
    if (sanitized) {
      const terms = sanitized.split(/\s+/).filter(Boolean);
      if (terms.length > 0) {
        return {
          clause: "",
          params: [],
          useFts: true,
          ftsMatch: terms.map((t) => `"${t}"*`).join(" OR "),
          ...opts.kind || opts.language ? buildExtraDocFilters(opts) : {},
        };
      }
    }
    // Fallback to LIKE if sanitization fails
    conditions.push("lower(documents.path) LIKE ?");
    params.push(`%${search.toLowerCase()}%`);
  }
  const kind = opts.kind?.trim();
  if (kind) {
    conditions.push("documents.kind = ?");
    params.push(kind);
  }
  const language = opts.language?.trim();
  if (language) {
    conditions.push("documents.language = ?");
    params.push(language);
  }
  return {
    clause: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

function buildExtraDocFilters(opts: { kind?: string; language?: string }): { extraWhere?: string; extraParams?: unknown[] } {
  const extra: string[] = [];
  const params: unknown[] = [];
  const kind = opts.kind?.trim();
  if (kind) { extra.push("documents.kind = ?"); params.push(kind); }
  const language = opts.language?.trim();
  if (language) { extra.push("documents.language = ?"); params.push(language); }
  return extra.length > 0 ? { extraWhere: ` AND ${extra.join(" AND ")}`, extraParams: params } : {};
}

function buildDocumentOrderBy(sortBy?: string, sortDir?: "asc" | "desc"): string {
  const dir = sortDir === "asc" ? "ASC" : "DESC";
  const key = sortBy?.trim();
  if (key) {
    const expr = DOCUMENT_SORT_WHITELIST.get(key);
    if (expr) {
      return `ORDER BY ${expr} ${dir}, documents.path ASC`;
    }
  }
  return "ORDER BY documents.updated_at DESC, documents.path ASC";
}

export interface WebMemoryRow {
  id: string;
  title: string;
  content: string;
  tags: string[];
  source: string;
  supersedesId: string | null;
  createdAt: string;
  updatedAt: string;
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
    `CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
      path,
      content_rowid UNINDEXED,
      tokenize = 'porter unicode61'
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
    `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      content,
      heading,
      path UNINDEXED,
      content_rowid UNINDEXED,
      tokenize = 'porter unicode61'
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
    `CREATE VIRTUAL TABLE IF NOT EXISTS graph_nodes_fts USING fts5(
      label,
      type UNINDEXED,
      content_rowid UNINDEXED,
      tokenize = 'porter unicode61'
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
      latency_ms INTEGER,
      retrieved_chunks TEXT NOT NULL DEFAULT '[]',
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
    )`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(title, content, tags, content='memories', content_rowid='rowid')`,
    `CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, title, content, tags) VALUES (new.rowid, new.title, new.content, new.tags);
    END`,
    `CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, title, content, tags) VALUES ('delete', old.rowid, old.title, old.content, old.tags);
    END`,
    `CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, title, content, tags) VALUES ('delete', old.rowid, old.title, old.content, old.tags);
      INSERT INTO memories_fts(rowid, title, content, tags) VALUES (new.rowid, new.title, new.content, new.tags);
    END`
  ];
  for (const ddl of tables) {
    db.exec(ddl);
  }

  migrateQueryLogsColumns(db);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON chunks(document_id);
    CREATE INDEX IF NOT EXISTS idx_chunks_content_hash ON chunks(content_hash);
    CREATE INDEX IF NOT EXISTS idx_graph_nodes_type ON graph_nodes(type);
    CREATE INDEX IF NOT EXISTS idx_graph_nodes_label ON graph_nodes(label);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_from ON graph_edges(from_node_id);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_to ON graph_edges(to_node_id);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_type ON graph_edges(type);
  `);
}

/**
 * Idempotent migration: add `latency_ms` and `retrieved_chunks` columns to
 * existing `query_logs` tables created before plan 08-01. Uses PRAGMA
 * table_info to check presence so re-running on an already-migrated DB is
 * a no-op. Each ALTER is guarded individually so a partially-migrated DB
 * does not throw.
 */
function migrateQueryLogsColumns(db: SqliteDb): void {
  const columns = db.prepare("PRAGMA table_info(query_logs)").all() as Array<{ name: string }>;
  const existing = new Set(columns.map((col) => col.name));

  if (!existing.has("latency_ms")) {
    try {
      db.exec("ALTER TABLE query_logs ADD COLUMN latency_ms INTEGER");
    } catch {
      // Column may have been added concurrently; ignore.
    }
  }

  if (!existing.has("retrieved_chunks")) {
    try {
      db.exec("ALTER TABLE query_logs ADD COLUMN retrieved_chunks TEXT NOT NULL DEFAULT '[]'");
    } catch {
      // Column may have been added concurrently; ignore.
    }
  }
}

function getWorkspaceDb(rootPath: string): SqliteDb {
  const normalized = normalizeRootPath(rootPath);

  // Guard: reject invalid root paths (e.g. "/" or non-existent dirs)
  if (normalized === "/" || normalized === "" || !fs.existsSync(normalized)) {
    throw new Error(`Workspace root path does not exist: "${rootPath}"`);
  }

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

export interface QueryLogListOpts {
  limit?: number;
  offset?: number;
  sort?: typeof QUERY_SORT_OPTIONS[number];
  fromTime?: string;
  toTime?: string;
}

function buildQueryLogWhere(opts: QueryLogListOpts): { clause: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (opts.fromTime) {
    conditions.push("created_at >= ?");
    params.push(opts.fromTime);
  }
  if (opts.toTime) {
    conditions.push("created_at <= ?");
    params.push(opts.toTime);
  }
  const clause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return { clause, params };
}

function buildQueryLogOrderBy(sort: QueryLogListOpts["sort"]): string {
  switch (sort) {
    case QUERY_SORT.LATENCY_DESC:
      return "ORDER BY latency_ms DESC NULLS LAST";
    case QUERY_SORT.LATENCY_ASC:
      return "ORDER BY latency_ms ASC NULLS LAST";
    case QUERY_SORT.OLDEST:
      return "ORDER BY created_at ASC";
    case QUERY_SORT.NEWEST:
    default:
      return "ORDER BY created_at DESC";
  }
}

export function listWorkspaceQueryLogs(rootPath: string, opts: QueryLogListOpts = {}): WebQueryLogRow[] {
  const db = getWorkspaceDb(rootPath);
  const { clause, params } = buildQueryLogWhere(opts);
  const orderBy = buildQueryLogOrderBy(opts.sort);
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  const rows = db
    .prepare(`SELECT * FROM query_logs ${clause} ${orderBy} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    query: String(row.query),
    mode: String(row.mode),
    resultCount: Number(row.result_count ?? 0),
    latencyMs: row.latency_ms != null ? Number(row.latency_ms) : null,
    retrievedChunks: safeParseJson(
      String(row.retrieved_chunks ?? "[]"),
      [] as Array<{ chunkId: string; score: number; documentId: string; path: string }>,
    ),
    createdAt: String(row.created_at),
  }));
}

export function countWorkspaceQueryLogs(rootPath: string, opts: QueryLogListOpts = {}): number {
  const db = getWorkspaceDb(rootPath);
  const { clause, params } = buildQueryLogWhere(opts);
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM query_logs ${clause}`)
    .get(...params) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function listWorkspaceDocumentsFiltered(
  rootPath: string,
  opts: { limit: number; offset: number } & DocumentFilterOpts,
): WebDocumentRowEnriched[] {
  const db = getWorkspaceDb(rootPath);
  const where = buildDocumentWhere(opts);
  const orderBy = buildDocumentOrderBy(opts.sortBy, opts.sortDir);

  let sql: string;
  let params: unknown[];

  if (where.useFts) {
    // FTS5 join path for search
    const extra = where as { extraWhere?: string; extraParams?: unknown[] };
    sql = `
      SELECT
        documents.id AS id,
        documents.path AS path,
        documents.kind AS kind,
        documents.language AS language,
        documents.size_bytes AS sizeBytes,
        documents.updated_at AS lastIndexedAt,
        documents.updated_at AS updatedAt,
        (SELECT COUNT(*) FROM chunks WHERE document_id = documents.id) AS chunkCount,
        (SELECT COUNT(*) FROM graph_nodes gn JOIN chunks c ON gn.ref_id = c.id WHERE gn.type = 'symbol' AND c.document_id = documents.id) AS symbolCount
      FROM documents_fts
      INNER JOIN documents ON documents.rowid = documents_fts.content_rowid
      WHERE documents_fts MATCH ?${extra.extraWhere ?? ""}
      ${orderBy}
      LIMIT ? OFFSET ?
    `;
    params = [where.ftsMatch, ...(extra.extraParams ?? []), opts.limit, opts.offset];
  } else {
    sql = `
      SELECT
        documents.id AS id,
        documents.path AS path,
        documents.kind AS kind,
        documents.language AS language,
        documents.size_bytes AS sizeBytes,
        documents.updated_at AS lastIndexedAt,
        documents.updated_at AS updatedAt,
        (SELECT COUNT(*) FROM chunks WHERE document_id = documents.id) AS chunkCount,
        (SELECT COUNT(*) FROM graph_nodes gn JOIN chunks c ON gn.ref_id = c.id WHERE gn.type = 'symbol' AND c.document_id = documents.id) AS symbolCount
      FROM documents
      ${where.clause}
      ${orderBy}
      LIMIT ? OFFSET ?
    `;
    params = [...where.params, opts.limit, opts.offset];
  }

  try {
    const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      path: String(row.path),
      kind: String(row.kind),
      language: row.language ? String(row.language) : undefined,
      sizeBytes: Number(row.sizeBytes ?? 0),
      chunkCount: Number(row.chunkCount ?? 0),
      symbolCount: Number(row.symbolCount ?? 0),
      lastIndexedAt: row.lastIndexedAt ? String(row.lastIndexedAt) : undefined,
      updatedAt: row.updatedAt ? String(row.updatedAt) : undefined,
    }));
  } catch {
    // FTS5 error — fall back to LIKE
    const likeQuery = `%${(opts.search ?? "").toLowerCase()}%`;
    const conditions: string[] = [];
    const likeParams: unknown[] = [];
    if (opts.search) { conditions.push("lower(documents.path) LIKE ?"); likeParams.push(likeQuery); }
    if (opts.kind) { conditions.push("documents.kind = ?"); likeParams.push(opts.kind); }
    if (opts.language) { conditions.push("documents.language = ?"); likeParams.push(opts.language); }
    const clause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const fallbackSql = `
      SELECT documents.id AS id, documents.path AS path, documents.kind AS kind,
        documents.language AS language, documents.size_bytes AS sizeBytes,
        documents.updated_at AS lastIndexedAt, documents.updated_at AS updatedAt,
        (SELECT COUNT(*) FROM chunks WHERE document_id = documents.id) AS chunkCount,
        (SELECT COUNT(*) FROM graph_nodes gn JOIN chunks c ON gn.ref_id = c.id WHERE gn.type = 'symbol' AND c.document_id = documents.id) AS symbolCount
      FROM documents ${clause} ${orderBy} LIMIT ? OFFSET ?
    `;
    const rows = db.prepare(fallbackSql).all(...likeParams, opts.limit, opts.offset) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      path: String(row.path),
      kind: String(row.kind),
      language: row.language ? String(row.language) : undefined,
      sizeBytes: Number(row.sizeBytes ?? 0),
      chunkCount: Number(row.chunkCount ?? 0),
      symbolCount: Number(row.symbolCount ?? 0),
      lastIndexedAt: row.lastIndexedAt ? String(row.lastIndexedAt) : undefined,
      updatedAt: row.updatedAt ? String(row.updatedAt) : undefined,
    }));
  }
}

export function countWorkspaceDocumentsFiltered(
  rootPath: string,
  opts: { search?: string; kind?: string; language?: string },
): number {
  const db = getWorkspaceDb(rootPath);
  const where = buildDocumentWhere(opts);

  try {
    if (where.useFts) {
      const extra = where as { extraWhere?: string; extraParams?: unknown[] };
      const sql = `SELECT COUNT(*) AS count FROM documents_fts INNER JOIN documents ON documents.rowid = documents_fts.content_rowid WHERE documents_fts MATCH ?${extra.extraWhere ?? ""}`;
      const row = db.prepare(sql).get(where.ftsMatch, ...(extra.extraParams ?? [])) as { count: number } | undefined;
      return row?.count ?? 0;
    }
    const sql = `SELECT COUNT(*) AS count FROM documents ${where.clause}`;
    const row = db.prepare(sql).get(...where.params) as { count: number } | undefined;
    return row?.count ?? 0;
  } catch {
    // FTS5 error — fall back to LIKE
    const likeQuery = `%${(opts.search ?? "").toLowerCase()}%`;
    const conditions: string[] = [];
    const likeParams: unknown[] = [];
    if (opts.search) { conditions.push("lower(documents.path) LIKE ?"); likeParams.push(likeQuery); }
    if (opts.kind) { conditions.push("documents.kind = ?"); likeParams.push(opts.kind); }
    if (opts.language) { conditions.push("documents.language = ?"); likeParams.push(opts.language); }
    const clause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const row = db.prepare(`SELECT COUNT(*) AS count FROM documents ${clause}`).get(...likeParams) as { count: number } | undefined;
    return row?.count ?? 0;
  }
}

export function listDocumentFacets(
  rootPath: string,
  opts: { search?: string; kind?: string; language?: string },
): { kinds: string[]; languages: string[] } {
  const db = getWorkspaceDb(rootPath);
  const where = buildDocumentWhere({ search: opts.search });

  let fromClause: string;
  let matchParams: unknown[];
  if (where.useFts) {
    fromClause = "FROM documents_fts INNER JOIN documents ON documents.rowid = documents_fts.content_rowid";
    matchParams = [where.ftsMatch];
  } else {
    fromClause = "FROM documents";
    matchParams = where.params;
  }
  const clause = where.useFts ? "WHERE documents_fts MATCH ?" : where.clause;

  try {
    const kindRows = db
      .prepare(`SELECT DISTINCT documents.kind AS kind ${fromClause} ${clause} ORDER BY documents.kind ASC`)
      .all(...matchParams) as Array<Record<string, unknown>>;
    const kinds = kindRows
      .map((row) => String(row.kind))
      .filter((k) => k.length > 0);

    const languageWhere = where.useFts
      ? `${clause} AND documents.language IS NOT NULL`
      : clause
        ? `${clause} AND documents.language IS NOT NULL`
        : "WHERE documents.language IS NOT NULL";
    const languageRows = db
      .prepare(`SELECT DISTINCT documents.language AS language ${fromClause} ${languageWhere} ORDER BY documents.language ASC`)
      .all(...matchParams) as Array<Record<string, unknown>>;
    const languages = languageRows
      .map((row) => String(row.language))
      .filter((l) => l.length > 0);

    return { kinds, languages };
  } catch {
    // FTS5 error — fall back to LIKE
    const likeQuery = `%${(opts.search ?? "").toLowerCase()}%`;
    const likeClause = opts.search ? "WHERE lower(documents.path) LIKE ?" : "";
    const likeParams = opts.search ? [likeQuery] : [];
    const kindRows = db
      .prepare(`SELECT DISTINCT documents.kind AS kind FROM documents ${likeClause} ORDER BY documents.kind ASC`)
      .all(...likeParams) as Array<Record<string, unknown>>;
    const kinds = kindRows.map((row) => String(row.kind)).filter((k) => k.length > 0);
    const langWhere = likeClause ? `${likeClause} AND documents.language IS NOT NULL` : "WHERE documents.language IS NOT NULL";
    const languageRows = db
      .prepare(`SELECT DISTINCT documents.language AS language FROM documents ${langWhere} ORDER BY documents.language ASC`)
      .all(...likeParams) as Array<Record<string, unknown>>;
    const languages = languageRows.map((row) => String(row.language)).filter((l) => l.length > 0);
    return { kinds, languages };
  }
}

export function listWorkspaceMemories(rootPath: string, limit = 50, offset = 0): WebMemoryRow[] {
  const rows = getWorkspaceDb(rootPath)
    .prepare("SELECT * FROM memories ORDER BY updated_at DESC, created_at DESC LIMIT ? OFFSET ?")
    .all(limit, offset) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    title: String(row.title),
    content: String(row.content),
    tags: String(row.tags ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0),
    source: String(row.source),
    supersedesId: row.supersedes_id ? String(row.supersedes_id) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }));
}

export function countWorkspaceMemories(rootPath: string): number {
  const row = getWorkspaceDb(rootPath)
    .prepare("SELECT COUNT(*) as count FROM memories")
    .get() as { count: number } | undefined;
  return row?.count ?? 0;
}

export function getRecentMemories(
  rootPath: string,
  limit = 5,
): Array<{ id: string; title: string; source: string }> {
  const rows = getWorkspaceDb(rootPath)
    .prepare("SELECT id, title, source FROM memories ORDER BY updated_at DESC LIMIT ?")
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    title: String(row.title),
    source: String(row.source),
  }));
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

export function cancelIndexRun(rootPath: string, runId: string): boolean {
  const db = getWorkspaceDb(rootPath);
  const result = db
    .prepare("UPDATE index_runs SET status = 'cancelled', finished_at = datetime('now') WHERE id = ? AND status = 'running'")
    .run(runId);
  return result.changes > 0;
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

export function listGraphNodesByType(
  rootPath: string,
  type: string | null,
  limit: number,
  offset: number,
): WebGraphNode[] {
  const db = getWorkspaceDb(rootPath);
  let rows: Array<Record<string, unknown>>;
  if (type) {
    rows = db.prepare(
      "SELECT * FROM graph_nodes WHERE type = ? ORDER BY label ASC LIMIT ? OFFSET ?",
    )
      .all(type, limit, offset) as Array<Record<string, unknown>>;
  } else {
    const placeholders = SYMBOL_TYPES.map(() => "?").join(",");
    rows = db.prepare(
      `SELECT * FROM graph_nodes WHERE type IN (${placeholders}) ORDER BY type ASC, label ASC LIMIT ? OFFSET ?`,
    )
      .all(...SYMBOL_TYPES, limit, offset) as Array<Record<string, unknown>>;
  }
  return rows.map((row) => ({
    id: String(row.id),
    label: String(row.label),
    type: String(row.type),
    refId: row.ref_id ? String(row.ref_id) : null,
    metadata: safeParseJson(String(row.metadata ?? "{}"), {}),
  }));
}

export function countGraphNodesByType(
  rootPath: string,
  type: string | null,
): number {
  const db = getWorkspaceDb(rootPath);
  if (type) {
    const row = db.prepare(
      "SELECT COUNT(*) AS count FROM graph_nodes WHERE type = ?",
    )
      .get(type) as { count: number } | undefined;
    return row?.count ?? 0;
  }
  const placeholders = SYMBOL_TYPES.map(() => "?").join(",");
  const row = db.prepare(
    `SELECT COUNT(*) AS count FROM graph_nodes WHERE type IN (${placeholders})`,
  )
    .get(...SYMBOL_TYPES) as { count: number } | undefined;
  return row?.count ?? 0;
}

export { SYMBOL_TYPES };

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

  // Build FTS5 MATCH expression with prefix wildcards for partial matching.
  const sanitized = query.replace(/["'*]/g, " ").trim();
  if (!sanitized) return [];

  const terms = sanitized.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const matchExpr = terms.map((t) => `"${t}"*`).join(" OR ");

  // Add type filter as a column filter in the MATCH expression if nodeTypes provided.
  // FTS5 supports column filters: {type symbol} label:foo*
  let fullMatch = matchExpr;
  if (nodeTypes && nodeTypes.length > 0) {
    // Use type column filter: (type:symbol OR type:file) AND (label terms)
    // FTS5 doesn't have AND for column filters easily, so we filter in SQL instead.
  }

  try {
    let rows: Array<Record<string, unknown>>;
    if (nodeTypes && nodeTypes.length > 0) {
      const placeholders = nodeTypes.map(() => "?").join(",");
      rows = db.prepare(
        `SELECT graph_nodes.id, graph_nodes.type, graph_nodes.label, graph_nodes.ref_id, graph_nodes.metadata
         FROM graph_nodes_fts
         INNER JOIN graph_nodes ON graph_nodes.rowid = graph_nodes_fts.content_rowid
         WHERE graph_nodes_fts MATCH ?
           AND graph_nodes.type IN (${placeholders})
         ORDER BY bm25(graph_nodes_fts)
         LIMIT 50`
      ).all(fullMatch, ...nodeTypes) as Array<Record<string, unknown>>;
    } else {
      rows = db.prepare(
        `SELECT graph_nodes.id, graph_nodes.type, graph_nodes.label, graph_nodes.ref_id, graph_nodes.metadata
         FROM graph_nodes_fts
         INNER JOIN graph_nodes ON graph_nodes.rowid = graph_nodes_fts.content_rowid
         WHERE graph_nodes_fts MATCH ?
         ORDER BY bm25(graph_nodes_fts)
         LIMIT 50`
      ).all(fullMatch) as Array<Record<string, unknown>>;
    }

    return rows.map((row) => ({
      id: String(row.id),
      label: String(row.label),
      type: String(row.type),
      refId: row.ref_id ? String(row.ref_id) : null,
      metadata: safeParseJson(String(row.metadata ?? "{}"), {})
    }));
  } catch {
    // FTS5 MATCH syntax errors fall back to LIKE search
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
}

export interface GraphFilterOptions {
  maxNodes: number;
  maxEdges: number;
  types?: string[];
  minDegree?: number;
  search?: string;
  focusNodeId?: string;
}

/**
 * Fetch a workspace graph with optional server-side filtering applied BEFORE the LIMIT.
 * - `types`: comma-separated node types → SQL `IN (...)` with ? placeholders
 * - `search`: case-insensitive label LIKE match
 * - `focusNodeId`: 2-hop neighbor expansion via graph_edges traversal
 * - `minDegree`: applied in JS after degree computation (requires edge join)
 *
 * `totalNodeCount` reflects the count after type/search/focus filters but before
 * the degree filter (degree requires edges which require the join).
 */
export function getWorkspaceGraphFiltered(
  rootPath: string,
  opts: GraphFilterOptions,
): { nodes: WebGraphNode[]; edges: WebGraphEdge[]; totalNodeCount: number } {
  const db = getWorkspaceDb(rootPath);
  const { maxNodes, maxEdges } = opts;
  const types = opts.types?.filter((t) => t.length > 0);
  const search = opts.search?.trim();
  const focusNodeId = opts.focusNodeId?.trim();

  // ── Focus: compute 2-hop neighbor id set ──
  let focusIds: Set<string> | null = null;
  if (focusNodeId) {
    focusIds = new Set<string>([focusNodeId]);
    // 1-hop
    const oneHop = db
      .prepare(
        "SELECT to_node_id AS id FROM graph_edges WHERE from_node_id = ? UNION SELECT from_node_id AS id FROM graph_edges WHERE to_node_id = ?",
      )
      .all(focusNodeId, focusNodeId) as Array<{ id: string }>;
    const oneHopIds = oneHop.map((r) => String(r.id));
    for (const id of oneHopIds) focusIds.add(id);
    // 2-hop
    if (oneHopIds.length > 0) {
      const placeholders = oneHopIds.map(() => "?").join(",");
      const twoHop = db
        .prepare(
          `SELECT to_node_id AS id FROM graph_edges WHERE from_node_id IN (${placeholders}) UNION SELECT from_node_id AS id FROM graph_edges WHERE to_node_id IN (${placeholders})`,
        )
        .all(...oneHopIds, ...oneHopIds) as Array<{ id: string }>;
      for (const r of twoHop) focusIds.add(String(r.id));
    }
  }

  // ── Build dynamic WHERE clause with ? placeholders ──
  const whereClauses: string[] = [];
  const whereParams: unknown[] = [];

  if (types && types.length > 0) {
    const placeholders = types.map(() => "?").join(",");
    whereClauses.push(`type IN (${placeholders})`);
    whereParams.push(...types);
  }

  if (search) {
    whereClauses.push("lower(label) LIKE ?");
    whereParams.push(`%${search.toLowerCase()}%`);
  }

  if (focusIds && focusIds.size > 0) {
    const focusArr = [...focusIds];
    const placeholders = focusArr.map(() => "?").join(",");
    whereClauses.push(`id IN (${placeholders})`);
    whereParams.push(...focusArr);
  }

  const whereSql =
    whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

  // Count after type/search/focus filters (before degree filter and before LIMIT)
  const countSql = `SELECT COUNT(*) AS count FROM graph_nodes ${whereSql}`;
  const countResult = db.prepare(countSql).get(...whereParams) as {
    count: number;
  };

  // Nodes with filters applied before ORDER BY ... LIMIT
  const nodesSql = `
    SELECT * FROM graph_nodes
    ${whereSql}
    ORDER BY
      CASE type ${typeOrderCase} ELSE 999 END,
      created_at DESC
    LIMIT ?
  `;
  const nodeRows = db
    .prepare(nodesSql)
    .all(...whereParams, maxNodes) as Array<Record<string, unknown>>;

  const nodes = nodeRows.map((row) => ({
    id: String(row.id),
    label: String(row.label),
    type: String(row.type),
    refId: row.ref_id ? String(row.ref_id) : null,
    metadata: safeParseJson(String(row.metadata ?? "{}"), {}),
  }));

  // Edges: fetch up to maxEdges, then filter to valid node ids
  const validIds = new Set(nodes.map((n) => n.id));
  const edgeRows = db
    .prepare("SELECT * FROM graph_edges LIMIT ?")
    .all(maxEdges) as Array<Record<string, unknown>>;
  const edges = edgeRows
    .map((row) => ({
      id: String(row.id),
      source: String(row.from_node_id),
      target: String(row.to_node_id),
      type: String(row.type),
      weight: Number(row.weight ?? 1),
    }))
    .filter((e) => validIds.has(e.source) && validIds.has(e.target));

  // ── minDegree: filter in JS after degree computation ──
  if (opts.minDegree !== undefined && opts.minDegree > 0) {
    const degreeMap = new Map<string, number>();
    for (const edge of edges) {
      degreeMap.set(edge.source, (degreeMap.get(edge.source) ?? 0) + 1);
      degreeMap.set(edge.target, (degreeMap.get(edge.target) ?? 0) + 1);
    }
    const filteredNodes = nodes.filter(
      (n) => (degreeMap.get(n.id) ?? 0) >= (opts.minDegree as number),
    );
    const filteredIds = new Set(filteredNodes.map((n) => n.id));
    const filteredEdges = edges.filter(
      (e) => filteredIds.has(e.source) && filteredIds.has(e.target),
    );
    return {
      nodes: filteredNodes,
      edges: filteredEdges,
      totalNodeCount: countResult.count,
    };
  }

  return {
    nodes,
    edges,
    totalNodeCount: countResult.count,
  };
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
