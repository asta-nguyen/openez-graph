# Plan: Basic Multi-Language Support + One-Command Local Setup

## Summary

Migrate the project from Postgres/Redis + brain.config.\* workspace management to a local
SQLite-first architecture with CLI-first workflow. Keep the web app, but make it secondary.
Add basic indexing support for Python, Go, Rust, YAML, JSON, and TOML without trying to
match current TS/JS graph depth.

End state:

- brain init /path/to/project is the main entrypoint.
- No manual brain.config.\* workspace registration.
- No Redis in the default flow.
- No required Postgres for local use.
- TS/JS remain the richest indexed languages.
- Python/Go/Rust get basic structure-aware indexing.
- YAML/JSON/TOML get structure-aware document chunking and metadata only.

## Implementation Changes

### 1. Storage and runtime architecture

- Replace the current default storage backend with SQLite in WAL mode using local files.
- Use two SQLite databases:
  - Global registry DB at ~/.openez/registry.sqlite for workspace metadata and UI
    listing.
  - Per-workspace DB at <workspace>/.openez/index.sqlite for documents, chunks,
    graph, memories, query logs, and optional embeddings.
- Introduce a repository/data-access layer so core, indexer, mcp, and web stop importing
  Drizzle Postgres tables directly.
- Keep the schema conceptually similar to the current one, but adapt it to SQLite:
  - workspaces lives in the global registry DB.
  - documents, chunks, graph_nodes, graph_edges, memories, query_logs, index_runs live in
    the per-workspace DB.
- Remove Redis/BullMQ from the default indexing path. Web-triggered indexing should invoke
  the same direct indexer path as CLI.

### 2. Workspace and setup simplification

- Make DB the only source of truth for workspaces. brain.config.\* is no longer required for
  workspace registration.
- Reduce BrainConfig to optional global tuning only:
  - chunking defaults
  - retrieval defaults
  - embedding provider defaults
- Add brain init [path]:
  - resolve target path
  - validate it is a readable directory
  - infer workspace id from folder name, with collision-safe slugging
  - create registry row
  - create <workspace>/.openez/
  - write a minimal local manifest only if needed for internal bookkeeping, not as user-
    facing required config
  - optionally run initial index when --index is passed
- Change CLI resolution rules:
  - brain index [path] resolves by explicit path first, then current working directory
  - brain serve resolves current workspace from cwd unless --path is provided
  - remove the main-project default and deprecate --workspace
- Simplify web workspace creation:
  - form asks only for name and root path
  - include/exclude globs become advanced optional overrides, hidden by default
  - newly created workspaces are stored only in registry DB

### 3. File discovery defaults

- Replace required include/exclude authoring with built-in presets.
- Default discovery behavior:
  - if inside a git repo, respect .gitignore
  - always exclude common generated directories: node_modules, .git, .next, dist, build,
    coverage, .turbo, vendored caches
  - index supported source, docs, and config files by extension
- Default supported extensions in this round:
  - TS/JS: .ts, .tsx, .js, .jsx, .mjs, .cjs, .mts, .cts
  - Python: .py
  - Go: .go
  - Rust: .rs
  - YAML: .yaml, .yml
  - JSON: .json
  - TOML: .toml
  - Docs: .md, .mdx
- Preserve per-workspace override capability in the registry DB for advanced users, but keep
  defaults sufficient for normal use.

### 4. Language indexing strategy

- Keep TS/JS on the existing richer ts-morph path.
- Add a second indexing path for Python/Go/Rust using Tree-sitter parsers:
  - extract top-level symbols only
  - chunk by symbol boundary
  - record metadata: symbol name, symbol type, line range, exported/public when obvious
  - record import/module references only at a basic level
  - do not build deep call graphs in this round
- Add structure-aware config/document chunkers:
  - YAML: split by top-level mapping/list sections; include key-path metadata where cheap
  - JSON: chunk by top-level object keys / array sections; include path metadata
  - TOML: chunk by table/section; include section path metadata
- For Python/Go/Rust/YAML/JSON/TOML:
  - create document.language correctly
  - create chunks with stable hashes and line ranges
  - create file -> chunk graph nodes/edges
  - only create symbol graph nodes when top-level symbol extraction exists
- Retrieval behavior:
  - default retrieval becomes FTS + graph expansion
  - embeddings become optional, disabled by default for zero-config local use
  - if embeddings are configured later, store them in SQLite through a backend-specific
    adapter; this is not required for the first simplified setup experience

### 5. CLI, MCP, and web behavior

- CLI commands after refactor:
  - brain init [path]
  - brain index [path]
  - brain reindex [path] as explicit full rebuild alias
  - brain watch [path]
  - brain serve [path] or brain serve --mcp
  - brain status [path]
- MCP server should resolve workspace by path/cwd instead of requiring workspaceId from a
  config-defined registry.
- Update MCP tool inputs to accept either:
  - path
  - or an optional workspaceId for already-registered workspaces
- Web app changes:
  - dashboard lists registry workspaces from SQLite
  - “Index Workspace” calls direct indexing, no queue worker
  - keep existing query/inspection pages, but remove assumptions that config workspaces
    exist
  - if no workspace is registered, guide users to run brain init or create one from the UI

## Public Interfaces and Type Changes

- BrainConfig becomes optional global settings only; remove required workspaces array.
- Introduce WorkspaceConfig or WorkspaceSettings stored in registry DB:
  - id
  - name
  - rootPath
  - optional include/exclude overrides
  - timestamps/status fields
- Replace getWorkspaceConfig(workspaceId) with resolution APIs based on path/registry
  lookup.
- Update MCP and retrieval entrypoints so they no longer depend on config-file workspace
  existence.
- Deprecate worker/queue-specific public commands and docs from the default path.

## Test Plan

- CLI:
  - brain init creates registry entry and local workspace metadata correctly
  - repeated init is idempotent
  - index, reindex, and watch resolve workspace by path/cwd correctly
  - no command depends on brain.config.\*
- Storage:
  - per-workspace SQLite DB is created on first init/index
  - WAL mode is enabled
  - full rebuild clears and recreates per-workspace index data safely
- File discovery:
  - gitignored files are skipped
  - default excludes skip generated folders
  - supported extensions above are included by default
- Language indexing:
  - TS/JS behavior remains unchanged
  - Python: top-level def and class produce chunks with metadata
  - Go: top-level func, type, const, var produce chunks with metadata
    slices
- Retrieval:
  - FTS + graph still returns useful context with embeddings disabled
  - mixed-language workspace queries return chunks from Python/Go/Rust/config files
- Web:
  - workspace list renders from registry DB only
  - create workspace flow works without config file edits
  - index action works without Redis/worker
- Migration safety:
  - existing Postgres-specific code paths are either removed or isolated behind adapters
  - no runtime path still imports Postgres-only helpers after the refactor

## Assumptions and Defaults

- This round fully migrates to SQLite; Postgres/Redis are no longer the default local path.
- Embeddings are optional and off by default to keep setup minimal.
- TS/JS remains the only language with comparatively rich semantic graphing in this round.
- Python/Go/Rust support is intentionally “basic but structured,” not full call-graph
  parity.
- YAML/JSON/TOML are indexed for context retrieval, not semantic symbol analysis.
- Web remains available, but CLI is the primary workflow and receives the cleaner UX first.
