import fs from "node:fs/promises";

import { getLocalWorkspaceDir } from "./local-workspace";
import { createRegistryRepository } from "./repository";
import { closeWorkspaceDb } from "./workspace-db";

export interface RemoveWorkspaceSelector {
  id?: string;
  rootPath?: string;
}

export interface RemoveWorkspaceReport {
  workspaceId: string;
  rootPath: string;
  unregistered: boolean;
  dataDirRemoved: boolean;
  dataDirPath: string;
  warnings: string[];
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

export async function removeWorkspace(
  selector: RemoveWorkspaceSelector,
): Promise<RemoveWorkspaceReport | null> {
  const repo = createRegistryRepository();
  const workspace = selector.id
    ? await repo.getWorkspace(selector.id)
    : selector.rootPath
      ? await repo.getWorkspaceByPath(selector.rootPath)
      : null;

  if (!workspace) return null;

  const warnings: string[] = [];
  if (workspace.indexingStatus === "running" || workspace.graphStatus === "running") {
    warnings.push(
      "Workspace appears to be indexing or building its graph; stop the process first to avoid stale writes.",
    );
  }

  await repo.deleteWorkspace(workspace.id);

  const dataDirPath = getLocalWorkspaceDir(workspace.rootPath);
  let dataDirRemoved = false;

  if (!(await pathExists(workspace.rootPath))) {
    warnings.push(`Workspace root path does not exist on disk: ${workspace.rootPath}`);
  } else {
    closeWorkspaceDb(workspace.rootPath);
    try {
      dataDirRemoved = await pathExists(dataDirPath);
      await fs.rm(dataDirPath, { recursive: true, force: true });
    } catch (err) {
      dataDirRemoved = false;
      warnings.push(
        `Failed to delete ${dataDirPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    workspaceId: workspace.id,
    rootPath: workspace.rootPath,
    unregistered: true,
    dataDirRemoved,
    dataDirPath,
    warnings,
  };
}
