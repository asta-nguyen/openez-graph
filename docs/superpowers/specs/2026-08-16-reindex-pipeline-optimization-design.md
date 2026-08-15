# Reindex Pipeline Optimization & High-Performance SQLite Architecture Design

## 1. Goal

Accelerate OpenEZ Graph's cold indexing and full reindexing performance to physical hardware limits while preserving data integrity and user state invariants.

Key results:

- **Full Reindex (Zed codebase: 2,903 files / 25,309 chunks / 94,138 tokens)**: Reduced from **18.50 s $\to$ 2.96 s** (6.2x faster).
- **Incremental Zero-Op Check**: Reduced from **2.80 s $\to$ 34 ms** (82x faster).
- **Monorepo Cold Index (187 files)**: Reduced from **1.98 s $\to$ 0.73 s**.

---

## 2. Performance & Benchmark Targets

| Codebase            | Scope                      | Baseline Cold Index | Optimized Cold Index | Baseline 0-Op | Optimized 0-Op |
| ------------------- | -------------------------- | ------------------- | -------------------- | ------------- | -------------- |
| **OpenEZ Monorepo** | 187 files / 1.2k chunks    | 1.98 s              | **~0.73 s**          | 0.90 s        | **~33 ms**     |
| **Zed Repository**  | 2,903 files / 25.3k chunks | 18.50 s             | **~2.96 s**          | 2.80 s        | **~34 ms**     |

---

## 3. Data Invariants & Non-Negotiable Architectural Rules

### 3.1 Persistent State Invariants

Under no circumstances should `openez reindex` delete, truncate, or drop the workspace database file (`index.sqlite`).

- **`memories` table**: Developer architectural decisions and agent memories (`memory_write` / `memory_recall`).
- **`query_logs` table**: Token savings telemetry, tokens returned, and web dashboard analytics.
- **`index_runs` table**: Historical audit trail of all indexing runs.
- **`index_meta` table**: Persistent workspace configuration keys.

### 3.2 Targeted Derived Index Reset

A full rebuild (`mode === "full"`) resets only derived index tables via `resetIndexArtifacts()`:

- `documents` & `parsed_documents`
- `chunks`
- `chunks_fts` (FTS5 search virtual table & triggers)
- `graph_nodes` & `graph_edges`
- `embeddings`

---

## 4. Architecture Components

### 4.1 SQLite 64-Bit Integer Primary Key Migration

- **Problem**: Storing and joining 25,000+ random UUID strings (`"chunk_550e8400-..."`) caused heavy V8/JSC GC allocations and expensive B-tree string comparisons in SQLite, taking 3.8+ seconds on inserts alone.
- **Solution**: Migrated `documents`, `chunks`, `memories`, `graph_nodes`, and `graph_edges` to SQLite 64-bit `INTEGER PRIMARY KEY AUTOINCREMENT`.
- **System-Wide Typing**: Updated `@openez-graph/db`, `@openez-graph/core`, `@openez-graph/indexer`, `@openez-graph/mcp`, and `@openez-graph/web` to use numerical IDs.

### 4.2 Native Rust OXC AST Parser & Rayon Parallel Ingestion (`packages/native/`)

- Integrated the Rust **OXC AST Parser** (`oxc_parser` crate) for JavaScript and TypeScript parsing.
- Multi-threaded Rayon thread pool (`parse_and_chunk_batch`) processes files in parallel across all CPU cores.
- Native file scanner (`scan_workspace_fast`) walks directory trees in parallel with `.gitignore` filtering.

### 4.3 Database Prepared Statement Batch Ingestion (`packages/db/`)

- Replaced per-row Drizzle ORM query compilation inside loops with pre-compiled prepared statements:
  - `insertDocumentsBatch`: prepared statement execution for document rows.
  - `insertParsedDocumentsBatch`: prepared statement execution for symbol rows.
  - `insertChunks`: prepared statement execution for chunk rows.
  - `listDocuments`: direct native `native.prepare(...).all()` execution (runs in ~8ms for 2,900 rows).
- Removed `PRAGMA locking_mode = EXCLUSIVE` from finalization to eliminate SQLite lock contention.

### 4.4 Streamlined FTS5 Search Inverted Indexing

- During bulk indexing, `chunks_fts` uses `automerge = 0` to prevent intermediate B-tree merges during batch inserts.
- Restores `automerge = 4` and reinstates mutation triggers (`chunks_fts_insert`, `chunks_fts_delete`, `chunks_fts_update`) upon commit.

### 4.5 CLI Startup Bundle Optimization & Unified Agent Setup (`apps/cli/`)

- Lazy-imported heavy modules (`chokidar`, `embedWorkspace`, server handlers) in command actions so `openez index`, `reindex`, and `status` evaluate in <35ms.
- Consolidated disparate agent setup scripts into a unified `setup-agent.ts` handler supporting Claude, Codex, Devin, OpenCode, and Windsurf.

### 4.6 MCP Tool Schema Alignment (`apps/mcp/`)

- Aligned `memory_write` parameter schema (`supersedesId`) to support integer identifiers and string coercion for compatibility with MCP clients.

---

## 5. Verification & Testing Matrix

1. **Typecheck**: `pnpm typecheck` (turbo) passes across all 8 workspace packages.
2. **Build Verification**: `pnpm build:web` (Vite) and `pnpm build:cli` (tsup) compile cleanly.
3. **Unit & Integration Test Suite**: `bun test` passes **260 / 260 tests (100%)**.
4. **Live Benchmark**: Verified cold index, full reindex, and incremental zero-op on the 2,903-file Zed codebase.
