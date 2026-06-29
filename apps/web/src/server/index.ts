import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import crypto from "node:crypto";
import { existsSync, promises as fs, readFileSync } from "node:fs";
import path from "node:path";

import {
  countWorkspaceDocuments,
  countWorkspaceDocumentsFiltered,
  countWorkspaceMemories,
  countGraphNodesByType,
  countWorkspaceQueryLogs,
  cancelIndexRun,
  deleteRegistryWorkspace,
  ensureRegistryWorkspace,
  getLatestGraphRun,
  getLatestIndexRun,
  getRecentGraphRuns,
  getRecentIndexRuns,
  getRecentMemories,
  getRegistryWorkspace,
  getWorkspaceCounts,
  getWorkspaceGraphFiltered,
  getWorkspaceGraphOptimized,
  listDocumentFacets,
  listGraphNodesByType,
  listRegistryWorkspaces,
  listWorkspaceDocuments,
  listWorkspaceDocumentsFiltered,
  listWorkspaceMemories,
  listWorkspaceQueryLogs,
  resolveRegistryDbPath,
  searchGraphNodesByLabel,
  SYMBOL_TYPES,
  updateRegistryWorkspace,
  type WebGraphNode,
  type WebGraphEdge,
  type WebRegistryWorkspace,
} from "./sqlite";

import { memoryQuery } from "@openez-graph/core";
import {
  createRegistryRepository,
  createWorkspaceRepository,
} from "@openez-graph/db";
import { indexWorkspace } from "@openez-graph/indexer";
import { QUERY_SORT_OPTIONS, QUERY_SORT } from "../lib/constants";
import {
  clearActiveRun,
  getActiveRun,
  setActiveRun,
  subscribe,
  unsubscribe,
  updateProgress,
  type IndexProgressEvent,
} from "./run-tracker";

const app = new Hono();
app.use("/*", cors({
  origin: ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:11368", "http://127.0.0.1:11368"],
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
  createdAt: string;
  updatedAt: string;
}) {
  return {
    id: ws.id,
    name: ws.name,
    rootPath: ws.rootPath,
    includeGlobs: ws.includeGlobs
      ? ws.includeGlobs.split("\n").filter(Boolean)
      : [],
    excludeGlobs: ws.excludeGlobs
      ? ws.excludeGlobs.split("\n").filter(Boolean)
      : [],
    status: ws.status,
    indexingStatus: ws.indexingStatus,
    graphStatus: ws.graphStatus,
    lastIndexedAt: ws.lastIndexedAt ? new Date(ws.lastIndexedAt) : null,
    lastGraphBuiltAt: ws.lastGraphBuiltAt
      ? new Date(ws.lastGraphBuiltAt)
      : null,
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
  id: string;
  mode: string;
  status: string;
  filesScanned: number;
  filesUpdated: number;
  chunksWritten: number;
  nodesCreated: number;
  edgesCreated: number;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
}) {
  return run;
}

function safeParseChunkMetadata(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Resolve the default workspace when no explicit `workspaceId` is provided:
 * the most-recently-indexed workspace (sorted by `lastIndexedAt` descending,
 * with null/undefined treated as oldest). Returns `null` when the registry
 * is empty.
 */
function resolveDefaultWorkspace(): WebRegistryWorkspace | null {
  const all = listRegistryWorkspaces();
  if (all.length === 0) return null;
  const sorted = [...all].sort((a, b) => {
    const aTime = a.lastIndexedAt ? new Date(a.lastIndexedAt).getTime() : -Infinity;
    const bTime = b.lastIndexedAt ? new Date(b.lastIndexedAt).getTime() : -Infinity;
    return bTime - aTime;
  });
  // Prefer most-recently-indexed, but only among workspaces with a valid root path
  const valid = sorted.find((ws) => {
    try {
      return ws.rootPath && ws.rootPath !== "/" && existsSync(ws.rootPath);
    } catch {
      return false;
    }
  });
  return valid ?? sorted[0] ?? null;
}

// Dashboard
app.get("/api/dashboard", (c) => {
  try {
    const workspaceIdParam = c.req.query("workspaceId");
    let target: WebRegistryWorkspace | null = null;
    if (workspaceIdParam && workspaceIdParam.trim() !== "") {
      target = getRegistryWorkspace(workspaceIdParam.trim());
    }
    if (!target) {
      target = resolveDefaultWorkspace();
    }
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
      recentMemories: getRecentMemories(target.rootPath, 5),
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
    const workspaceIdParam = c.req.query("workspaceId");
    const search = (c.req.query("search") ?? "").trim();
    const kind = (c.req.query("kind") ?? "").trim();
    const language = (c.req.query("language") ?? "").trim();
    const sortBy = (c.req.query("sortBy") ?? "").trim();
    const rawSortDir = (c.req.query("sortDir") ?? "").trim().toLowerCase();
    const sortDir: "asc" | "desc" = rawSortDir === "asc" ? "asc" : "desc";
    let ws: WebRegistryWorkspace | null = null;
    if (workspaceIdParam && workspaceIdParam.trim() !== "") {
      ws = getRegistryWorkspace(workspaceIdParam.trim());
    }
    if (!ws) {
      ws = resolveDefaultWorkspace();
    }
    if (!ws) {
      return c.json({ items: [], totalCount: 0, kinds: [], languages: [] });
    }
    const filterOpts = {
      search: search || undefined,
      kind: kind || undefined,
      language: language || undefined,
      sortBy: sortBy || undefined,
      sortDir,
    };
    const items = listWorkspaceDocumentsFiltered(ws.rootPath, {
      limit,
      offset,
      ...filterOpts,
    });
    const totalCount = countWorkspaceDocumentsFiltered(ws.rootPath, filterOpts);
    const facets = listDocumentFacets(ws.rootPath, filterOpts);
    return c.json({ items, totalCount, kinds: facets.kinds, languages: facets.languages });
  } catch {
    return c.json({ items: [], totalCount: 0, kinds: [], languages: [] });
  }
});

// Workspace memories (read-only — writes are MCP-only via memory_write)
app.get("/api/workspaces/:id/memories", (c) => {
  try {
    const id = c.req.param("id");
    const ws = getRegistryWorkspace(id);
    if (!ws) return c.json({ items: [], totalCount: 0 });
    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    const items = listWorkspaceMemories(ws.rootPath, limit, offset);
    const totalCount = countWorkspaceMemories(ws.rootPath);
    return c.json({ items, totalCount });
  } catch (err) {
    console.error("Memories endpoint error:", err);
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
    if (!stats.isDirectory())
      return c.json({ valid: false, error: "Path is not a directory" });
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
    if (!rootPath)
      return c.json({ success: false, error: "rootPath is required" });
    try {
      const stats = await fs.stat(rootPath);
      if (!stats.isDirectory())
        return c.json({ success: false, error: "Path is not a directory" });
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

// Do NOT apply compress middleware to this route (Hono #3833 — buffers SSE into one chunk)
app.get("/api/workspaces/:id/index/stream", (c) => {
  const id = c.req.param("id");
  const ws = getRegistryWorkspace(id);
  if (!ws) return c.json({ error: "Workspace not found" }, 404);

  c.header("X-Accel-Buffering", "no");
  c.header("Cache-Control", "no-cache, no-transform");
  c.header("Connection", "keep-alive");

  return streamSSE(c, async (stream) => {
    let aborted = false;
    stream.onAbort(() => {
      aborted = true;
    });

    const send = async (event: string, data: IndexProgressEvent) => {
      if (aborted) return;
      try {
        await stream.writeSSE({ event, data: JSON.stringify(data) });
      } catch {
        // writeSSE can hang after client disconnect (Hono #2068)
        aborted = true;
      }
    };

    const activeRun = getActiveRun(id);
    if (!activeRun) {
      // No active run — emit idle/complete and close
      await send("complete", {
        runId: "",
        phase: "complete",
        percent: 100,
        message: "No active indexing run",
        filesDone: 0,
        filesTotal: 0,
        chunksWritten: 0,
        currentPath: null,
        done: true,
      });
      return;
    }

    // Emit initial "started" event with current progress
    await send("started", activeRun.progress);

    // Register a subscriber for push updates
    const unsub = subscribe(id, (event) => {
      const eventName =
        event.phase === "complete"
          ? "complete"
          : event.phase === "error"
            ? "error"
            : event.phase === "cancelled"
              ? "complete"
              : "progress";
      void send(eventName, event);
      if (event.done) aborted = true;
    });

    // Polling loop for authoritative counts + heartbeat
    let lastHeartbeat = Date.now();
    try {
      while (!aborted) {
        await stream.sleep(2000);
        if (aborted) break;

        // Enrich with authoritative index_runs data
        const latestRun = getLatestIndexRun(ws.rootPath);
        if (latestRun && getActiveRun(id)) {
          updateProgress(id, {
            filesDone: latestRun.filesUpdated,
            filesTotal: latestRun.filesScanned,
            chunksWritten: latestRun.chunksWritten,
          });
        }

        // Heartbeat every 15s
        if (Date.now() - lastHeartbeat >= 15000) {
          const current = getActiveRun(id);
          await send("heartbeat", {
            runId: activeRun.runId,
            phase: current?.progress.phase ?? "indexing",
            percent: current?.progress.percent ?? 0,
            message: current?.progress.message ?? "",
            filesDone: current?.progress.filesDone ?? 0,
            filesTotal: current?.progress.filesTotal ?? 0,
            chunksWritten: current?.progress.chunksWritten ?? 0,
            currentPath: current?.progress.currentPath ?? null,
            done: current?.progress.done ?? false,
            error: current?.progress.error ?? null,
          });
          lastHeartbeat = Date.now();
        }

        // Check if the run completed/failed outside the subscriber path
        const current = getActiveRun(id);
        if (!current || current.progress.done) {
          if (current) {
            await send(
              current.progress.phase === "error" ? "error" : "complete",
              current.progress,
            );
          }
          break;
        }
      }
    } finally {
      unsub();
    }
  });
});

app.post("/api/workspaces/:id/index", async (c) => {
  const id = c.req.param("id");
  const ws = getRegistryWorkspace(id);
  if (!ws)
    return c.json(
      { jobId: null, status: "error", error: "Workspace not found" },
      404
    );
  const body = await c.req
    .json<{ mode?: string }>()
    .catch(() => ({ mode: "incremental" }));
  const mode = (body.mode === "full" ? "full" : "incremental") as
    | "incremental"
    | "full";

  // Reject if a run is already active for this workspace
  if (getActiveRun(id)) {
    return c.json(
      {
        jobId: null,
        status: "error",
        error: "An indexing run is already in progress for this workspace",
      },
      409,
    );
  }

  const abortController = new AbortController();
  updateRegistryWorkspace(id, {
    indexingStatus: "running",
    status: "indexing",
    lastError: null,
  });

  // Fire-and-forget: indexWorkspace creates the index_runs row synchronously
  // at its start, so we can query it after the microtask.
  let runId: string | null = null;
  const runPromise = indexWorkspace({
    workspaceId: id,
    mode,
    abortSignal: abortController.signal,
    onProgress: ({ message, progress }) => {
      try {
        const phase: IndexProgressEvent["phase"] = message.startsWith("Scanning")
          ? "scanning"
          : message.startsWith("Queued")
            ? "indexing"
            : message.startsWith("Indexing")
              ? "indexing"
              : message.startsWith("Finalizing")
                ? "finalizing"
                : message === "Index complete"
                  ? "complete"
                  : "indexing";
        const pathMatch = message.match(/^Indexing (.+)$/);
        const currentPath = pathMatch ? pathMatch[1] : null;
        updateProgress(id, {
          phase,
          percent: progress,
          message,
          currentPath,
          done: phase === "complete",
        });
      } catch {
        // swallow — a dead subscriber must not abort indexing
      }
    },
  });

  // Give indexWorkspace a microtask to create the run row, then capture runId
  await Promise.resolve();
  const latestRun = getLatestIndexRun(ws.rootPath);
  runId = latestRun?.id ?? crypto.randomUUID();

  const initialEvent: IndexProgressEvent = {
    runId,
    phase: "started",
    percent: 0,
    message: "Starting indexing run",
    filesDone: 0,
    filesTotal: 0,
    chunksWritten: 0,
    currentPath: null,
    done: false,
  };
  setActiveRun(id, {
    runId,
    abortController,
    rootPath: ws.rootPath,
    progress: initialEvent,
    subscribers: new Set(),
  });

  void runPromise
    .then(() => {
      // Ensure DB status is updated (in case indexWorkspace didn't do it)
      updateRegistryWorkspace(id, {
        indexingStatus: "completed",
        status: "indexed",
      });
      // Emit terminal event BEFORE clearing so connected subscribers receive it
      updateProgress(id, { phase: "complete", percent: 100, done: true });
      clearActiveRun(id);
    })
    .catch((err) => {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const isCancelled = errorMessage === "Indexing cancelled";
      // Always reset DB status so the UI doesn't get stuck on "running"
      updateRegistryWorkspace(id, {
        indexingStatus: isCancelled ? "cancelled" : "failed",
        status: isCancelled ? "indexed" : "error",
        lastError: isCancelled ? null : errorMessage,
      });
      updateProgress(id, {
        phase: isCancelled ? "cancelled" : "error",
        done: true,
        error: isCancelled ? null : errorMessage,
      });
      if (!isCancelled)
        console.error(`Indexing failed for workspace ${id}:`, err);
      clearActiveRun(id);
    });

  return c.json({ jobId: runId, status: "running" });
});

// Workspace jobs
app.get("/api/workspaces/:id/jobs", (c) => {
  const id = c.req.param("id");
  const ws = getRegistryWorkspace(id);
  if (!ws) return c.json([]);
  return c.json(getRecentIndexRuns(ws.rootPath, 100));
});

app.delete("/api/workspaces/:id/jobs/:jobId", (c) => {
  const id = c.req.param("id");
  const jobId = c.req.param("jobId");
  const activeRun = getActiveRun(id);

  if (!activeRun) {
    return c.json(
      { ok: false, reason: "not_found", message: "No active indexing run for this workspace" },
      404,
    );
  }

  if (activeRun.runId !== jobId) {
    return c.json(
      { ok: false, reason: "mismatch", message: "Job ID does not match the active run" },
      409,
    );
  }

  // Signal the indexer to stop via AbortController
  activeRun.abortController.abort();

  // DB-level fallback: mark the run cancelled directly
  cancelIndexRun(activeRun.rootPath, jobId);

  // Immediate registry update for UI feedback
  updateRegistryWorkspace(id, {
    indexingStatus: "cancelled",
    status: "error",
    lastError: "Indexing cancelled by user",
  });

  clearActiveRun(id);

  return c.json({ ok: true, jobId, status: "cancelled" });
});

// Workspace graph
app.get("/api/workspaces/:id/graph", (c) => {
  const id = c.req.param("id");
  const workspace = getRegistryWorkspace(id);
  if (!workspace) return c.json(null);

  // Parse optional filter query params
  const typesRaw = c.req.query("types")?.trim() ?? "";
  const types = typesRaw ? typesRaw.split(",").map((t) => t.trim()).filter(Boolean) : undefined;

  const minDegreeRaw = c.req.query("minDegree")?.trim() ?? "";
  const minDegreeParsed = parseInt(minDegreeRaw, 10);
  const minDegree = Number.isNaN(minDegreeParsed) ? undefined : minDegreeParsed;

  const search = c.req.query("search")?.trim() || undefined;
  const focus = c.req.query("focus")?.trim() || undefined;

  const hasFilters = !!(types || minDegree !== undefined || search || focus);

  let nodeRows: WebGraphNode[];
  let edgeRows: WebGraphEdge[];

  if (hasFilters) {
    const result = getWorkspaceGraphFiltered(workspace.rootPath, {
      maxNodes: 300,
      maxEdges: 1000,
      types,
      minDegree,
      search,
      focusNodeId: focus,
    });
    nodeRows = result.nodes;
    edgeRows = result.edges;
  } else {
    const result = getWorkspaceGraphOptimized(workspace.rootPath, 300, 1000);
    nodeRows = result.nodes;
    edgeRows = result.edges;
  }

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
    path:
      typeof node.metadata?.path === "string" ? node.metadata.path : undefined,
    startLine:
      typeof node.metadata?.startLine === "number"
        ? node.metadata.startLine
        : undefined,
    endLine:
      typeof node.metadata?.endLine === "number"
        ? node.metadata.endLine
        : undefined,
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

// Workspace document chunks (paginated, read-only)
app.get("/api/workspaces/:id/documents/:docId/chunks", async (c) => {
  try {
    const workspaceId = c.req.param("id");
    const documentId = c.req.param("docId");
    const ws = getRegistryWorkspace(workspaceId);
    if (!ws) return c.json({ items: [], totalCount: 0 });

    const limit = Math.max(1, parseInt(c.req.query("limit") ?? "", 10) || 50);
    const offset = Math.max(0, parseInt(c.req.query("offset") ?? "", 10) || 0);

    const repo = createWorkspaceRepository(ws.rootPath);
    const [rows, totalCount] = await Promise.all([
      repo.listChunksByDocument(documentId, limit, offset),
      repo.countChunksByDocument(documentId),
    ]);

    const items = rows.map((row) => ({
      ...row,
      metadata: safeParseChunkMetadata(row.metadata),
    }));

    return c.json({ items, totalCount });
  } catch (err) {
    console.error("Chunks endpoint error:", err);
    return c.json({ items: [], totalCount: 0 });
  }
});

// Workspace query logs
app.get("/api/workspaces/:id/query-logs", (c) => {
  try {
    const id = c.req.param("id");
    const ws = getRegistryWorkspace(id);
    if (!ws) return c.json({ items: [], totalCount: 0 });

    const limit = Math.max(1, parseInt(c.req.query("limit") ?? "", 10) || 50);
    const offset = Math.max(0, parseInt(c.req.query("offset") ?? "", 10) || 0);
    const sortParam = c.req.query("sort") ?? QUERY_SORT.NEWEST;
    const sort = (QUERY_SORT_OPTIONS.includes(sortParam as never)
      ? sortParam
      : QUERY_SORT.NEWEST) as typeof QUERY_SORT_OPTIONS[number];
    const fromTime = c.req.query("fromTime") || undefined;
    const toTime = c.req.query("toTime") || undefined;

    const items = listWorkspaceQueryLogs(ws.rootPath, { limit, offset, sort, fromTime, toTime });
    const totalCount = countWorkspaceQueryLogs(ws.rootPath, { fromTime, toTime });
    return c.json({ items, totalCount });
  } catch {
    return c.json({ items: [], totalCount: 0 });
  }
});

// Workspace symbols
app.get("/api/workspaces/:id/symbols", (c) => {
  const id = c.req.param("id");
  const workspace = getRegistryWorkspace(id);
  if (!workspace) return c.json(null);

  const typeParam = c.req.query("type")?.trim() || null;
  const type = typeParam || null;
  const q = c.req.query("q")?.trim() ?? "";
  const limit = Math.min(200, Math.max(1, parseInt(c.req.query("limit") ?? "", 10) || 50));
  const offset = Math.max(0, parseInt(c.req.query("offset") ?? "", 10) || 0);

  let nodeRows;
  let totalCount: number;

  if (q) {
    const searchTypes = type ? [type] : [...SYMBOL_TYPES];
    nodeRows = searchGraphNodesByLabel(workspace.rootPath, q, searchTypes);
    totalCount = nodeRows.length;
  } else {
    nodeRows = listGraphNodesByType(workspace.rootPath, type, limit, offset);
    totalCount = countGraphNodesByType(workspace.rootPath, type);
  }

  const items = nodeRows.map((node) => ({
    id: node.id,
    label: node.label,
    type: node.type,
    refId: node.refId,
    metadata: node.metadata,
    path:
      typeof node.metadata?.path === "string" ? node.metadata.path : undefined,
    startLine:
      typeof node.metadata?.startLine === "number"
        ? node.metadata.startLine
        : undefined,
    endLine:
      typeof node.metadata?.endLine === "number"
        ? node.metadata.endLine
        : undefined,
    signature:
      typeof node.metadata?.signature === "string"
        ? node.metadata.signature
        : undefined,
  }));

  return c.json({
    workspaceId: id,
    workspaceName: workspace.name,
    items,
    totalCount,
    types: [...SYMBOL_TYPES],
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

// Reset stale "running" indexing status from crashed/killed server
try {
  const allWorkspaces = listRegistryWorkspaces();
  for (const ws of allWorkspaces) {
    if (ws.indexingStatus === "running") {
      updateRegistryWorkspace(ws.id, {
        indexingStatus: "failed",
        status: "error",
        lastError: "Server restarted during indexing",
      });
    }
  }
} catch (err) {
  console.error("Failed to reset stale indexing status:", err);
}

// ── Static frontend serving ──

function resolveWebDist(): string | null {
  // When running from source (monorepo)
  const sourceDist = path.resolve(import.meta.dirname, "..", "dist");
  if (existsSync(path.join(sourceDist, "index.html"))) return sourceDist;

  // When running from CLI bundle (dist/web copied alongside)
  const cliDist = path.resolve(import.meta.dirname, "web");
  if (existsSync(path.join(cliDist, "index.html"))) return cliDist;

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
