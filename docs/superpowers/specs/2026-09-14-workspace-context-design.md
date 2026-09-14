# `workspace_context` Session Bootstrap Design

## Goal

Add a deterministic MCP read tool that gives a coding agent the minimum useful
workspace context at session start without requiring the agent to invent a
search query. The tool must remain local-first, work without embeddings or an
LLM, support OpenEZ's existing single- and multi-workspace selectors, and keep
the complete serialized response within a caller-provided token budget.

## Scope

Version 1 returns four kinds of existing information:

- workspace identity and index status from the registry;
- root agent instructions from regular `AGENTS.md` and `CLAUDE.md` files;
- current Git branch and changed-file statuses;
- newest active memories, where a memory is inactive when another memory
  supersedes it.

This version does not add query-specific retrieval, summarization, embeddings,
profile caching, automatic fact extraction, expiration, conflict resolution,
connectors, dependencies, or a SQLite schema migration.

## MCP Contract

The MCP server advertises `workspace_context` as a session-start bootstrap tool.
Its input follows the existing read-tool workspace resolver contract:

```ts
{
  workspaceIds?: string[];
  workspaceId?: string;
  paths?: string[];
  path?: string;
  maxTokens?: number; // integer, 128..100_000; default 800
}
```

At most one selector form may be defined. With no selector, the existing
resolver uses `.openez/workspace.json` from the current directory or a parent.

The response always uses a multi-workspace envelope:

```ts
{
  workspaces: Array<
    | {
        workspaceId: string;
        workspaceName: string;
        rootPath: string;
        context: {
          index: {
            status: string;
            indexingStatus: string;
            lastIndexedAt?: string;
            documentCount: number;
            chunkCount: number;
          };
          instructions: Array<{ path: "AGENTS.md" | "CLAUDE.md"; content: string }>;
          activity: {
            branch?: string;
            detachedHead?: string;
            changedFiles: Array<{ path: string; status: string }>;
          };
          memories: Array<{
            id: string;
            title: string;
            content: string;
            tags: string[];
            source: string;
            updatedAt: string;
          }>;
          warnings?: string[];
        };
      }
    | {
        workspaceId: string;
        workspaceName: string;
        rootPath: string;
        error: string;
      }
  >;
  metrics: {
    tokenBudget: number;
    responseTokens: number;
    truncated: boolean;
  }
}
```

## Components

### Active-memory listing

Extend the existing workspace repository with
`listActiveMemories(limit: number)`. It uses the current supersession rule:

```sql
SELECT m.*
FROM memories m
WHERE NOT EXISTS (
  SELECT 1 FROM memories newer WHERE newer.supersedes_id = m.id
)
ORDER BY m.updated_at DESC
LIMIT ?
```

The bootstrap requests at most ten rows. The repository maps rows through the
existing memory mapper, and the core layer converts comma-separated tags to the
public string-array shape. No memory table or write contract changes.

### Workspace snapshot

Add a focused core function in `packages/core/src/workspace-context.ts`. It
receives one already-resolved workspace and produces one unbudgeted context
entry.

- It copies index metadata from the resolved registry workspace.
- It checks only `<root>/AGENTS.md` and `<root>/CLAUDE.md`, in that order.
- It reads a candidate only when `lstat` reports a regular file. A symlink is
  skipped with a warning so the tool cannot follow an instruction path outside
  the registered workspace.
- It runs Git through `execFile`, with fixed arguments and `cwd` set to the
  workspace root. `git branch --show-current` supplies a branch name. On a
  detached head, `git rev-parse --short HEAD` supplies `detachedHead`.
  `git status --porcelain=v1 -z --untracked-files=all` supplies changed paths
  and preserves spaces in filenames.
- It fetches active memories through the workspace repository.

The function performs no indexing and no semantic search. Session bootstrap
must be fast and must not trigger embeddings, graph construction, or external
API calls.

### MCP orchestration and budgeting

`apps/mcp/src/mcp-core.ts` reuses `createWorkspaceResolver()` to resolve all
requested workspaces and calls the core snapshot function concurrently. A
failure after resolution becomes an error entry for that workspace; successful
siblings remain in the response.

The existing serialized-response fitter remains the final budget guard. Extend
its workspace-context handling only enough to apply this reduction order:

1. remove secondary instruction entries;
2. truncate remaining instruction content;
3. remove memories from oldest to newest;
4. remove changed files from the end;
5. if the envelope still cannot fit, retain the first workspace identity or
   error plus metrics, matching the existing `workspaces` fallback.

Workspace identity, index metadata, activity object, actionable errors, and
metrics are not removed during ordinary truncation. The final serialized JSON,
including metrics, must not exceed `maxTokens`.

## Error Semantics

- Invalid or conflicting workspace selectors fail through the existing MCP
  schema and resolver validation.
- An unknown workspace or path returns the existing resolver error rather than
  an empty context.
- Missing instruction files produce `instructions: []` without a warning.
- A symlinked instruction candidate is skipped and reported in `warnings`.
- A non-Git directory, unavailable Git binary, or failed Git command produces
  an empty activity object plus a warning; index metadata and memories still
  return.
- An unexpected instruction-file read or SQLite failure produces an error entry
  for that workspace without suppressing successful sibling entries. Git
  failures remain non-fatal as described above.

Warnings contain useful operation and path context but do not include file
contents or command output that may expose unrelated local data.

## Verification

Focused MCP tests cover:

- default resolution through the local workspace hint;
- explicit single- and multi-workspace selectors;
- root instruction loading and symlink rejection;
- branch, detached-head, modified, staged, renamed, and untracked Git states;
- graceful behavior for a non-Git workspace;
- newest-first active memories with superseded rows excluded;
- one workspace failure alongside one successful workspace;
- default and explicit token budgets, including a response whose measured
  token count is no greater than `maxTokens`;
- the session-start wording in the advertised tool description;
- unchanged contracts for `memory_recall`, `code_query`, and `diff_context`.

Verification commands:

```bash
pnpm exec vitest run tests/mcp-tools.test.ts tests/workspace-db.test.ts
pnpm typecheck
pnpm test
```

## Impact Map

```text
Entry: apps/mcp/src/mcp-core.ts — workspace_context tool registration and handler
Flow: MCP request → existing workspace resolver → core workspaceContext → filesystem/Git/workspace repository
State changes: none; reads registry and per-workspace SQLite only
External effects: local instruction-file reads and local Git subprocesses only
Change candidates: packages/core/src/workspace-context.ts, packages/core/src/index.ts, packages/db/src/sqlite/memory-repository.ts, packages/db/src/sqlite/types.ts, apps/mcp/src/mcp-core.ts, tests/mcp-tools.test.ts, tests/workspace-db.test.ts, README.md, apps/cli/README.md, AGENTS.md
Verification: focused MCP/repository tests, typecheck, full test suite
```

## Documentation

Update the root README, CLI README, and AGENTS tool inventories so agents know
to call `workspace_context` at session start. The existing `memory_recall` and
`code_query` tools remain available for query-specific follow-up.
