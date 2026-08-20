# `symbol_definition` MCP Tool Design Specification

## 1. Goal

Provide AI coding agents with a direct, pinpoint "Go to Definition" MCP tool (`symbol_definition`) that immediately resolves any exact symbol name (function, class, interface, type, method) to its precise declaration chunk, source code, and line numbers, aiming for sub-5ms lookup latency without scanning unrelated test files or comment matches.

---

## 2. Problem Statement & Value Proposition

- **Problem**: When an agent encounters `parseAndChunkBatch(file)` in code and needs to inspect its implementation, running `code_query("parseAndChunkBatch")` performs a broad full-text search returning 10+ call sites, test files, and docs, wasting tokens and context window.
- **Solution**: `symbol_definition(symbol: "parseAndChunkBatch")` queries the symbol index directly, returning the exact declaration and source chunk with targeted token usage and caller graph context.

---

## 3. Tool Interface & Schema

### MCP Tool Name

`symbol_definition`

### Input Schema

```json
{
  "type": "object",
  "properties": {
    "symbol": {
      "type": "string",
      "description": "Exact symbol name to locate (e.g. 'scanWorkspaceFiles', 'AuthService', 'authenticate')"
    },
    "workspaceIds": {
      "type": "array",
      "items": { "type": "string" },
      "description": "IDs of registered workspaces"
    },
    "workspaceId": { "type": "string" },
    "paths": {
      "type": "array",
      "items": { "type": "string" }
    },
    "path": { "type": "string" }
  },
  "required": ["symbol"]
}
```

### Return Payload Structure

```json
{
  "symbol": "scanWorkspaceFiles",
  "matches": [
    {
      "name": "scanWorkspaceFiles",
      "kind": "function",
      "filePath": "packages/indexer/src/scanner.ts",
      "startLine": 84,
      "endLine": 179,
      "exported": true,
      "sourceCode": "export async function scanWorkspaceFiles(...) {\n  ...\n}",
      "callerCount": 4,
      "calleeCount": 2
    }
  ]
}
```

---

## 4. Architecture & Data Flow

1. **Database Layer (`@openez-graph/db`)**:
   - `getSymbolDefinitions(symbolName: string)` queries:
     1. `graph_nodes` table where `label = symbolName` or `label LIKE '%::' || symbolName`.
     2. Joins `chunks` by `refId` or joins `parsed_documents` to locate declaration lines and source code.
     3. Queries `graph_edges` to attach caller count and callee count for graph-aware context.
2. **MCP Layer (`@openez-graph/mcp`)**:
   - Exposes `symbol_definition` tool in MCP server registry with multi-workspace support.

---

## 5. Verification & Quality Gates

- Unit test in `tests/symbol-definition.test.ts`:
  - Locate exported function definitions.
  - Locate class and method definitions.
  - Attach callers and callees counts.
  - Multi-workspace symbol resolution.
- Verification commands:
  - `pnpm typecheck` (0 errors).
  - `bun test` (100% pass rate).
