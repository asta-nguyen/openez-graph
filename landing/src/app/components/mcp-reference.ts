// Single source for the MCP tool list shown on the landing page and on /docs/mcp.
// Plain data only (no imports) so scripts/check-mcp-tools.mjs can load it and compare tool names
// with the ones registered in apps/mcp/src/mcp-core.ts. Parameters come from that file's inputSchema.

export interface ToolParam {
  name: string;
  type: string;
  required?: boolean;
  desc: string;
}

export interface McpTool {
  name: string;
  /** one line, used as the chip tooltip */
  desc: string;
  summary: string;
  when: string;
  /** read: one or many workspaces · single: one workspace · none: no workspace */
  scope: "read" | "single" | "none";
  /** parameters beyond the workspace scope ones */
  params: ToolParam[];
  needsConfirm?: boolean;
}

export interface McpToolGroup {
  label: "Retrieval" | "Memory" | "Workspaces";
  color: string;
  blurb: string;
  tools: McpTool[];
}

const maxTokens: ToolParam = {
  name: "maxTokens",
  type: "number",
  desc: "Token budget for the whole serialized response, 32 to 100,000.",
};

export const mcpReferenceGroups: McpToolGroup[] = [
  {
    label: "Retrieval",
    color: "#4cc9f0",
    blurb: "Find and understand code without reading whole files.",
    tools: [
      {
        name: "code_query",
        desc: "Ranked code and docs",
        summary:
          "Ranked code and documentation chunks for a question or a few keywords. Full-text search with graph expansion (and optional embedding reranking), returned inside a token budget.",
        when: "you need to find where something lives or how it works, before opening any file.",
        scope: "read",
        params: [
          {
            name: "query",
            type: "string",
            required: true,
            desc: "Question or keywords to search for.",
          },
          { name: "limit", type: "integer", desc: "Maximum number of results, up to 100." },
          {
            ...maxTokens,
            desc: "Token budget for the whole response across all selected workspaces, 32 to 100,000 (default 4,000).",
          },
        ],
      },
      {
        name: "code_outline",
        desc: "AST outline of a file",
        summary:
          "The AST outline of one file: functions, classes, and exported symbols with line numbers.",
        when: "you only need a file's structure. It costs a fraction of reading the file (about 50 tokens against 3,000 in the tool's own description).",
        scope: "single",
        params: [
          {
            name: "path",
            type: "string",
            required: true,
            desc: "Relative or absolute path to the file inside the workspace.",
          },
        ],
      },
      {
        name: "code_context",
        desc: "Graph context for a symbol",
        summary:
          "Graph-adjacent context for a symbol or a file: the code that calls it, imports it, or sits next to it in the graph.",
        when: "you are about to change a symbol or file and need to know what depends on it.",
        scope: "read",
        params: [
          {
            name: "symbolOrPath",
            type: "string",
            required: true,
            desc: "A symbol name or a file path.",
          },
          { name: "hops", type: "integer", desc: "How far to follow the graph, 1 to 5." },
          {
            name: "limit",
            type: "integer",
            desc: "Maximum records per workspace (default 50, up to 200).",
          },
          maxTokens,
        ],
      },
      {
        name: "graph_neighbors",
        desc: "Nodes and edges around it",
        summary:
          "The raw graph nodes and edges around a label or a node id, with their relationship types such as imports, calls, and defines.",
        when: "you want to inspect relationships directly instead of reading ranked text.",
        scope: "read",
        params: [
          { name: "nodeId", type: "string", desc: "Start from this node id…" },
          { name: "label", type: "string", desc: "…or from the node with this label." },
          { name: "edgeTypes", type: "string[]", desc: "Only follow these edge types." },
          { name: "depth", type: "integer", desc: "Traversal depth, 1 to 5." },
          {
            name: "limit",
            type: "integer",
            desc: "Maximum nodes and edges per workspace, up to 200.",
          },
          maxTokens,
        ],
      },
      {
        name: "diff_context",
        desc: "Impact of a git diff",
        summary:
          "Analyzes a git diff and returns the affected AST symbols with their callers and callees. By default it covers tracked staged and unstaged changes; untracked files are not included.",
        when: "you are reviewing a change and want to know what it touches.",
        scope: "read",
        params: [
          {
            name: "ref",
            type: "string",
            desc: "Git ref or commit range, for example HEAD~1, main, or origin/main.",
          },
          { name: "staged", type: "boolean", desc: "Analyze only staged changes." },
          {
            name: "limit",
            type: "integer",
            desc: "Maximum callers per symbol, up to 50 (default 5).",
          },
          {
            ...maxTokens,
            desc: "Token budget, 32 to 100,000. The formatted summary is dropped before structured symbols and files.",
          },
        ],
      },
    ],
  },
  {
    label: "Memory",
    color: "#c084fc",
    blurb: "Decisions that outlive a single session.",
    tools: [
      {
        name: "memory_recall",
        desc: "Recall project decisions",
        summary: "Active technical decisions and learned memories stored for the project.",
        when: "you start work in a new session. Query with one to three keywords from the task.",
        scope: "read",
        params: [
          { name: "query", type: "string", required: true, desc: "One to three task keywords." },
          { name: "limit", type: "integer", desc: "Maximum number of memories, up to 100." },
          maxTokens,
        ],
      },
      {
        name: "memory_write",
        desc: "Store a decision",
        summary:
          "Persists a technical decision or a learned constraint so later sessions can recall it.",
        when: "an architectural decision or a non-obvious constraint has been confirmed.",
        scope: "single",
        params: [
          { name: "title", type: "string", required: true, desc: "Short title." },
          { name: "content", type: "string", required: true, desc: "The decision or constraint." },
          { name: "tags", type: "string[]", desc: "Tags to recall it by." },
          {
            name: "supersedesId",
            type: "string",
            desc: "Id of an earlier memory this one replaces.",
          },
        ],
      },
    ],
  },
  {
    label: "Workspaces",
    color: "#fbbf24",
    blurb: "See, refresh, and remove what is indexed.",
    tools: [
      {
        name: "list_workspaces",
        desc: "Registered workspaces",
        summary: "The registered workspaces and their current status.",
        when: "you need a workspace id or path to scope another call.",
        scope: "none",
        params: [],
      },
      {
        name: "index_workspace",
        desc: "Index or refresh",
        summary:
          "Runs indexing for a workspace. The MCP runtime already registers and indexes a project and keeps it current as files change; use this to refresh or rebuild on demand.",
        when: "an index looks stale or you want a full rebuild.",
        scope: "single",
        params: [
          {
            name: "mode",
            type: "incremental | full",
            desc: "Incremental updates changed files; full rebuilds the index.",
          },
        ],
      },
      {
        name: "remove_workspace",
        desc: "Delete a workspace",
        summary:
          "Removes a workspace from the registry and deletes its .openez data directory. This is destructive and cannot be undone.",
        when: "the user has explicitly approved it. Never call it on your own initiative.",
        scope: "single",
        needsConfirm: true,
        params: [
          {
            name: "confirm",
            type: "boolean",
            required: true,
            desc: "Must be true. Without it the call returns an error and removes nothing.",
          },
          {
            name: "workspaceId or path",
            type: "string",
            required: true,
            desc: "Pass exactly one. It never falls back to the current project.",
          },
        ],
      },
    ],
  },
];
