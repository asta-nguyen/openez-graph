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
  pinnedAt: string | null;
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

export interface QueryMetrics {
  metricMethod: "selected-full-files-minus-serialized-response";
  totalQueries: number;
  totalTokensReturned: number;
  totalTokensSaved: number;
  totalFilesScanned: number;
  avgTokensPerQuery: number;
  workspaceId: string | null;
  recentQueries: Array<{
    id: string;
    query: string;
    mode: string;
    resultCount: number;
    tokensReturned: number;
    tokensSaved: number;
    filesScanned: number;
    createdAt: string;
  }>;
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
  displayedNodes: number;
  displayedEdges: number;
}

export interface QueryResult {
  answerContext: string;
  sources: Array<{
    path: string;
    startLine?: number;
    endLine?: number;
    score: number;
    reason: string;
  }>;
  graphNodes: Array<{ id: string; type: string; label: string; metadata: Record<string, unknown> }>;
  graphEdges: Array<{ from_node_id: string; to_node_id: string; type: string }>;
  error: string | null;
}

export interface IndexWorkspaceResult {
  workspaceId: string;
  filesScanned: number;
  filesUpdated: number;
  chunksWritten: number;
  embeddingsWritten: number;
  status: "completed";
}

export interface EmbeddingConfigResponse {
  provider: string;
  openaiApiKey: string;
  openaiBaseUrl: string;
  openaiModel: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  localModel: string;
  dbOverrides: string[];
}

export const api = {
  getDashboard: () => request<DashboardSnapshot>("/dashboard"),
  listWorkspaces: () => request<{ ok: boolean; data: WorkspaceListItem[] }>("/workspaces"),
  getWorkspace: (id: string) =>
    request<{ ok: boolean; data: WorkspaceDetail | null }>(`/workspaces/${id}`),
  createWorkspace: (input: {
    name: string;
    rootPath: string;
    includeGlobs?: string[];
    excludeGlobs?: string[];
  }) =>
    request<{ success: boolean; workspace?: WorkspaceListItem; error?: string }>("/workspaces", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  deleteWorkspace: (id: string) =>
    request<{
      success: boolean;
      error?: string;
      report?: {
        workspaceId: string;
        rootPath: string;
        unregistered: boolean;
        dataDirRemoved: boolean;
        dataDirPath: string;
        warnings: string[];
      };
    }>(`/workspaces/${id}`, { method: "DELETE" }),
  pinWorkspace: (id: string, pinned: boolean) =>
    request<{ success: boolean; error?: string }>(`/workspaces/${id}/pin`, {
      method: "PATCH",
      body: JSON.stringify({ pinned }),
    }),
  getWorkspaceGraph: (id: string) => request<WorkspaceGraphData>(`/workspaces/${id}/graph`),
  getDocuments: (params: { limit?: number; offset?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.offset) qs.set("offset", String(params.offset));
    return request<{ items: DocumentRow[]; totalCount: number }>(`/documents?${qs}`);
  },
  runQuery: (input: { workspaceId: string; query: string }) =>
    request<QueryResult>("/query", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  startIndexRun: (workspaceId: string, mode?: string) =>
    request<IndexWorkspaceResult>(`/workspaces/${workspaceId}/index`, {
      method: "POST",
      body: JSON.stringify({ mode: mode ?? "incremental" }),
    }),
  getIndexStatus: (workspaceId: string) =>
    request<{ status: string } | null>(`/workspaces/${workspaceId}/index`),
  validatePath: (rootPath: string) =>
    request<{ valid: boolean; error?: string }>("/validate-path", {
      method: "POST",
      body: JSON.stringify({ rootPath }),
    }),
  getChangelog: () => request<{ content: string }>("/changelog"),
  getMemories: (params: { q?: string; limit?: number; offset?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.q) qs.set("q", params.q);
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.offset) qs.set("offset", String(params.offset));
    return request<{ items: MemoryRow[]; totalCount: number }>(`/memories?${qs}`);
  },
  getMemory: (id: string) => request<{ ok: boolean; data: MemoryRow | null }>(`/memories/${id}`),
  createMemory: (input: {
    title: string;
    content: string;
    tags?: string[];
    source?: string;
    supersedesId?: string;
  }) =>
    request<{ ok: boolean; data: MemoryRow | null }>(`/memories`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  deleteMemory: (id: string) => request<{ ok: boolean }>(`/memories/${id}`, { method: "DELETE" }),
  getMetrics: (workspaceId?: string) =>
    request<QueryMetrics>(workspaceId ? `/metrics?workspaceId=${workspaceId}` : "/metrics"),
  getEmbeddingConfig: () => request<EmbeddingConfigResponse>("/settings/embedding"),
  updateEmbeddingConfig: (
    input: Partial<{
      "embedding.provider": string;
      "embedding.openai_api_key": string;
      "embedding.openai_base_url": string;
      "embedding.openai_model": string;
      "embedding.ollama_base_url": string;
      "embedding.ollama_model": string;
      "embedding.local_model": string;
    }>,
  ) =>
    request<{ ok: boolean; updated: string[] }>("/settings/embedding", {
      method: "PUT",
      body: JSON.stringify(input),
    }),
};
