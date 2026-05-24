"use server";

import { revalidatePath } from "next/cache";

import crypto from "node:crypto";
import { promises as fs } from "fs";
import path from "path";

import {
  deleteRegistryWorkspace,
  ensureRegistryWorkspace,
  getLatestGraphRun,
  getLatestIndexRun,
  getRecentGraphRuns,
  getRecentIndexRuns,
  getRegistryWorkspace,
  listRegistryWorkspaces,
  updateRegistryWorkspace
} from "../../server/sqlite";
import { withRegistry } from "../../lib/registry-access";
import type { RegistryResult } from "../../lib/registry-access";

export interface CreateWorkspaceInput {
  name: string;
  rootPath: string;
  includeGlobs?: string[];
  excludeGlobs?: string[];
}

interface RunShim {
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

export interface WorkspaceListItem {
  id: string;
  name: string;
  rootPath: string;
  includeGlobs: string[];
  excludeGlobs: string[];
  status: string;
  indexingStatus: string;
  graphStatus: string;
  lastIndexedAt: Date | null;
  lastGraphBuiltAt: Date | null;
  documentCount: number;
  chunkCount: number;
  nodeCount: number;
  edgeCount: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  latestIndexRun: RunShim | null;
  latestGraphRun: RunShim | null;
}

export interface WorkspaceDetail extends WorkspaceListItem {
  recentIndexRuns: RunShim[];
  recentGraphRuns: RunShim[];
}

const DEFAULT_INCLUDE_GLOBS = [
  "src/**/*.{ts,tsx,js,jsx}",
  "app/**/*.{ts,tsx}",
  "pages/**/*.{ts,tsx}",
  "lib/**/*.{ts,tsx}",
  "**/*.md"
];

const DEFAULT_EXCLUDE_GLOBS = [
  "node_modules/**",
  "**/node_modules/**",
  ".next/**",
  "dist/**",
  "build/**",
  ".git/**",
  "coverage/**",
  "**/.turbo/**"
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

export async function createWorkspace(input: CreateWorkspaceInput): Promise<{
  success: boolean;
  workspace?: WorkspaceListItem;
  error?: string;
}> {
  try {
    try {
      const stats = await fs.stat(input.rootPath);
      if (!stats.isDirectory()) {
        return { success: false, error: "Path is not a directory" };
      }
    } catch {
      return { success: false, error: "Directory does not exist or is not accessible" };
    }

    if (!input.name || input.name.trim().length === 0) {
      return { success: false, error: "Workspace name is required" };
    }

    const ws = ensureRegistryWorkspace({
      name: input.name.trim(),
      rootPath: path.resolve(input.rootPath),
      includeGlobs: (input.includeGlobs ?? DEFAULT_INCLUDE_GLOBS).join("\n"),
      excludeGlobs: (input.excludeGlobs ?? DEFAULT_EXCLUDE_GLOBS).join("\n"),
    });

    revalidatePath("/workspaces");
    return { success: true, workspace: { ...mapWorkspace(ws), latestIndexRun: null, latestGraphRun: null } };
  } catch (err) {
    console.error("Failed to create workspace:", err);
    return { success: false, error: "Failed to create workspace" };
  }
}

export async function listWorkspaces(): Promise<RegistryResult<WorkspaceListItem[]>> {
  return withRegistry(async () => {
    const all = listRegistryWorkspaces();
    return all.map((ws) => ({
      ...mapWorkspace(ws),
      latestIndexRun: getLatestIndexRun(ws.rootPath),
      latestGraphRun: getLatestGraphRun(ws.rootPath)
    }));
  });
}

export async function getWorkspace(id: string): Promise<RegistryResult<WorkspaceDetail | null>> {
  return withRegistry(async () => {
    const ws = getRegistryWorkspace(id);
    if (!ws) return null;
    return {
      ...mapWorkspace(ws),
      latestIndexRun: getLatestIndexRun(ws.rootPath),
      latestGraphRun: getLatestGraphRun(ws.rootPath),
      recentIndexRuns: getRecentIndexRuns(ws.rootPath),
      recentGraphRuns: getRecentGraphRuns(ws.rootPath)
    };
  });
}

export async function validateWorkspacePath(rootPath: string): Promise<{
  valid: boolean;
  error?: string;
}> {
  try {
    const stats = await fs.stat(rootPath);
    if (!stats.isDirectory()) {
      return { valid: false, error: "Path is not a directory" };
    }
    return { valid: true };
  } catch {
    return { valid: false, error: "Directory does not exist or is not accessible" };
  }
}

export async function updateWorkspaceStatus(
  id: string,
  updates: {
    status?: "pending" | "indexing" | "indexed" | "error";
    indexingStatus?: "pending" | "running" | "completed" | "failed";
    graphStatus?: "pending" | "running" | "completed" | "failed";
    lastIndexedAt?: Date | null;
    lastGraphBuiltAt?: Date | null;
    documentCount?: number;
    chunkCount?: number;
    nodeCount?: number;
    edgeCount?: number;
    lastError?: string | null;
  }
): Promise<void> {
  updateRegistryWorkspace(id, {
    status: updates.status,
    indexingStatus: updates.indexingStatus,
    graphStatus: updates.graphStatus,
    lastIndexedAt: updates.lastIndexedAt?.toISOString(),
    lastGraphBuiltAt: updates.lastGraphBuiltAt?.toISOString(),
    documentCount: updates.documentCount,
    chunkCount: updates.chunkCount,
    nodeCount: updates.nodeCount,
    edgeCount: updates.edgeCount,
    lastError: updates.lastError ?? undefined,
  });
  revalidatePath("/workspaces");
  revalidatePath(`/workspaces/${id}`);
}

export async function syncWorkspaceIndexingState(workspaceId: string): Promise<void> {
  // Indexing state is now managed by the CLI; no-op for legacy queue flow
  return;
}

export async function deleteWorkspace(id: string): Promise<{ success: boolean; error?: string }> {
  try {
    deleteRegistryWorkspace(id);
    revalidatePath("/workspaces");
    return { success: true };
  } catch (err) {
    console.error("Failed to delete workspace:", err);
    return { success: false, error: "Failed to delete workspace" };
  }
}

export async function startIndexRun(
  workspaceId: string,
  _mode: "incremental" | "full" = "incremental"
): Promise<{ success: boolean; runId?: string; error?: string }> {
  try {
    updateRegistryWorkspace(workspaceId, {
      indexingStatus: "running",
      status: "indexing",
      lastError: undefined,
    });
    revalidatePath("/workspaces");
    revalidatePath(`/workspaces/${workspaceId}`);
    return { success: true, runId: crypto.randomUUID() };
  } catch (err) {
    console.error("Failed to start index run:", err);
    return { success: false, error: "Failed to start index run" };
  }
}

export async function completeIndexRun(
  _runId: string,
  result: {
    status: "completed" | "failed";
    filesScanned?: number;
    filesUpdated?: number;
    chunksWritten?: number;
    embeddingsWritten?: number;
    errorMessage?: string;
  }
): Promise<void> {
  try {
    // Indexing updates are handled by the CLI directly;
    // this stub exists only for legacy queue compatibility.
    if (result.status === "completed") return;
    console.error("Index run failed:", result.errorMessage);
  } catch (err) {
    console.error("completeIndexRun error:", err);
  }
}

export async function startGraphRun(
  workspaceId: string,
  _mode: "incremental" | "full" = "incremental"
): Promise<{ success: boolean; runId?: string; error?: string }> {
  return { success: false, error: "Graph runs are managed by the CLI. Use `openez graph` to build the graph." };
}

export async function completeGraphRun(
  _runId: string,
  _result: {
    status: "completed" | "failed";
    nodesCreated?: number;
    edgesCreated?: number;
    errorMessage?: string;
  }
): Promise<void> {
  return;
}
