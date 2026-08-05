import { queryOptions } from "@tanstack/react-query";
import { api } from "./api";

export const dashboardQueryOptions = queryOptions({
  queryKey: ["dashboard"],
  queryFn: api.getDashboard,
});

export const workspacesQueryOptions = queryOptions({
  queryKey: ["workspaces"],
  queryFn: api.listWorkspaces,
});

export const workspaceQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ["workspace", id],
    queryFn: () => api.getWorkspace(id),
  });

export const workspaceGraphQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ["workspace-graph", id],
    queryFn: () => api.getWorkspaceGraph(id),
  });

export const documentsQueryOptions = (page: number, pageSize: number) =>
  queryOptions({
    queryKey: ["documents", page, pageSize],
    queryFn: () => api.getDocuments({ limit: pageSize, offset: (page - 1) * pageSize }),
  });

export const settingsEnvQueryOptions = queryOptions({
  queryKey: ["settings", "env"],
  queryFn: async () => {
    const r = await fetch("/api/settings/env");
    if (!r.ok) throw new Error(`Failed to fetch env settings: ${r.status} ${r.statusText}`);
    return r.json();
  },
  staleTime: Infinity,
});

export const embeddingConfigQueryOptions = queryOptions({
  queryKey: ["settings", "embedding"],
  queryFn: () => api.getEmbeddingConfig(),
  staleTime: 0,
});

export const memoriesQueryOptions = (page: number, pageSize: number) =>
  queryOptions({
    queryKey: ["memories", page, pageSize],
    queryFn: () => api.getMemories({ limit: pageSize, offset: (page - 1) * pageSize }),
  });

export const memoriesSearchQueryOptions = (query: string) =>
  queryOptions({
    queryKey: ["memories", "search", query],
    queryFn: () => api.getMemories({ q: query, limit: 100 }),
  });

export const metricsQueryOptions = (workspaceId?: string) =>
  queryOptions({
    queryKey: ["metrics", workspaceId ?? "default"],
    queryFn: () => api.getMetrics(workspaceId),
    staleTime: 30_000,
  });
