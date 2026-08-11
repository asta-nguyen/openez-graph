# Enhance Merge Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `feat/enhance` pass its test, typecheck, web-build, and CLI-build gates while correcting the confirmed MCP and vector-retrieval regressions.

**Architecture:** Keep the repair inside existing boundaries. MCP validation stays with the tool that owns the input, the web client receives model metadata through its API, and vector retrieval performs a cheap SQLite existence check before invoking an embedding provider. Type fixes are applied at shared query boundaries instead of annotating every render callback.

**Tech Stack:** Bun 1.3+, TypeScript, SQLite/WAL, Hono, TanStack Query, Vite, Bun test runner

## Global Constraints

- Keep SQLite/WAL as the default storage path.
- Keep embeddings optional; FTS + graph remains the no-provider/no-vector fallback.
- Do not add dependencies, configuration, ANN infrastructure, or new abstractions.
- Use `workspaceId` as the canonical internal workspace key.
- Preserve memory, query log, and graph behavior outside the confirmed fixes.
- Every production behavior change starts from a failing test or failing repository gate.

---

### Task 1: Restore MCP `code_context`

**Files:**

- Modify: `apps/mcp/src/mcp-core.ts:665-703`
- Test: `tests/mcp-tools.test.ts`

**Interfaces:**

- Consumes: `codeContextSchema` requiring `symbolOrPath`.
- Produces: a `code_context` response for valid symbol/file requests without graph-neighbor-only validation.

- [ ] **Step 1: Verify the existing regression test is red**

Run:

```bash
rtk bun test tests/mcp-tools.test.ts -t "resolves code_context callers and source snippets"
```

Expected: FAIL with `Either nodeId or label is required`.

- [ ] **Step 2: Remove the misplaced validation**

Delete only this block from the `code_context` case:

```ts
if (!input.nodeId && !input.label) {
  throw new Error("Either nodeId or label is required");
}
```

Do not add it to the MCP switch's `graph_neighbors` case; `graphNeighbors()` already rejects calls missing both identifiers.

- [ ] **Step 3: Verify the focused MCP tests are green**

Run:

```bash
rtk bun test tests/mcp-tools.test.ts
```

Expected: 9 pass, 0 fail.

- [ ] **Step 4: Commit**

```bash
git add apps/mcp/src/mcp-core.ts tests/mcp-tools.test.ts
git commit -m "fix(mcp): restore code context requests"
```

---

### Task 2: Skip query embedding when no active vectors exist

**Files:**

- Modify: `tests/hybrid-retrieval.test.ts:53-69`
- Modify: `packages/core/src/retrieval.ts:135-155`

**Interfaces:**

- Consumes: `EmbeddingProvider.provider`, `embeddingStorageModel(provider)`, and workspace `embeddings` rows.
- Produces: vector fallback without calling `provider.embed` when no row matches the active provider/model.

- [ ] **Step 1: Change the empty-workspace test to the required behavior**

Replace the current test with:

```ts
it("does not embed a query when the workspace has no active-model vectors", async () => {
  const workspace = await createRegistryRepository().createWorkspace({
    id: "empty-vector-test",
    name: "empty-vector-test",
    rootPath: workspaceRoot,
  });

  await codeQuery({
    workspaceId: workspace.id,
    query: "maintain",
    limit: 5,
    skipGraphExpand: true,
  });

  expect(testEmbeddingProvider.embed).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Verify the new test is red**

Run:

```bash
rtk bun test tests/hybrid-retrieval.test.ts -t "does not embed a query"
```

Expected: FAIL because `provider.embed` is called once.

- [ ] **Step 3: Add the minimal SQLite preflight**

In `vectorSearch`, after the provider null check and before `provider.embed`, add:

```ts
const repo = createWorkspaceRepository(rootPath);
const stored = await repo.queryRaw(
  "SELECT 1 FROM embeddings WHERE provider = ? AND model = ? LIMIT 1",
  [provider.provider, embeddingStorageModel(provider)],
);
if (stored.length === 0) {
  console.error("[retrieval] vector search: disabled (no active-model vectors)");
  return [];
}
```

- [ ] **Step 4: Verify hybrid and vector retrieval**

Run:

```bash
rtk bun test tests/hybrid-retrieval.test.ts tests/vector-search.test.ts tests/embed-workspace.test.ts
```

Expected: all tests pass; vector-only retrieval after `embedWorkspace` remains covered.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/retrieval.ts tests/hybrid-retrieval.test.ts
git commit -m "fix(retrieval): skip unused query embeddings"
```

---

### Task 3: Keep the local-model catalog out of the browser bundle

**Files:**

- Modify: `tests/web-index-endpoint.test.ts`
- Modify: `apps/web/src/server/index.ts:579-599`
- Modify: `apps/web/src/lib/api.ts:171-180`
- Modify: `apps/web/src/routes/settings.tsx:1-133`

**Interfaces:**

- Consumes: server-side `LOCAL_EMBEDDING_MODELS`.
- Produces: `EmbeddingConfigResponse.localModels: string[]`.

- [ ] **Step 1: Add an API regression assertion**

Extend the existing normalized-model test with:

```ts
expect(config.localModels).toEqual(["jina-code-static-256"]);
```

- [ ] **Step 2: Verify the API test is red**

Run:

```bash
rtk bun test tests/web-index-endpoint.test.ts -t "normalizes whitespace"
```

Expected: FAIL because `localModels` is absent.

- [ ] **Step 3: Return the catalog through the settings API**

Add to the GET response in `apps/web/src/server/index.ts`:

```ts
localModels: Object.keys(LOCAL_EMBEDDING_MODELS),
```

Add to `EmbeddingConfigResponse`:

```ts
localModels: string[];
```

- [ ] **Step 4: Remove the browser import and use API data**

Delete:

```ts
import { LOCAL_EMBEDDING_MODELS } from "@openez-graph/core";
```

Inside `EmbeddingConfigForm`, use:

```ts
const localModelPresets = config?.localModels ?? [];
const defaultLocalModel = localModelPresets[0] ?? "jina-code-static-256";
```

Replace the catalog membership check in the effect with:

```ts
setLocalModel(
  config.localModels.includes(config.localModel) ? config.localModel : defaultLocalModel,
);
```

Include `defaultLocalModel` in the effect dependencies.

- [ ] **Step 5: Verify API behavior and the production bundle**

Run:

```bash
rtk bun test tests/web-index-endpoint.test.ts
rtk pnpm build:web
```

Expected: tests pass and Vite no longer resolves `ollama`/SQLite through `settings.tsx`.

- [ ] **Step 6: Commit**

```bash
git add tests/web-index-endpoint.test.ts apps/web/src/server/index.ts apps/web/src/lib/api.ts apps/web/src/routes/settings.tsx
git commit -m "fix(web): keep embedding providers server side"
```

---

### Task 4: Restore strict TypeScript gates at shared boundaries

**Files:**

- Modify: `apps/web/src/lib/queries.ts`
- Modify: `tests/local-embedding.test.ts:195-230`
- Verify: all TypeScript projects through root `pnpm typecheck`

**Interfaces:**

- Consumes: response interfaces exported by `apps/web/src/lib/api.ts`.
- Produces: typed TanStack query data for all route consumers.

- [ ] **Step 1: Confirm the typecheck gate is red**

Run:

```bash
rtk pnpm typecheck
```

Expected: 36 errors including `unknown`/implicit-any query results and invalid `typeof fetch` casts.

- [ ] **Step 2: Make query result types explicit once**

Import the response types:

```ts
import type {
  DashboardSnapshot,
  DocumentRow,
  EmbeddingConfigResponse,
  MemoryRow,
  QueryMetrics,
  WorkspaceDetail,
  WorkspaceGraphData,
  WorkspaceListItem,
} from "./api";

interface SettingsEnvResponse {
  EMBEDDING_PROVIDER: string;
  OPENAI_BASE_URL?: string;
  OPENAI_EMBEDDING_MODEL: string;
  OLLAMA_EMBEDDING_MODEL: string;
}
```

Apply the first generic to each `queryOptions` call, for example:

```ts
export const dashboardQueryOptions = queryOptions<DashboardSnapshot>({
  queryKey: ["dashboard"],
  queryFn: api.getDashboard,
});

export const workspacesQueryOptions = queryOptions<{
  ok: boolean;
  data: WorkspaceListItem[];
}>({
  queryKey: ["workspaces"],
  queryFn: api.listWorkspaces,
});

export const workspaceQueryOptions = (id: string) =>
  queryOptions<{ ok: boolean; data: WorkspaceDetail | null }>({
    queryKey: ["workspace", id],
    queryFn: () => api.getWorkspace(id),
  });
```

Use these exact remaining type arguments:

```ts
queryOptions<WorkspaceGraphData>; // workspaceGraphQueryOptions
queryOptions<{ items: DocumentRow[]; totalCount: number }>; // documentsQueryOptions
queryOptions<SettingsEnvResponse>; // settingsEnvQueryOptions
queryOptions<EmbeddingConfigResponse>; // embeddingConfigQueryOptions
queryOptions<{ items: MemoryRow[]; totalCount: number }>; // memoriesQueryOptions
queryOptions<{ items: MemoryRow[]; totalCount: number }>; // memoriesSearchQueryOptions
queryOptions<QueryMetrics>; // metricsQueryOptions
```

- [ ] **Step 3: Fix the Bun `fetch` mock type without weakening production types**

Change each test-only cast from:

```ts
}) as typeof fetch;
```

to:

```ts
}) as unknown as typeof fetch;
```

- [ ] **Step 4: Verify typecheck**

Run:

```bash
rtk pnpm typecheck
```

Expected: exit 0. Do not annotate individual `.map()` callbacks and do not disable strictness.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/queries.ts apps/web/src/lib/api.ts tests/local-embedding.test.ts
git commit -m "fix(types): restore strict query inference"
```

---

### Task 5: Report embedding cache status and reconcile reindex docs

**Files:**

- Modify: `tests/embed-workspace.test.ts`
- Modify: `packages/indexer/src/embed-workspace.ts:19-26,200-239`
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-08-10-local-embedding-cli.md:113-124`

**Interfaces:**

- Produces: `EmbedWorkspaceSummary.cacheStatus: "ready" | "not-applicable"`.

- [ ] **Step 1: Add the summary regression assertion**

In the remote-provider resume test, add:

```ts
expect(first.cacheStatus).toBe("not-applicable");
```

- [ ] **Step 2: Verify the assertion is red**

Run:

```bash
rtk bun test tests/embed-workspace.test.ts -t "resumes missing chunks"
```

Expected: FAIL because `cacheStatus` is undefined.

- [ ] **Step 3: Add the minimal summary field**

Extend the interface:

```ts
cacheStatus: "ready" | "not-applicable";
```

Set it only after local cache verification succeeds:

```ts
let cacheStatus: EmbedWorkspaceSummary["cacheStatus"] = "not-applicable";
if (provider.provider === "local") {
  await ensureLocalEmbeddingCache(provider.model);
  cacheStatus = "ready";
}
```

Include `cacheStatus` in the returned summary.

- [ ] **Step 4: Correct the reindex lifecycle documentation**

Replace the stale plan assertion that full reindex preserves vectors with the implemented contract: full reindex replaces chunks and removes their vectors; it never creates embeddings, and users run `openez embed [path]` afterward. Add the same concise warning beside the README reindex/embed instructions.

- [ ] **Step 5: Verify embed behavior**

Run:

```bash
rtk bun test tests/embed-workspace.test.ts tests/embedding-migration.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add tests/embed-workspace.test.ts packages/indexer/src/embed-workspace.ts README.md docs/superpowers/plans/2026-08-10-local-embedding-cli.md
git commit -m "fix(embed): report cache readiness"
```

---

### Task 6: Full verification and smoke checks

**Files:**

- Verify only; no planned source changes.

**Interfaces:**

- Consumes: all repaired CLI/MCP/web/index/retrieval/memory surfaces.
- Produces: release-gate evidence.

- [ ] **Step 1: Run repository gates**

Run in order:

```bash
rtk pnpm test
rtk pnpm typecheck
rtk pnpm build:web
rtk pnpm build:cli
rtk bun apps/cli/dist/cli.cjs --version
rtk bun apps/cli/dist/cli.cjs --help
rtk git diff --check main...HEAD
```

Expected: every command exits 0; CLI version is `1.1.0`; help lists `embed` and all existing commands.

- [ ] **Step 2: Run live MCP smoke checks**

Use the indexed current workspace to verify:

- incremental `index_workspace` completes;
- `code_query` returns budgeted sources;
- `code_context` accepts `symbolOrPath`;
- `graph_neighbors` returns nodes/edges;
- `memory_recall` returns the merge-readiness architecture memory.

- [ ] **Step 3: Inspect the final diff**

Run:

```bash
rtk git status --short
rtk git diff main...HEAD --stat
```

Expected: no uncommitted source changes and only the intended merge-readiness commits beyond the reviewed branch.
