import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { getFullWorkspaceDdl, getRegistryDdl, migrateRegistrySchema } from "@openez-graph/db";

function getRequireUrl(): string {
  try {
    if (typeof import.meta !== "undefined" && import.meta.url) {
      return import.meta.url;
    }
  } catch {
    // import.meta not available (CJS)
  }
  return `file://${__filename}`;
}

const require = createRequire(getRequireUrl());

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

const { Database: BunDatabase } = require("bun:sqlite");
// Wrap to add .pragma() shim — bun:sqlite doesn't have it natively
const Database = class extends BunDatabase {
  constructor(filename: string, options?: any) {
    super(filename, options);
    (this as any).pragma = (cmd: string) => this.exec(`PRAGMA ${cmd}`);
  }
} as unknown as new (filename: string, options?: any) => SqliteDb;

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
  pinnedAt?: string;
  pinOrder?: number;
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
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );

  if (!homeDir) {
    throw new Error("Cannot resolve home directory for registry DB path");
  }

  return path.join(homeDir, ".openez", "registry.sqlite");
}

function initializeRegistrySchema(db: SqliteDb) {
  // Use the authoritative DDL and migration from @openez-graph/db so the
  // web server never creates a schema that diverges from the CLI/MCP/indexer
  // path. This includes column migrations, registry_meta, and the one-shot
  // graph invalidation backfill.
  db.exec(getRegistryDdl());
  migrateRegistrySchema(db);
}

export function getRegistryDb(): SqliteDb {
  if (!registryDb) {
    const dbPath = resolveRegistryDbPath();
    ensureDirForFile(dbPath);
    const db = openSqlite(dbPath);
    try {
      initializeRegistrySchema(db);
      registryDb = db;
    } catch (err) {
      db.close();
      registryDb = null;
      throw err;
    }
  }

  return registryDb;
}

export function closeRegistryDb() {
  registryDb?.close();
  registryDb = null;
}

export function closeWorkspaceDb(rootPath: string) {
  const normalized = normalizeRootPath(rootPath);
  const db = workspaceDbs.get(normalized);
  if (db) {
    try {
      db.close();
    } catch {
      // Already closed or closing in progress
    }
    workspaceDbs.delete(normalized);
  }
}

function resolveWorkspaceDbPath(rootPath: string): string {
  return path.join(rootPath, ".openez", "index.sqlite");
}

function initializeWorkspaceSchema(db: SqliteDb) {
  // Use the authoritative DDL from @openez-graph/db so the web server
  // creates the same schema as the CLI/MCP/indexer path, including FTS,
  // parsed_documents, index_meta, BLOB embeddings, and all indexes.
  db.exec(getFullWorkspaceDdl());
  migrateQueryLogColumns(db);
}

function migrateQueryLogColumns(db: SqliteDb) {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(query_logs)").all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );

  if (!columns.has("tokens_returned")) {
    db.exec("ALTER TABLE query_logs ADD COLUMN tokens_returned INTEGER NOT NULL DEFAULT 0");
  }
  if (!columns.has("tokens_saved")) {
    db.exec("ALTER TABLE query_logs ADD COLUMN tokens_saved INTEGER NOT NULL DEFAULT 0");
  }
  if (!columns.has("files_scanned")) {
    db.exec("ALTER TABLE query_logs ADD COLUMN files_scanned INTEGER NOT NULL DEFAULT 0");
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
    pinnedAt: row.pinned_at ? String(row.pinned_at) : undefined,
    pinOrder: row.pin_order != null ? Number(row.pin_order) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function listRegistryWorkspaces(): WebRegistryWorkspace[] {
  const rows = getRegistryDb()
    .prepare(
      "SELECT * FROM workspaces ORDER BY (pinned_at IS NULL), pin_order DESC, pinned_at DESC, created_at DESC",
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map(mapWorkspace);
}

export function getRegistryWorkspace(id: string): WebRegistryWorkspace | null {
  const row = getRegistryDb().prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
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
  const baseName = (
    input.name?.trim() ||
    path.basename(normalizeRootPath(input.rootPath)) ||
    "workspace"
  ).trim();
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
  getRegistryDb()
    .prepare(
      `INSERT INTO workspaces
      (id, name, root_path, include_globs, exclude_globs, status, indexing_status, graph_status, document_count, chunk_count, node_count, edge_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', 'pending', 'pending', 0, 0, 0, 0, ?, ?)`,
    )
    .run(
      nextId,
      nextName,
      normalizeRootPath(input.rootPath),
      input.includeGlobs ?? "",
      input.excludeGlobs ?? "",
      now,
      now,
    );

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
  }>,
) {
  const sets: string[] = ["updated_at = ?"];
  const values: unknown[] = [new Date().toISOString()];

  if (updates.status !== undefined) {
    sets.push("status = ?");
    values.push(updates.status);
  }
  if (updates.indexingStatus !== undefined) {
    sets.push("indexing_status = ?");
    values.push(updates.indexingStatus);
  }
  if (updates.graphStatus !== undefined) {
    sets.push("graph_status = ?");
    values.push(updates.graphStatus);
  }
  if (updates.lastIndexedAt !== undefined) {
    sets.push("last_indexed_at = ?");
    values.push(updates.lastIndexedAt);
  }
  if (updates.lastGraphBuiltAt !== undefined) {
    sets.push("last_graph_built_at = ?");
    values.push(updates.lastGraphBuiltAt);
  }
  if (updates.documentCount !== undefined) {
    sets.push("document_count = ?");
    values.push(updates.documentCount);
  }
  if (updates.chunkCount !== undefined) {
    sets.push("chunk_count = ?");
    values.push(updates.chunkCount);
  }
  if (updates.nodeCount !== undefined) {
    sets.push("node_count = ?");
    values.push(updates.nodeCount);
  }
  if (updates.edgeCount !== undefined) {
    sets.push("edge_count = ?");
    values.push(updates.edgeCount);
  }
  if (updates.lastError !== undefined) {
    sets.push("last_error = ?");
    values.push(updates.lastError);
  }

  values.push(id);
  getRegistryDb()
    .prepare(`UPDATE workspaces SET ${sets.join(", ")} WHERE id = ?`)
    .run(...values);
}

export function setRegistryWorkspacePinned(id: string, pinned: boolean) {
  const db = getRegistryDb();
  if (pinned) {
    const maxRow = db
      .prepare("SELECT MAX(pin_order) AS max_order FROM workspaces WHERE pin_order IS NOT NULL")
      .get() as { max_order: number | null } | undefined;
    const nextOrder = (maxRow?.max_order ?? 0) + 1;
    db.prepare("UPDATE workspaces SET pinned_at = ?, pin_order = ? WHERE id = ?").run(
      new Date().toISOString(),
      nextOrder,
      id,
    );
  } else {
    db.prepare("UPDATE workspaces SET pinned_at = NULL, pin_order = NULL WHERE id = ?").run(id);
  }
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
    finishedAt: row.finished_at ? String(row.finished_at) : null,
  };
}

export function getWorkspaceCounts(rootPath: string) {
  const db = getWorkspaceDb(rootPath);
  const documents = Number(
    (db.prepare("SELECT COUNT(*) AS count FROM documents").get() as { count: number } | undefined)
      ?.count ?? 0,
  );
  const chunks = Number(
    (db.prepare("SELECT COUNT(*) AS count FROM chunks").get() as { count: number } | undefined)
      ?.count ?? 0,
  );
  const nodes = Number(
    (db.prepare("SELECT COUNT(*) AS count FROM graph_nodes").get() as { count: number } | undefined)
      ?.count ?? 0,
  );
  const edges = Number(
    (db.prepare("SELECT COUNT(*) AS count FROM graph_edges").get() as { count: number } | undefined)
      ?.count ?? 0,
  );
  const memories = Number(
    (db.prepare("SELECT COUNT(*) AS count FROM memories").get() as { count: number } | undefined)
      ?.count ?? 0,
  );
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
    updatedAt: row.updated_at ? String(row.updated_at) : undefined,
  }));
}

export function countWorkspaceDocuments(rootPath: string): number {
  const row = getWorkspaceDb(rootPath).prepare("SELECT COUNT(*) as count FROM documents").get() as
    | { count: number }
    | undefined;
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
    metadata: safeParseJson(String(row.metadata ?? "{}"), {}),
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
  "memory",
];

const typeOrderCase = CURATED_TYPE_ORDER.map((t, i) => `WHEN '${t}' THEN ${i}`).join(" ");

export function listGraphNodesCurated(rootPath: string, limit = 300): WebGraphNode[] {
  const rows = getWorkspaceDb(rootPath)
    .prepare(
      `
      SELECT * FROM graph_nodes
      ORDER BY
        CASE type ${typeOrderCase} ELSE 999 END,
        created_at DESC
      LIMIT ?
    `,
    )
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    label: String(row.label),
    type: String(row.type),
    refId: row.ref_id ? String(row.ref_id) : null,
    metadata: safeParseJson(String(row.metadata ?? "{}"), {}),
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
    weight: Number(row.weight ?? 1),
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
    metadata: safeParseJson(String(row.metadata ?? "{}"), {}),
  };
}

export function searchGraphNodesByLabel(
  rootPath: string,
  query: string,
  nodeTypes?: string[],
): WebGraphNode[] {
  const db = getWorkspaceDb(rootPath);
  const likeQuery = `%${query.toLowerCase()}%`;

  let rows: Array<Record<string, unknown>>;
  if (nodeTypes && nodeTypes.length > 0) {
    const placeholders = nodeTypes.map(() => "?").join(",");
    rows = db
      .prepare(
        `SELECT * FROM graph_nodes WHERE lower(label) LIKE ? AND type IN (${placeholders}) LIMIT 50`,
      )
      .all(likeQuery, ...nodeTypes) as Array<Record<string, unknown>>;
  } else {
    rows = db
      .prepare("SELECT * FROM graph_nodes WHERE lower(label) LIKE ? LIMIT 50")
      .all(likeQuery) as Array<Record<string, unknown>>;
  }

  return rows.map((row) => ({
    id: String(row.id),
    label: String(row.label),
    type: String(row.type),
    refId: row.ref_id ? String(row.ref_id) : null,
    metadata: safeParseJson(String(row.metadata ?? "{}"), {}),
  }));
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

function mapMemoryRow(row: Record<string, unknown>): WebMemoryRow {
  return {
    id: String(row.id),
    title: String(row.title),
    content: String(row.content),
    tags: String(row.tags ?? "")
      .split(",")
      .filter(Boolean),
    source: String(row.source ?? "agent"),
    supersedesId: row.supersedes_id ? String(row.supersedes_id) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function listWorkspaceMemories(rootPath: string, limit = 50, offset = 0): WebMemoryRow[] {
  const rows = getWorkspaceDb(rootPath)
    .prepare(
      `SELECT m.* FROM memories m
       WHERE NOT EXISTS (SELECT 1 FROM memories newer WHERE newer.supersedes_id = m.id)
       ORDER BY m.updated_at DESC, m.created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as Array<Record<string, unknown>>;
  return rows.map(mapMemoryRow);
}

export function countWorkspaceMemories(rootPath: string): number {
  const row = getWorkspaceDb(rootPath)
    .prepare(
      `SELECT COUNT(*) AS count FROM memories m
       WHERE NOT EXISTS (SELECT 1 FROM memories newer WHERE newer.supersedes_id = m.id)`,
    )
    .get() as { count: number } | undefined;
  return row?.count ?? 0;
}

export function searchWorkspaceMemories(
  rootPath: string,
  query: string,
  limit = 50,
): WebMemoryRow[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return listWorkspaceMemories(rootPath, limit);

  const terms = [...new Set(normalized.split(/\s+/).filter(Boolean))].slice(0, 8);
  if (terms.length === 0) return listWorkspaceMemories(rootPath, limit);

  const clauses = terms.map(() => "(lower(m.title) LIKE ? OR lower(m.content) LIKE ?)");
  const termParams = terms.flatMap((t) => [`%${t}%`, `%${t}%`]);
  const phrasePattern = `%${normalized}%`;

  const rows = getWorkspaceDb(rootPath)
    .prepare(
      `SELECT m.* FROM memories m
       WHERE NOT EXISTS (SELECT 1 FROM memories newer WHERE newer.supersedes_id = m.id)
         AND (${clauses.join(" AND ")})
       ORDER BY
         CASE WHEN lower(m.title) = ? THEN 0
              WHEN lower(m.title) LIKE ? THEN 1
              ELSE 2
         END,
         m.updated_at DESC
       LIMIT ?`,
    )
    .all(...termParams, normalized, phrasePattern, limit) as Array<Record<string, unknown>>;
  return rows.map(mapMemoryRow);
}

export function getWorkspaceMemory(rootPath: string, id: string): WebMemoryRow | null {
  const row = getWorkspaceDb(rootPath).prepare("SELECT * FROM memories WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapMemoryRow(row) : null;
}

export function insertWorkspaceMemory(input: {
  rootPath: string;
  title: string;
  content: string;
  tags?: string[];
  source?: string;
  supersedesId?: string;
}): string {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  getWorkspaceDb(input.rootPath)
    .prepare(
      "INSERT INTO memories (id, title, content, tags, source, supersedes_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      id,
      input.title,
      input.content,
      (input.tags ?? []).join(","),
      input.source ?? "user",
      input.supersedesId ?? null,
      now,
      now,
    );
  return id;
}

export function deleteWorkspaceMemory(rootPath: string, id: string): boolean {
  const result = getWorkspaceDb(rootPath).prepare("DELETE FROM memories WHERE id = ?").run(id);
  return result.changes > 0;
}

export interface WebQueryMetrics {
  metricMethod: "selected-full-files-minus-serialized-response";
  totalQueries: number;
  totalTokensReturned: number;
  totalTokensSaved: number;
  totalFilesScanned: number;
  avgTokensPerQuery: number;
  recentQueries: Array<{
    id: string;
    query: string;
    mode: string;
    resultCount: number;
    tokensReturned: number;
    tokensSaved: number;
    filesScanned: number;
    createdAt: string;
  }>;
}

export function getWorkspaceQueryMetrics(rootPath: string, recentLimit = 10): WebQueryMetrics {
  const db = getWorkspaceDb(rootPath);
  const totals = db
    .prepare(
      `SELECT
      COUNT(*) AS totalQueries,
      COALESCE(SUM(tokens_returned), 0) AS totalTokensReturned,
      COALESCE(SUM(tokens_saved), 0) AS totalTokensSaved,
      COALESCE(SUM(files_scanned), 0) AS totalFilesScanned
     FROM query_logs`,
    )
    .get() as Record<string, number> | undefined;

  const recentRows = db
    .prepare(
      `SELECT id, query, mode, result_count, tokens_returned, tokens_saved, files_scanned, created_at
     FROM query_logs
     ORDER BY created_at DESC
     LIMIT ?`,
    )
    .all(recentLimit) as Array<Record<string, unknown>>;

  const totalQueries = Number(totals?.totalQueries ?? 0);
  const totalTokensReturned = Number(totals?.totalTokensReturned ?? 0);
  const totalTokensSaved = Number(totals?.totalTokensSaved ?? 0);
  const totalFilesScanned = Number(totals?.totalFilesScanned ?? 0);

  return {
    metricMethod: "selected-full-files-minus-serialized-response",
    totalQueries,
    totalTokensReturned,
    totalTokensSaved,
    totalFilesScanned,
    avgTokensPerQuery: totalQueries > 0 ? Math.round(totalTokensReturned / totalQueries) : 0,
    recentQueries: recentRows.map((row) => ({
      id: String(row.id),
      query: String(row.query),
      mode: String(row.mode),
      resultCount: Number(row.result_count ?? 0),
      tokensReturned: Number(row.tokens_returned ?? 0),
      tokensSaved: Number(row.tokens_saved ?? 0),
      filesScanned: Number(row.files_scanned ?? 0),
      createdAt: String(row.created_at),
    })),
  };
}

// Optimized combined query for graph page - fetches nodes and edges in parallel
export function getWorkspaceGraphOptimized(
  rootPath: string,
  maxNodes: number,
  maxEdges: number,
): {
  nodes: WebGraphNode[];
  edges: WebGraphEdge[];
  totalNodeCount: number;
  totalEdgeCount: number;
} {
  const db = getWorkspaceDb(rootPath);

  // Use prepared statements for better performance
  const countStmt = db.prepare("SELECT COUNT(*) AS count FROM graph_nodes");
  const edgeCountStmt = db.prepare("SELECT COUNT(*) AS count FROM graph_edges");
  const nodesStmt = db.prepare(`
    SELECT * FROM graph_nodes
    ORDER BY
      CASE type ${typeOrderCase} ELSE 999 END,
      created_at DESC
    LIMIT ?
  `);
  const edgesStmt = db.prepare(`
    SELECT ge.* FROM graph_edges ge
    WHERE ge.from_node_id IN (
      SELECT id FROM graph_nodes
      ORDER BY
        CASE type ${typeOrderCase} ELSE 999 END,
        created_at DESC
      LIMIT ?
    )
    AND ge.to_node_id IN (
      SELECT id FROM graph_nodes
      ORDER BY
        CASE type ${typeOrderCase} ELSE 999 END,
        created_at DESC
      LIMIT ?
    )
    LIMIT ?
  `);

  // Execute all queries
  const countResult = countStmt.get() as { count: number };
  const edgeCountResult = edgeCountStmt.get() as { count: number };
  const nodeRows = nodesStmt.all(maxNodes) as Array<Record<string, unknown>>;
  const edgeRows = edgesStmt.all(maxNodes, maxNodes, maxEdges) as Array<Record<string, unknown>>;

  return {
    totalNodeCount: countResult.count,
    totalEdgeCount: edgeCountResult.count,
    nodes: nodeRows.map((row) => ({
      id: String(row.id),
      label: String(row.label),
      type: String(row.type),
      refId: row.ref_id ? String(row.ref_id) : null,
      metadata: safeParseJson(String(row.metadata ?? "{}"), {}),
    })),
    edges: edgeRows.map((row) => ({
      id: String(row.id),
      source: String(row.from_node_id),
      target: String(row.to_node_id),
      type: String(row.type),
      weight: Number(row.weight ?? 1),
    })),
  };
}
