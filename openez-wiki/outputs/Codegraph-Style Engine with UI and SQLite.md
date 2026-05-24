---
title: Codegraph-Style Engine with UI and SQLite
type: output
status: active
created: 2026-05-24
updated: 2026-05-24
tags:
  - architecture
  - product
  - sqlite
  - mcp
  - workspace
---

# Codegraph-Style Engine with UI and SQLite

## Question

How should this project evolve if the goal is to be similar to CodeGraph while still having a UI for managing workspaces and operations?

## Answer

The recommended direction is not to turn the UI into the center of the product. The project should be split into three layers:

1. An engine layer that behaves like a CodeGraph-style semantic code intelligence system.
2. A runtime layer that manages local workspaces, storage, indexing state, and operational defaults.
3. A management UI that acts as a control plane for workspaces, jobs, query inspection, and graph inspection.

This keeps CLI and MCP as first-class interfaces while allowing the UI to improve usability and observability.

## Recommended Product Shape

### 1. Engine

This is the CodeGraph-like core:

- scan repositories
- parse source files
- extract symbols and graph relationships
- index code and documentation
- expose retrieval and MCP tools

This layer should be usable without the web app.

### 2. Runtime

This layer manages local operation:

- workspace registry
- config and defaults
- index state
- local storage
- job orchestration

The UI should talk to this layer instead of directly driving parser logic.

### 3. Management UI

The UI should focus on management and inspection:

- add and remove workspaces
- trigger index and reindex
- inspect runs and errors
- test queries
- inspect graph structure
- review workspace status

The UI is the control plane, not the semantic engine.

## Storage Decision

SQLite is the better default choice for the current product direction.

### Why SQLite

- better fit for local-first tooling
- simpler setup than Postgres
- no separate service required
- easier onboarding
- closer to the UX profile of CodeGraph
- better fit for CLI + MCP + local UI on a developer machine

### Why Not Postgres by Default

Postgres is stronger for:

- multi-user systems
- heavy concurrency
- always-on server deployment
- larger operational complexity

But it makes the product feel more like a backend platform than a local developer tool.

### Recommendation

- use SQLite as the default runtime backend
- use SQLite in WAL mode
- use two DB locations:
  - global registry DB in `~/.openez/`
  - per-workspace DB in `<workspace-root>/.openez/`
- design storage with a clean abstraction boundary
- do not build dual-backend support immediately

## Configuration and Setup

### Config Direction

`brain.config.*` should be optional.

- use it only for defaults and tuning when present
- do not require it for workspace registration
- do not make it the source of truth for multi-workspace routing

### CLI Direction

The main entrypoint should be:

```bash
openez init [path]
```

The default operational flow should not require `--workspace`.

Preferred command family:

- `openez init [path]`
- `openez index [path]`
- `openez reindex [path]`
- `openez watch [path]`
- `openez status [path]`
- `openez serve --mcp`

## Multi-Workspace MCP Design

If the product supports multiple workspaces, MCP queries must be explicitly scoped to the correct workspace.

### Canonical Approach

Every MCP tool that reads or mutates indexed knowledge should accept `workspaceId`.

For compatibility and convenience, MCP may also accept `path`, but runtime resolution should normalize to `workspaceId`.

Examples:

- `query`
- `code_context`
- `graph_neighbors`
- `index`

The runtime resolves:

`workspaceId -> rootPath -> workspace SQLite database -> query/index scope`

### Why `workspaceId`

Use `workspaceId` as the canonical identifier because it is:

- more stable than a path
- easier to expose in the UI
- easier to pass through MCP and CLI
- easier to map to runtime metadata

### Required MCP Safeguards

1. Require `workspaceId` when more than one workspace exists.
2. Add a `list_workspaces` tool so the agent can discover valid targets.
3. Allow default fallback only when exactly one workspace is configured.

### Error Policy

If multiple workspaces exist and the request does not specify one, MCP should return a clear error:

`Multiple workspaces configured; workspaceId is required.`

### Runtime Convenience

The UI or CLI may expose an active workspace for convenience, but MCP should not silently depend on it when ambiguity exists.

## Suggested Interface Shape

Example query call:

```ts
query({
  workspaceId: "openez",
  q: "how does indexing work?"
})
```

Suggested support tool:

```ts
list_workspaces()
```

Returns:

- `id`
- `name`
- `rootPath`
- `status`
- `lastIndexedAt`

## Recommended Operating Mode

- runtime and UI are multi-workspace
- MCP server is global
- MCP tools are explicitly workspace-scoped
- single-workspace fallback is allowed only when there is no ambiguity

This gives the cleanest behavior for a local system with multiple repositories under one UI.

## Indexing and Retrieval Defaults

### Indexing Support

- TS/JS: `ts-morph`, richest indexing path
- Python/Go/Rust: regex-based or lightweight top-level symbol extraction
- YAML/JSON/TOML: structure-aware chunking

The goal is practical basic coverage for non-TS languages, not parity with the TS/JS semantic path.

### Retrieval

Default retrieval should be:

1. full-text search
2. graph expansion

Embeddings should be optional and disabled by default.

## Queue and Worker

Redis and queue-backed indexing should be removed from the default product path.

- keep worker support temporarily only for backward compatibility
- do not make Redis or BullMQ required for a standard local install

## Evidence

- [[Index]]
- [[Log]]
- [[Wiki Schema]]

## Follow-Ups

- Write a concrete repository refactor plan for `engine`, `runtime`, `cli`, and `web`.
- Define the SQLite schema for multi-workspace management.
- Define the MCP tool surface for workspace-aware queries.
