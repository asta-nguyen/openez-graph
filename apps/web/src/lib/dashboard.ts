import "server-only";

import {
  countWorkspaceDocuments,
  getLatestIndexRun,
  getRegistryWorkspace,
  getWorkspaceCounts,
  listRegistryWorkspaces,
  listWorkspaceDocuments
} from "../server/sqlite";

interface RunRow {
  id: string;
  startedAt: string;
  mode: string;
  status: string;
  filesUpdated: number;
  filesScanned: number;
  errorMessage: string | null;
}

interface DocRow {
  id: string;
  path: string;
  kind: string;
  language?: string;
  updatedAt?: string;
}

interface MemoryRow {
  id: string;
  title: string;
  source: string;
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
  recentDocuments: DocRow[];
  recentMemories: MemoryRow[];
  databaseAvailable: boolean;
}

function numericCount(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function emptySnapshot(workspace: { id: string; name: string; root: string }): DashboardSnapshot {
  return {
    workspace,
    stats: {
      documents: 0,
      chunks: 0,
      graphNodes: 0,
      graphEdges: 0,
      memories: 0
    },
    recentRuns: [],
    recentDocuments: [],
    recentMemories: [],
    databaseAvailable: false
  };
}

export async function getDashboardSnapshot(workspaceId?: string): Promise<DashboardSnapshot> {
  try {
    const workspace = workspaceId ? getRegistryWorkspace(workspaceId) : null;

    if (!workspace) {
      const all = listRegistryWorkspaces();
      const target = all[0];
      if (!target) {
        return emptySnapshot({ id: "", name: "No workspace", root: "" });
      }
      const counts = getWorkspaceCounts(target.rootPath);

      return {
        workspace: { id: target.id, name: target.name, root: target.rootPath },
        stats: {
          documents: numericCount(counts.documents),
          chunks: numericCount(counts.chunks),
          graphNodes: numericCount(counts.nodes),
          graphEdges: numericCount(counts.edges),
          memories: numericCount(counts.memories)
        },
        recentRuns: (() => {
          const run = getLatestIndexRun(target.rootPath);
          return run ? [run] : [];
        })(),
        recentDocuments: listWorkspaceDocuments(target.rootPath, 10),
        recentMemories: [],
        databaseAvailable: true
      };
    }

    const counts = getWorkspaceCounts(workspace.rootPath);

    return {
      workspace: { id: workspace.id, name: workspace.name, root: workspace.rootPath },
      stats: {
        documents: numericCount(counts.documents),
        chunks: numericCount(counts.chunks),
        graphNodes: numericCount(counts.nodes),
        graphEdges: numericCount(counts.edges),
        memories: numericCount(counts.memories)
      },
      recentRuns: (() => {
        const run = getLatestIndexRun(workspace.rootPath);
        return run ? [run] : [];
      })(),
      recentDocuments: listWorkspaceDocuments(workspace.rootPath, 10),
      recentMemories: [],
      databaseAvailable: true
    };
  } catch {
    return emptySnapshot({ id: "", name: "No workspace", root: "" });
  }
}

export async function getRecentDocuments(
  opts: { workspaceId?: string; limit?: number; offset?: number } = {}
): Promise<{ items: DocRow[]; totalCount: number }> {
  const { workspaceId, limit = 50, offset = 0 } = opts;
  try {
    const workspace = workspaceId ? getRegistryWorkspace(workspaceId) : null;
    if (!workspace) {
      const all = listRegistryWorkspaces();
      if (all.length === 0) return { items: [], totalCount: 0 };
      const fallback = all[0];
      const items = listWorkspaceDocuments(fallback.rootPath, limit, offset);
      const totalCount = countWorkspaceDocuments(fallback.rootPath);
      return { items, totalCount };
    }

    const items = listWorkspaceDocuments(workspace.rootPath, limit, offset);
    const totalCount = countWorkspaceDocuments(workspace.rootPath);
    return { items, totalCount };
  } catch {
    return { items: [], totalCount: 0 };
  }
}
