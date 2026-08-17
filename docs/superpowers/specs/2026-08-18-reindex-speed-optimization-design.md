# Reindex Speed & Pipeline Optimization Design Specification

## 1. Goal

Accelerate OpenEZ Graph full reindexing and initial indexing throughput by **3–5×** through native multi-core AST parsing/chunking in Rust (Rayon), 500-row parameterized SQLite insert batching, and zero-data-loss legacy migration handling for memories and query logs.

---

## 2. Architecture & Data Flow

```
+-----------------------------------------------------------------------------------+
| 1. Scan Phase (Native Rust Rayon / JS Fallback)                                   |
|    - Fast traversal with `ignore` crate, preserving .gitignore negation rules     |
|    - Computes mtime + size + content hash                                         |
+----------------------------------------+------------------------------------------+
                                         |
                                         v
+-----------------------------------------------------------------------------------+
| 2. Parallel Parsing & Chunking (Hybrid Rayon / oxc AST + JS Fallback)             |
|    - Rust Native: Parallel Rayon workers for TS/JS/Python/Go/Rust AST & chunks    |
|    - JS Fallback: Multi-file async batching with oxc-parser & WASM tree-sitter    |
|    - Output: Parsed symbols, token counts, headings, and call edges               |
+----------------------------------------+------------------------------------------+
                                         |
                                         v
+-----------------------------------------------------------------------------------+
| 3. SQLite High-Throughput Bulk Write Engine                                       |
|    - Indexing Mode: PRAGMA synchronous = OFF, cache_size = -64MB                  |
|    - Batched Inserts: 500-row parameterized chunks inside transactions            |
|    - Direct FTS population with rowid alignment                                   |
|    - Post-Index: PRAGMA synchronous = NORMAL, explicit WAL checkpoint (TRUNCATE)  |
+----------------------------------------+------------------------------------------+
                                         |
                                         v
+-----------------------------------------------------------------------------------+
| 4. Safe Legacy Migrations                                                         |
|    - TEMP backups for memories & query_logs                                       |
|    - Preserves and remaps `supersedes_id` chains                                  |
|    - Schema-aware column inspection with zero silent data loss                    |
+-----------------------------------------------------------------------------------+
```

---

## 3. Component Details

### 3.1. Native Rust Parser & Scanner Acceleration (`packages/native`)

- **Parallel AST & Chunk Extraction**: Implement `parse_and_chunk_batch` in Rust utilizing Rayon parallel iterators across available CPU cores for TypeScript, JavaScript, Python, Go, and Rust.
- **Gitignore Negation Semantics**: Fix `scan_workspace_fast` to preserve `!` negation exceptions and rule ordering in `.gitignore`.
- **Fast Content Hashing**: Utilize internal xxHash64 / DJB2 routines for instant chunk hash calculations.

### 3.2. SQLite Write Batching & WAL Optimization (`packages/db`)

- **Bulk Insert Chunking**: Batch document, chunk, and graph node insertions into 500-row parameterized statements within explicit transactions instead of row-by-row queries.
- **WAL Pragma Management**:
  - `enableOptimizedWriteMode()`: Configures `PRAGMA synchronous = OFF`, `PRAGMA cache_size = -64000`, `PRAGMA wal_autocheckpoint = 0`.
  - `disableOptimizedWriteMode()`: Restores `PRAGMA synchronous = NORMAL`, `PRAGMA threads = 0`, and executes `PRAGMA wal_checkpoint(PASSIVE)` to flush write frames.
- **FTS Rowid Integrity**: Ensure all direct FTS writes (`bulkInsertFts`, `insertFtsBatch`, `ensureFtsReady`) bind `rowid = chunk_id` to guarantee trigger synchronization without constraint collisions.

### 3.3. Memory & Query Log Migration Safety (`packages/db`)

- **Safe PK Migration (`migrateTextPkToInteger`)**:
  - Creates TEMP backup tables before recreating schemas.
  - Remaps legacy string UUIDs to autoincrement integer IDs.
  - Preserves `supersedes_id` lineage across memory chains.
  - Checks for optional columns in legacy `query_logs` (e.g. token and file counts) before querying.
  - Fails loudly and aborts if restore errors occur, never dropping backup tables on failure.

---

## 4. Verification & Quality Gates

1. **Unit & Integration Tests**:
   - `tests/reindex-speed.test.ts`: Measures reindex throughput and phase execution timings.
   - `tests/workspace-migration.test.ts`: Validates complete preservation of memories, `supersedes_id` links, and query logs across schema migrations.
   - `tests/fts-triggers.test.ts`: Verifies rowid alignment and delete/update trigger consistency.
2. **Command Verification Gates**:
   - `pnpm typecheck` (0 errors across all 10 packages).
   - `bun test` (100% pass rate).
