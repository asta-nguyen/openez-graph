# MCP Server Guide

This project exposes MCP tools over a local, workspace-aware runtime.

The current direction is SQLite-first and multi-workspace.

## Key Behavior

- MCP operates against indexed local workspaces
- tools accept `workspaceId` or `path`
- if only one workspace exists, MCP may use it as the default scope
- if multiple workspaces exist, MCP should require explicit scope

Recommended ambiguity error:

```txt
Multiple workspaces configured; workspaceId or path is required.
```

## Recommended Tool Surface

- `list_workspaces`
- `memory_query`
- `code_context`
- `graph_neighbors`
- `index_workspace`

Example query:

```json
{
  "workspaceId": "openez",
  "query": "how does indexing work?"
}
```

Example path-scoped query:

```json
{
  "path": "/Users/nus/projects/Asta/openez",
  "query": "how does indexing work?"
}
```

## Storage Assumptions

Default runtime storage:

- global registry DB in `~/.openez/`
- per-workspace DB in `<workspace-root>/.openez/`

Do not assume Postgres or Redis in the default path.

## Setup

Preferred flow:

```bash
pnpm openez init /path/to/project
pnpm openez index /path/to/project
pnpm openez serve --mcp
```

For a real ask-and-answer smoke test through Codex, see the `Codex MCP Smoke Test` section in [openez-wiki/concepts/getting-started.md](/Users/nus/projects/Asta/openez/openez-wiki/concepts/getting-started.md:1).

For Codex specifically:
- after editing `~/.codex/config.toml`, restart Codex or start a fresh session
- MCP tools are invoked through natural-language requests, not slash commands like `/list_workspaces`
- if Codex says the tool is not exposed and falls back to reading `~/.codex/config.toml`, the session did not attach the MCP server

The goal is to avoid:

- `docker compose`
- required `DATABASE_URL`
- required `REDIS_URL`
- mandatory `brain.config.*`
- mandatory `--workspace`

## Multi-Workspace Guidance

Use `workspaceId` as the canonical internal identifier because it is:

- more stable than a root path
- easier to display in UI
- easier to pass through MCP and CLI

`list_workspaces` should return:

- `id`
- `name`
- `rootPath`
- `status`
- `lastIndexedAt`

## Embeddings

Embeddings are optional and disabled by default.

Default retrieval path:

1. full-text search
2. graph expansion

If embeddings are configured later, they should enhance retrieval without changing the default operational model.

## Legacy Notes

Older repo material may still reference:

- Postgres
- `pgvector`
- Redis
- BullMQ
- `--workspace`
- `brain.config.mjs` as the workspace source of truth

Treat those references as stale unless explicitly marked as compatibility-only.
