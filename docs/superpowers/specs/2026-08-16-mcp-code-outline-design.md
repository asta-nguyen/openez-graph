# `code_outline` MCP Tool Design Specification

## 1. Goal

Provide coding agents with an instant, token-minimal MCP tool (`code_outline`) to inspect the structure, exported symbols, classes, functions, and line boundaries of any file in the workspace without loading full file contents into the LLM context window.

---

## 2. Problem Statement & Value Proposition

- **Problem**: When an agent wants to discover what functions or classes exist inside an 800-line file (e.g. `user-service.ts`), using `read_file` wastes **3,000+ tokens** of context window.
- **Solution**: `code_outline(path)` queries pre-indexed AST symbol tables in SQLite and returns a structured, compact hierarchy consuming **~50 tokens (95%+ token savings)** in **<2 ms**.

---

## 3. Tool Interface & Schema

### MCP Tool Name

`code_outline`

### Input Schema

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "Relative or absolute path to the file within the workspace"
    },
    "workspaceId": {
      "type": "string",
      "description": "Optional workspace identifier. Defaults to current workspace."
    }
  },
  "required": ["path"]
}
```

### Return Payload Structure

```json
{
  "path": "packages/indexer/src/scanner.ts",
  "absolutePath": "/abs/path/to/packages/indexer/src/scanner.ts",
  "language": "typescript",
  "kind": "code",
  "sizeBytes": 3420,
  "symbols": [
    {
      "name": "scanWorkspaceFiles",
      "kind": "function",
      "startLine": 25,
      "endLine": 95,
      "exported": true
    },
    {
      "name": "isExcludedPath",
      "kind": "function",
      "startLine": 98,
      "endLine": 115,
      "exported": false
    }
  ],
  "outlineText": "📄 packages/indexer/src/scanner.ts (typescript, 3,420 bytes)\n  ├── 🔹 function scanWorkspaceFiles [L25-L95] (exported)\n  └── 🔹 function isExcludedPath [L98-L115]"
}
```

---

## 4. Architecture & Data Flow

1. **Database Layer (`@openez-graph/db`)**:
   - `getFileOutline(filePath: string)` queries:
     1. `documents` table to retrieve `id`, `path`, `absolute_path`, `language`, `kind`, `sizeBytes`, `mtimeMs`.
     2. `parsed_documents` table to retrieve pre-extracted AST symbols (`symbols` JSON column).
     3. `chunks` table if AST symbols are empty (fallback to chunk headings, symbols, and line ranges) and hydrates missing AST symbol line ranges.
   - Formats compact visual ASCII outline text tree.

2. **MCP Layer (`@openez-graph/mcp`)**:
   - Exposes `code_outline` tool in MCP server tool registry.
   - Resolves multi-workspace scoping from `workspaceId` or auto-detected path.

---

## 5. Verification & Quality Gates

- Unit test in `tests/code-outline.test.ts` verifying:
  - TypeScript/JavaScript AST symbol outlines with classes and nested methods.
  - Python/Ruby/Go AST symbol outlines.
  - Fallback chunk outline for Markdown and configuration files.
  - Non-existent file error handling.
- Monorepo typecheck: `pnpm typecheck` (0 errors).
- Test suite: `bun test` (100% pass rate).
