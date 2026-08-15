# Reindex Pipeline Optimization & SQLite Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Accelerate full workspace indexing and reindexing performance across large multi-thousand file repositories while preserving SQLite storage invariants and type safety across all packages.

---

## File Responsibility Matrix

| Package / Module     | Files                                                                                                                                                                                                                           | Responsibility                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Native Engine**    | `packages/native/src/oxc_parser.rs`<br>`packages/native/src/parser.rs`<br>`packages/native/src/lib.rs`                                                                                                                          | High-performance Rust OXC AST parser, Rayon thread-pool parallel chunking & scanning.                                         |
| **Database Layer**   | `packages/db/src/sqlite/chunk-repository.ts`<br>`packages/db/src/sqlite/document-repository.ts`<br>`packages/db/src/sqlite/fts-repository.ts`<br>`packages/db/src/sqlite/schema.ts`<br>`packages/db/src/sqlite/workspace-db.ts` | 64-bit integer primary keys, prepared statement batch ingestion, atomic write transactions, targeted `resetIndexArtifacts()`. |
| **Indexer Pipeline** | `packages/indexer/src/index-workspace.ts`<br>`packages/indexer/src/scanner.ts`<br>`packages/indexer/src/parsers/oxc-parser.ts`                                                                                                  | 7-phase streaming pipeline, native parser dispatch, scanner ignore pattern filtering.                                         |
| **Core Layer**       | `packages/core/src/types.ts`<br>`packages/core/src/retrieval.ts`<br>`packages/core/src/memory.ts`                                                                                                                               | Numerical ID typing for symbols, chunks, documents, and memory retrieval.                                                     |
| **MCP Server**       | `apps/mcp/src/mcp-core.ts`                                                                                                                                                                                                      | Integer `supersedesId` schema validation and tool dispatch for MCP clients.                                                   |
| **CLI Application**  | `apps/cli/src/cli.ts`<br>`apps/cli/src/setup-agent.ts`<br>`apps/cli/src/resolve-cli.ts`                                                                                                                                         | Lazy bundle evaluation, unified agent setup (`openez setup <agent>`).                                                         |
| **Web Dashboard**    | `apps/web/src/lib/api.ts`<br>`apps/web/src/routes/*`                                                                                                                                                                            | Numerical ID routing, document/chunk views, query telemetry dashboard.                                                        |
| **Documentation**    | `docs/superpowers/specs/2026-08-16-reindex-pipeline-optimization-design.md`<br>`docs/superpowers/plans/2026-08-16-reindex-pipeline-optimization.md`                                                                             | Formal architecture specification, design docs, and implementation plan.                                                      |

---

## Implemented Tasks & Verification Checklist

### Task 1: SQLite Integer ID Migration & Schema Refactor

- [x] Migrate `documents`, `chunks`, `memories`, `graph_nodes`, and `graph_edges` schema to 64-bit integer primary keys.
- [x] Update TypeScript interfaces across `@openez-graph/db`, `@openez-graph/core`, and `@openez-graph/web`.
- [x] Update all repository methods to return and consume numerical IDs.

### Task 2: Native Rust OXC Parser & Rayon Batching

- [x] Add `oxc_parser` crate in `packages/native/Cargo.toml`.
- [x] Implement parallel AST parser `parse_and_chunk_batch` using Rayon in `packages/native/src/parser.rs`.
- [x] Export N-API bindings and build native binary.

### Task 3: Prepared Statement Batch Ingestion & Lock Optimization

- [x] Replace Drizzle ORM per-row query compilation with prepared statements in `chunk-repository.ts` and `document-repository.ts`.
- [x] Remove `PRAGMA locking_mode = EXCLUSIVE` from `workspace-db.ts` finalize.
- [x] Add explicit `DELETE FROM parsed_documents` in `resetIndexArtifacts()`.

### Task 4: CLI Startup & MCP Schema Alignment

- [x] Apply `DEFAULT_EXCLUDE_PATTERNS` to native scanner results in `scanner.ts`.
- [x] Convert `chokidar` and `embedWorkspace` to dynamic imports in `cli.ts`.
- [x] Unify agent setup scripts into `apps/cli/src/setup-agent.ts`.
- [x] Support integer and string-coerced `supersedesId` in `apps/mcp/src/mcp-core.ts`.

### Task 5: Verification & Benchmarks

- [x] Run monorepo typecheck: `pnpm typecheck` (all 8 packages pass with 0 errors).
- [x] Build web and CLI artifacts: `pnpm build:web && pnpm build:cli` (clean build).
- [x] Run full unit & integration test suite: `bun test` (**260 / 260 tests passing, 100%**).
- [x] Execute live benchmark on 2,903-file Zed codebase (full reindex: **2.96 s**, incremental: **34 ms**).
