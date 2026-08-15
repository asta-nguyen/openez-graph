# `openez diff` CLI Review Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement `openez diff` to analyze git diffs, map changed hunks to AST symbols, and retrieve surrounding call graph context.

---

## File Responsibility Matrix

| File                                | Responsibility                                                                   |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| `packages/core/src/diff-context.ts` | Git diff hunk parser, AST symbol intersection mapper, and graph caller resolver. |
| `packages/core/src/index.ts`        | Export diff context methods and types.                                           |
| `apps/cli/src/cli.ts`               | Register `openez diff` command with `--staged`, `--json`, `--limit` options.     |
| `tests/diff-context.test.ts`        | Unit tests for diff hunk parsing and symbol mapping.                             |

---

## Implementation Tasks

### Task 1: Core Diff Context Engine

- [x] Create `packages/core/src/diff-context.ts` with:
  - `parseGitDiffHunks(diffOutput: string)`
  - `analyzeDiffContext(rootPath: string, options: { ref?: string, staged?: boolean, limit?: number })`
- [x] Export `analyzeDiffContext` and types in `packages/core/src/index.ts`.

### Task 2: CLI & MCP Integration

- [x] Register `openez diff` command in `apps/cli/src/cli.ts`.
- [x] Format terminal output with affected symbols and caller hierarchy.
- [x] Support `--json` flag for agent consumption.
- [x] Add `diffContextSchema` and `diff_context` tool in `apps/mcp/src/mcp-core.ts`.
- [x] Wire `diff_context` request handler in `apps/mcp/src/mcp-core.ts`.

### Task 3: Tests and Verification

- [x] Create `tests/diff-context.test.ts`.
- [x] Run `pnpm typecheck` (0 errors).
- [x] Run `bun test` (100% pass rate).
- [x] Smoke test `openez diff` on live repository.
