# Fix 1: Dynamic tool discovery via `tools/list` in Context7Client

## Status

DONE

## Finding

The plan's Global Constraints require the client to discover tool names
dynamically via `tools/list` after connecting, mapping to known names with
fallbacks. The previous `Context7Client` hardcoded `resolve-library-id` and
`query-docs` in `resolveLibraryId()` and `getLibraryDocs()`. If Context7
renamed its tools, the integration would break silently.

## Changes

### `packages/core/src/external-docs/context7-client.ts`

1. Added two module-level candidate arrays:
   - `RESOLVE_LIBRARY_ID_CANDIDATES = ["resolve-library-id", "get-library-id", "resolve-library"]`
   - `QUERY_DOCS_CANDIDATES = ["query-docs", "get-library-docs", "get-docs"]`
2. Added two instance fields initialized to the canonical (first) candidate:
   - `resolveLibraryIdToolName`
   - `queryDocsToolName`
3. Added `discoverToolNames()` private method called from `start()` right after
   `this.client.connect(transport)`:
   - Calls `this.client.listTools()` and collects returned tool names.
   - On `listTools()` failure, logs to `console.error` and returns early,
     keeping the canonical fallback names (call proceeds and fails naturally).
   - Picks the first matching candidate for each role via `pickToolName()`.
   - If no candidate matched for a role, logs a warning to `console.error`
     listing the tried names and the server's available tools, but does not
     throw — the canonical name is kept so the call fails with a clear
     server-side error.
4. `resolveLibraryId()` now uses `this.resolveLibraryIdToolName` instead of the
   hardcoded `"resolve-library-id"` string.
5. `getLibraryDocs()` now uses `this.queryDocsToolName` instead of the
   hardcoded `"query-docs"` string.

### `tests/context7-client.test.ts`

No changes needed. The stub server already lists both `resolve-library-id` and
`query-docs` via `ListToolsRequestSchema`, so the new `listTools()` call
resolves to the canonical names and existing assertions still hold.

### `tests/context7-e2e.test.ts`

No changes needed. Same stub-server reasoning as above.

## Verification

- `pnpm test tests/context7-client.test.ts` -> 3 passed
- `pnpm test tests/context7-e2e.test.ts` -> 3 passed

## Commits

- (commit hash filled in after commit)

## Concerns

None. The fallback behavior preserves the previous behavior when tools/list is
unavailable or tools are missing, so there is no regression risk.
