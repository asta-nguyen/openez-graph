---
title: OpenEZ Graph Getting Started Guide
type: concept
status: active
created: 2026-05-24
updated: 2026-05-24
tags:
  - guide
  - getting-started
  - mcp
  - cli
---

# OpenEZ Graph Getting Started Guide

End-to-end walkthrough: init a project, check status, connect MCP, and verify the connection works.

---

## 1. Init a Project

Register an existing project on your machine with OpenEZ Graph:

```bash
# Move into the project directory, or use an absolute path
cd /path/to/your/project

# Init workspace (registers into the global registry)
pnpm openez init /path/to/your/project
```

### Init with Immediate Indexing

```bash
pnpm openez init /path/to/your/project --index
```

This command will:
- Create a workspace entry in the global registry database at `~/.openez/registry.sqlite`
- If `--index` is used, run indexing immediately after init

> **Requirement**: The project must already exist on disk. OpenEZ Graph does not create new projects — it indexes existing codebases.

---

## 2. Check Init Status

### Using the CLI

```bash
# Show status for a specific path
pnpm openez status /path/to/your/project

# List all registered workspaces
pnpm openez list
```

Output of `openez status` looks like:

```
Workspace:    openez
ID:           openez
Path:         /Users/nus/projects/Asta/openez
Status:       indexed
Indexing:     indexed
Documents:    142
Chunks:       1,847
Nodes:        3,211
Edges:        8,944
Last Indexed: 2026-05-24T07:00:00.000Z
```

Key status values:
- `pending` — initialized but never indexed
- `indexing` — currently being indexed
- `indexed` — indexing completed successfully
- `error` — an error occurred (check `lastError` for details)

If the project has not been initialized, `openez status` will report that no workspace was found and may auto-register one.

### Using the Web UI

Open `http://localhost:3003/workspaces` to see the list of workspaces and their status.

---

## 3. Connect MCP

### Step 1: Start the MCP Server

The MCP server runs over stdio transport. There are three ways to start it:

```bash
# Option 1: Using the pnpm script (recommended)
pnpm mcp

# Option 2: Using the openez CLI
pnpm openez serve --mcp

# Option 3: Run both web UI and MCP concurrently
pnpm start
```

When the MCP server starts successfully, it **outputs nothing to stdout** — this is normal stdio MCP protocol behavior.

### Step 2: Configure Your Editor/Agent

#### Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "openez-graph": {
      "command": "pnpm",
      "args": ["--dir", "/path/to/openez", "mcp"]
    }
  }
}
```

#### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "openez-graph": {
      "command": "pnpm",
      "args": ["--dir", "/path/to/openez", "mcp"]
    }
  }
}
```

#### Cline / VS Code

Add to your Cline MCP config or VS Code settings:

```json
{
  "mcpServers": {
    "openez-graph": {
      "command": "pnpm",
      "args": ["--dir", "/path/to/openez", "mcp"]
    }
  }
}
```

> **Note**: Replace `/path/to/openez` with the absolute path to the OpenEZ Graph project directory (where `package.json` lives).

---

## 4. Verify MCP Connection

For Codex specifically, editing `~/.codex/config.toml` is not enough by itself. After adding or changing the MCP server entry, fully restart Codex or open a brand-new session in the trusted project. A session that started before the MCP server was attached will not see the new tools.

### Method 1: Observe the Editor/Client

When the MCP connection is successful:

- **Claude Desktop**: A hammer icon 🔨 appears in the bottom corner, indicating tools are ready
- **Claude Code**: The `--mcp` flag automatically detects MCP servers from settings
- **Cline**: Connected tools appear in the MCP panel

### Method 2: Use MCP Inspector (debugging)

```bash
npx @modelcontextprotocol/inspector pnpm --dir /path/to/openez mcp
```

Open your browser at `http://localhost:5173` and check:
- `List Tools` — should return 6 available tools
- `List Resources` — check available resources
- Try calling the `list_workspaces` tool

### Method 3: Call a Tool to Verify

After connecting, try using the `list_workspaces` tool:

```
Use the MCP tool `list_workspaces` and show me the registered workspaces.
```

If the connection is successful, you will see the list of registered workspaces (or an empty array if none exist).

Do not type `/list_workspaces`. MCP tools are not slash commands in Codex. If you use `/list_workspaces`, Codex will correctly report that the slash command does not exist.

### Available Tools After Successful Connection

| Tool | Description |
|------|-------------|
| `list_workspaces` | List all registered workspaces |
| `memory_query` | Retrieve code context using FTS + graph expansion |
| `code_context` | Fetch graph-adjacent context for a symbol or file |
| `graph_neighbors` | Inspect graph nodes and edges |
| `memory_write` | Persist a technical decision or learned memory |
| `index_workspace` | Trigger indexing for a workspace |

---

## 5. Codex MCP Smoke Test

This is the fastest real check that OpenEZ Graph can answer questions about an indexed workspace through MCP.

### Preconditions

- The workspace has been initialized and indexed:

```bash
pnpm openez init /Users/nus/projects/Asta/openez
pnpm openez index /Users/nus/projects/Asta/openez
pnpm openez status /Users/nus/projects/Asta/openez
```

- Codex is configured to start the MCP server:

```toml
[mcp_servers.ai_memory_graph]
command = "pnpm"
args = ["--dir", "/Users/nus/projects/Asta/openez", "mcp"]
startup_timeout_sec = 120
```

The key under `[mcp_servers.*]` is just a local label. It does not change the MCP tool names. The important part is the command and args.

### Step 1: Discover the Workspace

Call:

```text
Use the MCP tool `list_workspaces` and show me the registered workspaces.
```

Success criteria:
- the tool call succeeds
- the response includes workspace `openez`
- the workspace has a sane root path and non-error status

Fail criteria:
- Codex says the tool is not exposed in the available toolset
- Codex falls back to reading `~/.codex/config.toml`
- Codex returns trusted project entries from local config instead of MCP workspace results

If multiple workspaces exist, use `workspaceId: "openez"` explicitly in all later calls.

### Step 2: Ask Real Questions with `memory_query`

Use `memory_query` as the main ask-and-answer tool. It currently returns retrieval context, not a polished prose answer from the server itself.

Expected response shape:
- `answerContext`
- `sources[]`
  - `path`
  - `startLine`
  - `endLine`
  - `score`
  - `reason`

#### Question 1: How indexing works

```json
{
  "workspaceId": "openez",
  "query": "how does indexing work?"
}
```

Minimum expected result:
- `answerContext` is non-empty
- `sources` is non-empty
- at least one source points to indexing implementation, typically `packages/indexer/src/index-workspace.ts`

#### Question 2: How memory_query works

```json
{
  "workspaceId": "openez",
  "query": "how does memory_query work?"
}
```

Minimum expected result:
- `answerContext` is non-empty
- `sources` includes `packages/core/src/retrieval.ts`

#### Question 3: Where the MCP server is implemented

```json
{
  "workspaceId": "openez",
  "query": "where is the MCP server implemented?"
}
```

Minimum expected result:
- `answerContext` is non-empty
- `sources` includes `apps/cli/src/mcp-bridge.ts` or `apps/mcp/src/server.ts`

### Step 3: Judge the Result Quality

Treat the smoke test as passing when:
- MCP resolves the workspace without ambiguity errors
- each question returns non-empty `answerContext`
- each question returns relevant file paths in `sources`

Treat the result as weak when:
- `sources` is empty
- only unrelated markdown/config files appear
- obvious implementation files are missing for the question being asked

### Step 4: Debug a Weak Answer

If `list_workspaces` fails:
- verify the Codex MCP config path and command
- verify `pnpm mcp` starts
- verify `pnpm openez list` returns the workspace
- fully restart Codex or open a fresh session after editing `~/.codex/config.toml`
- rerun a natural-language MCP prompt, not a slash command
- if Codex answers by listing trusted projects from `~/.codex/config.toml`, treat that as a failed MCP attachment, not a successful tool call

If `memory_query` is weak or empty:

```bash
pnpm openez index /Users/nus/projects/Asta/openez
pnpm openez status /Users/nus/projects/Asta/openez
```

Then rerun the same question.

If the answer is still weak, use a narrower inspection tool:

`code_context` for a known symbol or file path:

```json
{
  "workspaceId": "openez",
  "symbolOrPath": "indexWorkspace"
}
```

`graph_neighbors` for a known label:

```json
{
  "workspaceId": "openez",
  "label": "indexWorkspace",
  "depth": 1
}
```

Use these tools for debugging retrieval quality, not as the primary ask-and-answer path.

### Signs of a Failed Connection

- **`command not found: pnpm`** — pnpm is not installed
- **`Cannot find module`** — `pnpm install` has not been run in the openez directory
- **Timeout** — wrong path in `args`, or the MCP server was not started correctly
- **No tools visible** — the client has not read the MCP configuration; check the settings file location and format
