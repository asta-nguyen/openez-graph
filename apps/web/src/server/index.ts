import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  countGraphNodes,
  deleteRegistryWorkspace,
  ensureRegistryWorkspace,
  getGraphNodeById,
  getLatestGraphRun,
  getLatestIndexRun,
  getRecentGraphRuns,
  getRecentIndexRuns,
  getRegistryWorkspace,
  getWorkspaceCounts,
  getWorkspaceGraphOptimized,
  listGraphEdges,
  listGraphNodesCurated,
  listRegistryWorkspaces,
  listWorkspaceDocuments,
  countWorkspaceDocuments,
  searchGraphNodesByLabel,
  updateRegistryWorkspace,
  resolveRegistryDbPath,
} from "./sqlite";

import { memoryQuery } from "@openez-graph/core";
import { createRegistryRepository, createWorkspaceRepository } from "@openez-graph/db";

const app = new Hono();
app.use("/*", cors({
  origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
  credentials: true,
}));

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

function mapWorkspace(ws: {
  id: string; name: string; rootPath: string;
  includeGlobs: string; excludeGlobs: string;
  status: string; indexingStatus: string; graphStatus: string;
  lastIndexedAt?: string; lastGraphBuiltAt?: string;
  documentCount: number; chunkCount: number;
  nodeCount: number; edgeCount: number;
  lastError?: string;
  createdAt: string; updatedAt: string;
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
    createdAt: new Date(ws.createdAt),
    updatedAt: new Date(ws.updatedAt),
  };
}

function toRunShim(run: {
  id: string; mode: string; status: string;
  filesScanned: number; filesUpdated: number;
  chunksWritten: number; embeddingsWritten: number;
  nodesCreated: number; edgesCreated: number;
  errorMessage: string | null;
  startedAt: string; finishedAt: string | null;
}) {
  return run;
}

// Dashboard
app.get("/api/dashboard", (c) => {
  try {
    const all = listRegistryWorkspaces();
    const target = all[0];
    if (!target) {
      return c.json({
        workspace: { id: "", name: "No workspace", root: "" },
        stats: { documents: 0, chunks: 0, graphNodes: 0, graphEdges: 0, memories: 0 },
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
      recentMemories: [] as Array<{ id: string; title: string; source: string }>,
      databaseAvailable: true,
    });
  } catch (err) {
    console.error("Dashboard error:", err);
    return c.json({
      workspace: { id: "", name: "No workspace", root: "" },
      stats: { documents: 0, chunks: 0, graphNodes: 0, graphEdges: 0, memories: 0 },
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

// Jobs
app.get("/api/jobs", (c) => {
  const workspaces = listRegistryWorkspaces();
  const runs: Array<ReturnType<typeof toRunShim>> = [];
  for (const ws of workspaces) {
    const workspaceRuns = getRecentIndexRuns(ws.rootPath, 100);
    runs.push(...workspaceRuns);
  }
  runs.sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );
  return c.json(runs);
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
    return c.json({ valid: false, error: "Directory does not exist or is not accessible" });
  }
});

// Workspaces
app.get("/api/workspaces", (c) => {
  try {
    const dbPath = resolveRegistryDbPath();
    const all = listRegistryWorkspaces();
    const data = all.map((ws) => ({
      ...mapWorkspace(ws),
      latestIndexRun: getLatestIndexRun(ws.rootPath),
      latestGraphRun: getLatestGraphRun(ws.rootPath),
    }));
    return c.json({ ok: true, data });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: message, dbPath: resolveRegistryDbPath() });
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
    return c.json({ ok: false, error: message, dbPath: resolveRegistryDbPath() });
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
      return c.json({ success: false, error: "Directory does not exist or is not accessible" });
    }
    const ws = ensureRegistryWorkspace({
      name: body.name?.trim() || path.basename(rootPath),
      rootPath: path.resolve(rootPath),
      includeGlobs: (body.includeGlobs ?? DEFAULT_INCLUDE_GLOBS).join("\n"),
      excludeGlobs: (body.excludeGlobs ?? DEFAULT_EXCLUDE_GLOBS).join("\n"),
    });
    return c.json({
      success: true,
      workspace: { ...mapWorkspace(ws), latestIndexRun: null, latestGraphRun: null },
    });
  } catch (err) {
    console.error("Failed to create workspace:", err);
    return c.json({ success: false, error: "Failed to create workspace" });
  }
});

app.delete("/api/workspaces/:id", (c) => {
  try {
    const id = c.req.param("id");
    deleteRegistryWorkspace(id);
    return c.json({ success: true });
  } catch (err) {
    console.error("Failed to delete workspace:", err);
    return c.json({ success: false, error: "Failed to delete workspace" });
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
  if (!ws) return c.json({ jobId: null, status: "error", error: "Workspace not found" }, 404);
  const body = await c.req.json<{ mode?: string }>().catch(() => ({ mode: "incremental" }));
  updateRegistryWorkspace(id, {
    indexingStatus: "running",
    status: "indexing",
    lastError: null,
  });
  return c.json({ jobId: crypto.randomUUID(), status: "running" });
});

// Workspace jobs
app.get("/api/workspaces/:id/jobs", (c) => {
  const id = c.req.param("id");
  const ws = getRegistryWorkspace(id);
  if (!ws) return c.json([]);
  return c.json(getRecentIndexRuns(ws.rootPath, 100));
});

app.delete("/api/workspaces/:id/jobs/:jobId", (c) => {
  return c.json({ ok: true });
});

// Workspace graph
app.get("/api/workspaces/:id/graph", (c) => {
  const id = c.req.param("id");
  const workspace = getRegistryWorkspace(id);
  if (!workspace) return c.json(null);

  const { nodes: nodeRows, edges: edgeRows } = getWorkspaceGraphOptimized(
    workspace.rootPath,
    300,
    1000
  );

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
    totalNodes: nodes.length,
    totalEdges: edges.length,
  });
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

    const [result, neighborResults] = await Promise.all([
      memoryQuery({ workspaceId, query, skipGraphExpand: true }),
      (async () => {
        if (!workspace) return [];
        const repo = createWorkspaceRepository(workspace.rootPath);
        const ftsHits = await repo.fullTextSearch(query, 3);
        const paths = [...new Set(ftsHits.map((h) => h.path))];
        return Promise.all(paths.map((p) => repo.graphNeighbors(p, 1)));
      })(),
    ]);

    const allGraphNodes: Array<{ id: string; type: string; label: string; metadata: Record<string, unknown> }> = [];
    const allGraphEdges: Array<{ from_node_id: string; to_node_id: string; type: string }> = [];
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
            metadata: typeof node.metadata === "object" && node.metadata !== null
              ? node.metadata as Record<string, unknown>
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

app.get("/api/settings/env", (c) => {
  return c.json({
    EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER ?? "ollama",
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? undefined,
    OPENAI_EMBEDDING_MODEL: process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small",
    OLLAMA_EMBEDDING_MODEL: process.env.OLLAMA_EMBEDDING_MODEL ?? "nomic-embed-text",
  });
});

const port = Number(process.env.API_PORT ?? 3001);
serve({ fetch: app.fetch, port });
