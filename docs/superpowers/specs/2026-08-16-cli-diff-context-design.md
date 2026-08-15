# `openez diff` CLI Review Context Design Specification

## 1. Goal

Provide AI review agents and developers with an instant Git diff & PR context analyzer (`openez diff`) that extracts modified AST symbols from git diffs and automatically connects them to their call-graph dependents (callers, callees, and dependencies) for zero-hallucination code reviews.

---

## 2. Problem Statement & Value Proposition

- **Problem**: When reviewing a PR or git commit, code review agents only see textual git diff hunks. They don't know what methods were changed, who calls those methods, or what external services will break unless they manually run dozens of slow grep searches.
- **Solution**: `openez diff [ref | --staged]` maps git diff hunks directly to indexed AST symbols and traverses the SQLite call graph in **<25 ms**, producing a complete **PR Review Context Bundle**.

---

## 3. Interfaces & Schemas

### 1. MCP Tool: `diff_context`

```json
{
  "name": "diff_context",
  "description": "Analyze git diff changes and retrieve affected AST symbols and their caller/callee dependencies for intelligent code reviews.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "workspaceIds": { "type": "array", "items": { "type": "string" } },
      "workspaceId": { "type": "string" },
      "paths": { "type": "array", "items": { "type": "string" } },
      "path": { "type": "string" },
      "ref": {
        "type": "string",
        "description": "Git ref or commit range (e.g. 'HEAD~1', 'main', 'origin/main')"
      },
      "staged": {
        "type": "boolean",
        "description": "Analyze only staged changes (git diff --staged)"
      },
      "limit": { "type": "number", "description": "Max callers to include per symbol (default: 5)" }
    }
  }
}
```

### 2. CLI Command: `openez diff`

```bash
openez diff [ref] [options]
```

#### Options:

- `[ref]`: Target git ref or commit range (e.g. `HEAD~1`, `origin/main`, `main..HEAD`). Defaults to uncommitted changes.
- `-s, --staged`: Analyze staged git changes (`git diff --staged`).
- `-j, --json`: Output machine-readable JSON context bundle for automated CI / agent workflows.
- `-l, --limit <number>`: Limit number of callers/callees shown per symbol (default: 5).

---

## 4. Architecture & Data Flow

1. **Git Diff Extractor**:
   - Runs `git diff` to collect modified files and hunk line boundaries (`@@ -L,N +L,N @@`).
2. **AST Symbol Mapper**:
   - Queries `parsed_documents` and `chunks` for each modified file to identify which functions/classes intersect the changed line ranges.
3. **Call Graph Traversal**:
   - Queries `graph_edges` and `graph_nodes` to identify incoming `calls` edges (affected callers) and outgoing calls/imports.
4. **Context Formatter**:
   - Prints formatted ASCII review card to terminal or outputs structured JSON.

---

## 5. Verification & Quality Gates

- Unit test in `tests/diff-context.test.ts`:
  - Diff parser line-range extraction.
  - Intersection with AST symbols.
  - Caller graph dependency resolution.
- Verification commands:
  - `pnpm typecheck` (0 errors).
  - `bun test` (100% pass rate).
