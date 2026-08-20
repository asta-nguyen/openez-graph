# `symbol_definition` MCP Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the `symbol_definition` MCP tool to locate exact symbol definitions and source chunks in <2ms.

---

## File Responsibility Matrix

| File                                             | Responsibility                                                             |
| ------------------------------------------------ | -------------------------------------------------------------------------- |
| `packages/db/src/sqlite/types.ts`                | Define `SymbolDefinitionMatch` and `SymbolDefinitionResult` interfaces.    |
| `packages/db/src/sqlite/workspace-repository.ts` | Implement `getSymbolDefinitions(symbolName: string)` in SQLite repository. |
| `packages/db/src/sqlite/index.ts`                | Export new types.                                                          |
| `apps/mcp/src/mcp-core.ts`                       | Register `symbol_definition` tool schema, descriptor, and request handler. |
| `tests/symbol-definition.test.ts`                | Unit tests for symbol definition resolution.                               |

---

## Implementation Tasks

### Task 1: Add Symbol Definition Types & DB Query

- [x] Add `SymbolDefinitionMatch` to `packages/db/src/sqlite/types.ts`.
- [x] Implement `getSymbolDefinitions(symbolName: string)` in `packages/db/src/sqlite/workspace-repository.ts`.
- [x] Export `SymbolDefinitionMatch` in `packages/db/src/sqlite/index.ts`.

### Task 2: MCP Tool Integration

- [x] Add `symbolDefinitionSchema` to `apps/mcp/src/mcp-core.ts`.
- [x] Add `symbol_definition` tool descriptor in `apps/mcp/src/mcp-core.ts`.
- [x] Add `symbol_definition` handler in `apps/mcp/src/mcp-core.ts` with multi-workspace support.

### Task 3: Tests and Verification

- [x] Create `tests/symbol-definition.test.ts`.
- [x] Run `pnpm typecheck` (0 errors).
- [x] Run `bun test` (100% pass rate).
