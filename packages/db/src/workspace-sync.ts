import { loadBrainConfig } from "@openez-graph/config";

import { getDb } from "./client";
import { workspaces } from "./schema";

export async function ensureConfigWorkspacesInDb(startDir = process.cwd()): Promise<void> {
  const config = await loadBrainConfig(startDir);
  const db = getDb();

  if (!config.workspaces || config.workspaces.length === 0) {
    return;
  }

  await db
    .insert(workspaces)
    .values(
      config.workspaces.map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        rootPath: workspace.root,
        includeGlobs: workspace.include,
        excludeGlobs: workspace.exclude
      }))
    )
    .onConflictDoNothing({
      target: workspaces.id
    });
}
