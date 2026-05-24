import { relations, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  customType,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uuid
} from "drizzle-orm/pg-core";

const vector = customType<{ data: number[] | string }>({
  dataType() {
    return "vector";
  },
  toDriver(value) {
    if (typeof value === "string") {
      return value;
    }
    return `[${value.join(",")}]`;
  }
});

// Enums for workspace status
export const workspaceStatusEnum = pgEnum("workspace_status", [
  "pending",
  "indexing",
  "indexed",
  "error"
]);

export const indexingStatusEnum = pgEnum("indexing_status", [
  "pending",
  "running",
  "completed",
  "failed"
]);

export const graphStatusEnum = pgEnum("graph_status", [
  "pending",
  "running",
  "completed",
  "failed"
]);

export const runStatusEnum = pgEnum("run_status", [
  "pending",
  "running",
  "completed",
  "failed"
]);

// Workspaces table - expanded for multi-workspace management
export const workspaces = pgTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    rootPath: text("root_path").notNull(),
    includeGlobs: text("include_globs").array().notNull().default(sql`ARRAY[]::text[]`),
    excludeGlobs: text("exclude_globs").array().notNull().default(sql`ARRAY[]::text[]`),
    status: workspaceStatusEnum("status").notNull().default("pending"),
    indexingStatus: indexingStatusEnum("indexing_status").notNull().default("pending"),
    graphStatus: graphStatusEnum("graph_status").notNull().default("pending"),
    lastIndexedAt: timestamp("last_indexed_at"),
    lastGraphBuiltAt: timestamp("last_graph_built_at"),
    documentCount: integer("document_count").notNull().default(0),
    chunkCount: integer("chunk_count").notNull().default(0),
    nodeCount: integer("node_count").notNull().default(0),
    edgeCount: integer("edge_count").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    nameUnique: unique().on(table.name)
  })
);

// Documents table
export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    absolutePath: text("absolute_path").notNull(),
    kind: text("kind").notNull(),
    language: text("language"),
    contentHash: text("content_hash").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    mtimeMs: bigint("mtime_ms", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    workspacePathUnique: unique().on(table.workspaceId, table.path)
  })
);

// Chunks table
export const chunks = pgTable("chunks", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  documentId: uuid("document_id")
    .notNull()
    .references(() => documents.id, { onDelete: "cascade" }),
  chunkIndex: integer("chunk_index").notNull(),
  heading: text("heading"),
  content: text("content").notNull(),
  tokenCount: integer("token_count").notNull(),
  contentHash: text("content_hash").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow()
});

// Embeddings table
export const embeddings = pgTable("embeddings", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  chunkId: uuid("chunk_id")
    .notNull()
    .references(() => chunks.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  dimensions: integer("dimensions").notNull(),
  embedding: vector("embedding").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow()
});

// Graph nodes table
export const graphNodes = pgTable("graph_nodes", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  label: text("label").notNull(),
  refId: text("ref_id"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow()
});

// Graph edges table
export const graphEdges = pgTable("graph_edges", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  fromNodeId: uuid("from_node_id")
    .notNull()
    .references(() => graphNodes.id, { onDelete: "cascade" }),
  toNodeId: uuid("to_node_id")
    .notNull()
    .references(() => graphNodes.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  weight: real("weight").notNull().default(1),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at").notNull().defaultNow()
});

// Index runs table - workspace-scoped
export const indexRuns = pgTable("index_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  mode: text("mode").notNull(),
  status: runStatusEnum("status").notNull().default("pending"),
  filesScanned: integer("files_scanned").notNull().default(0),
  filesUpdated: integer("files_updated").notNull().default(0),
  chunksWritten: integer("chunks_written").notNull().default(0),
  embeddingsWritten: integer("embeddings_written").notNull().default(0),
  errorMessage: text("error_message"),
  stats: jsonb("stats").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  finishedAt: timestamp("finished_at")
});

// Graph runs table - workspace-scoped
export const graphRuns = pgTable("graph_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  mode: text("mode").notNull().default("incremental"),
  status: runStatusEnum("status").notNull().default("pending"),
  nodesCreated: integer("nodes_created").notNull().default(0),
  edgesCreated: integer("edges_created").notNull().default(0),
  errorMessage: text("error_message"),
  stats: jsonb("stats").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  finishedAt: timestamp("finished_at")
});

// Query logs table
export const queryLogs = pgTable("query_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  query: text("query").notNull(),
  mode: text("mode").notNull(),
  resultCount: integer("result_count").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow()
});

// Memories table
export const memories = pgTable("memories", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  content: text("content").notNull(),
  tags: text("tags").array().notNull().default(sql`ARRAY[]::text[]`),
  source: text("source").notNull(),
  supersedesId: uuid("supersedes_id").references((): AnyPgColumn => memories.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow()
});

// Relations
export const workspaceRelations = relations(workspaces, ({ many }) => ({
  documents: many(documents),
  memories: many(memories),
  indexRuns: many(indexRuns),
  graphRuns: many(graphRuns),
  chunks: many(chunks),
  graphNodes: many(graphNodes),
  graphEdges: many(graphEdges)
}));

export const documentRelations = relations(documents, ({ many, one }) => ({
  workspace: one(workspaces, {
    fields: [documents.workspaceId],
    references: [workspaces.id]
  }),
  chunks: many(chunks)
}));

export const chunkRelations = relations(chunks, ({ one }) => ({
  document: one(documents, {
    fields: [chunks.documentId],
    references: [documents.id]
  }),
  workspace: one(workspaces, {
    fields: [chunks.workspaceId],
    references: [workspaces.id]
  })
}));

export const indexRunRelations = relations(indexRuns, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [indexRuns.workspaceId],
    references: [workspaces.id]
  })
}));

export const graphRunRelations = relations(graphRuns, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [graphRuns.workspaceId],
    references: [workspaces.id]
  })
}));

// Type exports
export type WorkspaceRow = typeof workspaces.$inferSelect;
export type DocumentRow = typeof documents.$inferSelect;
export type ChunkRow = typeof chunks.$inferSelect;
export type EmbeddingRow = typeof embeddings.$inferSelect;
export type GraphNodeRow = typeof graphNodes.$inferSelect;
export type GraphEdgeRow = typeof graphEdges.$inferSelect;
export type MemoryRow = typeof memories.$inferSelect;
export type IndexRunRow = typeof indexRuns.$inferSelect;
export type GraphRunRow = typeof graphRuns.$inferSelect;
