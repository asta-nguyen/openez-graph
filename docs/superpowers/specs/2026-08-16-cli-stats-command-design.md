# CLI `openez stats` & `openez tokens` Command Design

## 1. Goal

Provide developers and agents with instant terminal visibility into OpenEZ Graph workspace metrics, context token savings, query history, and codebase index statistics via a dedicated `openez stats` (alias: `tokens`) CLI command.

---

## 2. User Experience & CLI Interface

### Command Signature

```bash
openez stats [path] [--all] [--limit <n>]
openez tokens [path]
```

### Terminal Output Shape

```text
============================================================
 OpenEZ Stats: openez-graph (openez-graph)
============================================================
  Path:             /home/giogio/Project/openez-graph
  Status:           indexed (completed)
  Last Indexed:     2026-08-15T19:08:29.187Z

  -- Token Savings & Telemetry -----------------------------
  Total Queries:    42 queries
  Tokens Returned:  18,400 tokens (avg 438 / query)
  Tokens Saved:     1,420,500 tokens (98.7% context savings)
  Files Scanned:    148 files

  -- Index & Graph Breakdown -------------------------------
  Documents:        187 files
  Chunks:           1,198 chunks
  Graph Nodes:      48 nodes
  Graph Edges:      92 edges
  Memories:         3 stored decisions

  -- Recent Queries ----------------------------------------
  * "oxc parser AST extraction" -> 2 results, 18,200 tokens saved (2m ago)
  * "migrateTextPkToInteger" -> 1 result, 9,400 tokens saved (15m ago)
```

---

## 3. Architecture & Data Flow

1. **Database Layer (`@openez-graph/db`)**:
   - Expose `getQueryMetrics(limit?: number)` on `WorkspaceRepository`.
   - Query `query_logs` table for aggregate totals (`totalQueries`, `totalTokensReturned`, `totalTokensSaved`, `totalFilesScanned`).
   - Query `memories` table count via `getMemoryCount()`.
   - Retrieve recent `limit` queries from `query_logs`.

2. **CLI Layer (`apps/cli`)**:
   - Register `openez stats` and alias `openez tokens`.
   - Format numbers cleanly with locale separators (e.g. `1,420,500`).
   - Calculate percentage context savings `(tokensSaved / (tokensSaved + tokensReturned)) * 100`.
   - If `--all` is passed, iterate across all registered workspaces and display a global aggregate summary.

---

## 4. Verification & Testing

- Unit test in `tests/stats-command.test.ts` asserting:
  - `getQueryMetrics` aggregates token counts accurately.
  - Zero-query workspaces handle averages without division by zero.
  - CLI `status` and `stats` handle both existing and unregistered paths cleanly.
