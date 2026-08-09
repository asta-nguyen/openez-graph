import { createRegistryRepository } from "@openez-graph/db";
import type { RegistryRepository } from "@openez-graph/db";

import { buildGraphGeneration } from "./index-workspace";

export interface GraphServiceDeps {
  registry: RegistryRepository;
  buildGraphGeneration(
    workspaceId: string,
    rootPath: string,
    generation: number,
  ): Promise<{ nodeCount: number; edgeCount: number }>;
  now(): string;
}

export function createGraphService(deps: GraphServiceDeps): {
  ensureGraphReady(workspaceId: string): Promise<void>;
} {
  const graphBuilds = new Map<string, Promise<void>>();

  async function ensureGraphReadyInternal(workspaceId: string): Promise<void> {
    // An index can invalidate while a graph build runs. Retry until the graph
    // represents the generation that was current when it was published.
    for (;;) {
      const workspace = await deps.registry.getWorkspace(workspaceId);
      if (!workspace) throw new Error(`Workspace '${workspaceId}' not found`);
      if (
        workspace.graphStatus === "completed" &&
        workspace.graphGeneration === workspace.indexGeneration
      ) {
        return;
      }

      const generation = workspace.indexGeneration;
      await deps.registry.updateWorkspace(workspaceId, { graphStatus: "running" });

      try {
        const counts = await deps.buildGraphGeneration(workspaceId, workspace.rootPath, generation);
        const current = await deps.registry.getWorkspace(workspaceId);
        if (!current) throw new Error(`Workspace '${workspaceId}' not found`);
        if (current.indexGeneration !== generation) continue;

        await deps.registry.updateWorkspace(workspaceId, {
          graphStatus: "completed",
          graphGeneration: generation,
          nodeCount: counts.nodeCount,
          edgeCount: counts.edgeCount,
          lastGraphBuiltAt: deps.now(),
          lastError: "",
        });
        return;
      } catch (error) {
        const current = await deps.registry.getWorkspace(workspaceId);
        if (current && current.indexGeneration !== generation) continue;
        if (current?.indexGeneration === generation) {
          await deps.registry.updateWorkspace(workspaceId, {
            graphStatus: "failed",
            lastError: error instanceof Error ? error.message : String(error),
          });
        }
        throw error;
      }
    }
  }

  return {
    ensureGraphReady(workspaceId: string): Promise<void> {
      const existing = graphBuilds.get(workspaceId);
      if (existing) return existing;

      const build = ensureGraphReadyInternal(workspaceId).finally(() => {
        if (graphBuilds.get(workspaceId) === build) graphBuilds.delete(workspaceId);
      });
      graphBuilds.set(workspaceId, build);
      return build;
    },
  };
}

const defaultGraphService = createGraphService({
  // Test and CLI lifecycles can close/reconfigure the registry DB after this
  // module loads, so resolve a fresh repository for each operation.
  registry: {
    getWorkspace: (id) => createRegistryRepository().getWorkspace(id),
    updateWorkspace: (id, updates) => createRegistryRepository().updateWorkspace(id, updates),
  } as RegistryRepository,
  buildGraphGeneration,
  now: () => new Date().toISOString(),
});

export const ensureGraphReady = defaultGraphService.ensureGraphReady;
