import fs from "node:fs";
import path from "node:path";

import chokidar from "chokidar";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { codeContext, graphNeighbors, memoryQuery, memoryWrite } from "@openez-graph/core";
import { createRegistryRepository, findLocalWorkspaceConfig } from "@openez-graph/db";
import { indexWorkspace } from "@openez-graph/indexer";

const memoryQuerySchema = z.object({
  workspaceIds: z.array(z.string()).optional(),
  workspaceId: z.string().optional(),
  paths: z.array(z.string()).optional(),
  path: z.string().optional(),
  query: z.string(),
  limit: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional()
});

const codeContextSchema = z.object({
  workspaceIds: z.array(z.string()).optional(),
  workspaceId: z.string().optional(),
  paths: z.array(z.string()).optional(),
  path: z.string().optional(),
  symbolOrPath: z.string(),
  hops: z.number().int().positive().optional()
});

const graphNeighborsSchema = z.object({
  workspaceIds: z.array(z.string()).optional(),
  workspaceId: z.string().optional(),
  paths: z.array(z.string()).optional(),
  path: z.string().optional(),
  nodeId: z.string().optional(),
  label: z.string().optional(),
  edgeTypes: z.array(z.string()).optional(),
  depth: z.number().int().positive().optional()
});

const memoryWriteSchema = z.object({
  workspaceId: z.string().optional(),
  path: z.string().optional(),
  title: z.string(),
  content: z.string(),
  tags: z.array(z.string()).optional(),
  supersedesId: z.string().optional()
});

const indexWorkspaceSchema = z.object({
  workspaceId: z.string().optional(),
  path: z.string().optional(),
  mode: z.enum(["incremental", "full"]).optional()
});

const MCP_CATCHUP_INTERVAL_MS = Number(process.env.OPENEZ_MCP_CATCHUP_INTERVAL_MS ?? 5000);
const catchupState = new Map<string, { lastRunAt: number; inFlight?: Promise<void> }>();

type WorkspaceLike = {
  id: string;
  name: string;
  rootPath: string;
};

function countDefinedScopes(input: {
  workspaceIds?: string[];
  workspaceId?: string;
  paths?: string[];
  path?: string;
}): number {
  let count = 0;
  if (input.workspaceIds && input.workspaceIds.length > 0) count += 1;
  if (input.workspaceId) count += 1;
  if (input.paths && input.paths.length > 0) count += 1;
  if (input.path) count += 1;
  return count;
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function createWorkspaceResolver(options?: { defaultPath?: string }) {
  const defaultPath = options?.defaultPath ? path.resolve(options.defaultPath) : undefined;

  async function resolveWorkspaceById(workspaceId: string): Promise<WorkspaceLike> {
    const registry = createRegistryRepository();
    const workspace = await registry.getWorkspace(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace '${workspaceId}' not found.`);
    }
    return workspace;
  }

  async function resolveWorkspaceByPath(searchPath: string): Promise<WorkspaceLike> {
    const registry = createRegistryRepository();
    const workspace = await registry.getWorkspaceByPath(path.resolve(searchPath));
    if (!workspace) {
      throw new Error(
        `No workspace registered at ${path.resolve(searchPath)}. ` +
        "Run 'openez init <path>' or pass a registered workspaceId."
      );
    }
    return workspace;
  }

  async function resolveDefaultWorkspace(): Promise<WorkspaceLike> {
    const registry = createRegistryRepository();
    const searchRoot = defaultPath ?? process.cwd();
    const localConfig = await findLocalWorkspaceConfig(searchRoot);

    if (localConfig) {
      const workspace = await registry.getWorkspace(localConfig.workspaceId);
      if (workspace) {
        return workspace;
      }
    }

    const byPath = await registry.getWorkspaceByPath(path.resolve(searchRoot));
    if (byPath) {
      return byPath;
    }

    const workspaces = await registry.listWorkspaces();
    if (workspaces.length === 1) return workspaces[0];

    if (workspaces.length === 0) {
      throw new Error("No workspace registered. Run 'openez init <path>' or pass 'workspaceId' or 'path'.");
    }

    throw new Error(
      `Multiple workspaces found. Specify 'workspaceId' or 'path' to disambiguate. Available: ${workspaces.map((w) => `'${w.id}'`).join(", ")}`
    );
  }

  return {
    async resolveReadWorkspaces(input: {
      workspaceIds?: string[];
      workspaceId?: string;
      paths?: string[];
      path?: string;
    }): Promise<WorkspaceLike[]> {
      if (countDefinedScopes(input) > 1) {
        throw new Error("Pass only one workspace selector type at a time: workspaceIds, workspaceId, paths, or path.");
      }

      if (input.workspaceIds && input.workspaceIds.length > 0) {
        return dedupeById(await Promise.all(input.workspaceIds.map((workspaceId) => resolveWorkspaceById(workspaceId))));
      }

      if (input.paths && input.paths.length > 0) {
        return dedupeById(await Promise.all(input.paths.map((workspacePath) => resolveWorkspaceByPath(workspacePath))));
      }

      if (input.workspaceId) {
        return [await resolveWorkspaceById(input.workspaceId)];
      }

      if (input.path) {
        return [await resolveWorkspaceByPath(input.path)];
      }

      return [await resolveDefaultWorkspace()];
    },

    async resolveWriteWorkspace(input: { workspaceId?: string; path?: string }): Promise<WorkspaceLike> {
      if (input.workspaceId && input.path) {
        throw new Error("Pass either workspaceId or path, not both.");
      }
      if (input.workspaceId) return resolveWorkspaceById(input.workspaceId);
      if (input.path) return resolveWorkspaceByPath(input.path);
      return resolveDefaultWorkspace();
    }
  };
}

function jsonResponse(result: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(result, null, 2)
      }
    ]
  };
}

async function catchUpWorkspaceIndex(workspaceId: string): Promise<void> {
  const now = Date.now();
  const current = catchupState.get(workspaceId);

  if (current?.inFlight) {
    await current.inFlight;
    return;
  }

  if (current && now - current.lastRunAt < MCP_CATCHUP_INTERVAL_MS) {
    return;
  }

  const inFlight = indexWorkspace({ workspaceId, mode: "incremental" })
    .then(() => undefined)
    .catch((error) => {
      console.error(`OpenEZ MCP catch-up indexing failed: ${error instanceof Error ? error.message : String(error)}`);
    })
    .finally(() => {
      catchupState.set(workspaceId, { lastRunAt: Date.now() });
    });

  catchupState.set(workspaceId, { lastRunAt: current?.lastRunAt ?? 0, inFlight });
  await inFlight;
}

async function catchUpReadWorkspaces(workspaces: WorkspaceLike[]): Promise<void> {
  await Promise.all(workspaces.map((workspace) => catchUpWorkspaceIndex(workspace.id)));
}

export async function createAndStartMcpServer(options?: { defaultPath?: string }) {
  const resolver = createWorkspaceResolver(options);

  const server = new Server(
    {
      name: "openez-graph",
      version: "0.2.0"
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "list_workspaces",
        description: "List registered workspaces and their current status.",
        inputSchema: {
          type: "object",
          properties: {},
          required: []
        }
      },
      {
        name: "memory_query",
        description: "Retrieve ranked code and documentation context for a user query. Supports one or many workspaces.",
        inputSchema: {
          type: "object",
          properties: {
            workspaceIds: { type: "array", items: { type: "string" }, description: "IDs of registered workspaces" },
            workspaceId: { type: "string", description: "ID of a registered workspace" },
            paths: { type: "array", items: { type: "string" }, description: "Filesystem paths to registered workspaces" },
            path: { type: "string", description: "Filesystem path to a registered workspace" },
            query: { type: "string" },
            limit: { type: "number" },
            maxTokens: { type: "number" }
          },
          required: ["query"]
        }
      },
      {
        name: "code_context",
        description: "Fetch graph-adjacent context for a symbol or file path. Supports one or many workspaces.",
        inputSchema: {
          type: "object",
          properties: {
          workspaceIds: { type: "array", items: { type: "string" } },
          workspaceId: { type: "string" },
          paths: { type: "array", items: { type: "string" } },
          path: { type: "string" },
          symbolOrPath: { type: "string" },
          hops: { type: "number" }
          },
          required: ["symbolOrPath"]
        }
      },
      {
        name: "graph_neighbors",
        description: "Inspect raw graph nodes and edges around a label or node id. Supports one or many workspaces.",
        inputSchema: {
          type: "object",
          properties: {
          workspaceIds: { type: "array", items: { type: "string" } },
          workspaceId: { type: "string" },
          paths: { type: "array", items: { type: "string" } },
          path: { type: "string" },
          nodeId: { type: "string" },
          label: { type: "string" },
          edgeTypes: { type: "array", items: { type: "string" } },
          depth: { type: "number" }
          },
          required: []
        }
      },
      {
        name: "memory_write",
        description: "Persist a technical decision or learned memory into the memory store.",
        inputSchema: {
          type: "object",
          properties: {
          workspaceId: { type: "string" },
          path: { type: "string" },
          title: { type: "string" },
          content: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          supersedesId: { type: "string" }
          },
          required: ["title", "content"]
        }
      },
      {
        name: "index_workspace",
        description: "Run indexing for a workspace.",
        inputSchema: {
          type: "object",
          properties: { workspaceId: { type: "string" }, path: { type: "string" }, mode: { type: "string", enum: ["incremental", "full"] } },
          required: []
        }
      }
    ]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
    switch (request.params.name) {
      case "list_workspaces": {
        const registry = createRegistryRepository();
        return jsonResponse(await registry.listWorkspaces());
      }
      case "memory_query": {
        const input = memoryQuerySchema.parse(request.params.arguments ?? {});
        const workspaces = await resolver.resolveReadWorkspaces(input);
        await catchUpReadWorkspaces(workspaces);
        const results = await Promise.all(
          workspaces.map(async (workspace) => ({
            workspace,
            result: await memoryQuery({
              workspaceId: workspace.id,
              query: input.query,
              limit: input.limit,
              maxTokens: input.maxTokens
            })
          }))
        );

        const mergedSources = results
          .flatMap(({ workspace, result }) =>
            result.sources.map((source) => ({
              ...source,
              workspaceId: workspace.id,
              workspaceName: workspace.name,
              rootPath: workspace.rootPath
            }))
          )
          .sort((left, right) => right.score - left.score);

        const answerContext = results.length === 1
          ? results[0].result.answerContext
          : results
              .map(({ workspace, result }) => `## Workspace: ${workspace.name} (${workspace.id})\n${result.answerContext}`)
              .join("\n\n");

        return jsonResponse({
          answerContext,
          sources: mergedSources,
          workspaces: results.map(({ workspace }) => ({
            workspaceId: workspace.id,
            workspaceName: workspace.name,
            rootPath: workspace.rootPath
          }))
        });
      }
      case "code_context": {
        const input = codeContextSchema.parse(request.params.arguments ?? {});
        const workspaces = await resolver.resolveReadWorkspaces(input);
        await catchUpReadWorkspaces(workspaces);
        const results = await Promise.all(
          workspaces.map(async (workspace) => ({
            workspaceId: workspace.id,
            workspaceName: workspace.name,
            rootPath: workspace.rootPath,
            result: await codeContext({
              workspaceId: workspace.id,
              symbolOrPath: input.symbolOrPath,
              hops: input.hops
            })
          }))
        );
        return jsonResponse({ results });
      }
      case "graph_neighbors": {
        const input = graphNeighborsSchema.parse(request.params.arguments ?? {});
        const workspaces = await resolver.resolveReadWorkspaces(input);
        await catchUpReadWorkspaces(workspaces);
        const results = await Promise.all(
          workspaces.map(async (workspace) => ({
            workspaceId: workspace.id,
            workspaceName: workspace.name,
            rootPath: workspace.rootPath,
            result: await graphNeighbors({
              workspaceId: workspace.id,
              nodeId: input.nodeId,
              label: input.label,
              edgeTypes: input.edgeTypes,
              depth: input.depth
            })
          }))
        );
        return jsonResponse({ results });
      }
      case "memory_write": {
        const input = memoryWriteSchema.parse(request.params.arguments ?? {});
        const workspace = await resolver.resolveWriteWorkspace(input);
        return jsonResponse(await memoryWrite({ ...input, workspaceId: workspace.id }));
      }
      case "index_workspace": {
        const input = indexWorkspaceSchema.parse(request.params.arguments ?? {});
        const workspace = await resolver.resolveWriteWorkspace(input);
        const summary = await indexWorkspace({ workspaceId: workspace.id, mode: input.mode });
        return jsonResponse(summary);
      }
      default:
        throw new Error(`Unknown tool: ${request.params.name}`);
    }
  });

  // ── Auto-index + optional auto-sync watcher ──
  const searchRoot = options?.defaultPath ?? process.cwd();
  await autoIndexAndSync(searchRoot);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const WATCH_DEBOUNCE_MS = 2000;
const WATCH_ENABLED = ["1", "true", "yes"].includes((process.env.OPENEZ_MCP_WATCH ?? "").toLowerCase());
const WATCH_IGNORE_PATTERNS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.next/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.turbo/**",
  "**/.openez/**"
];

async function autoIndexAndSync(searchRoot: string): Promise<void> {
  const resolvedRoot = path.resolve(searchRoot);

  if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) {
    return;
  }

  const registry = createRegistryRepository();

  // Auto-register workspace if not yet registered
  let workspace = await registry.getWorkspaceByPath(resolvedRoot);
  if (!workspace) {
    const localConfig = await findLocalWorkspaceConfig(resolvedRoot);
    if (localConfig) {
      workspace = await registry.getWorkspace(localConfig.workspaceId);
    }
  }

  if (!workspace) {
    return;
  }

  // Auto-index if workspace has no documents yet
  if (workspace.indexingStatus === "pending" || workspace.documentCount === 0) {
    try {
      await indexWorkspace({ workspaceId: workspace.id, mode: "incremental" });
    } catch {
      // Indexing failure is non-fatal — MCP server still starts
    }
  }

  // The stdio MCP server must stay cheap to start and robust on large repos.
  // Read tools run throttled incremental catch-up before querying; live watch is opt-in.
  if (!WATCH_ENABLED) {
    return;
  }

  // Start file watcher for opt-in auto-sync.
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const watcher = chokidar.watch(resolvedRoot, {
    ignored: WATCH_IGNORE_PATTERNS,
    ignoreInitial: true,
    persistent: true
  });

  const triggerReindex = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      try {
        await indexWorkspace({ workspaceId: workspace!.id, mode: "incremental" });
      } catch {
        // Silent failure — watcher keeps running
      }
    }, WATCH_DEBOUNCE_MS);
  };

  watcher.on("add", triggerReindex);
  watcher.on("change", triggerReindex);
  watcher.on("unlink", triggerReindex);
  watcher.on("error", (error) => {
    console.error(`OpenEZ MCP auto-sync watcher disabled: ${error instanceof Error ? error.message : String(error)}`);
    void watcher.close();
  });
}
