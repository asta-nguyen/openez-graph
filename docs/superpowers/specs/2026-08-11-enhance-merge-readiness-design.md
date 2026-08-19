# Enhance Merge Readiness Design

## Goal

Make `feat/enhance` safe to merge into `main` by fixing the confirmed MCP, retrieval, browser-build, and TypeScript regressions without broad refactoring or rewriting branch history.

## Scope

- Restore `code_context` requests that use `symbolOrPath`; validation for `nodeId` or `label` remains owned by `graph_neighbors`.
- Keep embedding provider implementations server-only. The browser obtains the supported local-model catalog through the existing settings API instead of importing the `@openez-graph/core` barrel.
- Before embedding a query, check whether the workspace contains rows for the configured provider/model. With no matching rows, return the existing FTS + graph fallback without calling `provider.embed`.
- Make `pnpm typecheck` pass, including the newly introduced MCP/test errors and existing UI inference errors exposed by the repository gate.
- Include an explicit embedding cache status in successful `openez embed` output.
- Reconcile documentation around full reindex: because chunk identities are rebuilt, full reindex invalidates vectors and users rerun `openez embed`; indexing itself never creates embeddings.

## Non-goals

- Rewriting or splitting the existing 27 commits.
- Consolidating the duplicate web/database registry implementations.
- Adding ANN/vector infrastructure, new dependencies, or new configuration.
- Changing memory storage or ranking semantics.

## Design

### MCP validation

Remove the misplaced `nodeId`/`label` guard from the `code_context` case. `codeContextSchema` continues requiring `symbolOrPath`, while `graphNeighbors` remains the single validation point for graph-neighbor identifiers.

### Browser-safe model catalog

Extend the existing embedding settings response with a `localModels: string[]` field populated by the server from `LOCAL_EMBEDDING_MODELS`. The Settings route renders that response and no longer imports `@openez-graph/core`. This preserves one catalog source without exposing server modules to Vite.

### Vector preflight

After resolving the configured provider but before generating a query vector, issue a bounded `SELECT 1` against embeddings for the provider and storage-model key. If absent, log the fallback and return no vector hits. Existing FTS and graph retrieval continue unchanged.

### Type safety

Fix types at shared query/API boundaries where possible. Use direct local annotations only where the source is test-only or no shared boundary exists. Do not weaken strict compiler settings.

### Embed summary and reindex documentation

Return `cacheStatus: "ready" | "not-applicable"`: local providers report `ready` after verified cache preparation; remote providers report `not-applicable`. Update public types and tests. Document that full reindex removes vectors tied to replaced chunks and requires a subsequent explicit embed.

## Error handling

- Provider construction failures retain the current safe FTS fallback.
- The vector preflight is inside the existing vector-search error boundary.
- Settings API failures retain the existing UI error path.
- Cache preparation failures still fail `openez embed`; successful local runs cannot report `ready` before verification.

## Verification

- Regression test: valid MCP `code_context` succeeds.
- Regression test: a workspace without active-model rows never calls `provider.embed`.
- Settings/browser test or production build proves the client graph excludes server-only embedding dependencies.
- Embed tests assert cache status.
- Run `pnpm test`, `pnpm typecheck`, `pnpm build:web`, `pnpm build:cli`, CLI version/help, and live MCP index/query/graph/memory smoke checks.
