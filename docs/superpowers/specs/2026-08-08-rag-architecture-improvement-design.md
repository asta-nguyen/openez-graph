# OpenEZ RAG Architecture Improvement Design

**Date:** 2026-08-08
**Status:** Approved
**Approach:** Sequential — 4 phases, each committed and verified independently
**Breaking changes:** Yes — full reindex required (no auto-migration)

## Goal

Improve 4 architectural bottlenecks in the OpenEZ RAG pipeline:

1. `repository.ts` too large (1824 lines) — split into focused modules
2. Vector search linear scan — replace with sqlite-vec ANN
3. Graph build re-parses all docs — cache parse results
4. Embeddings stored as JSON TEXT — switch to BLOB (Float32Array)

## Phase 1: Split `repository.ts`

### Problem

`packages/db/src/sqlite/repository.ts` is 1824 lines containing documents, chunks, embeddings, FTS, graph, memories, index_runs, and query_logs operations. Hard to navigate, hard to test, violates single responsibility.

### Design

Split into 6 focused files. `repository.ts` becomes a thin re-export facade for backward compatibility.

```
packages/db/src/sqlite/
├─ repository.ts              → re-export facade (existing imports unchanged)
├─ document-repository.ts     → documents + chunks CRUD
├─ embedding-repository.ts    → embeddings insert/delete
├─ fts-repository.ts          → FTS5 bulk insert, search, trigger toggle
├─ graph-repository.ts        → nodes/edges CRUD + BFS traversal
├─ memory-repository.ts       → memories CRUD + search
└─ workspace-repository.ts    → schema init + orchestrator (composes 5 above)
```

### Constraints

- No behavior change — move functions only, no logic edits
- All existing imports from `repository.ts` must still work (re-export)
- Each file <300 lines target
- `createWorkspaceRepository()` and `createRegistryRepository()` signatures unchanged
- All 134 tests must pass after split

### Migration strategy

1. Extract functions group-by-group into new files
2. Update `repository.ts` to re-export from new files
3. Verify tests pass after each extraction
4. No external API changes — consumers don't notice

---

## Phase 2: Embedding BLOB Storage

### Problem

`embeddings.embedding` column is `TEXT` storing JSON arrays like `"[0.1, 0.2, ...]"`. Every vector search loads + JSON.parse for each row. 3-5x slower than binary, ~50% larger storage.

### Design

Change to `BLOB` storing `Float32Array.buffer` directly.

```sql
-- Before
embedding TEXT NOT NULL

-- After
embedding BLOB NOT NULL
```

### Changes

- `insertEmbeddings()` — `new Float32Array(arr).buffer` instead of `JSON.stringify`
- `rankStoredEmbeddings()` — `new Float32Array(blob)` instead of `JSON.parse`
- `vectorSearch()` — read BLOB directly
- Schema: `ALTER TABLE embeddings` column type (requires full reindex)

### Constraints

- Full reindex required — no auto-migration
- Dimensions stored in existing `dimensions` column (unchanged)
- `input_hash` dedup logic unchanged
- Provider/model columns unchanged
- Embeddings are optional (per AGENTS.md) — BLOB change only affects rows that exist; `vectorSearch()` already no-ops when no embeddings configured

### Affected files

- `packages/db/src/sqlite/embedding-repository.ts` (after Phase 1 split)
- `packages/db/src/sqlite/workspace-db.ts` — schema definition
- `packages/core/src/retrieval.ts` — `rankStoredEmbeddings()`

---

## Phase 3: sqlite-vec ANN Index

### Problem

`rankStoredEmbeddings()` does linear cosine similarity scan over all embeddings. O(n) per query. With 10K+ chunks, latency becomes noticeable.

### Design

Add `sqlite-vec` extension for approximate nearest neighbor (ANN) search.

```sql
CREATE VIRTUAL TABLE embeddings_vec USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  embedding FLOAT[768]
);
```

### Changes

- Load `sqlite-vec` extension in `createNativeDatabase()` via `db.loadExtension()`
- Sync `embeddings` → `embeddings_vec` on insert/delete
- `vectorSearch()` — `SELECT chunk_id FROM embeddings_vec WHERE embedding MATCH ? ORDER BY distance LIMIT k`
- Fallback: if extension fails to load, keep linear scan (graceful degradation)

### Constraints

- `sqlite-vec` is an optional native dependency — graceful fallback to linear scan if not installed (per AGENTS.md: "Embeddings are optional")
- Extension path resolved at runtime (platform-specific)
- Dimensions must match provider config (768 for bge-m3, 1536 for OpenAI)
- If dimensions change (different model), vec table must be rebuilt
- Full reindex required for initial setup
- If embeddings disabled (`embedding.provider = "none"`), vec table stays empty — no overhead

### Affected files

- `packages/db/src/sqlite/database-loader.ts` — load extension
- `packages/db/src/sqlite/embedding-repository.ts` — sync to vec table
- `packages/db/src/sqlite/workspace-db.ts` — vec table schema
- `packages/core/src/retrieval.ts` — `vectorSearch()` query

### Fallback strategy

```ts
let hasVecExtension = false;
try {
  db.loadExtension(sqliteVecPath);
  hasVecExtension = true;
} catch {
  // Graceful degradation — linear scan
}
```

---

## Phase 4: Cache Parse Results for Graph

### Problem

`buildGraphForWorkspace()` re-parses all code/markdown/config documents even though they were already parsed during indexing. For 1000 files, this adds ~5s of redundant work.

### Design

Store parse output (symbols, imports, calls) in DB during indexing. Graph build reads from cache instead of re-parsing.

```sql
CREATE TABLE parsed_documents (
  document_id INTEGER PRIMARY KEY,
  content_hash TEXT NOT NULL,    -- invalidate when content changes
  symbols TEXT,                   -- JSON: [{name, kind, line, endLine, chunkId}]
  imports TEXT,                   -- JSON: [{path, resolvedPath}]
  calls TEXT,                     -- JSON: [{caller, callee, line}]
  parsed_at INTEGER NOT NULL
);
```

### Changes

- `indexWorkspace()` — save parse results into `parsed_documents` during indexing
- `buildGraphForWorkspace()` — read from `parsed_documents` instead of re-parsing
- Cache invalidation: compare `content_hash` — if mismatch, parse and cache
- Fallback: if cache miss (old data without cache), parse and populate

### Constraints

- Cache only for code/markdown/config (not binary files)
- `content_hash` from `documents` table is the invalidation key
- If parse logic changes (parser upgrade), must invalidate all cache
- Graph build still works without cache (backward compat)

### Affected files

- `packages/db/src/sqlite/document-repository.ts` — `parsed_documents` CRUD
- `packages/db/src/sqlite/workspace-db.ts` — schema
- `packages/indexer/src/index-workspace.ts` — save parse results during index, read from cache in `buildGraphForWorkspace()`

---

## Execution Order

| Phase | What                | Risk                      | Reindex?                     |
| ----- | ------------------- | ------------------------- | ---------------------------- |
| 1     | Split repository.ts | Low — move only           | No                           |
| 2     | Embedding BLOB      | Medium — schema change    | Yes                          |
| 3     | sqlite-vec ANN      | Medium — native extension | Yes                          |
| 4     | Cache parse results | Low — additive            | No (populated on next index) |

Phases 2 and 3 both require reindex, so they're ordered consecutively. Phase 1 (split) must come first since Phases 2-4 modify files created by the split.

## Verification

After each phase:

- `bun test` — all 134 tests pass
- `pnpm typecheck` — 8/8 packages pass
- `prettier --check` — clean
- CLI smoke test: `init` → `index` → `status` → `code_query` via MCP

## Out of Scope

- Query result caching (separate concern, not architectural)
- Memory integration with codeQuery (feature, not architecture)
- `index-workspace.ts` split (1452 lines — deferred, lower priority)
- Multi-model embedding support (feature, not architecture)
