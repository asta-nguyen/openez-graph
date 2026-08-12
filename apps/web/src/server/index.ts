import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { existsSync, promises as fs, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

function getDirname(): string {
  try {
    if (typeof import.meta !== "undefined" && import.meta.url) {
      return path.dirname(new URL(import.meta.url).pathname);
    }
  } catch {
    // import.meta not available (CJS)
  }
  // CJS: __dirname is a global, use it directly
  if (typeof __dirname !== "undefined") {
    return __dirname;
  }
  return process.cwd();
}

const serverDir = getDirname();

import {
  countWorkspaceDocuments,
  countWorkspaceMemories,
  deleteWorkspaceMemory,
  ensureRegistryWorkspace,
  getLatestGraphRun,
  getLatestIndexRun,
  getWorkspaceQueryMetrics,
  getRecentGraphRuns,
  getRecentIndexRuns,
  getRegistryWorkspace,
  getWorkspaceCounts,
  getWorkspaceGraphOptimized,
  getWorkspaceMemory,
  insertWorkspaceMemory,
  listRegistryWorkspaces,
  closeWorkspaceDb,
  listWorkspaceDocuments,
  listWorkspaceMemories,
  resolveRegistryDbPath,
  searchWorkspaceMemories,
  setRegistryWorkspacePinned,
} from "./sqlite";

import { LOCAL_EMBEDDING_MODELS, codeQuery } from "@openez-graph/core";
import {
  createRegistryRepository,
  createWorkspaceRepository,
  removeWorkspace,
} from "@openez-graph/db";
import { ensureGraphReady, indexWorkspace } from "@openez-graph/indexer";

const app = new Hono();
app.use(
  "/*",
  cors({
    origin: [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "http://localhost:11368",
      "http://127.0.0.1:11368",
    ],
    credentials: true,
  }),
);

const DEFAULT_INCLUDE_GLOBS = [
  "src/**/*.{ts,tsx,js,jsx}",
  "app/**/*.{ts,tsx}",
  "pages/**/*.{ts,tsx}",
  "lib/**/*.{ts,tsx}",
  "**/*.md",
];

const DEFAULT_EXCLUDE_GLOBS = [
  "node_modules/**",
  "**/node_modules/**",
  ".next/**",
  "dist/**",
  "build/**",
  ".git/**",
  "coverage/**",
  "**/.turbo/**",
];

const activeIndexRuns = new Set<string>();

function mapWorkspace(ws: {
  id: string;
  name: string;
  rootPath: string;
  includeGlobs: string;
  excludeGlobs: string;
  status: string;
  indexingStatus: string;
  graphStatus: string;
  lastIndexedAt?: string;
  lastGraphBuiltAt?: string;
  documentCount: number;
  chunkCount: number;
  nodeCount: number;
  edgeCount: number;
  lastError?: string;
  pinnedAt?: string;
  createdAt: string;
  updatedAt: string;
}) {
  return {
    id: ws.id,
    name: ws.name,
    rootPath: ws.rootPath,
    includeGlobs: ws.includeGlobs ? ws.includeGlobs.split("\n").filter(Boolean) : [],
    excludeGlobs: ws.excludeGlobs ? ws.excludeGlobs.split("\n").filter(Boolean) : [],
    status: ws.status,
    indexingStatus: ws.indexingStatus,
    graphStatus: ws.graphStatus,
    lastIndexedAt: ws.lastIndexedAt ? new Date(ws.lastIndexedAt) : null,
    lastGraphBuiltAt: ws.lastGraphBuiltAt ? new Date(ws.lastGraphBuiltAt) : null,
    documentCount: ws.documentCount,
    chunkCount: ws.chunkCount,
    nodeCount: ws.nodeCount,
    edgeCount: ws.edgeCount,
    lastError: ws.lastError ?? null,
    pinnedAt: ws.pinnedAt ?? null,
    createdAt: new Date(ws.createdAt),
    updatedAt: new Date(ws.updatedAt),
  };
}

// Dashboard
app.get("/api/dashboard", (c) => {
  try {
    const all = listRegistryWorkspaces();
    // Find first workspace with a valid root path
    const target =
      all.find((ws) => {
        try {
          return ws.rootPath && ws.rootPath !== "/" && existsSync(ws.rootPath);
        } catch {
          return false;
        }
      }) ?? all[0];
    if (!target) {
      return c.json({
        workspace: { id: "", name: "No workspace", root: "" },
        stats: {
          documents: 0,
          chunks: 0,
          graphNodes: 0,
          graphEdges: 0,
          memories: 0,
        },
        recentRuns: [],
        recentDocuments: [],
        recentMemories: [],
        databaseAvailable: false,
      });
    }
    const counts = getWorkspaceCounts(target.rootPath);
    const run = getLatestIndexRun(target.rootPath);
    return c.json({
      workspace: { id: target.id, name: target.name, root: target.rootPath },
      stats: {
        documents: Number(counts.documents),
        chunks: Number(counts.chunks),
        graphNodes: Number(counts.nodes),
        graphEdges: Number(counts.edges),
        memories: Number(counts.memories),
      },
      recentRuns: run ? [run] : [],
      recentDocuments: listWorkspaceDocuments(target.rootPath, 10),
      recentMemories: listWorkspaceMemories(target.rootPath, 10).map((m) => ({
        id: m.id,
        title: m.title,
        source: m.source,
      })),
      databaseAvailable: true,
    });
  } catch (err) {
    console.error("Dashboard error:", err);
    return c.json({
      workspace: { id: "", name: "No workspace", root: "" },
      stats: {
        documents: 0,
        chunks: 0,
        graphNodes: 0,
        graphEdges: 0,
        memories: 0,
      },
      recentRuns: [],
      recentDocuments: [],
      recentMemories: [],
      databaseAvailable: false,
    });
  }
});

// Documents
app.get("/api/documents", (c) => {
  try {
    const limit = Number(c.req.query("limit") ?? 10);
    const offset = Number(c.req.query("offset") ?? 0);
    const all = listRegistryWorkspaces();
    if (all.length === 0) return c.json({ items: [], totalCount: 0 });
    const ws = all[0];
    const items = listWorkspaceDocuments(ws.rootPath, limit, offset);
    const totalCount = countWorkspaceDocuments(ws.rootPath);
    return c.json({ items, totalCount });
  } catch {
    return c.json({ items: [], totalCount: 0 });
  }
});

// Validate path
app.post("/api/validate-path", async (c) => {
  const body = await c.req.json<{ rootPath?: string }>();
  const rootPath = body.rootPath;
  if (!rootPath) return c.json({ valid: false, error: "Path is required" });
  try {
    const stats = await fs.stat(rootPath);
    if (!stats.isDirectory()) return c.json({ valid: false, error: "Path is not a directory" });
    return c.json({ valid: true });
  } catch {
    return c.json({
      valid: false,
      error: "Directory does not exist or is not accessible",
    });
  }
});

// Workspaces
app.get("/api/workspaces", (c) => {
  try {
    const dbPath = resolveRegistryDbPath();
    const all = listRegistryWorkspaces();
    const data = all.map((ws) => {
      let latestIndexRun = null;
      let latestGraphRun = null;
      try {
        latestIndexRun = getLatestIndexRun(ws.rootPath);
        latestGraphRun = getLatestGraphRun(ws.rootPath);
      } catch {
        // Skip workspaces with invalid/inaccessible root paths
      }
      return {
        ...mapWorkspace(ws),
        latestIndexRun,
        latestGraphRun,
      };
    });
    return c.json({ ok: true, data });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({
      ok: false,
      error: message,
      dbPath: resolveRegistryDbPath(),
    });
  }
});

app.get("/api/workspaces/:id", (c) => {
  try {
    const id = c.req.param("id");
    const ws = getRegistryWorkspace(id);
    if (!ws) return c.json({ ok: true, data: null });
    const data = {
      ...mapWorkspace(ws),
      latestIndexRun: getLatestIndexRun(ws.rootPath),
      latestGraphRun: getLatestGraphRun(ws.rootPath),
      recentIndexRuns: getRecentIndexRuns(ws.rootPath),
      recentGraphRuns: getRecentGraphRuns(ws.rootPath),
    };
    return c.json({ ok: true, data });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({
      ok: false,
      error: message,
      dbPath: resolveRegistryDbPath(),
    });
  }
});

app.post("/api/workspaces", async (c) => {
  try {
    const body = await c.req.json<{
      name?: string;
      rootPath?: string;
      includeGlobs?: string[];
      excludeGlobs?: string[];
    }>();
    const rootPath = body.rootPath;
    if (!rootPath) return c.json({ success: false, error: "rootPath is required" });
    try {
      const stats = await fs.stat(rootPath);
      if (!stats.isDirectory()) return c.json({ success: false, error: "Path is not a directory" });
    } catch {
      return c.json({
        success: false,
        error: "Directory does not exist or is not accessible",
      });
    }
    const ws = ensureRegistryWorkspace({
      name: body.name?.trim() || path.basename(rootPath),
      rootPath: path.resolve(rootPath),
      includeGlobs: (body.includeGlobs ?? DEFAULT_INCLUDE_GLOBS).join("\n"),
      excludeGlobs: (body.excludeGlobs ?? DEFAULT_EXCLUDE_GLOBS).join("\n"),
    });
    return c.json({
      success: true,
      workspace: {
        ...mapWorkspace(ws),
        latestIndexRun: null,
        latestGraphRun: null,
      },
    });
  } catch (err) {
    console.error("Failed to create workspace:", err);
    return c.json({ success: false, error: "Failed to create workspace" });
  }
});

app.delete("/api/workspaces/:id", async (c) => {
  try {
    const id = c.req.param("id");
    // Close the web server's cached workspace DB handle before removing,
    // so the native connection doesn't keep the SQLite files locked.
    const ws = getRegistryWorkspace(id);
    if (ws) closeWorkspaceDb(ws.rootPath);
    const report = await removeWorkspace({ id });
    if (!report) return c.json({ success: false, error: "Workspace not found" }, 404);
    return c.json({ success: true, report });
  } catch (err) {
    console.error("Failed to delete workspace:", err);
    return c.json({ success: false, error: "Failed to delete workspace" }, 500);
  }
});

app.patch("/api/workspaces/:id/pin", async (c) => {
  try {
    const id = c.req.param("id");
    const body = await c.req.json<{ pinned?: boolean }>().catch(() => null);
    if (typeof body?.pinned !== "boolean") {
      return c.json({ success: false, error: "pinned (boolean) is required" }, 400);
    }
    if (!getRegistryWorkspace(id)) {
      return c.json({ success: false, error: "Workspace not found" }, 404);
    }
    setRegistryWorkspacePinned(id, body.pinned);
    return c.json({ success: true });
  } catch (err) {
    console.error("Failed to pin workspace:", err);
    return c.json({ success: false, error: "Failed to pin workspace" });
  }
});

// Workspace index status
app.get("/api/workspaces/:id/index", (c) => {
  const id = c.req.param("id");
  const ws = getRegistryWorkspace(id);
  if (!ws) return c.json(null);
  return c.json({ status: ws.indexingStatus });
});

app.post("/api/workspaces/:id/index", async (c) => {
  const id = c.req.param("id");
  const ws = getRegistryWorkspace(id);
  if (!ws) return c.json({ status: "failed", error: "Workspace not found" }, 404);
  const body = await c.req.json<{ mode?: string }>().catch(() => ({ mode: "incremental" }));
  const mode = body.mode ?? "incremental";
  if (mode !== "incremental" && mode !== "full") {
    return c.json({ status: "failed", error: "Mode must be 'incremental' or 'full'" }, 400);
  }

  if (activeIndexRuns.has(id)) {
    return c.json({ status: "running", error: `Workspace '${id}' is already being indexed` }, 409);
  }

  activeIndexRuns.add(id);
  try {
    const summary = await indexWorkspace({ workspaceId: id, mode });
    return c.json({ ...summary, status: "completed" });
  } catch (error) {
    if (error instanceof Error && error.message.includes("already being indexed")) {
      return c.json({ status: "running", error: error.message }, 409);
    }
    return c.json(
      {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  } finally {
    activeIndexRuns.delete(id);
  }
});

// Workspace graph
app.get("/api/workspaces/:id/graph", async (c) => {
  const id = c.req.param("id");
  const workspace = getRegistryWorkspace(id);
  if (!workspace) return c.json(null);

  try {
    await ensureGraphReady(id);

    // ponytail: canvas-first ceiling; move to WebGL/streaming for larger full graphs.
    const maxNodes = Math.min(parseInt(c.req.query("limit") ?? "25000", 10) || 25000, 25000);
    const maxEdges = Math.min(parseInt(c.req.query("edgeLimit") ?? "75000", 10) || 75000, 75000);

    const {
      nodes: nodeRows,
      edges: edgeRows,
      totalNodeCount,
      totalEdgeCount,
    } = getWorkspaceGraphOptimized(workspace.rootPath, maxNodes, maxEdges);

    const degreeMap = new Map<string, number>();
    for (const edge of edgeRows) {
      degreeMap.set(edge.source, (degreeMap.get(edge.source) ?? 0) + 1);
      degreeMap.set(edge.target, (degreeMap.get(edge.target) ?? 0) + 1);
    }

    const validIds = new Set(nodeRows.map((n) => n.id));

    const nodes = nodeRows.map((node) => ({
      id: node.id,
      label: node.label,
      type: node.type,
      degree: degreeMap.get(node.id) ?? 0,
      metadata: node.metadata,
      path: typeof node.metadata?.path === "string" ? node.metadata.path : undefined,
      startLine: typeof node.metadata?.startLine === "number" ? node.metadata.startLine : undefined,
      endLine: typeof node.metadata?.endLine === "number" ? node.metadata.endLine : undefined,
      refId: node.refId,
    }));

    const edges = edgeRows
      .filter((e) => validIds.has(e.source) && validIds.has(e.target))
      .map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: edge.type,
        weight: edge.weight,
      }));

    const nodeTypes = [...new Set(nodes.map((n) => n.type))].sort();
    const edgeTypes = [...new Set(edges.map((e) => e.type))].sort();

    return c.json({
      workspaceId: id,
      workspaceName: workspace.name,
      nodes,
      edges,
      nodeTypes,
      edgeTypes,
      totalNodes: totalNodeCount,
      totalEdges: totalEdgeCount,
      displayedNodes: nodes.length,
      displayedEdges: edges.length,
    });
  } catch (error) {
    return c.json(
      {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});

// Query
app.post("/api/query", async (c) => {
  const body = await c.req.json<{ workspaceId?: string; query?: string }>();
  const workspaceId = (body.workspaceId ?? "").trim();
  const query = (body.query ?? "").trim();

  if (!workspaceId) {
    return c.json({
      answerContext: "",
      sources: [],
      graphNodes: [],
      graphEdges: [],
      error: "Workspace ID is required.",
    });
  }
  if (!query) {
    return c.json({
      answerContext: "",
      sources: [],
      graphNodes: [],
      graphEdges: [],
      error: "Query is required.",
    });
  }

  try {
    const registry = createRegistryRepository();
    const workspace = await registry.getWorkspace(workspaceId);
    await ensureGraphReady(workspaceId);

    const [result, neighborResults] = await Promise.all([
      codeQuery({ workspaceId, query, skipGraphExpand: true }),
      (async () => {
        if (!workspace) return [];
        const repo = createWorkspaceRepository(workspace.rootPath);
        const ftsHits = await repo.fullTextSearch(query, 3);
        const paths = [...new Set(ftsHits.map((h) => h.path))];
        return Promise.all(paths.map((p) => repo.graphNeighbors(p, 1)));
      })(),
    ]);

    const allGraphNodes: Array<{
      id: string;
      type: string;
      label: string;
      metadata: Record<string, unknown>;
    }> = [];
    const allGraphEdges: Array<{
      from_node_id: string;
      to_node_id: string;
      type: string;
    }> = [];
    const visitedNodeIds = new Set<string>();
    const edgeSet = new Set<string>();

    for (const neighbors of neighborResults) {
      for (const node of neighbors.nodes) {
        const nodeId = String(node.id);
        if (!visitedNodeIds.has(nodeId)) {
          visitedNodeIds.add(nodeId);
          allGraphNodes.push({
            id: nodeId,
            type: String(node.type),
            label: String(node.label),
            metadata:
              typeof node.metadata === "object" && node.metadata !== null
                ? (node.metadata as Record<string, unknown>)
                : {},
          });
        }
      }
      for (const edge of neighbors.edges) {
        const key = `${edge.from_node_id}:${edge.to_node_id}:${edge.type}`;
        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          allGraphEdges.push({
            from_node_id: String(edge.from_node_id),
            to_node_id: String(edge.to_node_id),
            type: String(edge.type),
          });
        }
      }
    }

    return c.json({
      ...result,
      graphNodes: allGraphNodes,
      graphEdges: allGraphEdges,
      error: null,
    });
  } catch (error) {
    return c.json({
      answerContext: "",
      sources: [],
      graphNodes: [],
      graphEdges: [],
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get("/api/settings/embedding", async (c) => {
  try {
    const { getEmbeddingConfig, LOCAL_EMBEDDING_MODELS } = await import("@openez-graph/core");
    const config = await getEmbeddingConfig();
    const registry = createRegistryRepository();
    const dbSettings = await registry.getAllSettings();
    return c.json({
      provider: config.provider,
      openaiApiKey: config.openaiApiKey ? "****" : "",
      openaiBaseUrl: config.openaiBaseUrl ?? "",
      openaiModel: config.openaiModel,
      ollamaBaseUrl: config.ollamaBaseUrl,
      ollamaModel: config.ollamaModel,
      localModel: config.localModel,
      localModels: Object.keys(LOCAL_EMBEDDING_MODELS),
      dbOverrides: Object.keys(dbSettings).filter((k) => k.startsWith("embedding.")),
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.put("/api/settings/embedding", async (c) => {
  try {
    const body = await c.req.json();
    const VALID_KEYS: Record<string, boolean> = {
      "embedding.provider": true,
      "embedding.openai_api_key": true,
      "embedding.openai_base_url": true,
      "embedding.openai_model": true,
      "embedding.ollama_base_url": true,
      "embedding.ollama_model": true,
      "embedding.local_model": true,
    };
    const VALID_PROVIDERS = new Set(["none", "openai", "ollama", "local"]);
    const registry = createRegistryRepository();
    const updated: string[] = [];
    for (const [key, value] of Object.entries(body)) {
      if (!VALID_KEYS[key]) continue;
      if (typeof value !== "string") continue;
      if (value.trim() === "") {
        await registry.deleteSetting(key);
        updated.push(key);
        continue;
      }
      if (key === "embedding.provider" && !VALID_PROVIDERS.has(value.trim())) {
        return c.json(
          {
            error: `Invalid embedding provider '${value}'. Must be one of: none, openai, ollama, local.`,
          },
          400,
        );
      }
      if (
        key === "embedding.local_model" &&
        !Object.prototype.hasOwnProperty.call(LOCAL_EMBEDDING_MODELS, value.trim())
      ) {
        return c.json(
          {
            error: `Unsupported local embedding model '${value}'. Must be one of: ${Object.keys(LOCAL_EMBEDDING_MODELS).join(", ")}.`,
          },
          400,
        );
      }
      await registry.setSetting(key, key === "embedding.local_model" ? value.trim() : value);
      updated.push(key);
    }
    return c.json({ ok: true, updated });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.get("/api/settings/env", (c) => {
  return c.json({
    EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER ?? "none",
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? undefined,
    OPENAI_EMBEDDING_MODEL: process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small",
    OLLAMA_EMBEDDING_MODEL: process.env.OLLAMA_EMBEDDING_MODEL ?? "bge-m3",
  });
});

// ── Memories ──

function resolveActiveWorkspace() {
  const all = listRegistryWorkspaces();
  if (all.length === 0) return null;
  // Prefer workspace whose rootPath exists on disk
  const valid = all.find((w) => existsSync(w.rootPath));
  return valid ?? all[0];
}

app.get("/api/memories", (c) => {
  try {
    const q = c.req.query("q") ?? "";
    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    const ws = resolveActiveWorkspace();
    if (!ws) return c.json({ items: [], totalCount: 0 });
    if (q.trim()) {
      const items = searchWorkspaceMemories(ws.rootPath, q, limit);
      return c.json({ items, totalCount: items.length });
    }
    const items = listWorkspaceMemories(ws.rootPath, limit, offset);
    const totalCount = countWorkspaceMemories(ws.rootPath);
    return c.json({ items, totalCount });
  } catch (err) {
    console.error("Memories list error:", err);
    return c.json({ items: [], totalCount: 0 });
  }
});

app.get("/api/memories/:id", (c) => {
  try {
    const id = c.req.param("id");
    const ws = resolveActiveWorkspace();
    if (!ws) return c.json({ ok: false, error: "No workspace" }, 404);
    const memory = getWorkspaceMemory(ws.rootPath, id);
    if (!memory) return c.json({ ok: false, error: "Memory not found" }, 404);
    return c.json({ ok: true, data: memory });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.post("/api/memories", async (c) => {
  try {
    const body = await c.req.json<{
      title?: string;
      content?: string;
      tags?: string[];
      source?: string;
      supersedesId?: string;
    }>();
    if (!body.title?.trim()) return c.json({ ok: false, error: "title is required" }, 400);
    if (!body.content?.trim()) return c.json({ ok: false, error: "content is required" }, 400);
    const ws = resolveActiveWorkspace();
    if (!ws) return c.json({ ok: false, error: "No workspace registered" }, 400);
    const id = insertWorkspaceMemory({
      rootPath: ws.rootPath,
      title: body.title.trim(),
      content: body.content.trim(),
      tags: body.tags ?? [],
      source: body.source ?? "user",
      supersedesId: body.supersedesId,
    });
    const memory = getWorkspaceMemory(ws.rootPath, id);
    return c.json({ ok: true, data: memory });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.delete("/api/memories/:id", (c) => {
  try {
    const id = c.req.param("id");
    const ws = resolveActiveWorkspace();
    if (!ws) return c.json({ ok: false, error: "No workspace" }, 404);
    const deleted = deleteWorkspaceMemory(ws.rootPath, id);
    if (!deleted) return c.json({ ok: false, error: "Memory not found" }, 404);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// ── Metrics ──

function resolveMetricsWorkspace(c: Context) {
  const workspaceId = c.req.query("workspaceId");
  const all = listRegistryWorkspaces();
  if (workspaceId) {
    return all.find((w) => w.id === workspaceId) ?? null;
  }
  // Default: same logic as dashboard — first workspace with valid root path
  return (
    all.find((w) => {
      try {
        return w.rootPath && w.rootPath !== "/" && existsSync(w.rootPath);
      } catch {
        return false;
      }
    }) ?? all[0]
  );
}

app.get("/api/metrics", (c) => {
  try {
    const ws = resolveMetricsWorkspace(c);
    if (!ws) {
      return c.json({ error: "Workspace not found" }, 404);
    }
    const metrics = getWorkspaceQueryMetrics(ws.rootPath, 10);
    return c.json({ ...metrics, workspaceId: ws.id });
  } catch {
    return c.json({
      metricMethod: "selected-full-files-minus-serialized-response",
      totalQueries: 0,
      totalTokensReturned: 0,
      totalTokensSaved: 0,
      totalFilesScanned: 0,
      avgTokensPerQuery: 0,
      recentQueries: [],
      workspaceId: null,
    });
  }
});

// ── Changelog ──

function findChangelogPath(): string | null {
  const candidates = [
    path.resolve(serverDir, "CHANGELOG.md"),
    path.resolve(serverDir, "..", "..", "..", "..", "CHANGELOG.md"),
    path.resolve(serverDir, "..", "..", "..", "CHANGELOG.md"),
    path.resolve(serverDir, "..", "CHANGELOG.md"),
    path.resolve(process.cwd(), "CHANGELOG.md"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "CHANGELOG.md");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

app.get("/api/changelog", (c) => {
  try {
    const filePath = findChangelogPath();
    if (!filePath) return c.json({ content: "" }, 404);
    const content = readFileSync(filePath, "utf-8");
    return c.json({ content });
  } catch {
    return c.json({ content: "" }, 500);
  }
});

// ── Static frontend serving ──

function resolveWebDist(): string | null {
  // When running from source (monorepo)
  const sourceDist = path.resolve(serverDir, "..", "dist");
  if (existsSync(path.join(sourceDist, "index.html"))) return sourceDist;

  // When running from CLI bundle (dist/web copied alongside)
  if (process.env.OPENEZ_CLI_BUNDLE === "true" && process.argv[1]) {
    const cliDist = path.resolve(path.dirname(realpathSync(process.argv[1])), "web");
    if (existsSync(path.join(cliDist, "index.html"))) return cliDist;
  }

  return null;
}

export function createWebServer() {
  const webDist = resolveWebDist();

  if (webDist) {
    app.use("/*", serveStatic({ root: webDist, rewriteRequestPath: (p) => p }));
    // SPA fallback — serve index.html for non-API routes
    app.get("*", (c) => {
      const indexPath = path.join(webDist, "index.html");
      const index = readFileSync(indexPath, "utf-8");
      return c.html(index);
    });
  }

  return app;
}
