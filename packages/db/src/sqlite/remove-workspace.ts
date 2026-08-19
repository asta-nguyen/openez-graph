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
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return false;
    }
    throw err;
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

  const dataDirPath = getLocalWorkspaceDir(workspace.rootPath);
  let dataDirRemoved = false;
  let rootPathExists: boolean | null = null;

  // Close the native DB handle and remove the data directory BEFORE unregistering.
  // If the data-dir deletion fails, the workspace stays registered so the caller
  // can retry; unregistering first would orphan the data dir with no retry path.
  try {
    rootPathExists = await pathExists(workspace.rootPath);
    if (!rootPathExists) {
      warnings.push(`Workspace root path does not exist on disk: ${workspace.rootPath}`);
    } else {
      closeWorkspaceDb(workspace.rootPath);
      try {
        await fs.rm(dataDirPath, { recursive: true, force: true });
        dataDirRemoved = !(await pathExists(dataDirPath));
      } catch (err) {
        dataDirRemoved = false;
        warnings.push(
          `Failed to delete ${dataDirPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch (err) {
    warnings.push(
      `Could not check workspace root path ${workspace.rootPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Only unregister if the data directory was successfully removed (or was
  // already absent because the root path is gone). If removal failed or we
  // could not confirm the root path state, keep the registry row so the
  // caller can retry.
  let unregistered = false;
  let rootPathAbsent = false;
  if (rootPathExists === false) {
    // Root path confirmed missing (ENOENT) — safe to unregister.
    rootPathAbsent = true;
  } else if (rootPathExists === true) {
    try {
      rootPathAbsent = !(await pathExists(workspace.rootPath));
    } catch (err) {
      warnings.push(
        `Could not re-check workspace root path ${workspace.rootPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  // rootPathExists === null: stat threw a non-ENOENT error; don't assume it's gone.

  if (dataDirRemoved || rootPathAbsent) {
    await repo.deleteWorkspace(workspace.id);
    unregistered = true;
  } else {
    warnings.push(
      "Workspace was not unregistered because the data directory could not be removed. Retry to attempt cleanup again.",
    );
  }

  return {
    workspaceId: workspace.id,
    rootPath: workspace.rootPath,
    unregistered,
    dataDirRemoved,
    dataDirPath,
    warnings,
  };
}
