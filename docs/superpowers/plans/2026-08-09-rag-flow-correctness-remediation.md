# RAG Flow Correctness Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make FTS, lazy graph expansion, incremental graph invalidation, embedding retrieval, and parser caches deterministic and correct across restarts and multiple workspaces.

**Architecture:** Fix retrieval in dependency order. First make FTS lossless and migrate existing indexes. Then introduce one registry-backed graph lifecycle service with generation checks and route every graph consumer through it. Keep the default vector path Bun-first by retaining BLOB cosine search and removing the misleading, process-global sqlite-vec path until a supported ANN runtime is selected separately. Finish by removing global tokenizer state, fixing parser cache/symbol coverage, and restoring all repository verification gates.

**Tech Stack:** Bun 1.3+, TypeScript, `bun:sqlite` in WAL mode, FTS5, Bun test runner, pnpm/Turbo

## Global Constraints

- SQLite in WAL mode remains the default and only required storage path.
- The registry database remains global under `~/.openez/`; workspace databases remain under `<root>/.openez/`.
- `workspaceId` is the canonical identity. Services resolve `rootPath` from the registry and never accept an unverified ID/path pair.
- Embeddings remain optional. `embedding.provider = "none"` must leave indexing and querying fully functional.
- Do not add Postgres, Redis, BullMQ, Docker, or a second required SQLite driver.
- Every behavior change follows red-green TDD with focused `bun test` commands before the full suite.
- No destructive data migration may run merely because a workspace database was opened.
- Complete only when `bun test`, `pnpm typecheck`, `pnpm format:check`, `pnpm build:web`, and `pnpm build:cli` all exit 0.

---

## File Structure

| File                                             | Action | Responsibility                                                       |
| ------------------------------------------------ | ------ | -------------------------------------------------------------------- |
| `packages/db/src/sqlite/fts-repository.ts`       | Modify | Lossless FTS text composition, schema version, transactional rebuild |
| `packages/db/src/sqlite/workspace-db.ts`         | Modify | Non-destructive schema upgrades and graph generation metadata        |
| `packages/db/src/sqlite/types.ts`                | Modify | Graph lifecycle and FTS rebuild contracts                            |
| `packages/db/src/sqlite/graph-traversal-ops.ts`  | Modify | Persistence/traversal only; remove competing graph builder           |
| `packages/indexer/src/graph-service.ts`          | Create | Canonical graph readiness, locking, lifecycle, generation checks     |
| `packages/indexer/src/index-workspace.ts`        | Modify | Persist graph invalidation and delegate graph construction           |
| `packages/indexer/src/index.ts`                  | Modify | Export the graph service entry points                                |
| `packages/core/src/retrieval.ts`                 | Modify | Ensure graph readiness and keep explicit BLOB cosine retrieval       |
| `packages/core/src/tokenizer.ts`                 | Modify | Scoped token counting strategy without mutable global mode           |
| `apps/mcp/src/mcp-core.ts`                       | Modify | Route all read tools through canonical orchestration                 |
| `apps/web/src/server/index.ts`                   | Modify | Route graph/query endpoints through canonical orchestration          |
| `packages/indexer/src/parsers/oxc-parser.ts`     | Modify | First-class nested functions and class methods                       |
| `packages/db/src/sqlite/database-loader.ts`      | Modify | Remove process-global vec capability                                 |
| `packages/db/src/sqlite/embedding-repository.ts` | Modify | BLOB embeddings only; surface write failures                         |
| `tests/fts-retrieval.test.ts`                    | Create | FTS beginning/middle/end, metadata, rebuild regression coverage      |
| `tests/graph-lifecycle.test.ts`                  | Create | Lazy build, restart, concurrency, generation, identity coverage      |
| `tests/tokenizer-concurrency.test.ts`            | Create | Concurrent exact/fast token strategy isolation                       |
| `tests/embedding-migration.test.ts`              | Modify | Explicit reindex requirement and non-destructive database open       |
| `tests/vector-search.test.ts`                    | Modify | BLOB cosine fallback and provider/dimension isolation                |
| `tests/parsed-documents-cache.test.ts`           | Modify | Native-unavailable fallback cache hit                                |
| `tests/oxc-parser.test.ts`                       | Modify | Nested function and method graph symbol coverage                     |
| `AGENTS.md`                                      | Modify | Match the implemented Oxc/Bun-first indexing path                    |
| `CONTRIBUTING.md`                                | Modify | Match Bun test runner and verification gates                         |

---

### Task 1: Make FTS indexing lossless and self-migrating

**Files:**

- Modify: `packages/db/src/sqlite/fts-repository.ts`
- Modify: `packages/db/src/sqlite/workspace-db.ts`
- Modify: `packages/db/src/sqlite/types.ts`
- Create: `tests/fts-retrieval.test.ts`
- Modify: `tests/workspace-db.test.ts`

**Interfaces:**

- Produces: `composeFtsSearchText(content: string, metadata: string): string`
- Produces: `FTS_SCHEMA_VERSION = "2"`
- Produces: `ensureFtsReady()` that transactionally rebuilds all FTS rows when `fts_schema_version !== "2"`
- Preserves: `WorkspaceRepository.fullTextSearch(query, limit)`

- [ ] **Step 1: Write failing long-content and metadata tests**

Create `tests/fts-retrieval.test.ts` using the existing temporary workspace setup from `tests/workspace-db.test.ts`:

```ts
async function insertTestDocument(
  repo: WorkspaceRepository,
  documentPath: string,
): Promise<string> {
  return repo.insertDocument({
    path: documentPath,
    absolutePath: path.join(tempRoot, documentPath),
    kind: "code",
    language: "typescript",
    contentHash: `document:${documentPath}`,
    sizeBytes: 1,
    mtimeMs: 1,
  });
}

it("finds terms at the beginning, middle, and end of a long chunk", async () => {
  const repo = createWorkspaceRepository(tempRoot);
  const documentId = await insertTestDocument(repo, "src/long.ts");
  const content = `startNeedle ${"padding ".repeat(90)} middleNeedle ${"padding ".repeat(90)} endNeedle`;
  await repo.insertChunks([
    { documentId, chunkIndex: 0, content, tokenCount: 400, contentHash: "long", metadata: "{}" },
  ]);

  expect(await repo.fullTextSearch("startNeedle", 5)).toHaveLength(1);
  expect(await repo.fullTextSearch("middleNeedle", 5)).toHaveLength(1);
  expect(await repo.fullTextSearch("endNeedle", 5)).toHaveLength(1);
});

it("indexes normalized symbol metadata that is absent from content", async () => {
  const repo = createWorkspaceRepository(tempRoot);
  const documentId = await insertTestDocument(repo, "src/payment.ts");
  await repo.insertChunks([
    {
      documentId,
      chunkIndex: 0,
      content: "return true",
      tokenCount: 2,
      contentHash: "metadata",
      metadata: JSON.stringify({ searchText: "process payment history" }),
    },
  ]);

  expect(await repo.fullTextSearch("payment", 5)).toHaveLength(1);
});
```

- [ ] **Step 2: Run the focused test and verify the regression**

Run: `bun test tests/fts-retrieval.test.ts`

Expected: FAIL because the end token and metadata-only token are not present in `chunks_fts.search_text`.

- [ ] **Step 3: Implement one FTS text composer and use it on every write path**

Add to `fts-repository.ts`:

```ts
export const FTS_SCHEMA_VERSION = "2";

export function composeFtsSearchText(content: string, metadata: string): string {
  const parsed = safeParseJson(metadata, {}) as { searchText?: unknown };
  const searchText = typeof parsed.searchText === "string" ? parsed.searchText.trim() : "";
  return searchText ? `${searchText}\n${content}` : content;
}
```

Replace `content.slice(0, 400)` in `bulkInsertFts`. Change SQL trigger/backfill definitions to use full `new.content`; trigger SQL cannot parse the application JSON helper, so concatenate `coalesce(json_extract(new.metadata, '$.searchText'), '') || char(10) || new.content`.

- [ ] **Step 4: Add a transactional FTS v2 rebuild**

In `ensureFtsReady()`, rebuild rather than only backfill when the version is stale:

```ts
if (deps.getMeta("fts_schema_version") === FTS_SCHEMA_VERSION) return;
native.exec("BEGIN IMMEDIATE");
try {
  native.exec("DELETE FROM chunks_fts");
  native.exec(`INSERT INTO chunks_fts (chunk_id, path, heading, language, search_text)
    SELECT c.id, d.path, coalesce(c.heading, ''), coalesce(d.language, ''),
      coalesce(json_extract(c.metadata, '$.searchText'), '') || char(10) || c.content
    FROM chunks c JOIN documents d ON d.id = c.document_id`);
  restoreFtsTriggerDefinitions(native);
  deps.setMeta("fts_schema_version", FTS_SCHEMA_VERSION);
  native.exec("COMMIT");
} catch (error) {
  native.exec("ROLLBACK");
  throw error;
}
```

Fresh databases must set `fts_schema_version=2` after schema initialization. Legacy `fts_backfill_pending` may be read once for compatibility but must not remain the canonical version signal.

- [ ] **Step 5: Add a legacy rebuild regression test**

Open a database containing a v1 FTS row, set `index_meta.fts_schema_version` to `1`, reopen it, call `fullTextSearch("endNeedle", 5)`, and assert the term is returned and the stored version is `2`.

- [ ] **Step 6: Run focused tests**

Run: `bun test tests/fts-retrieval.test.ts tests/workspace-db.test.ts tests/e2e-search.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/sqlite/fts-repository.ts packages/db/src/sqlite/workspace-db.ts packages/db/src/sqlite/types.ts tests/fts-retrieval.test.ts tests/workspace-db.test.ts
git commit -m "fix(db): index complete chunk content in FTS"
```

---

### Task 2: Persist graph invalidation and generation state

**Files:**

- Modify: `packages/db/src/sqlite/schema.ts`
- Modify: `packages/db/src/sqlite/registry-db.ts`
- Modify: `packages/db/src/sqlite/registry-repository.ts`
- Modify: `packages/db/src/sqlite/types.ts`
- Modify: `packages/indexer/src/index-workspace.ts`
- Create: `tests/graph-lifecycle.test.ts`

**Interfaces:**

- Adds to `RegistryWorkspace`: `indexGeneration: number`, `graphGeneration: number`
- Produces: `invalidateWorkspaceGraph(workspaceId: string): Promise<number>` returning the new index generation
- State transitions: source change → `pending`; build start → `running`; matching build success → `completed`; build failure → `failed`

- [ ] **Step 1: Write a failing persisted-invalidation test**

```ts
it("persists graph pending after an incremental symbol change", async () => {
  const source = path.join(workspaceRoot, "symbol.ts");
  fs.writeFileSync(source, "export function oldName() {}\n");
  const workspace = await registry.ensureWorkspace({ rootPath: workspaceRoot });
  await indexWorkspace({ workspaceId: workspace.id });
  await ensureGraphReady(workspace.id);

  fs.writeFileSync(source, "export function newName() {}\n");
  await indexWorkspace({ workspaceId: workspace.id, mode: "incremental" });
  closeRegistryDb();

  const reopened = await createRegistryRepository().getWorkspace(workspace.id);
  expect(reopened?.graphStatus).toBe("pending");
  expect(reopened?.indexGeneration).toBeGreaterThan(reopened?.graphGeneration ?? -1);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `bun test tests/graph-lifecycle.test.ts -t "persists graph pending"`

Expected: FAIL because invalidation currently exists only in process-local memory.

- [ ] **Step 3: Add registry generation columns and map them**

Add non-null integer columns with default `0`:

```sql
ALTER TABLE workspaces ADD COLUMN index_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workspaces ADD COLUMN graph_generation INTEGER NOT NULL DEFAULT 0;
```

Update registry templates, row mapping, `RegistryWorkspace`, and `updateWorkspace` to expose both values. Migration must check `PRAGMA table_info(workspaces)` before each `ALTER TABLE`.

- [ ] **Step 4: Implement atomic invalidation**

Add this registry operation:

```ts
invalidateWorkspaceGraph(id: string): Promise<number>;
```

Its SQL must atomically increment `index_generation`, set `graph_status='pending'`, and return the new generation:

```sql
UPDATE workspaces
SET index_generation = index_generation + 1,
    graph_status = 'pending',
    updated_at = ?
WHERE id = ?
RETURNING index_generation;
```

Call it once per indexing run only when a full reset, deletion, or changed parsed document affects graph input. Do not invalidate for a true no-op incremental index.

- [ ] **Step 5: Add no-op and restart assertions**

Add tests proving a no-op index preserves `completed` and generation values, while a changed/deleted source survives registry close/reopen as `pending`.

- [ ] **Step 6: Run focused tests**

Run: `bun test tests/graph-lifecycle.test.ts tests/index-workspace.test.ts tests/registry.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/sqlite/schema.ts packages/db/src/sqlite/registry-db.ts packages/db/src/sqlite/registry-repository.ts packages/db/src/sqlite/types.ts packages/indexer/src/index-workspace.ts tests/graph-lifecycle.test.ts
git commit -m "fix(indexer): persist graph invalidation generations"
```

---

### Task 3: Introduce one canonical graph lifecycle service

**Files:**

- Create: `packages/indexer/src/graph-service.ts`
- Modify: `packages/indexer/src/index-workspace.ts`
- Modify: `packages/indexer/src/index.ts`
- Modify: `packages/db/src/sqlite/graph-traversal-ops.ts`
- Modify: `packages/db/src/sqlite/graph-ops-shared.ts`
- Modify: `packages/db/src/sqlite/graph-repository.ts`
- Modify: `packages/db/src/sqlite/types.ts`
- Modify: `packages/core/src/retrieval.ts`
- Modify: `apps/mcp/src/mcp-core.ts`
- Modify: `apps/web/src/server/index.ts`
- Modify: `tests/graph-lifecycle.test.ts`
- Modify: `tests/mcp-tools.test.ts`

**Interfaces:**

- Produces: `ensureGraphReady(workspaceId: string): Promise<void>`
- Produces: `createGraphService(deps: GraphServiceDeps)` for dependency-isolated tests
- Internal builder: `buildGraphGeneration(workspaceId: string, rootPath: string, generation: number): Promise<{ nodeCount: number; edgeCount: number }>`
- Removes public use of: `buildGraphForWorkspace(workspaceId, rootPath)`
- DB graph repositories retain persistence and traversal only.

- [ ] **Step 1: Write a failing code-query lazy-build test**

```ts
it("builds graph when code_query is the first graph-aware operation", async () => {
  fs.writeFileSync(path.join(workspaceRoot, "a.ts"), "export function target() {}\n");
  fs.writeFileSync(path.join(workspaceRoot, "b.ts"), "export function caller() { target(); }\n");
  const workspace = await registry.ensureWorkspace({ rootPath: workspaceRoot });
  await indexWorkspace({ workspaceId: workspace.id });
  expect(await createWorkspaceRepository(workspaceRoot).getNodeCount()).toBe(0);

  await codeQuery({ workspaceId: workspace.id, query: "target" });

  expect(await createWorkspaceRepository(workspaceRoot).getNodeCount()).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Add failing concurrency and stale-generation tests**

Use an injectable internal builder spy. Assert two concurrent `ensureGraphReady(id)` calls invoke it once. Start generation 1, invalidate to generation 2 before generation 1 publishes, then assert generation 1 cannot set `completed` or replace generation 2 graph state.

Use this explicit dependency boundary rather than a module-level test setter:

```ts
export interface GraphServiceDeps {
  registry: RegistryRepository;
  buildGraphGeneration(
    workspaceId: string,
    rootPath: string,
    generation: number,
  ): Promise<{ nodeCount: number; edgeCount: number }>;
  now(): string;
}

export function createGraphService(deps: GraphServiceDeps): {
  ensureGraphReady(workspaceId: string): Promise<void>;
};
```

- [ ] **Step 3: Run the focused tests and verify they fail**

Run: `bun test tests/graph-lifecycle.test.ts`

Expected: FAIL because `codeQuery` does not ensure graph readiness and the builder lacks persisted generation checks.

- [ ] **Step 4: Implement `ensureGraphReady` with canonical registry resolution**

Create `graph-service.ts` with a per-workspace in-flight map:

```ts
const graphBuilds = new Map<string, Promise<void>>();

export async function ensureGraphReady(workspaceId: string): Promise<void> {
  const existing = graphBuilds.get(workspaceId);
  if (existing) return existing;

  const build = ensureGraphReadyInternal(workspaceId).finally(() => {
    if (graphBuilds.get(workspaceId) === build) graphBuilds.delete(workspaceId);
  });
  graphBuilds.set(workspaceId, build);
  return build;
}
```

`ensureGraphReadyInternal` must load the workspace by ID, return only when `graphStatus === "completed" && graphGeneration === indexGeneration`, set `running`, build the captured generation, then re-read the registry. Publish `completed`, counts, `lastGraphBuiltAt`, and `graphGeneration` only if `indexGeneration` still equals the captured generation. On failure, set `failed` only when that generation is still current.

- [ ] **Step 5: Move graph construction behind the service**

Move `_buildGraphInternal` out of `index-workspace.ts` or export it only as the internal `buildGraphGeneration` dependency. Remove `_graphDirtyWorkspaces` and the old `graphBuilds` map.

Delete `ensureGraphBuilt` from `graph-traversal-ops.ts`, its `GraphOpsDeps` meta dependency, and all `graph_pending` lifecycle decisions. `graphNeighbors` becomes a pure query over persisted graph tables.

- [ ] **Step 6: Route every graph consumer through the service**

- `codeQuery`: call `ensureGraphReady(workspace.id)` immediately before graph expansion unless `skipGraphExpand` is true.
- MCP `code_context` and `graph_neighbors`: call `ensureGraphReady(w.id)`; never pass `rootPath`.
- Web graph endpoint: call `ensureGraphReady(id)` unconditionally; the service performs the cheap readiness check.
- Web query endpoint: retain parallel query only after `ensureGraphReady(workspaceId)` has completed, or let `codeQuery` own expansion and remove the duplicate repository traversal.

- [ ] **Step 7: Add cross-workspace identity coverage**

Create two roots with the same basename and distinct registry IDs. Assert each `ensureGraphReady(id)` populates only its own workspace DB and that no API accepts a caller-supplied mismatched root.

- [ ] **Step 8: Run focused tests**

Run: `bun test tests/graph-lifecycle.test.ts tests/mcp-tools.test.ts tests/index-workspace.test.ts tests/hybrid-retrieval.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/indexer/src/graph-service.ts packages/indexer/src/index-workspace.ts packages/indexer/src/index.ts packages/db/src/sqlite/graph-traversal-ops.ts packages/db/src/sqlite/graph-ops-shared.ts packages/db/src/sqlite/graph-repository.ts packages/db/src/sqlite/types.ts packages/core/src/retrieval.ts apps/mcp/src/mcp-core.ts apps/web/src/server/index.ts tests/graph-lifecycle.test.ts tests/mcp-tools.test.ts
git commit -m "fix(graph): centralize lazy build lifecycle"
```

---

### Task 4: Make the default embedding path explicit and non-destructive

**Decision:** Keep BLOB cosine linear scan as the supported Bun-first path. Remove sqlite-vec code and the ANN claim from the default runtime. A future ANN implementation requires its own spec, supported runtime matrix, integration test, and benchmark.

**Files:**

- Modify: `packages/db/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `packages/db/src/sqlite/database-loader.ts`
- Modify: `packages/db/src/sqlite/workspace-db.ts`
- Modify: `packages/db/src/sqlite/embedding-repository.ts`
- Modify: `packages/db/src/sqlite/index.ts`
- Modify: `packages/core/src/retrieval.ts`
- Modify: `tests/embedding-migration.test.ts`
- Modify: `tests/vector-search.test.ts`
- Modify: `docs/superpowers/specs/2026-08-08-rag-architecture-improvement-design.md`

**Interfaces:**

- Removes: `hasVecExtension()` and `embeddings_vec`
- Preserves: `rankStoredEmbeddings(rootPath, provider, queryEmbedding, limit)` using provider/model/dimensions-filtered BLOB rows and cosine similarity
- Database open preserves legacy TEXT embeddings, marks the workspace FTS-only, and emits an actionable reindex warning; it never deletes them.

- [ ] **Step 1: Replace the destructive migration test with a failing preservation test**

```ts
it("does not delete legacy TEXT embeddings when opening a workspace", () => {
  const db = createNativeDatabase(dbPath);
  initializeWorkspaceSchema(db);
  db.exec("DROP TABLE embeddings");
  db.exec(`CREATE TABLE embeddings (
    id TEXT PRIMARY KEY,
    chunk_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    dimensions INTEGER NOT NULL,
    embedding TEXT NOT NULL,
    input_hash TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.prepare(
    "INSERT INTO embeddings (id, chunk_id, provider, model, dimensions, embedding) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("emb-1", "chunk-1", "ollama", "bge-m3", 3, "[0.1, 0.2, 0.3]");

  expect(() => initializeWorkspaceSchema(db)).not.toThrow();
  expect(db.prepare("SELECT value FROM index_meta WHERE key = 'embedding_format'").get()).toEqual({
    value: "text",
  });
  expect(db.prepare("SELECT count(*) AS count FROM embeddings").get()).toEqual({ count: 1 });
  db.close();
});
```

- [ ] **Step 2: Run focused tests and verify the preservation test fails**

Run: `bun test tests/embedding-migration.test.ts tests/vector-search.test.ts`

Expected: FAIL because database open should preserve legacy rows, mark the workspace
for FTS-only retrieval, and emit an actionable reindex warning.

- [ ] **Step 3: Replace destructive open-time migration with FTS-only fallback**

Detect a TEXT `embedding` column before preparing repository statements, preserve it,
and record the legacy format so retrieval disables vector ranking:

```ts
console.error(
  "Workspace has legacy TEXT embeddings. Vector search is disabled until `openez reindex <path>` rebuilds them as BLOB.",
);
```

The full reindex path must explicitly recreate the embedding table as BLOB inside its reset flow. Do not perform this action from `initializeWorkspaceSchema()`.

- [ ] **Step 4: Remove the unreachable sqlite-vec path**

Remove the dependency, extension loader state, virtual table creation/sync/delete code, and vec query branch. Keep the existing BLOB cosine scan and its `dimensions = queryEmbedding.length` filter. Rename comments from “fallback” to “supported local vector search”.

- [ ] **Step 5: Add provider/dimension isolation tests**

Insert 768- and 1536-dimension rows for different model keys, query each model, and assert only matching provider/model/dimension rows participate. Assert an invalid BLOB length returns similarity 0 rather than throwing.

- [ ] **Step 6: Correct the architecture spec**

Mark the former sqlite-vec ANN phase as deferred and record the implemented Bun-first BLOB decision. Do not retain claims that `vec0` 0.1.9 provides ANN.

- [ ] **Step 7: Run focused tests**

Run: `bun test tests/embedding-blob.test.ts tests/embedding-migration.test.ts tests/vector-search.test.ts tests/hybrid-retrieval.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/db/package.json pnpm-lock.yaml packages/db/src/sqlite/database-loader.ts packages/db/src/sqlite/workspace-db.ts packages/db/src/sqlite/embedding-repository.ts packages/db/src/sqlite/index.ts packages/core/src/retrieval.ts tests/embedding-migration.test.ts tests/vector-search.test.ts docs/superpowers/specs/2026-08-08-rag-architecture-improvement-design.md
git commit -m "fix(embeddings): make BLOB cosine search the supported path"
```

---

### Task 5: Scope token counting and accept the active parser cache

**Files:**

- Modify: `packages/core/src/tokenizer.ts`
- Modify: `packages/indexer/src/tokenizer.ts`
- Modify: `packages/indexer/src/index-workspace.ts`
- Create: `tests/tokenizer-concurrency.test.ts`
- Modify: `tests/parsed-documents-cache.test.ts`

**Interfaces:**

- Produces: `TokenCounter` with `count(value)` and `split(value, maxTokens, overlapTokens)`
- Produces: `exactTokenCounter` and `fastTokenCounter`
- Removes: `setFastTokenCount(enabled)` and module-global `_fastMode`
- Produces: `resolveNativeParser(): NativeParser | null`

```ts
interface NativeParser {
  id: "native-v1";
  parseCodeBatch(items: Array<{ language: string; content: string }>): Array<{
    symbols: Array<{ name: string; symbolType: string; exported: boolean }>;
    importPaths: string[];
    calledIdentifiers: string[];
    callExpressions: Array<{ callerName: string; calleeName: string }>;
  } | null>;
}
```

- [ ] **Step 1: Write a failing concurrency isolation test**

```ts
it("keeps fast indexing counts isolated from exact retrieval counts", async () => {
  const value = "function calculateTotal(price: number) { return price * 1.2; }";
  const [fast, exact] = await Promise.all([
    Promise.resolve(fastTokenCounter.count(value)),
    Promise.resolve(exactTokenCounter.count(value)),
  ]);

  expect(fast).toBe(Math.ceil(value.length / 4));
  expect(exact).toBe(countTokens(value));
});
```

- [ ] **Step 2: Write a failing fallback-cache test**

Inject `resolveNativeParser()` returning `null`, build the graph twice, and spy on the fallback parser. Assert the second build reuses the matching `fallback-v1` cache and performs zero fallback parses.

- [ ] **Step 3: Run focused tests and verify they fail**

Run: `bun test tests/tokenizer-concurrency.test.ts tests/parsed-documents-cache.test.ts`

Expected: FAIL because token mode is global and native cache selection rejects fallback entries before resolving parser availability.

- [ ] **Step 4: Implement scoped token counters**

```ts
export interface TokenCounter {
  count(value: string): number;
  split(value: string, maxTokens: number, overlapTokens?: number): string[];
}

export const fastTokenCounter: TokenCounter = {
  count: (value) => Math.ceil(value.length / 4),
  split: splitApproximately,
};

export const exactTokenCounter: TokenCounter = {
  count: countTokens,
  split: splitToTokenLimit,
};
```

Pass `fastTokenCounter` through `chunkDocument`, parser input, and `boundChunks` during indexing. Retrieval continues to use `exactTokenCounter`. Remove the outer `setFastTokenCount(true/false)` lifecycle entirely.

- [ ] **Step 5: Resolve the active parser before cache validation**

Resolve native capability once per graph build. Set `expectedParserVersion` to `native-v1` when available and `fallback-v1` otherwise. Accept a cache row only when both content hash and that expected version match. Extract duplicated native loader code into `resolveNativeParser()` and reuse it from indexing and graph build.

- [ ] **Step 6: Run focused tests**

Run: `bun test tests/tokenizer-concurrency.test.ts tests/parsed-documents-cache.test.ts tests/index-workspace.test.ts tests/mcp-tools.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/tokenizer.ts packages/indexer/src/tokenizer.ts packages/indexer/src/index-workspace.ts tests/tokenizer-concurrency.test.ts tests/parsed-documents-cache.test.ts
git commit -m "fix(indexer): scope token strategy and parser cache"
```

---

### Task 6: Make Oxc nested functions and class methods graph symbols

**Files:**

- Modify: `packages/indexer/src/parsers/oxc-parser.ts`
- Modify: `tests/oxc-parser.test.ts`
- Modify: `tests/index-workspace.test.ts`
- Modify: `AGENTS.md`

**Interfaces:**

- `ParsedDocument.definedSymbols` includes nested named functions and class methods.
- Method labels use `ClassName.methodName` to avoid collisions.
- Call expressions use the same qualified caller label as the corresponding symbol.

- [ ] **Step 1: Write failing parser coverage**

```ts
it("emits nested functions and class methods as graphable symbols", () => {
  const content = `
    function outer() { function inner() { helper(); } inner(); }
    class Service { run() { helper(); } }
    function helper() {}
  `;
  const result = new OxcParser().parse(
    {
      relativePath: "symbols.ts",
      absolutePath: "/tmp/symbols.ts",
      content,
      targetTokens: 500,
      overlapTokens: 50,
    },
    "typescript",
    "code",
  );

  expect(result.definedSymbols.map((symbol) => symbol.name)).toEqual(
    expect.arrayContaining(["outer", "inner", "Service", "Service.run", "helper"]),
  );
  expect(result.callExpressions).toContainEqual({ callerName: "inner", calleeName: "helper" });
  expect(result.callExpressions).toContainEqual({
    callerName: "Service.run",
    calleeName: "helper",
  });
});
```

- [ ] **Step 2: Write a failing graph integration test**

Index the same source, call `ensureGraphReady(workspace.id)`, and assert `graphNeighbors("inner", 1)` and `graphNeighbors("Service.run", 1)` each contain a `calls` edge to `helper`.

- [ ] **Step 3: Run focused tests and verify they fail**

Run: `bun test tests/oxc-parser.test.ts tests/index-workspace.test.ts`

Expected: FAIL because nested callables are internal-only and class methods are not extracted.

- [ ] **Step 4: Extend symbol extraction**

Return nested callable `SymbolAst` entries as part of the public symbol list, not only call extraction. Walk `ClassDeclaration.body.body` for `MethodDefinition` entries, create qualified method names, and ensure nested traversal skips method/function bodies already attributed to their own symbol so calls are not duplicated on the enclosing class/function.

- [ ] **Step 5: Update indexing documentation**

Change `AGENTS.md` from “TS/JS richest indexing path via ts-morph” to the actual Oxc-based path, including the first-class nested function/method behavior.

- [ ] **Step 6: Run focused tests**

Run: `bun test tests/oxc-parser.test.ts tests/parser-registry.test.ts tests/index-workspace.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/indexer/src/parsers/oxc-parser.ts tests/oxc-parser.test.ts tests/index-workspace.test.ts AGENTS.md
git commit -m "fix(indexer): graph nested TypeScript symbols"
```

---

### Task 7: Restore repository verification gates and run MCP smoke tests

**Files:**

- Modify: `package.json`
- Modify: `tsconfig.json`
- Modify: `tsconfig.base.json`
- Modify: `packages/db/tsconfig.json`
- Modify: `packages/indexer/tsconfig.json`
- Modify: `apps/web/tsconfig.json`
- Modify: `apps/web/src/routes/documents.tsx`
- Modify: `apps/web/src/routes/index.tsx`
- Modify: `apps/web/src/routes/memories.tsx`
- Modify: `apps/web/src/routes/workspaces/index.tsx`
- Modify: `apps/web/src/routes/workspaces/$workspaceId/index.tsx`
- Modify: `tests/index-workspace.test.ts`
- Modify: `tests/parser-registry.test.ts`
- Modify: `tests/vector-search.test.ts`
- Modify: `CONTRIBUTING.md`
- Modify: `.prettierignore`

**Interfaces:**

- Root TypeScript configuration recognizes `bun:test`, `bun:sqlite`, `Bun`, and `ImportMeta.dir` without weakening strictness.
- Web API response types flow into route loaders so arrays are not `unknown[]` or implicit `any`.
- `CONTRIBUTING.md` names Bun tests consistently with `package.json`.

- [ ] **Step 1: Capture the failing gate baselines**

Run: `pnpm typecheck`

Expected before fixes: FAIL with the known Bun type, web `unknown`/implicit-any, and parser test signature errors.

Run: `pnpm format:check`

Expected before fixes: FAIL because generated native build output is included.

- [ ] **Step 2: Configure Bun types without weakening compiler options**

Add `@types/bun` at the workspace root or the package that owns Bun-based tests and include `"bun"` in the relevant `compilerOptions.types`. Do not disable `strict`, `noImplicitAny`, or `useUnknownInCatchVariables`.

- [ ] **Step 3: Fix source-level type errors**

Define typed loader/API response shapes for web routes and use them at query boundaries. Correct parser test calls to current zero-argument factory signatures. Narrow `queryRaw` results explicitly in vector tests. Add explicit types to test destructuring callbacks.

- [ ] **Step 4: Align documented test tooling**

Replace “focused Vitest test” in `CONTRIBUTING.md` with “focused Bun test”, because the root test command and all tests use `bun:test`.

- [ ] **Step 5: Exclude generated native artifacts from formatting**

Add these patterns to `.prettierignore`:

```text
packages/native/target/
packages/native/*.node
```

Do not ignore authored TypeScript, Markdown, JSON, or source configuration files to make the gate pass.

- [ ] **Step 6: Run the complete verification sequence**

Run in order:

```bash
bun test
pnpm typecheck
pnpm format:check
pnpm build:web
pnpm build:cli
bun apps/cli/dist/cli.cjs --version
bun apps/cli/dist/cli.cjs --help
```

Expected: every command exits 0.

- [ ] **Step 7: Run a fresh CLI and MCP smoke flow**

In a temporary workspace containing two related TypeScript files:

```bash
bun apps/cli/dist/cli.cjs init <temp-path>
bun apps/cli/dist/cli.cjs status <temp-path>
```

Start the freshly built MCP server, call only `code_query` for a symbol near the end of a long chunk, and assert the result is returned and graph node count becomes non-zero. Restart MCP, rename the symbol, run incremental index, call `code_query` again, and assert the old symbol is absent and the new symbol is present.

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json packages/*/tsconfig.json apps/web/src/routes tests CONTRIBUTING.md .prettierignore
git commit -m "chore: restore typecheck and verification gates"
```

---

## Final Acceptance Checklist

- [ ] FTS retrieves unique tokens from the beginning, middle, and end of long chunks.
- [ ] FTS retrieves path/symbol terms present only in normalized metadata.
- [ ] Opening a v1 workspace transactionally rebuilds FTS v2 without requiring a full source reindex.
- [ ] Calling only `code_query` on a fresh workspace builds the graph once.
- [ ] Graph invalidation survives process restart.
- [ ] A stale graph generation cannot publish over a newer index generation.
- [ ] Workspace identity is resolved solely from canonical `workspaceId`.
- [ ] Legacy TEXT embeddings are preserved until an explicit full reindex.
- [ ] Default vector retrieval is documented and tested as BLOB cosine linear scan, not ANN.
- [ ] Concurrent indexing cannot change retrieval token-count behavior.
- [ ] Native-unavailable graph builds reuse `fallback-v1` parse cache entries.
- [ ] Nested functions and class methods produce resolvable graph nodes and call edges.
- [ ] Tests, typecheck, format check, web build, CLI build, and fresh MCP smoke flow all pass.

## Deferred Work

- A real ANN implementation is intentionally outside this remediation. It requires a separate design choosing a supported SQLite runtime/build, ANN library/version, index lifecycle, metric, dimension migration, benchmark dataset, and production capability reporting.
- Splitting `index-workspace.ts` further is deferred until correctness work lands. Extraction may happen only where needed to create `graph-service.ts` and shared native-parser resolution.
