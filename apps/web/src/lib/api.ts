const API_BASE = "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `API error: ${res.status}`);
  }
  return res.json();
}

export interface WorkspaceListItem {
  id: string;
  name: string;
  rootPath: string;
  includeGlobs: string[];
  excludeGlobs: string[];
  status: string;
  indexingStatus: string;
  graphStatus: string;
  lastIndexedAt: string | null;
  lastGraphBuiltAt: string | null;
  documentCount: number;
  chunkCount: number;
  nodeCount: number;
  edgeCount: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  latestIndexRun: RunRow | null;
  latestGraphRun: RunRow | null;
}

export interface WorkspaceDetail extends WorkspaceListItem {
  recentIndexRuns: RunRow[];
  recentGraphRuns: RunRow[];
}

export interface RunRow {
  id: string;
  mode: string;
  status: string;
  filesScanned: number;
  filesUpdated: number;
  chunksWritten: number;
  embeddingsWritten: number;
  nodesCreated: number;
  edgesCreated: number;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface DocumentRow {
  id: string;
  path: string;
  kind: string;
  language?: string;
  updatedAt?: string;
}

export interface DashboardSnapshot {
  workspace: { id: string; name: string; root: string };
  stats: {
    documents: number;
    chunks: number;
    graphNodes: number;
    graphEdges: number;
    memories: number;
  };
  recentRuns: RunRow[];
  recentDocuments: DocumentRow[];
  recentMemories: Array<{ id: string; title: string; source: string }>;
  databaseAvailable: boolean;
}

export interface GraphNodeData {
  id: string;
  label: string;
  type: string;
  degree: number;
  metadata: Record<string, unknown>;
  path?: string;
  startLine?: number;
  endLine?: number;
  refId?: string | null;
}

export interface GraphEdgeData {
  id: string;
  source: string;
  target: string;
  type: string;
  weight: number;
}

export interface WorkspaceGraphData {
  workspaceId: string;
  workspaceName: string;
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
  nodeTypes: string[];
  edgeTypes: string[];
  totalNodes: number;
  totalEdges: number;
}

export interface QueryResult {
  answerContext: string;
  sources: Array<{ path: string; startLine?: number; endLine?: number; score: number; reason: string }>;
  graphNodes: Array<{ id: string; type: string; label: string; metadata: Record<string, unknown> }>;
  graphEdges: Array<{ from_node_id: string; to_node_id: string; type: string }>;
  error: string | null;
}

export const api = {
  getDashboard: () => request<DashboardSnapshot>("/dashboard"),
  listWorkspaces: () => request<{ ok: boolean; data: WorkspaceListItem[] }>("/workspaces"),
  getWorkspace: (id: string) => request<{ ok: boolean; data: WorkspaceDetail | null }>(`/workspaces/${id}`),
  createWorkspace: (input: { name: string; rootPath: string; includeGlobs?: string[]; excludeGlobs?: string[] }) =>
    request<{ success: boolean; workspace?: WorkspaceListItem; error?: string }>("/workspaces", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  deleteWorkspace: (id: string) => request<{ success: boolean; error?: string }>(`/workspaces/${id}`, { method: "DELETE" }),
  getWorkspaceGraph: (id: string) => request<WorkspaceGraphData>(`/workspaces/${id}/graph`),
  getDocuments: (params: { limit?: number; offset?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.offset) qs.set("offset", String(params.offset));
    return request<{ items: DocumentRow[]; totalCount: number }>(`/documents?${qs}`);
  },
  getAllJobs: () => request<RunRow[]>("/jobs"),
  runQuery: (input: { workspaceId: string; query: string }) =>
    request<QueryResult>("/query", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  startIndexRun: (workspaceId: string, mode?: string) =>
    request<{ jobId: string; status: string }>(`/workspaces/${workspaceId}/index`, {
      method: "POST",
      body: JSON.stringify({ mode: mode ?? "incremental" }),
    }),
  getIndexStatus: (workspaceId: string) =>
    request<{ status: string } | null>(`/workspaces/${workspaceId}/index`),
  getWorkspaceJobs: (workspaceId: string) =>
    request<RunRow[]>(`/workspaces/${workspaceId}/jobs`),
  cancelJob: (workspaceId: string, jobId: string) =>
    request<{ ok: boolean }>(`/workspaces/${workspaceId}/jobs/${jobId}`, { method: "DELETE" }),
  validatePath: (rootPath: string) =>
    request<{ valid: boolean; error?: string }>("/validate-path", {
      method: "POST",
      body: JSON.stringify({ rootPath }),
    }),
};
