# @openez-graph/cli

> Local-first code intelligence engine — index, query, and graph your codebase with zero config.

[![npm version](https://img.shields.io/npm/v/@openez-graph/cli.svg)](https://www.npmjs.com/package/@openez-graph/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

OpenEZ Graph indexes your codebase into a local SQLite database, builds a code graph (symbols, files, chunks, edges), and exposes it through MCP tools for AI coding agents like Claude Code, Codex, and OpenCode.

**Zero config. No Docker. No Postgres. No Redis. Just install and go.**

## Features

- **Zero-config** — auto-registers workspace, auto-indexes, auto-syncs on file changes
- **SQLite-first** — all data stored locally in `.openez/` per workspace, no Postgres/Redis
- **FTS5 full-text search** — SQLite FTS5 with BM25 ranking and porter tokenizer
- **Vector search** — optional OpenAI/Ollama embeddings with cosine similarity
- **MCP-first** — exposes `memory_query`, `code_context`, `graph_neighbors`, `memory_write`, `index_workspace`, `list_workspaces` tools
- **Multi-workspace** — register and query across multiple codebases
- **Code graph** — symbols, files, chunks, and edges (calls, imports, contains)
- **Web dashboard** — built-in graph explorer and workspace management UI
- **Auto-sync** — file watcher re-indexes on changes (250ms debounce)

## Install

```bash
npm install -g @openez-graph/cli
openez setup claude    # or: codex, opencode
```

Or run without installing:

```bash
npx @openez-graph/cli setup claude
```

Restart your agent. Done.

## Quick start

```bash
# 1. Install
npm install -g @openez-graph/cli

# 2. Wire up your agent
openez setup claude       # Claude Code
openez setup codex        # Codex
openez setup opencode     # OpenCode

# 3. Restart your agent — it will auto-index and auto-sync
```

## Commands

```bash
openez init [path]              # register + index a workspace
openez index [path]             # incremental index
openez reindex [path]           # full rebuild
openez watch [path]             # watch + auto-reindex on changes
openez serve --mcp              # start MCP server (auto-index + auto-sync)
openez serve --web              # start web dashboard (default port 17881)
openez serve --web --port 8080  # start web dashboard on custom port
openez status [path]            # show workspace status
openez list                     # list registered workspaces
openez setup claude             # wire up Claude Code
openez setup codex              # wire up Codex
openez setup opencode           # wire up OpenCode
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `list_workspaces` | List all registered workspaces |
| `memory_query` | Full-text search + graph expansion for retrieval context |
| `code_context` | Get symbol context with callers, callees, and related files |
| `graph_neighbors` | Traverse graph edges from a node or label |
| `memory_write` | Write a memory entry (notes, decisions, patterns) |
| `index_workspace` | Trigger indexing for a workspace |

## How it works

1. **`openez setup claude`** writes MCP server config to `~/.claude/settings.json`
2. When Claude Code starts, it launches the MCP server via `openez serve --mcp`
3. The MCP server auto-registers the current project as a workspace
4. It auto-indexes if the workspace has no documents yet
5. It watches for file changes and re-indexes automatically (250ms debounce)
6. All data is stored in `<project>/.openez/index.sqlite` — local, portable, gitignored

## Supported languages

| Language | Indexing depth |
|----------|---------------|
| TypeScript / JavaScript | Richest — `ts-morph` symbol extraction, imports, calls |
| Python | Basic top-level symbol extraction |
| Go | Basic top-level symbol extraction |
| Rust | Basic top-level symbol extraction |
| YAML / JSON / TOML | Structure-aware chunking |
| Markdown | Section-oriented chunking |

## Retrieval quality

Benchmarked on 18 real queries against the openez codebase itself (118 files, 640 chunks):

| Metric | Value |
|--------|-------|
| Recall@5 | 94.44% |
| MRR | 0.6565 |
| Avg latency | 38.68 ms |
| p50 latency | 18.65 ms |
| Duplicate path rate | 0% |
| Quality gate | PASS |

FTS5 with BM25 ranking handles 94% of queries in under 40ms — no embeddings needed for the default path. Embeddings (OpenAI/Ollama) are optional semantic fallback for queries without direct keyword overlap.

## Web dashboard

```bash
openez serve --web
```

Opens a full web dashboard at `http://localhost:17881` with:
- Workspace overview (documents, chunks, nodes, edges)
- Graph explorer with force-directed layout
- Query interface for memory retrieval
- Indexing control and run history

## Requirements

- Node.js 20+
- No external services needed

## License

MIT © [Asta Nguyen](https://github.com/asta-nguyen)
