# `code_outline` MCP Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the `code_outline` MCP tool to return token-efficient symbol outlines and file hierarchy in <2ms.

---

## File Responsibility Matrix

| File                                            | Responsibility                                                                            |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `packages/db/src/sqlite/types.ts`               | Define `FileOutlineSymbol` and `FileOutlineResult` interfaces.                            |
| `packages/db/src/sqlite/document-repository.ts` | Implement `getFileOutline(filePath: string)` querying `documents` and `parsed_documents`. |
| `packages/core/src/outline.ts`                  | Symbol hierarchy builder and compact ASCII tree formatter.                                |
| `packages/core/src/index.ts`                    | Export outline functions and types.                                                       |
| `apps/mcp/src/mcp-core.ts`                      | Register `code_outline` tool definition, schema, and handler.                             |
| `tests/code-outline.test.ts`                    | Unit and integration tests for `code_outline`.                                            |

---

## Implementation Tasks

### Task 1: Add Outline Types and DB Query

- [x] Add `FileOutlineSymbol` and `FileOutlineResult` to `packages/db/src/sqlite/types.ts`.
- [x] Implement `getFileOutline(filePath: string)` in `packages/db/src/sqlite/document-repository.ts` and `workspace-repository.ts`.

### Task 2: Core Outline Formatting

- [x] ASCII tree formatting integrated in `getFileOutline`.
- [x] Export `FileOutlineSymbol` and `FileOutlineResult` in `packages/db/src/sqlite/index.ts`.

### Task 3: MCP Tool Integration

- [x] Add `codeOutlineSchema` to `apps/mcp/src/mcp-core.ts`.
- [x] Wire `code_outline` tool descriptor in `apps/mcp/src/mcp-core.ts`.
- [x] Wire `code_outline` request handler in `apps/mcp/src/mcp-core.ts`.

### Task 4: Tests and Verification

- [x] Create `tests/code-outline.test.ts`.
- [x] Run `pnpm typecheck` (0 errors).
- [x] Run `bun test` (100% pass).
