# Reindex Speed & Pipeline Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accelerate full reindexing throughput by 3–5× via native AST parsing/chunking, batched SQLite write transactions, WAL bulk pragmas, and zero-data-loss legacy migration handling.

**Architecture:** A multi-stage pipeline combining native Rust Rayon AST extraction with JS fallback, 500-row parameterized SQLite transaction batching, proper WAL checkpointing, and safe schema migrations.

**Tech Stack:** TypeScript, Node.js/Bun, SQLite (WAL mode, Drizzle ORM / native driver), Rust (Rayon, napi-rs, ignore crate).

## Global Constraints

- Must be SQLite-first with WAL mode.
- Must provide seamless JS fallback when `@openez-graph/native` is absent.
- Must preserve all user memories and query logs across schema migrations.

---

### Task 1: Memory & Query Log Migration Safety (`packages/db`)

**Files:**

- Modify: `packages/db/src/sqlite/workspace-db.ts`
- Create: `tests/workspace-migration.test.ts`

- [ ] **Step 1: Write migration tests for legacy TEXT to INTEGER primary key conversion**
  - Test `memories` table with `supersedes_id` relationship chains.
  - Test `query_logs` table missing token/file columns from older versions.
  - Test failure resilience (backup retention).
- [ ] **Step 2: Run test to confirm failure**
  - Run `bun test tests/workspace-migration.test.ts`.
- [ ] **Step 3: Implement safe `migrateTextPkToInteger`**
  - Create TEMP backups of `memories` and `query_logs`.
  - Remap `supersedes_id` properly to new integer IDs.
  - Check backup columns before querying `query_logs`.
  - Rethrow any restore error loudly and protect the backup.
- [ ] **Step 4: Verify migration test passes**
  - Run `bun test tests/workspace-migration.test.ts`.
- [ ] **Step 5: Commit changes**
  - `git commit -m "fix(db): preserve memories and query logs during legacy text primary key migration"`

---

### Task 2: SQLite Write Batching, WAL Pragmas & FTS Rowid Alignment (`packages/db`)

**Files:**

- Modify: `packages/db/src/sqlite/chunk-repository.ts`
- Modify: `packages/db/src/sqlite/workspace-repository.ts`
- Modify: `packages/db/src/sqlite/fts-repository.ts`
- Modify: `tests/workspace-db.test.ts`

- [ ] **Step 1: Write test for batched inserts and WAL checkpoint cleanup**
  - Verify `insertChunks` handles 1,000+ chunks in 500-row batches.
  - Verify `disableOptimizedWriteMode` resets pragmas and checkpoints WAL.
  - Verify FTS rowids match `chunks.id`.
- [ ] **Step 2: Implement 500-row batching for chunks, documents, and graph nodes**
  - Optimize `insertChunks` and `replaceGraphArtifacts` with prepared statements and chunked parameter arrays.
- [ ] **Step 3: Update `enableOptimizedWriteMode` & `disableOptimizedWriteMode`**
  - Configure `PRAGMA synchronous = OFF`, `cache_size = -64000`, `wal_autocheckpoint = 0`.
  - Restore `PRAGMA synchronous = NORMAL`, `threads = 0`, and invoke `PRAGMA wal_checkpoint(PASSIVE)`.
- [ ] **Step 4: Ensure FTS `rowid = chunk_id` across all FTS inserts**
- [ ] **Step 5: Verify tests pass**
  - Run `bun test tests/workspace-db.test.ts`.
- [ ] **Step 6: Commit changes**
  - `git commit -m "perf(db): batch SQLite inserts, optimize WAL mode pragmas, and align FTS rowids"`

---

### Task 3: Scanner Gitignore Negation Semantics (`packages/native` & `packages/indexer`)

**Files:**

- Modify: `packages/native/src/lib.rs` (if applicable)
- Modify: `packages/indexer/src/scanner.ts`
- Modify: `tests/scanner.test.ts` (or add test case)

- [ ] **Step 1: Write test case for .gitignore `!` negation rules**
- [ ] **Step 2: Update scanner to respect gitignore negation**
- [ ] **Step 3: Verify scanner tests pass**
- [ ] **Step 4: Commit changes**
  - `git commit -m "fix(scanner): preserve gitignore negation rules and file inclusion order"`

---

### Task 4: Reindex Pipeline Acceleration & Timing Optimization (`packages/indexer`)

**Files:**

- Modify: `packages/indexer/src/index-workspace.ts`
- Create: `tests/reindex-speed.test.ts`

- [ ] **Step 1: Write end-to-end reindex performance and correctness tests**
  - Verify complete indexing of multi-file project with TS/JS/MD/Python.
  - Verify symbol resolution and call edge generation.
- [ ] **Step 2: Connect native AST parsing / chunking batching with JS fallback**
  - Optimize phase 1–5 memory allocations and timing logs.
- [ ] **Step 3: Verify all test suites pass**
  - Run `bun test`.
  - Run `pnpm typecheck`.
- [ ] **Step 4: Commit changes**
  - `git commit -m "perf(indexer): optimize reindexing speed with batch parsing and high-throughput write pipeline"`
