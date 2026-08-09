import fs from "node:fs";
import path from "node:path";

import chokidar from "chokidar";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  codeContext,
  codeQuery,
  countTokens,
  graphNeighbors,
  memoryRecall,
  memoryWrite,
  truncateToTokenLimit,
} from "@openez-graph/core";
import {
  createRegistryRepository,
  createWorkspaceRepository,
  findLocalWorkspaceConfig,
  removeWorkspace,
} from "@openez-graph/db";
import { ensureGraphReady, indexWorkspace, waitForFts } from "@openez-graph/indexer";

const MIN_RESPONSE_TOKENS = 32;

const codeQuerySchema = z.object({
  workspaceIds: z.array(z.string()).optional(),
  workspaceId: z.string().optional(),
  paths: z.array(z.string()).optional(),
  path: z.string().optional(),
  query: z.string().trim().min(1),
  limit: z.number().int().positive().max(100).optional(),
  maxTokens: z.number().int().min(MIN_RESPONSE_TOKENS).max(100_000).optional(),
});

const codeContextSchema = z.object({
  workspaceIds: z.array(z.string()).optional(),
  workspaceId: z.string().optional(),
  paths: z.array(z.string()).optional(),
  path: z.string().optional(),
  symbolOrPath: z.string(),
  hops: z.number().int().positive().max(5).optional(),
  limit: z.number().int().positive().max(200).optional(),
  maxTokens: z.number().int().min(MIN_RESPONSE_TOKENS).max(100_000).optional(),
});

const graphNeighborsSchema = z.object({
  workspaceIds: z.array(z.string()).optional(),
  workspaceId: z.string().optional(),
  paths: z.array(z.string()).optional(),
  path: z.string().optional(),
  nodeId: z.string().optional(),
  label: z.string().optional(),
  edgeTypes: z.array(z.string()).optional(),
  depth: z.number().int().positive().max(5).optional(),
  limit: z.number().int().positive().max(200).optional(),
  maxTokens: z.number().int().min(MIN_RESPONSE_TOKENS).max(100_000).optional(),
});

const memoryWriteSchema = z.object({
  workspaceId: z.string().optional(),
  path: z.string().optional(),
  title: z.string().trim().min(1),
  content: z.string().trim().min(1),
  tags: z.array(z.string()).optional(),
  supersedesId: z.string().optional(),
});

const memoryRecallSchema = z.object({
  workspaceIds: z.array(z.string()).optional(),
  workspaceId: z.string().optional(),
  paths: z.array(z.string()).optional(),
  path: z.string().optional(),
  query: z.string().trim().min(1),
  limit: z.number().int().positive().max(100).optional(),
  maxTokens: z.number().int().min(MIN_RESPONSE_TOKENS).max(100_000).optional(),
});

const indexWorkspaceSchema = z.object({
  workspaceId: z.string().optional(),
  path: z.string().optional(),
  mode: z.enum(["incremental", "full"]).optional(),
});

const removeWorkspaceSchema = z.object({
  workspaceId: z.string().optional(),
  path: z.string().optional(),
  confirm: z.boolean().optional(),
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
          "Run 'openez init <path>' or pass a registered workspaceId.",
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
      throw new Error(
        "No workspace registered. Run 'openez init <path>' or pass 'workspaceId' or 'path'.",
      );
    }

    throw new Error(
      `Multiple workspaces found. Specify 'workspaceId' or 'path' to disambiguate. Available: ${workspaces.map((w) => `'${w.id}'`).join(", ")}`,
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
        throw new Error(
          "Pass only one workspace selector type at a time: workspaceIds, workspaceId, paths, or path.",
        );
      }

      if (input.workspaceIds && input.workspaceIds.length > 0) {
        return dedupeById(
          await Promise.all(
            input.workspaceIds.map((workspaceId) => resolveWorkspaceById(workspaceId)),
          ),
        );
      }

      if (input.paths && input.paths.length > 0) {
        return dedupeById(
          await Promise.all(
            input.paths.map((workspacePath) => resolveWorkspaceByPath(workspacePath)),
          ),
        );
      }

      if (input.workspaceId) {
        return [await resolveWorkspaceById(input.workspaceId)];
      }

      if (input.path) {
        return [await resolveWorkspaceByPath(input.path)];
      }

      return [await resolveDefaultWorkspace()];
    },

    async resolveWriteWorkspace(input: {
      workspaceId?: string;
      path?: string;
    }): Promise<WorkspaceLike> {
      if (input.workspaceId && input.path) {
        throw new Error("Pass either workspaceId or path, not both.");
      }
      if (input.workspaceId) return resolveWorkspaceById(input.workspaceId);
      if (input.path) return resolveWorkspaceByPath(input.path);
      return resolveDefaultWorkspace();
    },
  };
}

type McpServerOptions = { defaultPath?: string; version?: string; build?: string };

function jsonResponse(result: unknown, maxTokens?: number) {
  const value = maxTokens ? fitToTokenBudget(result, maxTokens) : result;
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value),
      },
    ],
  };
}

function fitToTokenBudget(result: unknown, maxTokens: number): unknown {
  const value = structuredClone(result) as Record<string, unknown>;
  const metrics =
    typeof value.metrics === "object" && value.metrics !== null
      ? (value.metrics as Record<string, unknown>)
      : {};
  value.metrics = metrics;
  metrics.tokenBudget = maxTokens;
  metrics.truncated = false;

  const serializedTokens = () => countTokens(JSON.stringify(value));
  const updateMetrics = () => {
    metrics.responseTokens = serializedTokens();
    if (typeof metrics.selectedFullFileTokens === "number") {
      metrics.estimatedTokensSaved = metrics.truncated
        ? 0
        : Math.max(0, metrics.selectedFullFileTokens - Number(metrics.responseTokens));
      metrics.method = "selected-full-files-minus-serialized-response";
    }
  };
  updateMetrics();
  if (serializedTokens() <= maxTokens) {
    updateMetrics();
    return value;
  }

  metrics.truncated = true;
  for (let attempts = 0; attempts < 10_000 && serializedTokens() > maxTokens; attempts += 1) {
    const arrays: Array<{ items: unknown[]; minimum: number }> = [];
    const strings: Array<{ owner: Record<string, unknown>; key: string; value: string }> = [];
    const visit = (current: unknown, parentKey?: string) => {
      if (Array.isArray(current)) {
        const minimum = parentKey === "nodes" ? 1 : 0;
        if (current.length > minimum && parentKey !== "results")
          arrays.push({ items: current, minimum });
        current.forEach((item) => visit(item));
        return;
      }
      if (!current || typeof current !== "object") return;
      for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
        if (typeof child === "string" && key !== "method")
          strings.push({ owner: current as Record<string, unknown>, key, value: child });
        else visit(child, key);
      }
    };
    visit(value);

    const array = arrays.sort(
      (left, right) =>
        JSON.stringify(right.items[right.items.length - 1]).length -
        JSON.stringify(left.items[left.items.length - 1]).length,
    )[0];
    if (array) {
      array.items.pop();
      continue;
    }

    const longest = strings.sort((left, right) => right.value.length - left.value.length)[0];
    if (!longest?.value) break;
    const overflow = serializedTokens() - maxTokens;
    const currentTokens = countTokens(longest.value);
    longest.owner[longest.key] = truncateToTokenLimit(
      longest.value,
      Math.max(0, currentTokens - overflow - 8),
    );
  }

  updateMetrics();
  while (serializedTokens() > maxTokens && typeof metrics.method === "string")
    delete metrics.method;
  updateMetrics();
  if (serializedTokens() > maxTokens) {
    const minimal = { metrics: { responseTokens: 0, tokenBudget: maxTokens, truncated: true } };
    minimal.metrics.responseTokens = countTokens(JSON.stringify(minimal));
    return minimal;
  }
  return value;
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
      console.error(
        `OpenEZ MCP catch-up indexing failed: ${error instanceof Error ? error.message : String(error)}`,
      );
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

export function createMcpServer(options?: McpServerOptions) {
  const resolver = createWorkspaceResolver(options);

  const server = new Server(
    {
      name: "openez-graph",
      version: options?.build
        ? `${options.version ?? "development"}+${options.build}`
        : (options?.version ?? "development"),
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "list_workspaces",
        description: "List registered workspaces and their current status.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "code_query",
        description:
          "Retrieve ranked code and documentation context for a user query. Supports one or many workspaces.",
        inputSchema: {
          type: "object",
          properties: {
            workspaceIds: {
              type: "array",
              items: { type: "string" },
              description: "IDs of registered workspaces",
            },
            workspaceId: { type: "string", description: "ID of a registered workspace" },
            paths: {
              type: "array",
              items: { type: "string" },
              description: "Filesystem paths to registered workspaces",
            },
            path: { type: "string", description: "Filesystem path to a registered workspace" },
            query: { type: "string" },
            limit: { type: "number" },
            maxTokens: {
              type: "number",
              minimum: MIN_RESPONSE_TOKENS,
              description:
                "Maximum tokens for the complete serialized tool response across all selected workspaces",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "code_context",
        description:
          "Fetch graph-adjacent context for a symbol or file path. Supports one or many workspaces.",
        inputSchema: {
          type: "object",
          properties: {
            workspaceIds: { type: "array", items: { type: "string" } },
            workspaceId: { type: "string" },
            paths: { type: "array", items: { type: "string" } },
            path: { type: "string" },
            symbolOrPath: { type: "string" },
            hops: { type: "number" },
            limit: { type: "number", description: "Maximum total records returned" },
            maxTokens: {
              type: "number",
              minimum: MIN_RESPONSE_TOKENS,
              description: "Maximum tokens for the complete serialized tool response",
            },
          },
          required: ["symbolOrPath"],
        },
      },
      {
        name: "graph_neighbors",
        description:
          "Inspect raw graph nodes and edges around a label or node id. Supports one or many workspaces.",
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
            depth: { type: "number" },
            limit: { type: "number", description: "Maximum nodes and edges per workspace" },
            maxTokens: {
              type: "number",
              minimum: MIN_RESPONSE_TOKENS,
              description: "Maximum tokens for the complete serialized tool response",
            },
          },
          required: [],
        },
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
            supersedesId: { type: "string" },
          },
          required: ["title", "content"],
        },
      },
      {
        name: "memory_recall",
        description:
          "Recall active technical decisions and learned memories. Supports one or many workspaces.",
        inputSchema: {
          type: "object",
          properties: {
            workspaceIds: { type: "array", items: { type: "string" } },
            workspaceId: { type: "string" },
            paths: { type: "array", items: { type: "string" } },
            path: { type: "string" },
            query: { type: "string" },
            limit: { type: "number" },
            maxTokens: {
              type: "number",
              minimum: MIN_RESPONSE_TOKENS,
              description: "Maximum tokens for the complete serialized tool response",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "index_workspace",
        description: "Run indexing for a workspace.",
        inputSchema: {
          type: "object",
          properties: {
            workspaceId: { type: "string" },
            path: { type: "string" },
            mode: { type: "string", enum: ["incremental", "full"] },
          },
          required: [],
        },
      },
      {
        name: "remove_workspace",
        description:
          "Remove a workspace from the registry and delete its .openez data directory. Destructive and irreversible: call only with confirm: true after explicit user approval.",
        inputSchema: {
          type: "object",
          properties: {
            workspaceId: { type: "string" },
            path: { type: "string" },
            confirm: { type: "boolean" },
          },
          required: ["confirm"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
    switch (request.params.name) {
      case "list_workspaces": {
        const registry = createRegistryRepository();
        return jsonResponse(await registry.listWorkspaces());
      }
      case "code_query":
      case "memory_query": {
        const input = codeQuerySchema.parse(request.params.arguments ?? {});
        const workspaces = await resolver.resolveReadWorkspaces(input);
        const responseBudget = input.maxTokens ?? 4000;
        const workspaceBudget = Math.max(100, Math.floor(responseBudget / workspaces.length));
        await catchUpReadWorkspaces(workspaces);
        // Wait for background FTS build if still in progress
        await Promise.all(workspaces.map((w) => waitForFts(w.id)));
        // Graph is built lazily inside codeQuery via ensureGraph callback
        const results = await Promise.all(
          workspaces.map(async (workspace) => ({
            workspace,
            result: await codeQuery({
              workspaceId: workspace.id,
              query: input.query,
              limit: input.limit,
              maxTokens: workspaceBudget,
              recordMetrics: false,
              ensureGraph: ensureGraphReady,
            }),
          })),
        );

        const mergedSources = results
          .flatMap(({ workspace, result }) =>
            result.sources.map((source) => ({
              ...source,
              workspaceId: workspace.id,
              workspaceName: workspace.name,
              rootPath: workspace.rootPath,
            })),
          )
          .sort((left, right) => right.score - left.score);

        const answerContext =
          results.length === 1
            ? results[0].result.answerContext
            : results
                .map(
                  ({ workspace, result }) =>
                    `## Workspace: ${workspace.name} (${workspace.id})\n${result.answerContext}`,
                )
                .join("\n\n");

        const response = jsonResponse(
          {
            answerContext,
            sources: mergedSources,
            workspaces: results.map(({ workspace }) => ({
              workspaceId: workspace.id,
              workspaceName: workspace.name,
              rootPath: workspace.rootPath,
            })),
            metrics: {
              selectedFullFileTokens: results.reduce(
                (sum, entry) => sum + entry.result.metrics.selectedFullFileTokens,
                0,
              ),
              candidateFiles: results.reduce(
                (sum, entry) => sum + entry.result.metrics.candidateFiles,
                0,
              ),
              selectedFiles: results.reduce(
                (sum, entry) => sum + entry.result.metrics.selectedFiles,
                0,
              ),
            },
          },
          responseBudget,
        );
        const responseTokens = countTokens(response.content[0].text);
        const delivered = JSON.parse(response.content[0].text) as {
          sources?: Array<{ workspaceId?: string }>;
          metrics?: { truncated?: boolean };
        };
        const totalRetrievalTokens = Math.max(
          1,
          results.reduce((sum, entry) => sum + entry.result.metrics.retrievalTokens, 0),
        );
        let attributedSoFar = 0;
        const attributedTokens = results.map(({ result }, index) => {
          const tokens =
            index === results.length - 1
              ? responseTokens - attributedSoFar
              : Math.floor(
                  (responseTokens * result.metrics.retrievalTokens) / totalRetrievalTokens,
                );
          attributedSoFar += tokens;
          return tokens;
        });
        await Promise.all(
          results.map(({ workspace, result }, index) => {
            return createWorkspaceRepository(workspace.rootPath).insertQueryLog({
              query: input.query,
              mode: "code_query",
              resultCount:
                delivered.sources?.filter((source) => source.workspaceId === workspace.id).length ??
                0,
              tokensReturned: attributedTokens[index],
              tokensSaved: delivered.metrics?.truncated
                ? 0
                : Math.max(0, result.metrics.selectedFullFileTokens - attributedTokens[index]),
              filesScanned: result.metrics.candidateFiles,
            });
          }),
        );
        return response;
      }
      case "code_context": {
        const input = codeContextSchema.parse(request.params.arguments ?? {});
        const workspaces = await resolver.resolveReadWorkspaces(input);
        await catchUpReadWorkspaces(workspaces);
        await Promise.all(workspaces.map((w) => ensureGraphReady(w.id)));
        const results = await Promise.all(
          workspaces.map(async (workspace) => ({
            workspaceId: workspace.id,
            workspaceName: workspace.name,
            rootPath: workspace.rootPath,
            result: await codeContext({
              workspaceId: workspace.id,
              symbolOrPath: input.symbolOrPath,
              hops: input.hops,
              limit: input.limit,
              maxTokens: input.maxTokens,
            }),
          })),
        );
        return jsonResponse({ results }, input.maxTokens ?? 4000);
      }
      case "graph_neighbors": {
        const input = graphNeighborsSchema.parse(request.params.arguments ?? {});
        const workspaces = await resolver.resolveReadWorkspaces(input);
        await catchUpReadWorkspaces(workspaces);
        await Promise.all(workspaces.map((w) => ensureGraphReady(w.id)));
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
              depth: input.depth,
              limit: input.limit,
            }),
          })),
        );
        return jsonResponse({ results }, input.maxTokens ?? 4000);
      }
      case "memory_write": {
        const input = memoryWriteSchema.parse(request.params.arguments ?? {});
        const workspace = await resolver.resolveWriteWorkspace(input);
        return jsonResponse(await memoryWrite({ ...input, workspaceId: workspace.id }));
      }
      case "memory_recall": {
        const input = memoryRecallSchema.parse(request.params.arguments ?? {});
        const workspaces = await resolver.resolveReadWorkspaces(input);
        const results = await Promise.all(
          workspaces.map(async (workspace) => ({
            workspace,
            result: await memoryRecall({
              workspaceId: workspace.id,
              query: input.query,
              limit: input.limit,
            }),
          })),
        );
        return jsonResponse(
          {
            memories: results.flatMap(({ workspace, result }) =>
              result.memories.map((memory) => ({
                ...memory,
                workspaceId: workspace.id,
                workspaceName: workspace.name,
                rootPath: workspace.rootPath,
              })),
            ),
          },
          input.maxTokens ?? 4000,
        );
      }
      case "index_workspace": {
        const input = indexWorkspaceSchema.parse(request.params.arguments ?? {});
        const workspace = await resolver.resolveWriteWorkspace(input);
        const summary = await indexWorkspace({ workspaceId: workspace.id, mode: input.mode });
        return jsonResponse(summary);
      }
      case "remove_workspace": {
        const input = removeWorkspaceSchema.parse(request.params.arguments ?? {});
        if (input.confirm !== true) {
          return jsonResponse({
            error:
              "remove_workspace permanently deletes the registry entry and the workspace's .openez data directory. Requires confirm: true.",
            hint: "Ask the user for approval, then call remove_workspace again with confirm: true.",
          });
        }
        if (input.workspaceId && input.path) {
          return jsonResponse({ error: "Pass either workspaceId or path, not both." });
        }
        if (!input.workspaceId && !input.path) {
          return jsonResponse({ error: "Pass an explicit workspaceId or path." });
        }
        const report = await removeWorkspace({
          id: input.workspaceId,
          rootPath: input.path ? path.resolve(input.path) : undefined,
        });
        if (!report) {
          return jsonResponse({
            error: "Workspace not found",
            workspaceId: input.workspaceId,
            path: input.path,
          });
        }
        // Stop the opt-in auto-sync watcher if it was watching this workspace,
        // preventing stale reindex attempts against the deleted workspace.
        stopWatcherForWorkspace(report.workspaceId);
        return jsonResponse(report);
      }
      default:
        throw new Error(`Unknown tool: ${request.params.name}`);
    }
  });

  return server;
}

export async function createAndStartMcpServer(options?: McpServerOptions) {
  // ── Auto-index + optional auto-sync watcher ──
  const searchRoot = options?.defaultPath ?? process.cwd();
  await autoIndexAndSync(searchRoot);

  const server = createMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// ── Watcher state (module-scoped so remove_workspace can close it) ──
interface ActiveWatcher {
  watcher: ReturnType<typeof chokidar.watch>;
  workspaceId: string;
  rootPath: string;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}
let activeWatcher: ActiveWatcher | null = null;

const WATCH_DEBOUNCE_MS = 2000;
const WATCH_ENABLED = ["1", "true", "yes"].includes(
  (process.env.OPENEZ_MCP_WATCH ?? "").toLowerCase(),
);
const WATCH_IGNORE_PATTERNS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.next/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.turbo/**",
  "**/.openez/**",
];

export async function autoIndexAndSync(searchRoot: string): Promise<void> {
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
    workspace = await registry.ensureWorkspace({ rootPath: resolvedRoot });
  }

  // Auto-index workspaces that have never completed an index, including legacy pending rows.
  if (workspace.indexingStatus === "pending" || !workspace.lastIndexedAt) {
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
  const debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const watcher = chokidar.watch(resolvedRoot, {
    ignored: WATCH_IGNORE_PATTERNS,
    ignoreInitial: true,
    persistent: true,
  });

  activeWatcher = { watcher, workspaceId: workspace.id, rootPath: resolvedRoot, debounceTimer };

  const triggerReindex = () => {
    const current = activeWatcher;
    if (!current) return;
    if (current.debounceTimer) clearTimeout(current.debounceTimer);
    current.debounceTimer = setTimeout(async () => {
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
    console.error(
      `OpenEZ MCP auto-sync watcher disabled: ${error instanceof Error ? error.message : String(error)}`,
    );
    void watcher.close();
    activeWatcher = null;
  });
}

function stopWatcherForWorkspace(workspaceId: string): void {
  if (activeWatcher && activeWatcher.workspaceId === workspaceId) {
    if (activeWatcher.debounceTimer) clearTimeout(activeWatcher.debounceTimer);
    void activeWatcher.watcher.close();
    activeWatcher = null;
  }
}
