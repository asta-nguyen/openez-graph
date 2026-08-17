# Autoincrement Primary & Foreign Keys Design Specification

- **Date**: 2026-08-18
- **Branch**: `feat/autoincrement-primary-keys` (stacked on `feat/reindex-speed-optimization`)
- **Status**: Proposed

---

## 1. Problem Statement & Motivation

Currently, the workspace SQLite schema uses 36-character UUID strings (`crypto.randomUUID()`) for primary keys and foreign keys across all entities:

- `documents` (`id TEXT PRIMARY KEY`)
- `chunks` (`id TEXT PRIMARY KEY`, `document_id TEXT REFERENCES documents(id)`)
- `graph_nodes` (`id TEXT PRIMARY KEY`, `document_id TEXT`, `chunk_id TEXT`)
- `graph_edges` (`id TEXT PRIMARY KEY`, `source_node_id TEXT`, `target_node_id TEXT`)
- `embeddings` (`id TEXT PRIMARY KEY`, `chunk_id TEXT REFERENCES chunks(id)`)
- `query_logs` (`id TEXT PRIMARY KEY`)
- `memories` (`id TEXT PRIMARY KEY`, `supersedes_id TEXT REFERENCES memories(id)`)
- `index_runs` (`id TEXT PRIMARY KEY`)

### Drawbacks of UUIDs in SQLite:

1. **CPU & Allocation Overhead**: Generating tens of thousands of UUID strings in V8/JSC during indexing adds significant GC and string allocation pressure.
2. **B-Tree Index Bloat**: 36-byte strings are ~4.5x larger than 8-byte SQLite integers, causing higher cache misses and larger database files.
3. **Join Inefficiency**: String comparisons on foreign keys (`document_id`, `chunk_id`, `source_node_id`, `target_node_id`) are significantly slower than 64-bit integer comparisons.

---

## 2. Proposed Architecture & Schema Changes

### 2.1 Workspace SQLite DDL (`packages/db/src/sqlite/workspace-db.ts`)

All tables will use `INTEGER PRIMARY KEY AUTOINCREMENT`:

```sql
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  absolute_path TEXT NOT NULL,
  kind TEXT NOT NULL,
  language TEXT,
  content_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  heading TEXT,
  content TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (document_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS graph_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  chunk_id INTEGER REFERENCES chunks(id) ON DELETE SET NULL,
  symbol_name TEXT NOT NULL,
  symbol_type TEXT NOT NULL,
  path TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  is_exported INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS graph_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_node_id INTEGER NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  target_node_id INTEGER NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  edge_type TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  embedding BLOB NOT NULL,
  input_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual',
  supersedes_id INTEGER REFERENCES memories(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS query_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query TEXT NOT NULL,
  mode TEXT NOT NULL,
  result_count INTEGER NOT NULL,
  tokens_returned INTEGER NOT NULL DEFAULT 0,
  tokens_saved INTEGER NOT NULL DEFAULT 0,
  files_scanned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS index_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  files_scanned INTEGER NOT NULL DEFAULT 0,
  files_updated INTEGER NOT NULL DEFAULT 0,
  chunks_written INTEGER NOT NULL DEFAULT 0,
  embeddings_written INTEGER NOT NULL DEFAULT 0,
  embedding_failures INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);
```

---

## 3. TypeScript Type Updates

### 3.1 Type Definitions (`packages/db/src/sqlite/types.ts`)

- `WorkspaceDocument.id`: `number`
- `WorkspaceChunk.id`: `number`, `documentId`: `number`
- `WorkspaceGraphNode.id`: `number`, `documentId: number | null`, `chunkId: number | null`
- `WorkspaceGraphEdge.id`: `number`, `sourceNodeId`: `number`, `targetNodeId`: `number`
- `WorkspaceEmbedding.id`: `number`, `chunkId`: `number`
- `Memory.id`: `number`, `supersedesId`: `number | null`
- `QueryLog.id`: `number`
- `IndexRun.id`: `number`

---

## 4. Repository & Batch Insert Operations

### 4.1 SQLite Batch Inserts without JS UUID Generation

- When inserting `chunks` in batch, omit `id` from the parameter list so SQLite generates consecutive auto-increment `id` values natively.
- For FTS matching, FTS5 `chunk_id` stores integer `id` directly.
- Graph node and edge ingestion maps internal symbol indices to generated integer IDs directly.

---

## 5. Migration & Backwards Compatibility

- On new indexing or reindexing, databases are initialized with the clean integer schema.
- Existing legacy databases are handled cleanly on opening without data loss.

---

## 6. Verification Plan

- Unit tests: all 262 tests updated and passing with numeric IDs.
- Monorepo typecheck: `pnpm typecheck` passing cleanly across all 10 packages.
- Benchmarks: `tests/reindex-speed.test.ts` verifying faster indexing throughput.
