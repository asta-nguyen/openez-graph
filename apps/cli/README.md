# @openez-graph/cli

> Local-first code intelligence engine — index, query, and graph your codebase with zero config.

[![npm version](https://img.shields.io/npm/v/@openez-graph/cli.svg)](https://www.npmjs.com/package/@openez-graph/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

OpenEZ Graph indexes your codebase into a local SQLite database, builds a code graph (symbols, files, chunks, edges), and exposes it through MCP tools for AI coding agents like Claude Code, Codex, OpenCode, Windsurf, and Devin.

**Zero config. No Docker. No Postgres. No Redis. Just install and go.**

> **v1.0: Bun-powered, Rust-native parsing.** The CLI now runs exclusively on [Bun](https://bun.sh) 1.1+ with native `bun:sqlite` (no `better-sqlite3` compilation step). TS/JS parsing uses [oxc-parser](https://oxc.rs) (Rust-based, ~13x faster than Babel) instead of `ts-morph`. Python/Go/Rust/Ruby use tree-sitter (WASM) with regex fallback. Requires Bun 1.1+.

## Features

- **Bun-powered** — native `bun:sqlite` driver, no native compilation, near-instant startup
- **Rust-native parsing** — [oxc-parser](https://oxc.rs) for TS/JS (~13x faster than Babel), tree-sitter (WASM) for Python/Go/Rust/Ruby with regex fallback
- **Zero-config** — auto-registers workspace, auto-indexes; opt-in auto-sync via `OPENEZ_MCP_WATCH=1`
- **SQLite-first** — all data stored locally in `.openez/` per workspace, no Postgres/Redis
- **FTS5 full-text search** — SQLite FTS5 with BM25 ranking and porter tokenizer
- **Vector search** — optional OpenAI/Ollama/local embeddings with cosine similarity
- **MCP-first** — exposes `code_query`, `code_context`, `graph_neighbors`, `memory_recall`, `memory_write`, `index_workspace`, `list_workspaces` tools
- **Multi-workspace** — register and query across multiple codebases
- **Code graph** — symbols, files, chunks, and edges (calls, imports, contains)
- **Web dashboard** — built-in graph explorer and workspace management UI
- **Auto-sync** — file watcher re-indexes on changes (2s debounce)

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

# 3. Restart your agent — it will auto-index (auto-sync opt-in via OPENEZ_MCP_WATCH=1)
```

## Commands

```bash
openez init [path]              # register + index a workspace
openez index [path]             # incremental index
openez embed [path]             # create configured provider vectors
openez reindex [path]           # full rebuild (removes vectors; run embed after)
openez watch [path]             # watch + auto-reindex on changes
openez serve --mcp              # start MCP server (auto-index; auto-sync opt-in via OPENEZ_MCP_WATCH=1)
openez serve --web              # start web dashboard (default port 17881)
openez serve --web --port 8080  # start web dashboard on custom port
openez status [path]            # show workspace status
openez diff [ref]               # review git diff with affected AST symbols & callers (--staged, --json)
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

Valid config keys: `embedding.provider`, `embedding.openai_api_key`, `embedding.openai_base_url`, `embedding.openai_model`, `embedding.ollama_base_url`, `embedding.ollama_model`, `embedding.local_model`. API keys are encrypted at rest with AES-256-GCM.

## MCP Tools

| Tool              | Description                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| `list_workspaces` | List all registered workspaces                                                                      |
| `code_query`      | Hybrid FTS/vector search + graph expansion over indexed code and docs                               |
| `code_context`    | Get budgeted symbol context with callers, callees, and related files (limit: 50/workspace, max 200) |
| `diff_context`    | Analyze git diff changes and retrieve affected AST symbols & caller/callee dependencies             |
| `graph_neighbors` | Traverse graph edges from a node or label                                                           |
| `memory_recall`   | Recall active memory entries and technical decisions                                                |
| `memory_write`    | Write a memory entry (notes, decisions, patterns)                                                   |
| `index_workspace` | Trigger indexing for a workspace                                                                    |

`memory_query` is accepted as a deprecated compatibility alias for `code_query`, but is not advertised to new clients.

## How it works

1. **`openez setup <agent>`** writes MCP server config to the agent's config file (e.g. `~/.claude/settings.json`, `~/.codeium/windsurf/mcp_config.json`, `~/.config/devin/config.json`) and installs agent instructions (`AGENTS.md` or `CLAUDE.md`) in the project root. These instruction files tell the agent to prefer OpenEZ MCP tools over grep/ripgrep. They are safe to commit or gitignore — `openez setup` will update them idempotently if already present.
2. When Claude Code starts, it launches the MCP server via `openez serve --mcp`
3. The MCP server auto-registers the current project as a workspace
4. It auto-indexes if the workspace has no documents yet
5. Live file watching is opt-in via `OPENEZ_MCP_WATCH=1` (2s debounce); without it, read tools run throttled incremental catch-up before querying
6. All data is stored in `<project>/.openez/index.sqlite` — local, portable, gitignored

## Supported languages

| Language                                              | Parser                       | Indexing depth                                                                           |
| ----------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------- |
| TypeScript / JavaScript                               | [oxc-parser](https://oxc.rs) | Richest — symbol extraction, imports, calls (~13x faster than Babel)                     |
| Python                                                | tree-sitter (WASM)           | Symbol extraction, decorators, imports, calls                                            |
| Go                                                    | tree-sitter (WASM)           | Symbol extraction, receiver-qualified methods, calls                                     |
| Rust                                                  | tree-sitter (WASM)           | Symbol extraction, impl blocks, calls                                                    |
| Ruby                                                  | tree-sitter (WASM)           | Symbol extraction, `class << self` context, `self.foo` calls, `require_relative` imports |
| CoffeeScript / Slim / CSS / SCSS / SASS / LESS / Haml | Fallback parser              | Scanned and chunked (no symbol extraction)                                               |
| YAML / JSON / TOML                                    | Structure-aware              | Structure-aware chunking                                                                 |
| Markdown                                              | Section-oriented             | Section-oriented chunking                                                                |

## Retrieval quality

Measured on 2026-08-10 against the openez codebase (180 files, 979 chunks, 17 fixture-backed
queries):

| Metric      | FTS only |
| ----------- | -------: |
| Recall@5    |   76.47% |
| MRR         |   0.6564 |
| Avg latency |  12.1 ms |

FTS-only remains the default. Embedding comparison is opt-in and is not claimed by this baseline.

```bash
# Enable Ollama embeddings (bge-m3 recommended for code search)
openez config set embedding.provider ollama
openez config set embedding.ollama_model bge-m3
openez embed .
pnpm benchmark:retrieval:embeddings

# Or use the public pinned local code model
openez config set embedding.provider local
openez config set embedding.local_model jina-code-static-256
openez embed .
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
