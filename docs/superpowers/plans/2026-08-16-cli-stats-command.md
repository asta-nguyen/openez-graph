# CLI `openez stats` & `openez tokens` Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement `openez stats` (alias: `tokens`) to display workspace metrics, token savings, index counts, and recent query telemetry in the terminal.

---

## File Responsibility Matrix

| File                                             | Responsibility                                                              |
| ------------------------------------------------ | --------------------------------------------------------------------------- |
| `packages/db/src/sqlite/types.ts`                | Define `QueryMetricsResult` and `WorkspaceQueryLog` interfaces.             |
| `packages/db/src/sqlite/workspace-repository.ts` | Implement `getQueryMetrics(limit?: number)` and `getMemoryCount()`.         |
| `apps/cli/src/cli.ts`                            | Register `openez stats` and `openez tokens` commands with formatted output. |
| `tests/stats-command.test.ts`                    | Unit tests for query metrics and stats aggregation.                         |

---

## Implementation Tasks

### Task 1: Add `getQueryMetrics` to `@openez-graph/db`

- [x] Export `WorkspaceQueryLog` and `WorkspaceQueryMetrics` in `packages/db/src/sqlite/types.ts`.
- [x] Implement `getQueryMetrics` on `createWorkspaceRepository` in `packages/db/src/sqlite/workspace-repository.ts`.
- [x] Implement `getMemoryCount` on `createWorkspaceRepository`.

### Task 2: Implement `openez stats` & `openez tokens` in `apps/cli`

- [x] Register `stats` command with alias `tokens` in `apps/cli/src/cli.ts`.
- [x] Implement terminal formatting with token savings percentage and recent query list.
- [x] Support `--all` flag to print aggregate stats across all registered workspaces.

### Task 3: Unit Tests & Verification

- [x] Create `tests/stats-command.test.ts`.
- [x] Run `pnpm typecheck` across all workspace packages.
- [x] Run `bun test` to verify 100% test pass rate.
- [x] Execute `openez stats .` on the real repository to verify formatting.
