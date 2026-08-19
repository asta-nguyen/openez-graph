import { queryOptions } from "@tanstack/react-query";
import type {
  DashboardSnapshot,
  DocumentRow,
  EmbeddingConfigResponse,
  MemoryRow,
  QueryMetrics,
  WorkspaceDetail,
  WorkspaceGraphData,
  WorkspaceListItem,
} from "./api";
import { api } from "./api";

interface SettingsEnvResponse {
  EMBEDDING_PROVIDER: string;
  OPENAI_BASE_URL?: string;
  OPENAI_EMBEDDING_MODEL: string;
  OLLAMA_EMBEDDING_MODEL: string;
}

export const dashboardQueryOptions = queryOptions<DashboardSnapshot>({
  queryKey: ["dashboard"],
  queryFn: api.getDashboard,
});

export const workspacesQueryOptions = queryOptions<{ ok: boolean; data: WorkspaceListItem[] }>({
  queryKey: ["workspaces"],
  queryFn: api.listWorkspaces,
});

export const workspaceQueryOptions = (id: string) =>
  queryOptions<{ ok: boolean; data: WorkspaceDetail | null }>({
    queryKey: ["workspace", id],
    queryFn: () => api.getWorkspace(id),
  });

export const workspaceGraphQueryOptions = (id: string) =>
  queryOptions<WorkspaceGraphData>({
    queryKey: ["workspace-graph", id],
    queryFn: () => api.getWorkspaceGraph(id),
  });

export const documentsQueryOptions = (page: number, pageSize: number) =>
  queryOptions<{ items: DocumentRow[]; totalCount: number }>({
    queryKey: ["documents", page, pageSize],
    queryFn: () => api.getDocuments({ limit: pageSize, offset: (page - 1) * pageSize }),
  });

export const settingsEnvQueryOptions = queryOptions<SettingsEnvResponse>({
  queryKey: ["settings", "env"],
  queryFn: async () => {
    const r = await fetch("/api/settings/env");
    if (!r.ok) throw new Error(`Failed to fetch env settings: ${r.status} ${r.statusText}`);
    return r.json();
  },
  staleTime: Infinity,
});

export const embeddingConfigQueryOptions = queryOptions<EmbeddingConfigResponse>({
  queryKey: ["settings", "embedding"],
  queryFn: () => api.getEmbeddingConfig(),
  staleTime: 0,
});

export const memoriesQueryOptions = (page: number, pageSize: number) =>
  queryOptions<{ items: MemoryRow[]; totalCount: number }>({
    queryKey: ["memories", page, pageSize],
    queryFn: () => api.getMemories({ limit: pageSize, offset: (page - 1) * pageSize }),
  });

export const memoriesSearchQueryOptions = (query: string) =>
  queryOptions<{ items: MemoryRow[]; totalCount: number }>({
    queryKey: ["memories", "search", query],
    queryFn: () => api.getMemories({ q: query, limit: 100 }),
  });

export const metricsQueryOptions = (workspaceId?: string) =>
  queryOptions<QueryMetrics>({
    queryKey: ["metrics", workspaceId ?? "default"],
    queryFn: () => api.getMetrics(workspaceId),
    staleTime: 30_000,
  });
