# Fix Fast Indexing Critical Issues Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore complete, workspace-scoped lazy graph building for TS/JS while resetting global indexing state and keeping SQLite in recoverable WAL mode.

**Architecture:** Keep indexing lazy: `indexWorkspace()` writes documents/chunks only, and the first graph query builds graph nodes and edges. Use `OxcParser` through `parseDocument()` for TypeScript/JavaScript/Markdown/config documents, and keep the native batch parser for Python/Go/Rust when available. Guard graph builds with a per-workspace in-flight promise and invalidate the cache when index artifacts change.

**Tech Stack:** TypeScript, `oxc-parser`, native Rust/tree-sitter parser, SQLite/WAL, Vitest, pnpm.

## Runtime Matrix

- Production CLI/MCP/web processes run under Bun and use built-in `bun:sqlite`; do not replace this with `better-sqlite3` in production.
- Node/Vitest tests use the existing `packages/db/src/sqlite/database-loader.ts` fallback to `better-sqlite3`.
- `apps/web/src/server/sqlite.ts` has its own Bun-first/Node-fallback loader and is not part of the repository driver change.
- `vitest.config.ts` must keep the existing `bun:sqlite` alias and inline settings for `drizzle-orm`, `@openez-graph/db`, and `@openez-graph/core`; these are test-runtime compatibility, not production architecture.
- Do not switch the project to `bun test` or remove Vitest features as part of this fix.

## Global Constraints

- Keep SQLite as the default storage path; do not add Postgres, Redis, or vector database dependencies.
- Keep lazy graph build; do not move graph construction back into the main indexing transaction.
- Keep the existing `slice(0, 20)` call cap, `slice(0, 30)` symbol cap, `_symMeta` storage, stderr timing logs, and native-loader fallback.
- Do not add a native TS/JS parser.
- Use the registered `workspace.id` as every in-memory graph/FTS cache key.
- Preserve `ParsedDocument`; no schema change is required.
- `synchronous=OFF` is only a bulk-indexing optimization and must be restored to `NORMAL`.

---

### Task 1: Lock Down Oxc Parser Behavior

**Files:**

- Create: `tests/oxc-parser.test.ts`
- Modify: `packages/indexer/src/parsers/oxc-parser.ts`
- Modify: `tests/parser-registry.test.ts`

**Interfaces:**

- Consumes: `OxcParser.parse(ParseInput, language, kind)`.
- Produces: complete TS/JS symbol, import-binding, and call-expression extraction.

- [ ] **Step 1: Write the failing parser test**

Create `tests/oxc-parser.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { OxcParser } from "../packages/indexer/src/parsers/oxc-parser";

describe("OxcParser", () => {
  it("extracts TS declarations, calls, and import bindings", () => {
    const result = new OxcParser().parse(
      {
        relativePath: "example.ts",
        absolutePath: "/tmp/example.ts",
        content: [
          'import { fetchData as fetch } from "./api";',
          'import * as api from "./api";',
          "",
          "interface User { id: string }",
          "type UserId = string;",
          "enum Status { Ready }",
          "",
          "function caller() {",
          "  fetch();",
          "  api.save();",
          "}",
          "",
          "function helper() {}",
        ].join("\n"),
        targetTokens: 500,
        overlapTokens: 50,
      },
      "typescript",
      "code",
    );

    expect(result.definedSymbols.map((symbol) => symbol.name)).toEqual(
      expect.arrayContaining(["User", "UserId", "Status", "caller", "helper"]),
    );
    expect(result.definedSymbols.find((symbol) => symbol.name === "User")?.symbolType).toBe(
      "interface",
    );
    expect(result.definedSymbols.find((symbol) => symbol.name === "UserId")?.symbolType).toBe(
      "type",
    );
    expect(result.definedSymbols.find((symbol) => symbol.name === "Status")?.symbolType).toBe(
      "enum",
    );
    expect(result.callExpressions).toEqual(
      expect.arrayContaining([
        { callerName: "caller", calleeName: "fetch" },
        { callerName: "caller", calleeName: "api.save" },
      ]),
    );
    expect(result.calledIdentifiers).toEqual(expect.arrayContaining(["fetch", "api.save"]));
  });
});
```

Also add a nested-function assertion if implementation walks nested callables: a call inside a nested function belongs to the nested symbol, not its outer symbol.

- [ ] **Step 2: Identify the pre-existing parser-test failure**

Run:

```bash
pnpm exec vitest run tests/parser-registry.test.ts
```

Expected on the current branch: test collection fails before assertions because `tests/parser-registry.test.ts` imports the removed `TsMorphParser`. This is pre-existing breakage.

Then run the new Oxc test independently:

```bash
pnpm exec vitest run tests/oxc-parser.test.ts
```

Expected: interface/type/enum assertions fail and `callExpressions` is empty. This is the actual Oxc regression test signal.

- [ ] **Step 3: Align the stale registry tests**

`packages/indexer/src/parsers/index.ts` already exports `OxcParser`; do not add another export. Remove the stale `TsMorphParser` import and parser instances from `tests/parser-registry.test.ts`. Update TS/JS paths to expect `OxcParser`, and update the TS parse metadata expectation from `parser: "ts-morph"` to `parser: "oxc"`.

- [ ] **Step 4: Preserve AST offsets internally**

In `packages/indexer/src/parsers/oxc-parser.ts`:

1. Add these switch cases in `extractSymbols`:

```ts
case "TSInterfaceDeclaration":
  symbolType = "interface";
  break;
case "TSTypeAliasDeclaration":
  symbolType = "type";
  break;
case "TSEnumDeclaration":
  symbolType = "enum";
  break;
```

2. Keep AST offsets in an internal result. The public symbol shape only stores `startLine` and `endLine`, which are not precise enough for subtree selection. Use a local type such as:

```ts
type SymbolAst = { symbol: ExtractedSymbol; node: OxcNode };
```

Return both the public symbols and their matching AST nodes from the internal helper. Keep `definedSymbols: symbols` unchanged.

3. For variable declarations, associate the symbol with the declaration or function initializer node that covers the actual function body. For export wrappers, recurse into `node.declaration` and preserve `exported: true`.

- [ ] **Step 5: Implement safe AST walking and call extraction**

Add an internal `walkNodes(value, visitor, visited)` helper. It must accept nodes or arrays, detect AST nodes by `value.type`, use `WeakSet<object>`, recurse through child object values, and ignore primitives/null. It must cover at least:

`body`, `declarations`, `init`, `expression`, `callee`, `object`, `property`, `argument`, `arguments`, `declaration`, `consequent`, `alternate`, `left`, `right`, `test`, and `update`.

Use these callee rules:

```ts
Identifier       -> identifier.name
MemberExpression -> object.name + "." + property.name
other            -> skip
```

For each `SymbolAst`, walk only its AST range. Skip call nodes inside nested callable declarations so nested calls are not attributed to an outer function. Add each result as `{ callerName, calleeName }` and add the callee name to a `Set<string>`.

Extract local import bindings from `ImportDefaultSpecifier`, `ImportNamespaceSpecifier`, and `ImportSpecifier.local.name`. Keep `importPaths` as module source paths.

- [ ] **Step 6: Return populated parser fields**

Replace the hardcoded empty arrays in the Oxc success path with:

```ts
return {
  parser: this.name,
  language,
  kind: "code",
  chunks,
  importPaths,
  wikilinks: [],
  definedSymbols: symbols,
  calledIdentifiers: [...calledIdentifiers],
  callExpressions,
};
```

- [ ] **Step 7: Run parser tests and commit**

Run:

```bash
pnpm exec vitest run tests/oxc-parser.test.ts tests/parser-registry.test.ts
```

Expected: PASS.

```bash
git add packages/indexer/src/parsers/oxc-parser.ts tests/oxc-parser.test.ts tests/parser-registry.test.ts
git commit -m "fix(indexer): complete Oxc TS symbol and call extraction"
```

---

### Task 2A: Build One Lazy Graph From All Parser Results

**Files:**

- Modify: `packages/indexer/src/index-workspace.ts:1093-1242`
- Modify: `packages/db/src/sqlite/types.ts`
- Modify: `packages/db/src/sqlite/repository.ts`
- Test: `tests/index-workspace.test.ts`

**Interfaces:**

- Consumes: `parseDocument()`, native `parseCodeBatch()`, and `WorkspaceRepository`.
- Produces: `buildGraphForWorkspace(workspaceId: string, rootPath: string): Promise<void>`.

- [ ] **Step 1: Write failing TS graph tests**

In `tests/index-workspace.test.ts`, add a test that:

1. Creates `caller.ts` and `helper.ts`.
2. Indexes the workspace.
3. Calls `buildGraphForWorkspace(workspace.id, workspace.rootPath)`.
4. Asserts file and symbol nodes exist.
5. Calls `codeContext({ workspaceId, symbolOrPath: "helper", hops: 1 })`.
6. Asserts `callers` contains `caller` and the symbol context has a source snippet.

Add an import-edge fixture:

```ts
import { target } from "./target";
export function caller() {
  return target();
}
```

Assert one `imports` edge from `caller.ts` to `target.ts`. Do not assert only `nodeCount > 0`; that would not prove graph context works.

Expected failure: TS files have no graph nodes/call edges before this task.

- [ ] **Step 2: Add a graph-only reset method**

Add `clearGraphArtifacts(): void` to `WorkspaceRepository` and implement it in `packages/db/src/sqlite/repository.ts`:

```ts
native.exec("DELETE FROM graph_edges");
native.exec("DELETE FROM graph_nodes");
```

Do not delete documents, chunks, embeddings, memories, query logs, or index runs.

- [ ] **Step 3: Split documents without requiring native parsing**

In `buildGraphForWorkspace`:

1. Include documents with kind `code`, `markdown`, or `config`.
2. Split Python/Go/Rust code documents from parser-registry documents.
3. Load native only when the native-language list is non-empty.
4. If native loading fails, parse those documents with `parseDocument()` so the existing tree-sitter WASM/regex fallback remains available.
5. Always parse TS/TSX/JS/JSX with `parseDocument()`.
6. Parse Markdown and JSON/YAML/TOML with `parseDocument()`; these produce file nodes but no symbol/call nodes.
7. Never return early just because native loading failed.

Before implementation, verify the fallback contract with tests in `tests/parser-registry.test.ts` or `tests/tree-sitter-parser.test.ts`: parse one minimal Python function, Go function, and Rust function through `parseDocument()`, and assert each result contains a defined symbol. Accept `parser: "tree-sitter"` or `parser: "regex"`; the current registry maps all three languages to `TreeSitterParser`, and its fallback map contains `parsePython`, `parseGo`, and `parseRust`.

Use `getBrainSettings()` once to supply `targetTokens` and `overlapTokens` to `parseDocument()`.

Normalize native results locally:

```ts
{
  parser: "tree-sitter-native",
  language,
  kind: "code",
  definedSymbols: nativeResult.symbols.map(...),
  importPaths: nativeResult.importPaths,
  calledIdentifiers: nativeResult.calledIdentifiers,
  callExpressions: nativeResult.callExpressions,
}
```

Merge native and registry results by document path before node creation. Keep `ParsedDocument` unchanged.

- [ ] **Step 4: Build nodes with valid chunk references**

Create one file node for each parsed code/markdown/config document. Load document chunks with `getChunksByDocument()` and map `chunk.metadata.symbolName` to chunk IDs.

For each symbol:

- Keep the existing 30-symbol cap.
- Set `refId` to the matching symbol chunk ID.
- Store `filePath`, `language`, `symbolType`, and parser metadata.
- If no matching chunk exists, use a null `refId`; never point a symbol node at the document ID because core resolves symbol `ref_id` against `chunks.id`.

Keep the existing `_symMeta` storage and batch insertion approach.

- [ ] **Step 5: Build defines, imports, and calls edges**

Use maps for file nodes and symbol nodes by workspace-relative path.

1. Add `defines` edges from each file node to its symbol nodes.
2. Resolve `importPaths` through the existing `createWorkspaceFileResolver(workspaceRoot, knownFiles)`. Add one `imports` edge from importer file node to the resolved target file node. Ignore external/unresolved imports.
3. Keep the existing 20-call cap.
4. Resolve call targets first in the caller file, then through the global symbol map.
5. Skip missing targets and self-edges.
6. Keep the existing low-confidence call metadata.

Insert edges in one transaction after all nodes exist.

- [ ] **Step 6: Run graph parser tests and commit**

Run:

```bash
pnpm exec vitest run tests/index-workspace.test.ts tests/parser-registry.test.ts tests/tree-sitter-parser.test.ts
```

Expected: the TS graph and native-parser fallback tests pass. Commit the graph construction and repository reset changes:

```bash
git add packages/indexer/src/index-workspace.ts packages/db/src/sqlite/types.ts packages/db/src/sqlite/repository.ts tests/index-workspace.test.ts tests/parser-registry.test.ts tests/tree-sitter-parser.test.ts
git commit -m "fix(indexer): merge parser results into lazy graph"
```

---

### Task 2B: Make Graph and FTS Cache Lifecycles Workspace-Scoped

**Files:**

- Modify: `packages/indexer/src/index-workspace.ts:1074-1242`
- Modify: `apps/mcp/src/mcp-core.ts:553-663`
- Test: `tests/index-workspace.test.ts`
- Test: `tests/mcp-tools.test.ts`

**Interfaces:**

- Consumes: the graph builder from Task 2A and the existing `_ftsBuildingWorkspaces` map.
- Produces: `waitForFts(workspaceId: string)` and race-safe `buildGraphForWorkspace(workspaceId, rootPath)`.

- [ ] **Step 1: Write failing cache and caller tests**

Add these regression cases to `tests/index-workspace.test.ts`:

- Two registered workspaces whose root directories have the same basename. Build both graphs and assert each contains only its own symbol labels.
- Two concurrent `buildGraphForWorkspace(workspace.id, workspace.rootPath)` calls. Assert there is one file node per path, no duplicate symbol nodes, and every returned edge references an existing node.
- Index, build the graph, change a function/call, index again, build again, and assert the old call edge is gone and the new edge is present.
- Call `waitForFts(workspace.id)` and assert it resolves for the registered workspace ID. Exercise the MCP `code_query` path after an index so the caller passes the same ID used by `_ftsBuildingWorkspaces`.

Expected failures: basename-collision cache reuse, duplicate concurrent graph builds, stale graph after reindex, or the old FTS lookup not observing the workspace ID.

- [ ] **Step 2: Run the cache tests and verify failure**

```bash
pnpm exec vitest run tests/index-workspace.test.ts tests/mcp-tools.test.ts
```

Expected: at least the same-basename or stale-graph test fails before the cache changes.

- [ ] **Step 3: Make both caches use workspace IDs**

Change the exported signatures:

```ts
export async function buildGraphForWorkspace(workspaceId: string, rootPath: string): Promise<void>;
```

```ts
export async function waitForFts(workspaceId: string): Promise<void>;
```

In `waitForFts`, remove the `path.basename(rootPath)` conversion and poll `_ftsBuildingWorkspaces` directly with the supplied `workspaceId`. This is required because `indexWorkspace()` stores and deletes the FTS key as `workspace.id`.

Use `workspaceId` for the graph-built cache. Add an in-flight map:

```ts
const graphBuilds = new Map<string, Promise<void>>();
```

The wrapper must return the existing promise for concurrent requests, delete it in `finally`, and add the workspace to the built set only after the graph transaction succeeds.

On a cache miss, call `repo.clearGraphArtifacts()` before inserting the complete graph. Remove the current `nodeCount > 0` shortcut: it cannot prove TS/JS coverage, and the current code also omits `await` on the async repository method.

- [ ] **Step 4: Invalidate the graph after index changes**

Add an internal `invalidateGraphForWorkspace(workspaceId)` helper. In `indexWorkspace()`, mark the graph dirty for full mode, deleted documents, or at least one changed file. Clear the module cache after changed artifacts are written; the next graph query will rebuild from current documents.

Do not invalidate on a true incremental no-op. Do not use `path.basename(rootPath)` anywhere for cache keys.

- [ ] **Step 5: Update MCP callers only**

Modify `apps/mcp/src/mcp-core.ts`:

```ts
await Promise.all(workspaces.map((w) => waitForFts(w.id)));
await Promise.all(workspaces.map((w) => buildGraphForWorkspace(w.id, w.rootPath)));
```

Do not add indexer imports to `packages/core/src/retrieval.ts` or `packages/core/src/graph.ts`; that would create an unnecessary dependency cycle.

- [ ] **Step 6: Run cache tests and commit**

Run:

```bash
pnpm exec vitest run tests/index-workspace.test.ts tests/mcp-tools.test.ts
```

Expected: PASS for FTS waiting, TS symbols, TS calls, imports, same-basename workspace isolation, concurrent graph calls, and reindex invalidation.

```bash
git add packages/indexer/src/index-workspace.ts apps/mcp/src/mcp-core.ts tests/index-workspace.test.ts tests/mcp-tools.test.ts
git commit -m "fix(indexer): scope graph and FTS caches by workspace"
```

---

### Task 3: Reset Fast Token Mode on Every Index Exit

**Files:**

- Modify: `packages/indexer/src/index-workspace.ts:573-1072`
- Test: `tests/index-workspace.test.ts`

**Interfaces:**

- Consumes: `setFastTokenCount()` and `countTokens()`.
- Produces: no fast-token state after `indexWorkspace()` resolves or rejects.

- [ ] **Step 1: Write the failing state-reset test**

Disable fast mode, record an exact BPE result for text whose count differs from `Math.ceil(length / 4)`, run indexing, and assert the exact count remains:

```ts
setFastTokenCount(false);
const sample = "The tokenizer must leave fast mode after indexing.";
const exact = countTokens(sample);
expect(exact).not.toBe(Math.ceil(sample.length / 4));

await indexWorkspace({ workspaceId: workspace.id });

expect(countTokens(sample)).toBe(exact);
```

Also cover a missing workspace ID to prove early errors reset the flag.

- [ ] **Step 2: Run the test and verify failure**

```bash
pnpm exec vitest run tests/index-workspace.test.ts -t "fast token"
```

Expected: post-index count uses the approximate `length / 4` value.

- [ ] **Step 3: Wrap the entire function body**

Place `try` immediately after `setFastTokenCount(true)`. Put workspace resolution, indexing, error handling, progress reporting, and return logic inside it. Add:

```ts
} finally {
  setFastTokenCount(false);
}
```

The `finally` must cover errors before `runId` is created.

- [ ] **Step 4: Run tests and commit**

```bash
pnpm exec vitest run tests/index-workspace.test.ts -t "fast token"
```

Expected: PASS.

```bash
git add packages/indexer/src/index-workspace.ts tests/index-workspace.test.ts
git commit -m "fix(indexer): restore exact token counting after indexing"
```

---

### Task 4: Keep Optimized SQLite Writes in WAL Mode

**Files:**

- Modify: `packages/db/src/sqlite/repository.ts:1211-1230`
- Test: `tests/workspace-db.test.ts`

**Interfaces:**

- Consumes: `WorkspaceRepository.setOptimizedWriteMode(enabled)`.
- Produces: WAL journal mode during and after bulk writes, with `synchronous=NORMAL` restored.

- [ ] **Step 1: Write failing pragma tests**

Add tests through `repo.queryRaw()`:

```ts
repo.setOptimizedWriteMode(true);
expect(await repo.queryRaw("PRAGMA journal_mode")).toEqual([{ journal_mode: "wal" }]);
expect(await repo.queryRaw("PRAGMA synchronous")).toEqual([{ synchronous: 0 }]);

repo.setOptimizedWriteMode(false);
expect(await repo.queryRaw("PRAGMA journal_mode")).toEqual([{ journal_mode: "wal" }]);
expect(await repo.queryRaw("PRAGMA synchronous")).toEqual([{ synchronous: 1 }]);
expect(await repo.queryRaw("PRAGMA locking_mode")).toEqual([{ locking_mode: "normal" }]);
```

Add a migration test that puts a temporary database into `journal_mode=MEMORY`, calls `setOptimizedWriteMode(false)`, and verifies it returns to WAL.

- [ ] **Step 2: Run tests and verify failure**

```bash
pnpm exec vitest run tests/workspace-db.test.ts -t "optimized write"
```

Expected: enabling optimized mode reports `memory` journal mode.

- [ ] **Step 3: Change pragma ordering**

Use this order when enabling:

```ts
native.pragma("journal_mode = WAL");
native.pragma("synchronous = OFF");
native.pragma("cache_size = -65536");
native.pragma("temp_store = MEMORY");
native.pragma("mmap_size = 536870912");
native.pragma("locking_mode = EXCLUSIVE");
```

Use this order when disabling:

```ts
native.pragma("synchronous = NORMAL");
native.pragma("locking_mode = NORMAL");
native.pragma("journal_mode = WAL");
native.exec("PRAGMA wal_checkpoint(PASSIVE)");
```

Restore cache/temp/mmap settings afterward. Keep `journal_mode=WAL` in the restore path so databases left in MEMORY by the previous branch are migrated.

Add:

```ts
// ponytail: synchronous=OFF trades power-loss durability for bulk-index speed; restore NORMAL below.
```

- [ ] **Step 4: Run tests and commit**

```bash
pnpm exec vitest run tests/workspace-db.test.ts -t "optimized write"
```

Expected: PASS.

```bash
git add packages/db/src/sqlite/repository.ts tests/workspace-db.test.ts
git commit -m "fix(db): keep optimized indexing in recoverable WAL mode"
```

---

### Task 5: Full Verification and Merge Review

**Files:**

- Verify: all files from Tasks 1-4.
- Test: `tests/oxc-parser.test.ts`, `tests/parser-registry.test.ts`, `tests/index-workspace.test.ts`, `tests/mcp-tools.test.ts`, `tests/workspace-db.test.ts`.

- [ ] **Step 1: Run the focused suite**

```bash
pnpm exec vitest run \
  tests/oxc-parser.test.ts \
  tests/parser-registry.test.ts \
  tests/index-workspace.test.ts \
  tests/mcp-tools.test.ts \
  tests/workspace-db.test.ts
```

Expected: all focused tests pass, including TS graph nodes, TS call/import edges, workspace ID isolation, concurrent build protection, cache invalidation, token reset, and WAL pragmas.

- [ ] **Step 2: Run typecheck and formatting**

```bash
pnpm typecheck
pnpm format:check
```

Expected: no TypeScript errors and no formatting changes required.

Before interpreting a Vitest failure, verify the test process is using the repository `vitest.config.ts` alias for `bun:sqlite`. A raw Node import of `drizzle-orm/bun-sqlite` is not a valid production/test signal.

- [ ] **Step 3: Run the full suite**

```bash
pnpm test
```

Expected: existing Python/Go/Rust parser, retrieval, MCP, and SQLite tests remain green.

- [ ] **Step 4: Smoke-test the real MCP path**

Use a temporary workspace containing:

```ts
export interface User {
  id: string;
}
export type UserId = string;
export function helper() {
  return 1;
}
export function caller() {
  return helper();
}
```

Run index, then call MCP `code_context` and `graph_neighbors`. Verify:

- `User` and `UserId` are symbol nodes.
- `caller -> helper` is a `calls` edge.
- The returned symbol context includes the source chunk.
- Two workspaces with the same basename build separate graphs.
- Reindexing after changing `helper` removes stale graph edges and exposes the new graph.

- [ ] **Step 5: Final merge checklist**

Confirm:

- No cache key uses `path.basename(rootPath)`.
- Only MCP calls `waitForFts` and `buildGraphForWorkspace`.
- No `journal_mode=MEMORY` remains in optimized write mode.
- `setFastTokenCount(false)` is guaranteed on every `indexWorkspace()` exit.
- Symbol graph nodes reference chunk IDs where snippets are expected.
- Parser registry tests expect `OxcParser`, not `TsMorphParser`.
