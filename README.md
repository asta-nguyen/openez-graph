# OpenEZ Graph

[![npm version](https://img.shields.io/npm/v/@openez-graph/cli?label=npm&logo=npm)](https://www.npmjs.com/package/@openez-graph/cli)
[![npm downloads](https://img.shields.io/npm/dm/@openez-graph/cli?label=downloads&logo=npm)](https://www.npmjs.com/package/@openez-graph/cli)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Website](https://img.shields.io/badge/website-openez.astalife.co-black)](https://openez.astalife.co)

Local-first code intelligence for coding agents. OpenEZ indexes code and documentation into SQLite, then exposes focused retrieval, graph context, and durable project memory through MCP.

[Website](https://openez.astalife.co) · [npm](https://www.npmjs.com/package/@openez-graph/cli) · [Contributing](CONTRIBUTING.md)

## Quick start

Requires Node.js 20 or newer.

```bash
npm install -g @openez-graph/cli
openez setup codex .
```

Replace `codex` with `claude`, `opencode`, `windsurf`, or `devin`. Restart the agent after setup.

Without a global install:

```bash
npx @openez-graph/cli setup codex .
```

The MCP runtime registers the current project, creates its first index when needed, and keeps the index synchronized as files change.

## Why OpenEZ

Coding agents repeatedly spend context reading the same files. OpenEZ creates a reusable local index so agents can retrieve relevant code and relationships without sending the whole codebase to an external database.

- Local SQLite storage in WAL mode
- Multi-workspace indexing and retrieval
- Full-text search with graph expansion and optional embedding reranking
- Persistent technical decisions through agent memory
- CLI, MCP, and management UI over the same runtime
- No Docker, Postgres, or Redis required

## MCP tools

| Tool | Purpose |
| --- | --- |
| `code_query` | Retrieve ranked code and documentation context |
| `code_context` | Get graph-adjacent context for a symbol or file |
| `graph_neighbors` | Inspect nearby graph nodes and edges |
| `list_workspaces` | List registered workspaces and index status |
| `memory_recall` | Recall stored technical decisions and notes |
| `memory_write` | Store a decision or learned constraint |
| `index_workspace` | Run an incremental or full index |

Read tools support one or many workspaces. Write and index operations remain scoped to one workspace.

## CLI

```bash
openez init [path]          # register and index a workspace
openez index [path]         # update changed files
openez reindex [path]       # rebuild the index
openez watch [path]         # keep an index synchronized
openez status [path]        # show workspace and graph counts
openez list                 # list registered workspaces
openez serve --mcp          # start the MCP server
openez serve --web          # start the management UI
openez setup <agent> [path] # configure an agent integration
```

Run `openez --help` or `openez <command> --help` for all options.

## Storage

OpenEZ uses three local artifacts:

```text
~/.openez/registry.sqlite       registered workspace metadata
<project>/.openez/index.sqlite  code, chunks, graph, memories, metrics
<project>/.openez/workspace.json workspace resolution hint
```

The project-local `.openez` directory is generated state and should not be committed.

## Supported content

- TypeScript and JavaScript: rich AST indexing with `ts-morph`
- Python, Go, and Rust: top-level symbol extraction
- YAML, JSON, and TOML: structure-aware chunks
- Markdown: section-oriented chunks

Embeddings are optional. The default retrieval path works with SQLite full-text search and graph expansion.

## Management UI

The web UI provides workspace status, query telemetry, document and memory inspection, benchmarks, and a graph explorer.

```bash
openez serve --web
```

![Workspace overview](assets/workspace.png)

![Graph explorer](assets/graph.png)

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm dev:web
```

The monorepo separates runtime surfaces under `apps/` from reusable packages under `packages/`:

```text
apps/       cli, mcp, web, worker
packages/   config, core, db, indexer, ui
landing/    product website
tests/      integration and retrieval tests
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## License

[MIT](LICENSE) © Asta Nguyen
