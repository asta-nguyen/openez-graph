# @openez-graph/cli

Local-first code intelligence CLI. Zero-config. SQLite-only.

## Install

```bash
npm install -g @openez-graph/cli
openez setup claude    # or: codex, opencode
```

## Commands

```bash
openez init [path]           # register + index a workspace
openez index [path]          # incremental index
openez reindex [path]        # full rebuild
openez watch [path]          # watch + auto-reindex on changes
openez serve --mcp           # start MCP server (auto-index + auto-sync)
openez status [path]         # show workspace status
openez list                  # list registered workspaces
openez setup claude          # wire up Claude Code
openez setup codex           # wire up Codex
openez setup opencode        # wire up OpenCode
```

## Requirements

- Node.js 20+
- No Docker, Postgres, or Redis needed
