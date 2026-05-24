# AGENTS.md

This file provides project-specific guidance for agents working in this repository.

## Project Overview

OpenEZ Graph is a local-first code intelligence system with:

- a CodeGraph-style indexing and retrieval engine
- a SQLite runtime with workspace registry and per-workspace databases
- a management UI
- MCP access over the same indexed runtime

Treat the repo as SQLite-first, multi-workspace, and CLI/MCP-first, with the web app as a management layer rather than the center of the system.

## Storage Model

Use SQLite in WAL mode as the default storage model.

- global registry DB under `~/.ai-memory-graph/`
- per-workspace DB under `<root>/.openez/`
- project-local workspace hint under `<root>/.openez/workspace.json`

Do not assume Postgres, `pgvector`, Redis, or BullMQ are part of the default path.

## Workspace Bootstrap

`openez init <path>` and `openez index <path>` should keep `<path>/.openez/workspace.json` up to date.

That file is a local hint for agents and MCP resolution. It is not a committed project artifact and should remain ignored by Git.

Expected shape:

```json
{
  "workspaceId": "openez",
  "rootPath": "/abs/path/to/project",
  "name": "openez",
  "updatedAt": "2026-05-24T14:00:38.958Z"
}
```

## Commands

The intended command shape is:

```bash
openez init [path]
openez index [path]
openez reindex [path]
openez watch [path]
openez status [path]
openez list
openez serve --mcp
openez setup codex
```

Do not bias new work toward `--workspace`, `main-project`, or pinned single-workspace assumptions.

## MCP-First Workflow

For questions about a codebase that has been indexed:

1. Use MCP tools before reading files directly.
2. Start with `memory_query` for broad questions.
3. Use `code_context` for symbol- or file-specific follow-up.
4. Use `graph_neighbors` when relationship inspection is needed.
5. Only fall back to direct file reads when MCP results are insufficient or need verification.

When no explicit workspace scope is provided, MCP should default by reading `.openez/workspace.json` from the current project or one of its parent directories.

For cross-workspace questions, pass explicit multi-workspace scope:

- `workspaceIds`
- or `paths`

## MCP Expectations

MCP should be multi-workspace aware.

- `memory_query`, `code_context`, and `graph_neighbors` should support one or many workspaces
- `memory_write` and `index_workspace` remain single-workspace operations
- `list_workspaces` should expose the registered workspace inventory
- `workspaceId` is the canonical internal key

## Indexing Expectations

- TS/JS: richest indexing path via `ts-morph`
- Python/Go/Rust: basic top-level symbol extraction
- YAML/JSON/TOML: structure-aware chunking
- Markdown: section-oriented chunking

Retrieval defaults to FTS + graph expansion. Embeddings are optional and should not be assumed to exist.

## Working Guidance

- Prefer changes that reinforce the engine/runtime/UI separation.
- Avoid introducing new hard dependencies on Postgres or Redis for the default path.
- Avoid assuming the web app is the center of the system.
- Prefer local-first, low-setup operational choices.
- When validating agent behavior, test MCP-first flows in a fresh session after `openez setup codex`.
