import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

// ── Global Registry DB Schema ──

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
    graphStatus: text("graph_status").notNull().default("pending"),
    lastIndexedAt: text("last_indexed_at"),
    lastGraphBuiltAt: text("last_graph_built_at"),
    documentCount: integer("document_count").notNull().default(0),
    chunkCount: integer("chunk_count").notNull().default(0),
    nodeCount: integer("node_count").notNull().default(0),
    edgeCount: integer("edge_count").notNull().default(0),
    lastError: text("last_error"),
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
  })
);

// ── Per-Workspace DB Schema ──

export const documents = sqliteTable(
  "documents",
  {
    id: text("id").primaryKey(),
    path: text("path").notNull(),
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
  },
  (table) => ({
    pathUnique: unique().on(table.path),
  })
);

export const chunks = sqliteTable("chunks", {
  id: text("id").primaryKey(),
  documentId: text("document_id")
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

export const graphNodes = sqliteTable("graph_nodes", {
  id: text("id").primaryKey(),
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
  id: text("id").primaryKey(),
  fromNodeId: text("from_node_id")
    .notNull()
    .references(() => graphNodes.id, { onDelete: "cascade" }),
  toNodeId: text("to_node_id")
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
  id: text("id").primaryKey(),
  mode: text("mode").notNull(),
  status: text("status").notNull().default("pending"),
  filesScanned: integer("files_scanned").notNull().default(0),
  filesUpdated: integer("files_updated").notNull().default(0),
  chunksWritten: integer("chunks_written").notNull().default(0),
  errorMessage: text("error_message"),
  stats: text("stats").default("{}"),
  startedAt: text("started_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  finishedAt: text("finished_at"),
});

export const graphRuns = sqliteTable("graph_runs", {
  id: text("id").primaryKey(),
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
  id: text("id").primaryKey(),
  query: text("query").notNull(),
  mode: text("mode").notNull(),
  resultCount: integer("result_count").notNull().default(0),
  latencyMs: integer("latency_ms"),
  retrievedChunks: text("retrieved_chunks").notNull().default("[]"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const memories = sqliteTable("memories", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  tags: text("tags").notNull().default(""),
  source: text("source").notNull(),
  supersedesId: text("supersedes_id"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});
