# Project Operations

This document describes the current intended operating model of the project.

## Product Direction

OpenEZ Graph is moving toward a CodeGraph-style local code intelligence product with:

- a semantic indexing engine
- a local runtime
- a management UI
- MCP access

The default path is local-first and low-setup.

## Core Decisions

### Storage

- Default backend: SQLite in WAL mode
- Global registry DB: `~/.openez/`
- Per-workspace DB: `<workspace-root>/.openez/`

### Configuration

- `brain.config.*` is optional
- workspace registration should not depend on a config file
- config files may still provide global tuning defaults

### CLI

Primary entrypoint:

```bash
pnpm openez init [path]
```

Expected command family:

```bash
pnpm openez init [path]
pnpm openez index [path]
pnpm openez reindex [path]
pnpm openez watch [path]
pnpm openez status [path]
pnpm openez serve --mcp
```

### Indexing

- TS/JS: rich path via `ts-morph`
- Python/Go/Rust: basic top-level symbol extraction
- YAML/JSON/TOML: structure-aware chunking
- Markdown: section-oriented chunking

### Retrieval

- default: FTS + graph expansion
- embeddings: optional, disabled by default

### MCP

- tools accept `workspaceId` or `path`
- `workspaceId` is the canonical internal key
- multi-workspace ambiguity should produce an explicit error

### Queue and worker

- Redis/BullMQ are not part of the default path
- worker support may remain temporarily for backward compatibility
- new work should not depend on queue-backed indexing by default

## Runtime Responsibilities

The runtime should own:

- workspace registration
- root path resolution
- workspace ID creation
- registry lookup
- index run state
- DB placement and lifecycle

The engine should not depend on the web UI for control flow.

## UI Responsibilities

The web UI should act as a control plane:

- add and remove workspaces
- inspect workspace status
- trigger indexing
- inspect graph and query results
- review logs and failures

The UI should not become the place where core indexing semantics live.

## Migration Notes

Some code and documentation still reflect the older architecture:

- Postgres with `pgvector`
- Redis/BullMQ queue flows
- `brain.config.*` as required workspace source of truth
- `--workspace`
- `main-project` fallback behavior

Those references should be treated as migration debt and updated over time.
