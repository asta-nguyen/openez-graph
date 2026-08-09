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
  // Process-local coalescing: if the same process already has a build in
  // flight for this workspace, attach to that promise rather than starting
  // a second one. Cross-process coordination is handled by the atomic
  // `tryClaimGraphBuild` CAS in the registry.
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

      // If another process is already building this graph, wait for it to
      // finish, then re-check the state. This avoids duplicate builds across
      // web/MCP/CLI processes that share the same registry DB.
      if (workspace.graphStatus === "running") {
        await new Promise((resolve) => setTimeout(resolve, 200));
        continue;
      }

      const generation = workspace.indexGeneration;
      // Atomic claim: only one process can transition to 'running'.
      const claimed = await deps.registry.tryClaimGraphBuild(workspaceId);
      if (!claimed) {
        // Another process just claimed it — wait and retry.
        await new Promise((resolve) => setTimeout(resolve, 200));
        continue;
      }

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
    tryClaimGraphBuild: (id) => createRegistryRepository().tryClaimGraphBuild(id),
  } as RegistryRepository,
  buildGraphGeneration,
  now: () => new Date().toISOString(),
});

export const ensureGraphReady = defaultGraphService.ensureGraphReady;
