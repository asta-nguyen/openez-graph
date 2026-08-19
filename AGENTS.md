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

- global registry DB under `~/.openez/`
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
openez init [path]          register workspace and run initial index (--no-index to skip)
openez index [path]
openez reindex [path]
openez watch [path]
openez status [path]
openez list
openez remove [path]        remove workspace from registry and delete its .openez data dir (--id, -y; alias: rm)
openez serve --mcp
openez setup codex
```

Do not bias new work toward `--workspace`, `main-project`, or pinned single-workspace assumptions.

## MCP-First Workflow

For questions about a codebase that has been indexed:

1. Use MCP tools before reading files directly.
2. Start with `code_query` for broad code/documentation questions.
3. Use `code_outline` for a cheap AST-level outline of a single file (functions, classes, exports with line numbers) before reading the full file.
4. Use `code_context` for symbol- or file-specific follow-up.
5. Use `graph_neighbors` when relationship inspection is needed.
6. Use `memory_recall` for previously stored technical decisions and agent notes.
7. Only fall back to direct file reads when MCP results are insufficient or need verification.

When no explicit workspace scope is provided, MCP should default by reading `.openez/workspace.json` from the current project or one of its parent directories.

For cross-workspace questions, pass explicit multi-workspace scope:

- `workspaceIds`
- or `paths`

## Code Search Rules (MANDATORY)

These rules apply to ALL agents working in this repository. Violating them wastes tokens and context window.

### When to use OpenEZ MCP tools

- **ALWAYS** use `code_query` instead of `grep`/`ripgrep`/`find` when searching for code by concept, function name, or behavior. `code_query` returns ranked, token-budgeted chunks — not entire files.
- **ALWAYS** use `code_outline` before reading a full file when you only need its structure (functions, classes, methods, exports with line numbers).
- **ALWAYS** use `code_context` when you need to understand what calls/imports a specific symbol or file.
- **ALWAYS** use `memory_recall` at the start of a session to load prior architectural decisions.
- **ALWAYS** use `memory_write` when the user makes an architectural decision or you discover a non-obvious technical constraint.

### When NOT to use OpenEZ

- You know the **exact file path** and need to read/edit it — use `read_file` directly.
- The codebase has **not been indexed** (`openez index` not run) — `code_query` will return empty.
- You need to **modify** code, not search for it — OpenEZ is read-only retrieval.

### Token savings tracking

Every `code_query` call logs `tokens_returned`, `tokens_saved`, and `files_scanned` to the `query_logs` table. The dashboard at `/` shows aggregate token savings. Use this data to verify that OpenEZ is reducing context window usage.

### Setup

```bash
openez setup codex    # or claude, opencode, windsurf
```

This configures MCP server access. After setup, the agent automatically sees `code_query`, `code_outline`, `code_context`, `graph_neighbors`, `memory_write`, `memory_recall`, `index_workspace`, `remove_workspace`, and `list_workspaces` as available tools. `remove_workspace` is destructive (deletes the registry entry and `<root>/.openez/`) and requires `confirm: true`.

## MCP Expectations

MCP should be multi-workspace aware.

- `code_query`, `code_context`, `graph_neighbors`, and `memory_recall` should support one or many workspaces
- `memory_write`, `index_workspace`, and `remove_workspace` remain single-workspace operations
- `list_workspaces` should expose the registered workspace inventory
- `workspaceId` is the canonical internal key

## Indexing Expectations

- TS/JS: richest indexing path via oxc-parser (Rust-based, 13x faster than Babel). Extracts top-level functions, nested functions, class declarations, and class methods as first-class graph symbols.
- Python/Go/Rust/Ruby: tree-sitter AST symbol extraction with regex fallback. Ruby adds `class << self` context-only nesting, `self.foo` call qualification, and `require_relative`-only import edges.
- CoffeeScript/Slim/CSS/SCSS/SASS/LESS/Haml: scanner inclusion + fallback chunking only (no symbol extraction).
- YAML/JSON/TOML: structure-aware chunking
- Markdown: section-oriented chunking

Retrieval defaults to FTS + graph expansion. Embeddings are optional and should not be assumed to exist.

## Working Guidance

- Prefer changes that reinforce the engine/runtime/UI separation.
- Avoid introducing new hard dependencies on Postgres or Redis for the default path.
- Avoid assuming the web app is the center of the system.
- Prefer local-first, low-setup operational choices.
- When validating agent behavior, test MCP-first flows in a fresh session after `openez setup codex`.

## Release Workflow

When the user asks to "release", "publish", "deploy cli", or "bump version", follow this tight loop — every step has a checkable gate before moving on.

### 1. Determine the version bump

Read `apps/cli/package.json` for the current version. Classify changes since last release:

- **Patch**: UI fixes, doc updates, minor bug fixes, no new features.
- **Minor**: New features, significant fixes (security, data integrity), new routes/pages.
- **Major**: Breaking changes to CLI commands, MCP tool signatures, or DB schema.

Default to **minor** when multiple fixes ship together. Ask the user if unsure.

### 2. Bump version

Edit `apps/cli/package.json` — update the `"version"` field only.

### 3. Update CHANGELOG.md

Add a new `## [X.Y.Z] - YYYY-MM-DD` section at the top of `CHANGELOG.md` using [Keep a Changelog](https://keepachangelog.com/) groups:

- `### Added` — new features, routes, UI pages
- `### Changed` — changes to existing functionality
- `### Removed` — deleted features, removed endpoints
- `### Fixed` — bug fixes, security patches
- `### Security` — security-relevant fixes

Each entry is one bullet. Add a compare link at the bottom.

### 4. Build and verify

Run from monorepo root, in order:

```bash
pnpm build:web    # rebuild frontend (CLI bundles it)
pnpm build:cli    # build CLI with tsup
bun apps/cli/dist/cli.cjs --version   # must print the new version
bun apps/cli/dist/cli.cjs --help      # must list all commands
```

Then smoke test in a temp dir: `init` + `status` must succeed.

### 5. Publish to npm

```bash
cd apps/cli && npm publish --access public
```

If npm requires OTP (2FA), tell the user to run with `--otp=<6-digit-code>`.

### 6. Commit and push

```bash
git add apps/cli/package.json CHANGELOG.md
git commit -m "chore(cli): release v<VERSION>"
git push
```

### Pitfalls

- Always run `pnpm build:web` before `pnpm build:cli` — CLI bundles stale frontend otherwise.
- Check `--version` output before publishing — npm rejects re-publishing the same version.
- Always commit `package.json` and `CHANGELOG.md` together to avoid changelog drift.
