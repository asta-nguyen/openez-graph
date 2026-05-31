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
    queryFn: () =>
      api.getDocuments({ limit: pageSize, offset: (page - 1) * pageSize }),
  });

export const jobsQueryOptions = queryOptions({
  queryKey: ["jobs"],
  queryFn: api.getAllJobs,
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
