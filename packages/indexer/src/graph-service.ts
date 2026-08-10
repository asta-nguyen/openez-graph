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

/** Lease duration: a builder must refresh within this window or lose ownership. */
const LEASE_DURATION_MS = 30_000;
/** Max time to wait for another process's build before giving up. */
const MAX_WAIT_MS = 120_000;
const POLL_INTERVAL_MS = 200;

function leaseExpiry(): string {
  return new Date(Date.now() + LEASE_DURATION_MS).toISOString();
}

export function createGraphService(deps: GraphServiceDeps): {
  ensureGraphReady(workspaceId: string): Promise<void>;
} {
  // Process-local coalescing: if the same process already has a build in
  // flight for this workspace, attach to that promise rather than starting
  // a second one. Cross-process coordination is handled by the atomic
  // `tryClaimGraphBuild` CAS + lease expiry in the registry.
  const graphBuilds = new Map<string, Promise<void>>();

  async function ensureGraphReadyInternal(workspaceId: string): Promise<void> {
    let waitStart = 0;

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
      // finish or for its lease to expire (then we can takeover).
      if (workspace.graphStatus === "running") {
        if (waitStart === 0) waitStart = Date.now();
        if (Date.now() - waitStart > MAX_WAIT_MS) {
          // Stale running status that never cleared — force a claim attempt.
          // The CAS will succeed if the lease has expired.
          waitStart = 0;
        } else {
          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
          continue;
        }
      }

      const generation = workspace.indexGeneration;
      // Atomic claim with lease: only one process can transition to 'running',
      // unless the previous lease expired (takeover from dead process).
      const claimed = await deps.registry.tryClaimGraphBuild(workspaceId, leaseExpiry());
      if (!claimed) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        continue;
      }

      try {
        // Build the graph. The build writes directly to live tables, but we
        // verify the generation is still current before publishing the result.
        // If index invalidated during the build, we retry with the new generation.
        const counts = await deps.buildGraphGeneration(workspaceId, workspace.rootPath, generation);

        // Re-check: did index invalidate while we were building?
        const current = await deps.registry.getWorkspace(workspaceId);
        if (!current) throw new Error(`Workspace '${workspaceId}' not found`);
        if (current.indexGeneration !== generation) {
          // A newer index generation exists — our build is stale. Retry.
          continue;
        }

        // Publish: only if we still own the lease.
        const stillOwner = await deps.registry.refreshGraphBuildLease(workspaceId, leaseExpiry());
        if (!stillOwner) {
          // Another process took over — let them handle it.
          continue;
        }

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
    tryClaimGraphBuild: (id, lease) => createRegistryRepository().tryClaimGraphBuild(id, lease),
    refreshGraphBuildLease: (id, lease) =>
      createRegistryRepository().refreshGraphBuildLease(id, lease),
  } as RegistryRepository,
  buildGraphGeneration,
  now: () => new Date().toISOString(),
});

export const ensureGraphReady = defaultGraphService.ensureGraphReady;
