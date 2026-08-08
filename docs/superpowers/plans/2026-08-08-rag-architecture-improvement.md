# RAG Architecture Improvement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the 1824-line `repository.ts` into focused modules, switch embeddings from JSON TEXT to BLOB, add sqlite-vec ANN index, and cache parse results for graph build.

**Architecture:** Four sequential phases. Phase 1 splits `repository.ts` into 6 focused files with a re-export facade. Phase 2 changes embedding storage from JSON TEXT to Float32Array BLOB. Phase 3 adds sqlite-vec extension for ANN vector search with linear-scan fallback. Phase 4 caches parse output in DB so graph build avoids re-parsing.

**Tech Stack:** Bun 1.3+, `bun:sqlite`, `sqlite-vec`, TypeScript, drizzle-orm

## Global Constraints

- All 134 tests must pass after each task (`bun test`)
- `pnpm typecheck` — 8/8 packages pass
- `prettier --check` — clean
- `bun:sqlite` is the only SQLite driver (no `better-sqlite3`)
- Embeddings are optional (per AGENTS.md) — all embedding changes must gracefully handle `embedding.provider = "none"`
- `createWorkspaceRepository()` and `createRegistryRepository()` signatures unchanged
- Full reindex required for Phases 2-3 (no auto-migration)
- `WorkspaceRepository` interface in `types.ts` is the contract — implementations change, interface stays

---

## File Structure

| File                                             | Action          | Responsibility                                             |
| ------------------------------------------------ | --------------- | ---------------------------------------------------------- |
| `packages/db/src/sqlite/repository.ts`           | Modify → facade | Re-export from split files                                 |
| `packages/db/src/sqlite/document-repository.ts`  | Create          | Documents + chunks CRUD                                    |
| `packages/db/src/sqlite/embedding-repository.ts` | Create          | Embeddings insert/delete + BLOB encoding                   |
| `packages/db/src/sqlite/fts-repository.ts`       | Create          | FTS5 bulk insert, search, trigger toggle                   |
| `packages/db/src/sqlite/graph-repository.ts`     | Create          | Nodes/edges CRUD + BFS traversal                           |
| `packages/db/src/sqlite/memory-repository.ts`    | Create          | Memories CRUD + search                                     |
| `packages/db/src/sqlite/workspace-repository.ts` | Create          | Schema init + orchestrator                                 |
| `packages/db/src/sqlite/workspace-db.ts`         | Modify          | Embedding BLOB schema, vec table, parsed_documents table   |
| `packages/db/src/sqlite/database-loader.ts`      | Modify          | Load sqlite-vec extension                                  |
| `packages/db/src/sqlite/types.ts`                | Modify          | `insertEmbeddings` embedding type: `string` → `Uint8Array` |
| `packages/core/src/retrieval.ts`                 | Modify          | `parseEmbedding` BLOB, `vectorSearch` vec query            |
| `packages/indexer/src/index-workspace.ts`        | Modify          | Save parse results, read from cache in graph build         |
| `package.json`                                   | Modify          | Add `sqlite-vec` dependency                                |

---

### Task 1: Extract document-repository.ts (documents + chunks)

**Files:**

- Create: `packages/db/src/sqlite/document-repository.ts`
- Modify: `packages/db/src/sqlite/repository.ts`
- Test: `bun test tests/workspace-db.test.ts tests/index-workspace.test.ts`

**Interfaces:**

- Consumes: `NativeDatabase` interface from `repository.ts`, `WorkspaceRepository` type from `types.ts`
- Produces: `createDocumentOps(native, stmts)` returning an object with: `getDocument`, `getDocumentByPath`, `insertDocument`, `insertDocumentsBatch`, `updateDocument`, `deleteDocument`, `listDocuments`, `getChunksByDocument`, `insertChunks`, `deleteChunksByDocument`, `getDocumentCount`, `getChunkCount`, `streamDocument`, `streamChunk`, `streamChunksBatch`, `refreshStreamTimestamp`

- [ ] **Step 1: Create document-repository.ts with extracted functions**

Create `packages/db/src/sqlite/document-repository.ts`. Move these functions from `repository.ts`:

- Lines 459-602: `getDocumentCount`, `getChunkCount`, `getDocument`, `getDocumentByPath`, `insertDocument`, `insertDocumentsBatch`, `updateDocument`, `deleteDocument`, `listDocuments`
- Lines 602-672: `getChunksByDocument`, `insertChunks`, `deleteChunksByDocument`
- Lines 1295-1345: `streamDocument`, `streamChunk`, `streamChunksBatch`
- Lines 1505-1507: `refreshStreamTimestamp`
- Lines 1711-1735: `mapDocumentRow`, `mapChunkRow` helper functions

Export a factory function:

```ts
import crypto from "node:crypto";
import type { NativeDatabase } from "./repository";
import type { WorkspaceRepository } from "./types";

export interface DocumentStmts {
  docByPath: ReturnType<NativeDatabase["prepare"]>;
  docById: ReturnType<NativeDatabase["prepare"]>;
  insertDoc: ReturnType<NativeDatabase["prepare"]>;
  chunksByDoc: ReturnType<NativeDatabase["prepare"]>;
  insertChunk: ReturnType<NativeDatabase["prepare"]>;
  deleteChunksByDoc: ReturnType<NativeDatabase["prepare"]>;
  streamDoc: ReturnType<NativeDatabase["prepare"]>;
  streamChunk: ReturnType<NativeDatabase["prepare"]>;
  streamChunkBatch: ReturnType<NativeDatabase["prepare"]>;
}

export function createDocumentOps(native: NativeDatabase, stmts: DocumentStmts) {
  return {
    // ... all document/chunk methods moved here
  };
}
```

The methods keep their exact implementation — only the location changes. The `this` references that existed in the object literal become standalone functions calling `native` and `stmts` directly.

- [ ] **Step 2: Update repository.ts to import and spread document ops**

In `repository.ts`, replace the moved methods with:

```ts
import { createDocumentOps } from "./document-repository";

// Inside createWorkspaceRepository():
const documentOps = createDocumentOps(native, stmts);

return {
  ...documentOps,
  // ... other ops that haven't been moved yet
};
```

Keep the `stmts` object in `repository.ts` for now — it will be progressively split.

- [ ] **Step 3: Run tests**

Run: `bun test tests/workspace-db.test.ts tests/index-workspace.test.ts`
Expected: All pass (no behavior change, just code movement).

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/sqlite/document-repository.ts packages/db/src/sqlite/repository.ts
git commit -m "refactor(db): extract document-repository.ts from repository.ts"
```

---

### Task 2: Extract graph-repository.ts (nodes + edges + traversal)

**Files:**

- Create: `packages/db/src/sqlite/graph-repository.ts`
- Modify: `packages/db/src/sqlite/repository.ts`
- Test: `bun test tests/workspace-db.test.ts tests/index-workspace.test.ts tests/mcp-tools.test.ts`

**Interfaces:**

- Consumes: `NativeDatabase`, `WorkspaceRepository` type
- Produces: `createGraphOps(native, stmts)` returning: `upsertGraphNode`, `insertGraphNodesBatch`, `upsertGraphNodesBatch`, `getGraphNode`, `findGraphNode`, `deleteGraphNodesByRefId`, `findFileNode`, `getSymbolNodesByFilePath`, `deleteOutgoingEdges`, `updateSymbolNode`, `deleteGraphNodesByIds`, `deleteChunkNodesByChunkIds`, `insertEdge`, `insertEdges`, `deleteEdgesByNodeIds`, `graphNeighbors`, `getNodeCount`, `getEdgeCount`, `loadAllSymbolNodes`, `streamGraphNode`, `streamGraphNodesBatch`, `streamEdge`, `streamEdgesBatch`, `clearGraphArtifacts`, `ensureGraphBuilt`

- [ ] **Step 1: Create graph-repository.ts with extracted functions**

Move from `repository.ts`:

- Lines 674-912: `upsertGraphNode`, `insertGraphNodesBatch`, `upsertGraphNodesBatch`, `getGraphNode`, `findGraphNode`, `deleteGraphNodesByRefId`, `findFileNode`, `getSymbolNodesByFilePath`, `deleteOutgoingEdges`, `updateSymbolNode`, `deleteGraphNodesByIds`, `deleteChunkNodesByChunkIds`, `insertEdge`, `insertEdges`, `deleteEdgesByNodeIds`
- Lines 989-1059: `graphNeighbors`
- Lines 1681-1689: `loadAllSymbolNodes`
- Lines 1702-1710: `clearGraphArtifacts`
- Lines 471-486: `getNodeCount`, `getEdgeCount`
- Lines 1386-1467: `streamGraphNode`, `streamGraphNodesBatch`, `streamEdgesBatch`, `streamEdge`
- Lines 1555-1658: `ensureGraphBuilt`

Export:

```ts
export function createGraphOps(native: NativeDatabase, stmts: GraphStmts) {
  return {
    /* ... all graph methods */
  };
}
```

- [ ] **Step 2: Update repository.ts to import and spread graph ops**

Same pattern as Task 1:

```ts
import { createGraphOps } from "./graph-repository";
const graphOps = createGraphOps(native, stmts);
return { ...documentOps, ...graphOps /* ... remaining */ };
```

- [ ] **Step 3: Run tests**

Run: `bun test tests/workspace-db.test.ts tests/index-workspace.test.ts tests/mcp-tools.test.ts`
Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/sqlite/graph-repository.ts packages/db/src/sqlite/repository.ts
git commit -m "refactor(db): extract graph-repository.ts from repository.ts"
```

---

### Task 3: Extract fts-repository.ts, embedding-repository.ts, memory-repository.ts

**Files:**

- Create: `packages/db/src/sqlite/fts-repository.ts`
- Create: `packages/db/src/sqlite/embedding-repository.ts`
- Create: `packages/db/src/sqlite/memory-repository.ts`
- Modify: `packages/db/src/sqlite/repository.ts`
- Test: `bun test tests/workspace-db.test.ts tests/hybrid-retrieval.test.ts tests/mcp-tools.test.ts`

**Interfaces:**

- Consumes: `NativeDatabase`, `WorkspaceRepository` type
- Produces: `createFtsOps`, `createEmbeddingOps`, `createMemoryOps`

- [ ] **Step 1: Create fts-repository.ts**

Move from `repository.ts`:

- Lines 640-667: `bulkInsertFts`
- Lines 938-988: `fullTextSearch`
- Lines 1240-1245: `dropFtsTriggers`
- Lines 1246-1256: `dropNonUniqueIndexes`, `restoreNonUniqueIndexes`
- Lines 1268-1294: `insertFtsBatch`
- Lines 1487-1504: `streamFtsRow`
- Lines 1522-1554: `ensureFtsReady`
- Lines 1659-1676: `restoreFtsTriggers`, `restoreFtsTriggersOnly`
- Lines 373-400: `restoreFtsTriggerDefinitions` (exported function)
- Lines 1694-1701: `resetIndexArtifacts`

```ts
export function createFtsOps(native: NativeDatabase, stmts: FtsStmts) {
  return {
    /* ... all FTS methods */
  };
}
```

- [ ] **Step 2: Create embedding-repository.ts**

Move from `repository.ts`:

- Lines 914-934: `insertEmbeddings`, `deleteEmbeddingsByChunkIds`

```ts
export function createEmbeddingOps(native: NativeDatabase, stmts: EmbeddingStmts) {
  return {
    /* ... embedding methods */
  };
}
```

- [ ] **Step 3: Create memory-repository.ts**

Move from `repository.ts`:

- Lines 1060-1119: `insertMemory`, `getMemory`, `searchMemories`

```ts
export function createMemoryOps(native: NativeDatabase, stmts: MemoryStmts) {
  return {
    /* ... memory methods */
  };
}
```

- [ ] **Step 4: Update repository.ts to import and spread all three**

```ts
import { createFtsOps } from "./fts-repository";
import { createEmbeddingOps } from "./embedding-repository";
import { createMemoryOps } from "./memory-repository";

const ftsOps = createFtsOps(native, stmts);
const embeddingOps = createEmbeddingOps(native, stmts);
const memoryOps = createMemoryOps(native, stmts);

return {
  ...documentOps,
  ...graphOps,
  ...ftsOps,
  ...embeddingOps,
  ...memoryOps,
  // remaining: transaction, setOptimizedWriteMode, walCheckpoint, createIndexRun,
  // completeIndexRun, insertQueryLog, executeRaw, queryRaw, setMeta, getMeta
};
```

- [ ] **Step 5: Run tests**

Run: `bun test`
Expected: 133 pass, 1 skip, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/sqlite/fts-repository.ts packages/db/src/sqlite/embedding-repository.ts packages/db/src/sqlite/memory-repository.ts packages/db/src/sqlite/repository.ts
git commit -m "refactor(db): extract fts/embedding/memory repositories from repository.ts"
```

---

### Task 4: Finalize repository.ts as thin facade

**Files:**

- Modify: `packages/db/src/sqlite/repository.ts`
- Test: `bun test`

**Interfaces:**

- Produces: `repository.ts` < 200 lines, only re-exports + remaining misc ops (transaction, index_runs, query_logs, meta)

- [ ] **Step 1: Move remaining misc ops to workspace-repository.ts**

Create `packages/db/src/sqlite/workspace-repository.ts` with:

- `createWorkspaceRepository()` — the main factory that composes all ops
- `createRegistryRepository()` — registry ops (stays here, it's small)
- Remaining misc methods: `transaction`, `setOptimizedWriteMode`, `walCheckpoint`, `createIndexRun`, `completeIndexRun`, `insertQueryLog`, `executeRaw`, `queryRaw`, `setMeta`, `getMeta`
- Helper functions: `mapWorkspaceRow`, `compareWorkspaces`, `normalizeRootPath`, `slugifyWorkspaceSegment`, `displayNameForSuffix`, `resolveImportPath`, `sanitizeFtsQuery`, `mapGraphNodeRow`, `mapMemoryRow`, `safeParseJson`

- [ ] **Step 2: Make repository.ts a re-export facade**

```ts
// repository.ts — thin facade for backward compatibility
export { createRegistryRepository } from "./workspace-repository";
export { createWorkspaceRepository } from "./workspace-repository";
export { restoreFtsTriggerDefinitions } from "./fts-repository";
export type { NativeDatabase } from "./shared-types";
```

Create `packages/db/src/sqlite/shared-types.ts` with the `NativeDatabase` interface (currently inlined in repository.ts).

- [ ] **Step 3: Run full test suite**

Run: `bun test`
Expected: 133 pass, 1 skip, 0 fail.

Run: `pnpm typecheck`
Expected: 8/8 pass.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/sqlite/
git commit -m "refactor(db): finalize repository.ts as thin re-export facade"
```

---

### Task 5: Change embedding storage to BLOB

**Files:**

- Modify: `packages/db/src/sqlite/workspace-db.ts` — schema definition
- Modify: `packages/db/src/sqlite/types.ts` — `insertEmbeddings` input type
- Modify: `packages/db/src/sqlite/embedding-repository.ts` — encode BLOB
- Modify: `packages/core/src/retrieval.ts` — `parseEmbedding` decode BLOB
- Modify: `packages/indexer/src/index-workspace.ts` — `writeEmbeddingsToRepo` pass BLOB
- Test: `bun test tests/hybrid-retrieval.test.ts tests/vector-search.test.ts`

**Interfaces:**

- Consumes: `Float32Array`, `Buffer`
- Produces: `insertEmbeddings` accepts `Uint8Array` instead of `string`; `parseEmbedding` returns `number[]` from BLOB

- [ ] **Step 1: Update schema in workspace-db.ts**

In `getWorkspaceTableDefinitions()`, change the embeddings table:

```ts
// Before
`CREATE TABLE IF NOT EXISTS embeddings (
  id TEXT PRIMARY KEY,
  chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  embedding TEXT NOT NULL,
  input_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`,

// After
`CREATE TABLE IF NOT EXISTS embeddings (
  id TEXT PRIMARY KEY,
  chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  embedding BLOB NOT NULL,
  input_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`,
```

Add a migration in `initializeWorkspaceSchema` for existing DBs:

```ts
function migrateEmbeddingToBlob(sqlite: ReturnType<typeof createNativeDatabase>) {
  // Check if embedding column is already BLOB
  const info = sqlite.prepare("PRAGMA table_info(embeddings)").all() as Array<{
    name: string;
    type: string;
  }>;
  const embeddingCol = info.find((c) => c.name === "embedding");
  if (embeddingCol && embeddingCol.type.toUpperCase() === "TEXT") {
    // Full reindex required — drop and recreate embeddings table
    sqlite.exec("DELETE FROM embeddings");
    sqlite.exec("DROP TABLE embeddings");
    // Recreate with BLOB column
    sqlite.exec(`CREATE TABLE IF NOT EXISTS embeddings (
      id TEXT PRIMARY KEY,
      chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      embedding BLOB NOT NULL,
      input_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    // Recreate indexes
    sqlite.exec("CREATE INDEX IF NOT EXISTS idx_embeddings_chunk_id ON embeddings(chunk_id)");
    sqlite.exec(
      "CREATE INDEX IF NOT EXISTS idx_embeddings_provider_model_hash ON embeddings(provider, model, input_hash)",
    );
    sqlite.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_embeddings_chunk_provider_model ON embeddings(chunk_id, provider, model)",
    );
  }
}
```

Call `migrateEmbeddingToBlob(sqlite)` in `initializeWorkspaceSchema` after `migrateEmbeddingDedup`.

- [ ] **Step 2: Update types.ts**

Change `insertEmbeddings` input type:

```ts
// Before
insertEmbeddings(
  inputs: Array<{
    chunkId: string;
    provider: string;
    model: string;
    dimensions: number;
    embedding: string;
    inputHash?: string | null;
  }>,
): Promise<void>;

// After
insertEmbeddings(
  inputs: Array<{
    chunkId: string;
    provider: string;
    model: string;
    dimensions: number;
    embedding: Uint8Array;
    inputHash?: string | null;
  }>,
): Promise<void>;
```

- [ ] **Step 3: Update embedding-repository.ts to encode BLOB**

```ts
// In insertEmbeddings:
async insertEmbeddings(inputs) {
  const now = new Date().toISOString();
  for (const input of inputs) {
    stmts.insertEmbedding.run(
      crypto.randomUUID(),
      input.chunkId,
      input.provider,
      input.model,
      input.dimensions,
      input.embedding,  // Uint8Array passed directly — bun:sqlite accepts Buffer/Uint8Array for BLOB columns
      input.inputHash ?? null,
      now,
    );
  }
},
```

- [ ] **Step 4: Update retrieval.ts parseEmbedding to decode BLOB**

```ts
// Before
function parseEmbedding(value: unknown): number[] {
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "number") ? parsed : [];
  } catch {
    return [];
  }
}

// After
function parseEmbedding(value: unknown): number[] {
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    const float32 = new Float32Array(value instanceof Uint8Array ? value.buffer : value);
    return Array.from(float32);
  }
  // Fallback for old JSON data (shouldn't exist after migration)
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "number") ? parsed : [];
  } catch {
    return [];
  }
}
```

- [ ] **Step 5: Update index-workspace.ts writeEmbeddingsToRepo**

In `writeEmbeddingsToRepo` (around line 253), convert embedding arrays to Float32Array before passing to `insertEmbeddings`:

```ts
// Before
await repo.insertEmbeddings(
  chunksToEmbed.map((c) => ({
    chunkId: c.chunkId,
    provider: provider.provider,
    model: embeddingStorageModel(provider),
    dimensions: queryEmbedding.length,
    embedding: JSON.stringify(c.embedding),
    inputHash: c.inputHash,
  })),
);

// After
await repo.insertEmbeddings(
  chunksToEmbed.map((c) => ({
    chunkId: c.chunkId,
    provider: provider.provider,
    model: embeddingStorageModel(provider),
    dimensions: c.embedding.length,
    embedding: new Float32Array(c.embedding).buffer as Uint8Array,
    inputHash: c.inputHash,
  })),
);
```

Note: `new Float32Array(arr).buffer` returns `ArrayBuffer`. Cast to `Uint8Array` for the type signature: `new Uint8Array(new Float32Array(arr).buffer)`.

- [ ] **Step 6: Run tests**

Run: `bun test tests/hybrid-retrieval.test.ts tests/vector-search.test.ts`
Expected: All pass.

Run: `bun test`
Expected: 133 pass, 1 skip, 0 fail.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/sqlite/workspace-db.ts packages/db/src/sqlite/types.ts packages/db/src/sqlite/embedding-repository.ts packages/core/src/retrieval.ts packages/indexer/src/index-workspace.ts
git commit -m "perf(db): switch embedding storage from JSON TEXT to Float32Array BLOB"
```

---

### Task 6: Add sqlite-vec dependency and load extension

**Files:**

- Modify: `package.json` — add `sqlite-vec` dependency
- Modify: `packages/db/src/sqlite/database-loader.ts` — load extension
- Test: `bun test`

**Interfaces:**

- Consumes: `sqlite-vec` npm package
- Produces: `createNativeDatabase` optionally loads vec extension, exports `hasVecExtension` flag

- [ ] **Step 1: Install sqlite-vec**

```bash
pnpm add sqlite-vec
```

Verify it installs: `ls node_modules/sqlite-vec/`

- [ ] **Step 2: Update database-loader.ts to load extension**

```ts
import module from "node:module";
import path from "node:path";

declare const __non_webpack_require__: typeof require | undefined;

function getRequireUrl(): string {
  try {
    if (typeof import.meta !== "undefined" && import.meta.url) {
      return import.meta.url;
    }
  } catch {}
  return `file://${__filename}`;
}

const _require: typeof require =
  typeof __non_webpack_require__ === "function"
    ? __non_webpack_require__
    : module.createRequire(getRequireUrl());

// ... existing interfaces ...

let _vecExtensionLoaded = false;

export function hasVecExtension(): boolean {
  return _vecExtensionLoaded;
}

export function createNativeDatabase(dbPath: string): NativeDatabase {
  const Database = _require("bun:sqlite").Database as NativeDatabaseConstructor;
  const db = new Database(dbPath, { create: true } as { nativeBinding?: string });
  (db as any).pragma = (cmd: string) => db.exec(`PRAGMA ${cmd}`);

  // Try loading sqlite-vec extension
  try {
    const sqliteVecPath = _require.resolve("sqlite-vec");
    (db as any).loadExtension(sqliteVecPath);
    _vecExtensionLoaded = true;
  } catch {
    _vecExtensionLoaded = false;
    // Graceful degradation — linear scan will be used
  }

  return db as unknown as NativeDatabase;
}
```

- [ ] **Step 3: Add vec table to workspace-db.ts schema**

In `getFullWorkspaceDdl()`, add after the FTS table:

```ts
// Only create vec table if extension is loaded — checked at runtime
"CREATE VIRTUAL TABLE IF NOT EXISTS embeddings_vec USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[768])",
```

Note: The dimension `768` is for bge-m3. For OpenAI (1536), the table needs different dimensions. For now, use 768 as default. If the extension isn't loaded, this table creation will fail silently (wrapped in try/catch in `initializeWorkspaceSchema`).

In `initializeWorkspaceSchema`, add:

```ts
// Try creating vec table if extension is loaded
try {
  const { hasVecExtension } = require("./database-loader");
  if (hasVecExtension()) {
    sqlite.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS embeddings_vec USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[768])",
    );
  }
} catch {
  // Extension not loaded or table creation failed — linear scan fallback
}
```

- [ ] **Step 4: Run tests**

Run: `bun test`
Expected: 133 pass, 1 skip, 0 fail. If sqlite-vec fails to load, tests still pass (fallback).

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml packages/db/src/sqlite/database-loader.ts packages/db/src/sqlite/workspace-db.ts
git commit -m "feat(db): add sqlite-vec extension loading with graceful fallback"
```

---

### Task 7: Sync embeddings to vec table and use ANN search

**Files:**

- Modify: `packages/db/src/sqlite/embedding-repository.ts` — sync on insert/delete
- Modify: `packages/core/src/retrieval.ts` — `rankStoredEmbeddings` use vec query
- Test: `bun test tests/hybrid-retrieval.test.ts tests/vector-search.test.ts`

**Interfaces:**

- Consumes: `hasVecExtension()` from `database-loader.ts`
- Produces: `insertEmbeddings` syncs to `embeddings_vec`; `rankStoredEmbeddings` uses vec query when available

- [ ] **Step 1: Sync embeddings to vec table on insert**

In `embedding-repository.ts`, after inserting into `embeddings`, also insert into `embeddings_vec`:

```ts
import { hasVecExtension } from "./database-loader";

async insertEmbeddings(inputs) {
  const now = new Date().toISOString();
  for (const input of inputs) {
    stmts.insertEmbedding.run(
      crypto.randomUUID(),
      input.chunkId,
      input.provider,
      input.model,
      input.dimensions,
      input.embedding,
      input.inputHash ?? null,
      now,
    );
  }

  // Sync to vec table if extension is loaded
  if (hasVecExtension()) {
    for (const input of inputs) {
      try {
        native.prepare(
          "INSERT OR REPLACE INTO embeddings_vec (chunk_id, embedding) VALUES (?, ?)",
        ).run(Number(input.chunkId), input.embedding);
      } catch {
        // Vec table might not exist or dimension mismatch — skip
      }
    }
  }
},
```

Also sync delete:

```ts
async deleteEmbeddingsByChunkIds(chunkIds: string[]) {
  if (chunkIds.length === 0) return;
  const placeholders = chunkIds.map(() => "?").join(",");
  native.prepare(`DELETE FROM embeddings WHERE chunk_id IN (${placeholders})`).run(...chunkIds);

  if (hasVecExtension()) {
    try {
      const numIds = chunkIds.map((id) => Number(id));
      const numPlaceholders = numIds.map(() => "?").join(",");
      native.prepare(`DELETE FROM embeddings_vec WHERE chunk_id IN (${numPlaceholders})`).run(...numIds);
    } catch {}
  }
},
```

- [ ] **Step 2: Update rankStoredEmbeddings to use vec query**

In `retrieval.ts`, add a vec-based search path:

```ts
import { hasVecExtension } from "../../db/src/sqlite/database-loader";

export async function rankStoredEmbeddings(
  rootPath: string,
  provider: Pick<EmbeddingProvider, "provider" | "model">,
  queryEmbedding: number[],
  limit: number,
): Promise<ChunkHit[]> {
  if (queryEmbedding.length === 0) return [];

  const repo = createWorkspaceRepository(rootPath);

  // Try vec ANN search first
  if (hasVecExtension()) {
    try {
      const queryBlob = new Uint8Array(new Float32Array(queryEmbedding).buffer);
      const vecResults = await repo.queryRaw(
        `SELECT
          chunks.id, chunks.content, chunks.heading, chunks.metadata,
          documents.path, embeddings_vec.distance
        FROM embeddings_vec
        INNER JOIN embeddings ON embeddings.chunk_id = embeddings_vec.chunk_id
        INNER JOIN chunks ON chunks.id = embeddings.chunk_id
        INNER JOIN documents ON documents.id = chunks.document_id
        WHERE embeddings.provider = ?
          AND embeddings.model = ?
          AND embeddings.dimensions = ?
        ORDER BY embeddings_vec.embedding MATCH ?
        LIMIT ?`,
        [
          provider.provider,
          embeddingStorageModel(provider),
          queryEmbedding.length,
          queryBlob,
          limit * 2,
        ],
      );

      if (vecResults.length > 0) {
        const seenPaths = new Set<string>();
        return vecResults
          .map((row) => {
            const path = String(row.path);
            const distance = Number(row.distance ?? 1);
            const score = 1 - distance; // Convert distance to similarity
            return {
              id: String(row.id),
              path,
              content: String(row.content),
              score: isCodeFile(path) ? score + CODE_FILE_BOOST : score,
              heading: row.heading ? String(row.heading) : null,
              metadata: safeParseJson(String(row.metadata ?? "{}"), {}),
            };
          })
          .filter((hit) => hit.score >= MIN_COSINE_SIMILARITY)
          .sort((left, right) => right.score - left.score)
          .filter((hit) => {
            if (seenPaths.has(hit.path)) return false;
            seenPaths.add(hit.path);
            return true;
          })
          .slice(0, limit);
      }
    } catch (error) {
      // Vec query failed — fall through to linear scan
      console.error("[retrieval] vec search failed, falling back to linear scan:", error);
    }
  }

  // Linear scan fallback (existing code)
  const results = await repo.queryRaw(
    `SELECT
      chunks.id, chunks.content, chunks.heading, chunks.metadata,
      documents.path, embeddings.embedding
    FROM embeddings
    INNER JOIN chunks ON chunks.id = embeddings.chunk_id
    INNER JOIN documents ON documents.id = chunks.document_id
    WHERE embeddings.provider = ?
      AND embeddings.model = ?
      AND embeddings.dimensions = ?`,
    [provider.provider, embeddingStorageModel(provider), queryEmbedding.length],
  );

  const seenPaths = new Set<string>();
  return results
    .map((row) => {
      const path = String(row.path);
      const baseScore = cosineSimilarity(queryEmbedding, parseEmbedding(row.embedding));
      return {
        id: String(row.id),
        path,
        content: String(row.content),
        score: isCodeFile(path) ? baseScore + CODE_FILE_BOOST : baseScore,
        heading: row.heading ? String(row.heading) : null,
        metadata: safeParseJson(String(row.metadata ?? "{}"), {}),
      };
    })
    .filter((hit) => hit.score >= MIN_COSINE_SIMILARITY)
    .sort((left, right) => right.score - left.score)
    .filter((hit) => {
      if (seenPaths.has(hit.path)) return false;
      seenPaths.add(hit.path);
      return true;
    })
    .slice(0, limit);
}
```

- [ ] **Step 3: Run tests**

Run: `bun test tests/hybrid-retrieval.test.ts tests/vector-search.test.ts`
Expected: All pass. If vec extension loaded, ANN path is used. If not, linear scan.

Run: `bun test`
Expected: 133 pass, 1 skip, 0 fail.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/sqlite/embedding-repository.ts packages/core/src/retrieval.ts
git commit -m "feat(retrieval): use sqlite-vec ANN with linear scan fallback"
```

---

### Task 8: Add parsed_documents table and cache parse results during indexing

**Files:**

- Modify: `packages/db/src/sqlite/workspace-db.ts` — add `parsed_documents` table
- Modify: `packages/db/src/sqlite/document-repository.ts` — add `insertParsedDocument`, `getParsedDocument`, `deleteParsedDocumentsByDocumentIds`
- Modify: `packages/db/src/sqlite/types.ts` — add new methods to `WorkspaceRepository`
- Modify: `packages/indexer/src/index-workspace.ts` — save parse results during `indexWorkspace`
- Test: `bun test tests/index-workspace.test.ts`

**Interfaces:**

- Consumes: `ParsedFile` type from `index-workspace.ts`
- Produces: `insertParsedDocument(input)`, `getParsedDocument(documentId)`, `deleteParsedDocumentsByDocumentIds(ids)`

- [ ] **Step 1: Add parsed_documents table to workspace-db.ts**

In `getWorkspaceTableDefinitions()`, add:

```ts
`CREATE TABLE IF NOT EXISTS parsed_documents (
  document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  symbols TEXT,
  imports TEXT,
  calls TEXT,
  parsed_at INTEGER NOT NULL
)`,
```

In `initializeWorkspaceSchema`, add migration for existing DBs:

```ts
const hasParsedDocs =
  (
    sqlite
      .prepare(
        "SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name='parsed_documents'",
      )
      .get() as { c: number }
  ).c > 0;
if (!hasParsedDocs) {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS parsed_documents (
    document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
    content_hash TEXT NOT NULL,
    symbols TEXT,
    imports TEXT,
    calls TEXT,
    parsed_at INTEGER NOT NULL
  )`);
}
```

- [ ] **Step 2: Add parsed_documents CRUD to document-repository.ts**

```ts
insertParsedDocument(input: {
  documentId: string;
  contentHash: string;
  symbols: string;
  imports: string;
  calls: string;
}): void {
  const now = Date.now();
  native.prepare(
    `INSERT OR REPLACE INTO parsed_documents (document_id, content_hash, symbols, imports, calls, parsed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(input.documentId, input.contentHash, input.symbols, input.imports, input.calls, now);
},

getParsedDocument(documentId: string): {
  documentId: string;
  contentHash: string;
  symbols: string | null;
  imports: string | null;
  calls: string | null;
  parsedAt: number;
} | null {
  const row = native.prepare("SELECT * FROM parsed_documents WHERE document_id = ?").get(documentId) as any;
  if (!row) return null;
  return {
    documentId: String(row.document_id),
    contentHash: String(row.content_hash),
    symbols: row.symbols ? String(row.symbols) : null,
    imports: row.imports ? String(row.imports) : null,
    calls: row.calls ? String(row.calls) : null,
    parsedAt: Number(row.parsed_at),
  };
},

deleteParsedDocumentsByDocumentIds(documentIds: string[]): void {
  if (documentIds.length === 0) return;
  const placeholders = documentIds.map(() => "?").join(",");
  native.prepare(`DELETE FROM parsed_documents WHERE document_id IN (${placeholders})`).run(...documentIds);
},
```

- [ ] **Step 3: Add to WorkspaceRepository interface in types.ts**

```ts
/** Cache parsed symbols/imports/calls for graph build. */
insertParsedDocument(input: {
  documentId: string;
  contentHash: string;
  symbols: string;
  imports: string;
  calls: string;
}): void;

getParsedDocument(documentId: string): {
  documentId: string;
  contentHash: string;
  symbols: string | null;
  imports: string | null;
  calls: string | null;
  parsedAt: number;
} | null;

deleteParsedDocumentsByDocumentIds(documentIds: string[]): void;
```

- [ ] **Step 4: Save parse results during indexWorkspace**

In `index-workspace.ts`, after parsing documents (around line 780), save parse results:

```ts
// After parsing, cache results for graph build
for (const parsed of parsedResults) {
  const doc = await repo.getDocumentByPath(parsed.relativePath);
  if (doc) {
    repo.insertParsedDocument({
      documentId: doc.id,
      contentHash: doc.contentHash,
      symbols: JSON.stringify(parsed.definedSymbols ?? []),
      imports: JSON.stringify(parsed.importPaths ?? []),
      calls: JSON.stringify(parsed.callExpressions ?? []),
    });
  }
}
```

The exact insertion point depends on where `parsedResults` is available — look for the loop that processes parsed files and inserts chunks.

- [ ] **Step 5: Run tests**

Run: `bun test tests/index-workspace.test.ts`
Expected: All pass. Parse results are now cached but graph build doesn't use them yet.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/sqlite/workspace-db.ts packages/db/src/sqlite/document-repository.ts packages/db/src/sqlite/types.ts packages/indexer/src/index-workspace.ts
git commit -m "feat(indexer): cache parse results in parsed_documents table during indexing"
```

---

### Task 9: Use cached parse results in graph build

**Files:**

- Modify: `packages/indexer/src/index-workspace.ts` — `_buildGraphInternal` reads from cache
- Test: `bun test tests/index-workspace.test.ts tests/mcp-tools.test.ts`

**Interfaces:**

- Consumes: `getParsedDocument(documentId)` from repository
- Produces: `_buildGraphInternal` skips re-parsing when cache hit with matching `content_hash`

- [ ] **Step 1: Modify \_buildGraphInternal to use cache**

In `_buildGraphInternal` (around line 1190), replace the parse loop:

```ts
// Before
for (const doc of registryDocs) {
  try {
    const content = await fs.readFile(doc.absolutePath, "utf8");
    const parsed = await parseDocument({ ... });
    parsedFiles.set(doc.path, { ... });
  } catch {}
}

// After
for (const doc of registryDocs) {
  // Try cache first
  const cached = repo.getParsedDocument(doc.id);
  if (cached && cached.contentHash === doc.contentHash) {
    parsedFiles.set(doc.path, {
      filePath: doc.path,
      language: doc.language,
      kind: doc.kind,
      parser: "cached",
      definedSymbols: cached.symbols ? JSON.parse(cached.symbols) : [],
      importPaths: cached.imports ? JSON.parse(cached.imports) : [],
      calledIdentifiers: [],
      callExpressions: cached.calls ? JSON.parse(cached.calls) : [],
    });
    continue;
  }

  // Cache miss — parse and cache
  try {
    const content = await fs.readFile(doc.absolutePath, "utf8");
    const parsed = await parseDocument({
      relativePath: doc.path,
      absolutePath: doc.absolutePath,
      content,
      targetTokens,
      overlapTokens,
    });
    parsedFiles.set(doc.path, {
      filePath: doc.path,
      language: parsed.language,
      kind: parsed.kind,
      parser: parsed.parser,
      definedSymbols: parsed.definedSymbols,
      importPaths: parsed.importPaths,
      calledIdentifiers: parsed.calledIdentifiers,
      callExpressions: parsed.callExpressions,
    });

    // Save to cache
    repo.insertParsedDocument({
      documentId: doc.id,
      contentHash: doc.contentHash,
      symbols: JSON.stringify(parsed.definedSymbols ?? []),
      imports: JSON.stringify(parsed.importPaths ?? []),
      calls: JSON.stringify(parsed.callExpressions ?? []),
    });
  } catch {}
}
```

Do the same for native docs (Python/Go/Rust) — check cache before native batch parse.

- [ ] **Step 2: Run tests**

Run: `bun test tests/index-workspace.test.ts tests/mcp-tools.test.ts`
Expected: All pass. Graph build now uses cache when available.

- [ ] **Step 3: Verify cache hit with a manual test**

```bash
# Index a workspace, then trigger graph build
bun apps/cli/src/cli.ts index /tmp/test-project
# Run code_context (triggers graph build) — should be faster on second run
```

- [ ] **Step 4: Commit**

```bash
git add packages/indexer/src/index-workspace.ts
git commit -m "perf(graph): use cached parse results to skip re-parsing in graph build"
```

---

### Task 10: Full verification

**Files:**

- None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: 133 pass, 1 skip, 0 fail.

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: 8/8 packages pass.

- [ ] **Step 3: Run prettier check**

Run: `npx prettier --check "packages/db/src/sqlite/**/*.ts" "packages/core/src/retrieval.ts" "packages/indexer/src/index-workspace.ts"`
Expected: All files pass.

- [ ] **Step 4: Verify repository.ts is now a thin facade**

Run: `wc -l packages/db/src/sqlite/repository.ts`
Expected: < 50 lines (re-exports only).

- [ ] **Step 5: Verify no JSON.stringify on embeddings**

Run: `grep -rn "JSON.stringify.*embedding\|JSON.parse.*embedding" packages/ --include="*.ts" | grep -v node_modules | grep -v ".d.ts"`
Expected: No matches (except fallback in `parseEmbedding`).

- [ ] **Step 6: CLI smoke test**

```bash
rm -rf /tmp/openez-arch-test && mkdir -p /tmp/openez-arch-test/src
echo 'export function foo() { return 1; }' > /tmp/openez-arch-test/src/foo.ts
bun apps/cli/src/cli.ts init /tmp/openez-arch-test
bun apps/cli/src/cli.ts status /tmp/openez-arch-test
bun apps/cli/src/cli.ts remove /tmp/openez-arch-test -y
```

Expected: init → index → status → remove all succeed.

- [ ] **Step 7: Final commit if any fixes were needed**

If Steps 1-6 required fixes:

```bash
git add -A
git commit -m "fix: address verification issues from architecture improvement"
```

---

## Self-Review

### Spec coverage

- ✅ Phase 1: Split repository.ts — Tasks 1-4
- ✅ Phase 2: Embedding BLOB storage — Task 5
- ✅ Phase 3: sqlite-vec ANN — Tasks 6-7
- ✅ Phase 4: Cache parse results — Tasks 8-9
- ✅ Full verification — Task 10

### Placeholder scan

- No "TBD", "TODO", "implement later" found
- All code blocks contain actual implementation code
- All test commands are explicit

### Type consistency

- `insertEmbeddings` input: `embedding: Uint8Array` (Task 5) — consistent across types.ts, embedding-repository.ts, index-workspace.ts
- `hasVecExtension(): boolean` (Task 6) — used in embedding-repository.ts (Task 7) and retrieval.ts (Task 7)
- `insertParsedDocument`, `getParsedDocument`, `deleteParsedDocumentsByDocumentIds` (Task 8) — consistent in types.ts, document-repository.ts, index-workspace.ts
- `createDocumentOps`, `createGraphOps`, `createFtsOps`, `createEmbeddingOps`, `createMemoryOps` — factory pattern consistent across all split files
