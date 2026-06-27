import { queryOptions } from "@tanstack/react-query";
import { api } from "./api";

export const dashboardQueryOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: ["dashboard", workspaceId],
    queryFn: () => api.getDashboard({ workspaceId }),
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

export const workspaceGraphQueryOptions = (
  id: string,
  filters?: { types?: string[]; minDegree?: number; search?: string; focus?: string },
) =>
  queryOptions({
    queryKey: ["workspace-graph", id, filters],
    queryFn: () => api.getWorkspaceGraph(id, filters),
  });

export const workspaceSymbolsQueryOptions = (
  workspaceId: string,
  type: string | null,
  page: number,
  pageSize: number,
  q: string | null,
) =>
  queryOptions({
    queryKey: ["symbols", workspaceId, type ?? "all", page, pageSize, q ?? ""],
    queryFn: () =>
      api.getWorkspaceSymbols(workspaceId, {
        type: type ?? undefined,
        limit: pageSize,
        offset: (page - 1) * pageSize,
        q: q ?? undefined,
      }),
  });

export const documentsQueryOptions = (
  workspaceId: string,
  page: number,
  pageSize: number,
  search: string = "",
  kind: string = "",
  language: string = "",
  sortBy: string = "",
  sortDir: "asc" | "desc" | "" = "",
) =>
  queryOptions({
    queryKey: [
      "documents",
      workspaceId,
      page,
      pageSize,
      search ?? "",
      kind ?? "",
      language ?? "",
      sortBy ?? "",
      sortDir ?? "",
    ],
    queryFn: () =>
      api.getDocuments({
        workspaceId,
        limit: pageSize,
        offset: (page - 1) * pageSize,
        search: search || undefined,
        kind: kind || undefined,
        language: language || undefined,
        sortBy: sortBy || undefined,
        sortDir: sortDir ? (sortDir as "asc" | "desc") : undefined,
      }),
  });

export const documentChunksQueryOptions = (
  workspaceId: string,
  documentId: string,
  page: number,
  pageSize: number,
) =>
  queryOptions({
    queryKey: ["chunks", workspaceId, documentId, page, pageSize],
    queryFn: () =>
      api.getDocumentChunks({
        workspaceId,
        documentId,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      }),
  });

export const memoriesQueryOptions = (
  workspaceId: string,
  page: number,
  pageSize: number,
) =>
  queryOptions({
    queryKey: ["memories", workspaceId, page, pageSize],
    queryFn: () =>
      api.getWorkspaceMemories({
        workspaceId,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      }),
  });

export const workspaceJobsQueryOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: ["workspace-jobs", workspaceId],
    queryFn: () => api.getWorkspaceJobs(workspaceId),
  });

export const queryLogsQueryOptions = (
  workspaceId: string,
  opts: {
    page: number;
    pageSize: number;
    sort: string;
    fromTime?: string;
    toTime?: string;
  },
) =>
  queryOptions({
    queryKey: [
      "query-logs",
      workspaceId,
      opts.page,
      opts.pageSize,
      opts.sort,
      opts.fromTime ?? "",
      opts.toTime ?? "",
    ],
    queryFn: () =>
      api.getWorkspaceQueryLogs(workspaceId, {
        limit: opts.pageSize,
        offset: (opts.page - 1) * opts.pageSize,
        sort: opts.sort,
        fromTime: opts.fromTime,
        toTime: opts.toTime,
      }),
  });
