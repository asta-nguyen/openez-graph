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
  sizeBytes: number;
  chunkCount: number;
  symbolCount: number;
  lastIndexedAt?: string;
  updatedAt?: string;
}

export interface ChunkRow {
  id: string;
  documentId: string;
  chunkIndex: number;
  heading: string | null;
  content: string;
  tokenCount: number;
  contentHash: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ChunkDocumentResponse {
  items: ChunkRow[];
  totalCount: number;
}

export interface DocumentsResponse {
  items: DocumentRow[];
  totalCount: number;
  kinds: string[];
  languages: string[];
}

export interface MemoryRow {
  id: string;
  title: string;
  content: string;
  tags: string[];
  source: string;
  supersedesId: string | null;
  createdAt: string;
  updatedAt: string;
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

export interface QueryLogRow {
  id: string;
  query: string;
  mode: string;
  resultCount: number;
  latencyMs: number | null;
  retrievedChunks: Array<{ chunkId: string; score: number; documentId: string; path: string }>;
  createdAt: string;
}

export interface QueryLogsResponse {
  items: QueryLogRow[];
  totalCount: number;
}

export interface SymbolRow {
  id: string;
  label: string;
  type: string;
  refId: string | null;
  metadata: Record<string, unknown>;
  path?: string;
  startLine?: number;
  endLine?: number;
  signature?: string;
}

export interface WorkspaceSymbolsResponse {
  workspaceId: string;
  workspaceName: string;
  items: SymbolRow[];
  totalCount: number;
  types: string[];
}

export const api = {
  getDashboard: (params: { workspaceId?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.workspaceId) qs.set("workspaceId", params.workspaceId);
    return request<DashboardSnapshot>(`/dashboard?${qs}`);
  },
  listWorkspaces: () => request<{ ok: boolean; data: WorkspaceListItem[] }>("/workspaces"),
  getWorkspace: (id: string) => request<{ ok: boolean; data: WorkspaceDetail | null }>(`/workspaces/${id}`),
  createWorkspace: (input: { name: string; rootPath: string; includeGlobs?: string[]; excludeGlobs?: string[] }) =>
    request<{ success: boolean; workspace?: WorkspaceListItem; error?: string }>("/workspaces", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  deleteWorkspace: (id: string) => request<{ success: boolean; error?: string }>(`/workspaces/${id}`, { method: "DELETE" }),
  getWorkspaceGraph: (
    id: string,
    filters?: { types?: string[]; minDegree?: number; search?: string; focus?: string },
  ) => {
    if (!filters) return request<WorkspaceGraphData>(`/workspaces/${id}/graph`);
    const qs = new URLSearchParams();
    if (filters.types && filters.types.length > 0) qs.set("types", filters.types.join(","));
    if (filters.minDegree !== undefined) qs.set("minDegree", String(filters.minDegree));
    if (filters.search) qs.set("search", filters.search);
    if (filters.focus) qs.set("focus", filters.focus);
    const queryStr = qs.toString();
    return request<WorkspaceGraphData>(
      queryStr ? `/workspaces/${id}/graph?${queryStr}` : `/workspaces/${id}/graph`,
    );
  },
  getWorkspaceSymbols: (
    id: string,
    params: { type?: string; limit?: number; offset?: number; q?: string } = {},
  ) => {
    const qs = new URLSearchParams();
    if (params.type) qs.set("type", params.type);
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.offset) qs.set("offset", String(params.offset));
    if (params.q) qs.set("q", params.q);
    return request<WorkspaceSymbolsResponse>(`/workspaces/${id}/symbols?${qs}`);
  },
  getDocuments: (
    params: {
      workspaceId?: string;
      limit?: number;
      offset?: number;
      search?: string;
      kind?: string;
      language?: string;
      sortBy?: string;
      sortDir?: "asc" | "desc";
    } = {},
  ) => {
    const qs = new URLSearchParams();
    if (params.workspaceId) qs.set("workspaceId", params.workspaceId);
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.offset) qs.set("offset", String(params.offset));
    if (params.search) qs.set("search", params.search);
    if (params.kind) qs.set("kind", params.kind);
    if (params.language) qs.set("language", params.language);
    if (params.sortBy) qs.set("sortBy", params.sortBy);
    if (params.sortDir) qs.set("sortDir", params.sortDir);
    return request<DocumentsResponse>(`/documents?${qs}`);
  },
  getDocumentChunks: (
    params: { workspaceId: string; documentId: string; limit?: number; offset?: number },
  ) => {
    const qs = new URLSearchParams();
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.offset) qs.set("offset", String(params.offset));
    return request<ChunkDocumentResponse>(
      `/workspaces/${params.workspaceId}/documents/${params.documentId}/chunks?${qs}`,
    );
  },
  getWorkspaceMemories: (params: { workspaceId: string; limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    qs.set("workspaceId", params.workspaceId);
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.offset) qs.set("offset", String(params.offset));
    return request<{ items: MemoryRow[]; totalCount: number }>(`/workspaces/${params.workspaceId}/memories?${qs}`);
  },
  getWorkspaceQueryLogs: (
    id: string,
    params: { limit?: number; offset?: number; sort?: string; fromTime?: string; toTime?: string } = {},
  ) => {
    const qs = new URLSearchParams();
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.offset) qs.set("offset", String(params.offset));
    if (params.sort) qs.set("sort", params.sort);
    if (params.fromTime) qs.set("fromTime", params.fromTime);
    if (params.toTime) qs.set("toTime", params.toTime);
    return request<QueryLogsResponse>(`/workspaces/${id}/query-logs?${qs}`);
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
    request<{ ok: boolean; jobId?: string; status?: string; reason?: string; message?: string }>(`/workspaces/${workspaceId}/jobs/${jobId}`, { method: "DELETE" }),
  validatePath: (rootPath: string) =>
    request<{ valid: boolean; error?: string }>("/validate-path", {
      method: "POST",
      body: JSON.stringify({ rootPath }),
    }),
};
