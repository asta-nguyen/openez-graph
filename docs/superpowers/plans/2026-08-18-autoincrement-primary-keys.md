# Autoincrement Primary & Foreign Keys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate all workspace SQLite tables from UUID strings (`crypto.randomUUID()`) to `INTEGER PRIMARY KEY AUTOINCREMENT` and update TypeScript types to numeric IDs.

**Architecture:** Update SQLite schema DDL in `packages/db`, adjust repository interfaces to return and query integer primary keys, update indexer ingestion pipelines to map auto-generated integer IDs natively, and update Core/MCP/Web consumption layers.

**Tech Stack:** TypeScript, SQLite (bun:sqlite / better-sqlite3), `@openez-graph/core`, `@openez-graph/db`, `@openez-graph/indexer`, `@openez-graph/mcp`.

## Global Constraints

- Storage model remains SQLite in WAL mode per `AGENTS.md`.
- All entity primary keys in workspace databases are `INTEGER PRIMARY KEY AUTOINCREMENT`.
- TypeScript entity interfaces use `id: number` and numeric foreign keys.
- Eliminate all `crypto.randomUUID()` ID generation in data ingestion paths.
- All 262 tests must pass with zero type errors across all 10 monorepo packages.

---

### Task 1: DDL & Database Layer Types

**Files:**

- Modify: `packages/db/src/sqlite/workspace-db.ts`
- Modify: `packages/db/src/sqlite/types.ts`
- Modify: `packages/db/src/sqlite/shared-types.ts`

**Interfaces:**

- Consumes: SQLite schema table definitions.
- Produces: `WorkspaceDocument.id: number`, `WorkspaceChunk.id: number`, `WorkspaceChunk.documentId: number`, `WorkspaceGraphNode.id: number`, `WorkspaceGraphEdge.id: number`, `Memory.id: number`, `QueryLog.id: number`, `IndexRun.id: number`.

- [ ] **Step 1: Update DDL statements in `workspace-db.ts`**
  - Change `documents.id`, `chunks.id`, `graph_nodes.id`, `graph_edges.id`, `embeddings.id`, `memories.id`, `query_logs.id`, `index_runs.id` to `INTEGER PRIMARY KEY AUTOINCREMENT`.
  - Change all foreign key columns (`document_id`, `chunk_id`, `source_node_id`, `target_node_id`, `supersedes_id`) to `INTEGER`.
- [ ] **Step 2: Update TypeScript type definitions in `types.ts` and `shared-types.ts`**
  - Update entity interfaces and repository method signatures to use `number` for IDs.
- [ ] **Step 3: Run typecheck on `@openez-graph/db`**
  - Run `pnpm --filter @openez-graph/db typecheck` and verify initial typing.

---

### Task 2: Repository Operations (DB Layer)

**Files:**

- Modify: `packages/db/src/sqlite/document-repository.ts`
- Modify: `packages/db/src/sqlite/chunk-repository.ts`
- Modify: `packages/db/src/sqlite/fts-repository.ts`
- Modify: `packages/db/src/sqlite/graph-node-ops.ts`
- Modify: `packages/db/src/sqlite/graph-edge-ops.ts`
- Modify: `packages/db/src/sqlite/graph-traversal-ops.ts`
- Modify: `packages/db/src/sqlite/embedding-repository.ts`
- Modify: `packages/db/src/sqlite/memory-repository.ts`
- Modify: `packages/db/src/sqlite/workspace-repository.ts`
- Test: `tests/workspace-db.test.ts`

**Interfaces:**

- Consumes: Numeric ID types from Task 1.
- Produces: Working repository methods for inserting, querying, batch streaming, and traversing integer-keyed entities.

- [ ] **Step 1: Update `document-repository.ts`**
  - Let SQLite assign `id` via `RETURNING id` or `lastInsertRowid` in `insertDocument`.
  - Update `listDocuments`, `getDocumentById`, `findDocumentByPath` to return numeric `id`.
- [ ] **Step 2: Update `chunk-repository.ts` and `fts-repository.ts`**
  - Remove `crypto.randomUUID()` in chunk insertion.
  - Update `chunks_fts(chunk_id)` to store integer `chunk_id`.
  - Update `getChunksForDocument`, `findChunksByHeading` to accept/return numeric IDs.
- [ ] **Step 3: Update `graph-node-ops.ts`, `graph-edge-ops.ts`, `graph-traversal-ops.ts`**
  - Remove UUID generation for nodes and edges.
  - Update neighbor traversal SQL queries to join on integer IDs.
- [ ] **Step 4: Update `embedding-repository.ts` and `memory-repository.ts`**
  - Remove UUID generation in embeddings and memories.
  - Update `supersedes_id` handling to work with integers.
- [ ] **Step 5: Update `tests/workspace-db.test.ts` and run tests**
  - Run `bun test tests/workspace-db.test.ts` and verify all pass.

---

### Task 3: Indexer Pipeline (`packages/indexer`)

**Files:**

- Modify: `packages/indexer/src/index-workspace.ts`
- Modify: `packages/indexer/src/graph-service.ts`
- Modify: `packages/indexer/src/types.ts`
- Test: `tests/index-workspace.test.ts`
- Test: `tests/reindex-speed.test.ts`
- Test: `tests/graph-lifecycle.test.ts`

**Interfaces:**

- Consumes: DB repository operations with numeric IDs.
- Produces: Ingestion pipeline that indexes codebases and builds graph topologies without UUID string overhead.

- [ ] **Step 1: Update `index-workspace.ts` document & chunk insertion**
  - Connect document IDs and chunk IDs via auto-increment integers.
- [ ] **Step 2: Update `graph-service.ts` & graph topology generation**
  - In `buildGraphGeneration`, resolve symbol node IDs to integer IDs and wire edge references (`source_node_id`, `target_node_id`).
- [ ] **Step 3: Run indexer unit tests**
  - Run `bun test tests/index-workspace.test.ts tests/graph-lifecycle.test.ts tests/reindex-speed.test.ts`.

---

### Task 4: Core, MCP, and Web Layer Adaptation

**Files:**

- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/retrieval.ts`
- Modify: `apps/mcp/src/mcp-core.ts`
- Modify: `apps/web/src/server/sqlite.ts`
- Test: `tests/mcp-tools.test.ts`
- Test: `tests/fts-retrieval.test.ts`
- Test: `tests/hybrid-retrieval.test.ts`
- Test: `tests/vector-search.test.ts`

**Interfaces:**

- Consumes: Indexer and DB interfaces.
- Produces: Consistent retrieval and MCP tool handlers accepting and returning numeric entity IDs.

- [ ] **Step 1: Update `packages/core/src/types.ts` and `retrieval.ts`**
  - Update `SearchResult.chunkId`, `Document.id`, `Chunk.id` to `number`.
- [ ] **Step 2: Update `apps/mcp/src/mcp-core.ts`**
  - Adjust MCP tool output formatters for `code_query`, `code_context`, `graph_neighbors`, `memory_recall`.
- [ ] **Step 3: Update `apps/web/src/server/sqlite.ts`**
  - Update web API endpoints querying chunks, documents, and memories.
- [ ] **Step 4: Run MCP and retrieval tests**
  - Run `bun test tests/mcp-tools.test.ts tests/fts-retrieval.test.ts tests/hybrid-retrieval.test.ts`.

---

### Task 5: End-to-End Verification & Squashed Commit

**Files:**

- Test: All tests in `tests/`
- Monorepo: `pnpm typecheck`

- [ ] **Step 1: Run full test suite**
  - Run `bun test` across the entire monorepo.
- [ ] **Step 2: Run monorepo typecheck**
  - Run `pnpm typecheck` across all 10 packages.
- [ ] **Step 3: Measure speed benchmark**
  - Run `tests/reindex-speed.test.ts` to measure throughput improvement with native integer keys.
- [ ] **Step 4: Squash into 1 clean commit on `feat/autoincrement-primary-keys`**
  - Commit and push to `origin/feat/autoincrement-primary-keys`.
