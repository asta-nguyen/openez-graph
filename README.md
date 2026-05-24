# OpenEZ Graph

Local-first code intelligence engine with workspace management UI, MCP access, and SQLite-based indexing.

The current architectural direction is:

- CodeGraph-style engine for semantic code indexing and retrieval
- local runtime with simple setup
- management UI for workspaces, indexing, queries, and graph inspection

## Open Source Defaults

This repository is intended to be safe to work with as an open source project:

- local indexes stay under `.openez/` and are ignored by Git
- registry state stays under `~/.openez/` and is never part of the repo
- example environment variables belong in `.env.example`
- real secrets belong in `.env.local`, `.env.development.local`, or other ignored `.env.*` files
- `openez setup codex` writes to the user's global `~/.codex/config.toml`, not into the repo

If you contribute to this project, do not commit:

- SQLite databases
- local `.openez/` contents
- real API keys, tokens, or credentials
- personal editor or MCP runtime state

## What This Repo Does

- indexes local codebases and docs
- extracts chunks, symbols, and graph relationships
- stores workspace metadata and index state locally in SQLite
- exposes CLI, web UI, and MCP interfaces over the same local runtime

## Current Architecture

### Product split

1. `engine`
   - scanning
   - chunking
   - symbol extraction
   - graph building
   - retrieval
   - MCP-facing query primitives
2. `runtime`
   - workspace registry
   - local storage
   - index runs and status
   - configuration defaults
3. `ui`
   - workspace management
   - indexing controls
   - query and graph inspection

### Storage

Default storage is SQLite in WAL mode.

- global registry DB:
  - `~/.openez/`
  - stores workspace registry and shared runtime metadata
- per-workspace DB:
  - `<workspace-root>/.openez/`
  - stores documents, chunks, graph, memories, query logs, and index history

## Indexing Model

Language support is intentionally uneven by design:

- TS/JS:
  - parsed with `ts-morph`
  - richest symbol and graph extraction path
- Python, Go, Rust:
  - basic top-level symbol extraction
  - practical indexing path, not full semantic parity with TS/JS
- YAML, JSON, TOML:
  - structure-aware chunking for config and data files
- Markdown:
  - section-oriented chunking

## Retrieval Model

Default retrieval is:

1. full-text search
2. graph expansion

Embeddings are optional and disabled by default. When configured, they augment retrieval rather than defining the default setup experience.

## Workspace Model

`brain.config.*` is now optional.

- if present, it can provide default tuning
- it is no longer required for workspace registration
- workspace registration is runtime-driven

Multi-workspace operation is a first-class use case.

## CLI

The main entrypoint is:

```bash
pnpm openez init [path]
```

Expected command shape:

```bash
pnpm openez init /path/to/project
pnpm openez index /path/to/project
pnpm openez reindex /path/to/project
pnpm openez watch /path/to/project
pnpm openez status /path/to/project
pnpm openez serve --mcp
```

The default workflow should not require `--workspace`.

Quickstart:

```bash
pnpm openez init /path/to/project
pnpm openez index /path/to/project
pnpm openez status /path/to/project
pnpm openez serve --mcp
```

`openez init` and `openez index` keep `<project>/.openez/workspace.json` up to date so agents and MCP clients can resolve the default workspace from the current project directory.

## MCP

MCP is workspace-aware.

Tools should accept either:

- `workspaceId`
- or `path`

Read tools also support multi-workspace queries through:

- `workspaceIds`
- or `paths`

If multiple workspaces exist and the request is ambiguous, MCP should require explicit scope instead of guessing.

Recommended MCP capability set:

- `list_workspaces`
- `memory_query`
- `code_context`
- `graph_neighbors`
- `index_workspace`

For project-local agent usage, the shared MCP server resolves the default workspace from `.openez/workspace.json` before falling back to registry heuristics.

## Security Notes

- Never commit `.env` or `.env.*` files other than `.env.example`.
- Never commit `.openez/` or any generated SQLite files.
- Treat `~/.codex/config.toml` and similar client config as user-local machine state.
- If you enable embeddings or external providers, keep provider keys in ignored environment files only.

## Setup Philosophy

The default local setup should not require:

- Postgres
- Redis
- Docker
- manual workspace registration in `brain.config.*`

Optional components may still exist for compatibility or advanced workflows, but they are not part of the default path.

## Local Artifacts

By default, OpenEZ writes local runtime data to:

- `~/.openez/registry.sqlite`
- `<workspace-root>/.openez/index.sqlite`
- `<workspace-root>/.openez/workspace.json`

These files are runtime state, not source files, and should stay untracked.

## Legacy Components

Some legacy code and docs still reference:

- Postgres
- `pgvector`
- Redis
- BullMQ
- `--workspace`
- required `brain.config.*`

These belong to the previous architecture and should be treated as compatibility or migration-era material unless updated.
