import { sql } from "drizzle-orm";
import { blob, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

// ── Global Registry DB ──────────────────────────────────────────────

export const workspaces = sqliteTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    rootPath: text("root_path").notNull(),
    includeGlobs: text("include_globs").notNull().default(""),
    excludeGlobs: text("exclude_globs").notNull().default(""),
    status: text("status").notNull().default("pending"),
    indexingStatus: text("indexing_status").notNull().default("pending"),
    indexBuildOwner: text("index_build_owner"),
    indexLeaseExpiresAt: text("index_lease_expires_at"),
    graphStatus: text("graph_status").notNull().default("pending"),
    indexGeneration: integer("index_generation").notNull().default(0),
    graphGeneration: integer("graph_generation").notNull().default(0),
    graphBuildOwner: text("graph_build_owner"),
    graphBuildEpoch: integer("graph_build_epoch").notNull().default(0),
    graphLeaseExpiresAt: text("graph_lease_expires_at"),
    lastIndexedAt: text("last_indexed_at"),
    lastGraphBuiltAt: text("last_graph_built_at"),
    documentCount: integer("document_count").notNull().default(0),
    chunkCount: integer("chunk_count").notNull().default(0),
    nodeCount: integer("node_count").notNull().default(0),
    edgeCount: integer("edge_count").notNull().default(0),
    lastError: text("last_error"),
    pinnedAt: text("pinned_at"),
    pinOrder: integer("pin_order"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => ({
    nameUnique: unique().on(table.name),
    rootPathUnique: unique().on(table.rootPath),
  }),
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const registryMeta = sqliteTable("registry_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// ── Per-Workspace DB ────────────────────────────────────────────────

export const documents = sqliteTable("documents", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  path: text("path").notNull().unique(),
  absolutePath: text("absolute_path").notNull(),
  kind: text("kind").notNull(),
  language: text("language"),
  contentHash: text("content_hash").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  mtimeMs: integer("mtime_ms").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const chunks = sqliteTable("chunks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  documentId: integer("document_id")
    .notNull()
    .references(() => documents.id, { onDelete: "cascade" }),
  chunkIndex: integer("chunk_index").notNull(),
  heading: text("heading"),
  content: text("content").notNull(),
  tokenCount: integer("token_count").notNull(),
  contentHash: text("content_hash").notNull(),
  metadata: text("metadata").notNull().default("{}"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const embeddings = sqliteTable("embeddings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  chunkId: integer("chunk_id")
    .notNull()
    .references(() => chunks.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  dimensions: integer("dimensions").notNull(),
  embedding: blob("embedding").notNull(),
  inputHash: text("input_hash"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const graphNodes = sqliteTable("graph_nodes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  type: text("type").notNull(),
  label: text("label").notNull(),
  refId: text("ref_id"),
  metadata: text("metadata").notNull().default("{}"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const graphEdges = sqliteTable("graph_edges", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  fromNodeId: integer("from_node_id")
    .notNull()
    .references(() => graphNodes.id, { onDelete: "cascade" }),
  toNodeId: integer("to_node_id")
    .notNull()
    .references(() => graphNodes.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  weight: integer("weight").notNull().default(1),
  metadata: text("metadata").notNull().default("{}"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const indexRuns = sqliteTable("index_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  mode: text("mode").notNull(),
  status: text("status").notNull().default("pending"),
  filesScanned: integer("files_scanned").notNull().default(0),
  filesUpdated: integer("files_updated").notNull().default(0),
  chunksWritten: integer("chunks_written").notNull().default(0),
  embeddingsWritten: integer("embeddings_written").notNull().default(0),
  errorMessage: text("error_message"),
  stats: text("stats").default("{}"),
  startedAt: text("started_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  finishedAt: text("finished_at"),
});

export const graphRuns = sqliteTable("graph_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  mode: text("mode").notNull().default("incremental"),
  status: text("status").notNull().default("pending"),
  nodesCreated: integer("nodes_created").notNull().default(0),
  edgesCreated: integer("edges_created").notNull().default(0),
  errorMessage: text("error_message"),
  stats: text("stats").default("{}"),
  startedAt: text("started_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  finishedAt: text("finished_at"),
});

export const queryLogs = sqliteTable("query_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  query: text("query").notNull(),
  mode: text("mode").notNull(),
  resultCount: integer("result_count").notNull().default(0),
  tokensReturned: integer("tokens_returned").notNull().default(0),
  tokensSaved: integer("tokens_saved").notNull().default(0),
  filesScanned: integer("files_scanned").notNull().default(0),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const memories = sqliteTable("memories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  content: text("content").notNull(),
  tags: text("tags").notNull().default(""),
  source: text("source").notNull(),
  supersedesId: integer("supersedes_id"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const indexMeta = sqliteTable("index_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const parsedDocuments = sqliteTable("parsed_documents", {
  documentId: integer("document_id")
    .primaryKey()
    .references(() => documents.id, { onDelete: "cascade" }),
  contentHash: text("content_hash").notNull(),
  symbols: text("symbols"),
  imports: text("imports"),
  calls: text("calls"),
  calledIdentifiers: text("called_identifiers"),
  parserVersion: text("parser_version"),
  parsedAt: integer("parsed_at").notNull(),
});

// FTS5 virtual table — declared as a Drizzle view-like table for query typing.
// The actual table is created via raw `CREATE VIRTUAL TABLE` because Drizzle
// does not support FTS5 virtual table definitions. Queries against chunks_fts
// use the raw SQL API (prepare/run/all) since Drizzle's query builder does not
// support FTS5 MATCH syntax.
