# @openez-graph/cli

> Local-first code intelligence engine — index, query, and graph your codebase with zero config.

[![npm version](https://img.shields.io/npm/v/@openez-graph/cli.svg)](https://www.npmjs.com/package/@openez-graph/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

OpenEZ Graph indexes your codebase into a local SQLite database, builds a code graph (symbols, files, chunks, edges), and exposes it through MCP tools for AI coding agents like Claude Code, Codex, OpenCode, Windsurf, and Devin.

**Zero config. No Docker. No Postgres. No Redis. Just install and go.**

## Features

- **Zero-config** — auto-registers workspace, auto-indexes, auto-syncs on file changes
- **SQLite-first** — all data stored locally in `.openez/` per workspace, no Postgres/Redis
- **FTS5 full-text search** — SQLite FTS5 with BM25 ranking and porter tokenizer
- **Vector search** — optional OpenAI/Ollama embeddings with cosine similarity
- **MCP-first** — exposes `code_query`, `code_context`, `graph_neighbors`, `memory_recall`, `memory_write`, `index_workspace`, `list_workspaces` tools
- **Multi-workspace** — register and query across multiple codebases
- **Code graph** — symbols, files, chunks, and edges (calls, imports, contains)
- **Web dashboard** — built-in graph explorer and workspace management UI
- **Auto-sync** — file watcher re-indexes on changes (250ms debounce)

## Install

```bash
npm install -g @openez-graph/cli
openez setup claude    # or: codex, opencode, windsurf, devin
```

Or run without installing:

```bash
npx @openez-graph/cli setup claude    # or: codex, opencode, windsurf, devin
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
openez setup windsurf     # Windsurf / Devin Desktop
openez setup devin        # Devin CLI

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
openez setup windsurf           # wire up Windsurf / Devin Desktop
openez setup devin              # wire up Devin CLI
openez config get [key]         # show embedding config (all if no key)
openez config set <key> <value> # set embedding config value
openez config list              # list all DB-stored config overrides
```

Valid config keys: `embedding.provider`, `embedding.openai_api_key`, `embedding.openai_base_url`, `embedding.openai_model`, `embedding.ollama_base_url`, `embedding.ollama_model`. API keys are encrypted at rest with AES-256-GCM.

## MCP Tools

| Tool              | Description                                                           |
| ----------------- | --------------------------------------------------------------------- |
| `list_workspaces` | List all registered workspaces                                        |
| `code_query`      | Hybrid FTS/vector search + graph expansion over indexed code and docs |
| `code_context`    | Get budgeted symbol context with callers, callees, and related files  |
| `graph_neighbors` | Traverse graph edges from a node or label                             |
| `memory_recall`   | Recall active memory entries and technical decisions                  |
| `memory_write`    | Write a memory entry (notes, decisions, patterns)                     |
| `index_workspace` | Trigger indexing for a workspace                                      |

`memory_query` is accepted as a deprecated compatibility alias for `code_query`, but is not advertised to new clients.

## How it works

1. **`openez setup <agent>`** writes MCP server config to the agent's config file (e.g. `~/.claude/settings.json`, `~/.codeium/windsurf/mcp_config.json`, `~/.config/devin/config.json`)
2. When Claude Code starts, it launches the MCP server via `openez serve --mcp`
3. The MCP server auto-registers the current project as a workspace
4. It auto-indexes if the workspace has no documents yet
5. It watches for file changes and re-indexes automatically (250ms debounce)
6. All data is stored in `<project>/.openez/index.sqlite` — local, portable, gitignored

## Supported languages

| Language                | Indexing depth                                         |
| ----------------------- | ------------------------------------------------------ |
| TypeScript / JavaScript | Richest — `ts-morph` symbol extraction, imports, calls |
| Python                  | Basic top-level symbol extraction                      |
| Go                      | Basic top-level symbol extraction                      |
| Rust                    | Basic top-level symbol extraction                      |
| YAML / JSON / TOML      | Structure-aware chunking                               |
| Markdown                | Section-oriented chunking                              |

## Retrieval quality

Benchmarked on 23 queries (17 keyword + 6 semantic) against the openez codebase (128 files, 810 chunks):

| Metric           | FTS only | FTS + Embedding (bge-m3) |
| ---------------- | -------: | -----------------------: |
| Recall@5         |   91.30% |                   95.65% |
| Keyword queries  |  100.00% |                  100.00% |
| Semantic queries |   66.67% |                   83.33% |
| Avg latency      |     5 ms |                   249 ms |

**FTS-only is the default** — 100% recall on keyword queries, 50x faster. **Embedding adds semantic search with +16.67% semantic recall and no keyword regression** via full RRF fusion (FTS weight 2x, vector weight 1x).

```bash
# Enable Ollama embeddings (bge-m3 recommended for code search)
openez config set embedding.provider ollama
openez config set embedding.ollama_model bge-m3
openez reindex .
```

See [BENCHMARK.md](https://github.com/asta-nguyen/openez-graph/blob/main/BENCHMARK.md) for full analysis.

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

- [Bun](https://bun.sh) 1.1+ (single-binary install: `curl -fsSL https://bun.sh/install | bash`)
- No external services needed

## Changelog

See [CHANGELOG.md](https://github.com/asta-nguyen/openez-graph/blob/main/CHANGELOG.md) for release history.

## License

MIT © [Asta Nguyen](https://github.com/asta-nguyen)
