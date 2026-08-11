import crypto from "node:crypto";

import { createRegistryRepository } from "@openez-graph/db";
import type { RegistryRepository } from "@openez-graph/db";

import { buildGraphGeneration } from "./index-workspace";

export interface GraphServiceDeps {
  registry: Pick<
    RegistryRepository,
    | "getWorkspace"
    | "tryClaimGraphBuild"
    | "refreshGraphBuildLease"
    | "releaseGraphBuild"
    | "completeGraphBuild"
    | "failGraphBuild"
  >;
  buildGraphGeneration(
    workspaceId: string,
    rootPath: string,
    generation: number,
    buildEpoch: number,
  ): Promise<{ nodeCount: number; edgeCount: number; published?: boolean }>;
  now(): string;
  maxWaitMs?: number;
}

/** Lease duration: a builder must refresh within this window or lose ownership. */
const LEASE_DURATION_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const POLL_INTERVAL_MS = 200;
const GRAPH_READY_TIMEOUT_MS = 5 * 60_000;

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
    const deadline = Date.now() + (deps.maxWaitMs ?? GRAPH_READY_TIMEOUT_MS);
    buildAttempt: for (;;) {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for graph build for workspace '${workspaceId}'`);
      }
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
      if (
        workspace.graphStatus === "running" &&
        workspace.graphLeaseExpiresAt &&
        workspace.graphLeaseExpiresAt > new Date().toISOString()
      ) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        continue;
      }

      const generation = workspace.indexGeneration;
      const ownerToken = crypto.randomUUID();
      // Atomic claim with lease: only one process can transition to 'running',
      // unless the previous lease expired (takeover from dead process).
      const buildEpoch = await deps.registry.tryClaimGraphBuild(
        workspaceId,
        ownerToken,
        leaseExpiry(),
      );
      if (buildEpoch === null) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        continue;
      }

      let leaseLost = false;
      let heartbeatBusy = false;
      const heartbeat = setInterval(() => {
        if (heartbeatBusy || leaseLost) return;
        heartbeatBusy = true;
        void deps.registry
          .refreshGraphBuildLease(workspaceId, ownerToken, leaseExpiry())
          .then((refreshed) => {
            if (!refreshed) leaseLost = true;
          })
          .catch(() => {})
          .finally(() => {
            heartbeatBusy = false;
          });
      }, HEARTBEAT_INTERVAL_MS);

      try {
        let targetGeneration = generation;
        for (;;) {
          const counts = await deps.buildGraphGeneration(
            workspaceId,
            workspace.rootPath,
            targetGeneration,
            buildEpoch,
          );
          const current = await deps.registry.getWorkspace(workspaceId);
          if (!current) throw new Error(`Workspace '${workspaceId}' not found`);
          const stillOwner = await deps.registry.refreshGraphBuildLease(
            workspaceId,
            ownerToken,
            leaseExpiry(),
          );
          if (leaseLost || !stillOwner) {
            continue buildAttempt;
          }
          if (counts.published === false) {
            await deps.registry.releaseGraphBuild(workspaceId, ownerToken);
            continue buildAttempt;
          }
          if (current.indexGeneration !== targetGeneration) {
            targetGeneration = current.indexGeneration;
            continue;
          }

          const completed = await deps.registry.completeGraphBuild(
            workspaceId,
            ownerToken,
            targetGeneration,
            {
              nodeCount: counts.nodeCount,
              edgeCount: counts.edgeCount,
              completedAt: deps.now(),
            },
          );
          if (completed) return;
          continue buildAttempt;
        }
      } catch (error) {
        const failed = await deps.registry.failGraphBuild(
          workspaceId,
          ownerToken,
          error instanceof Error ? error.message : String(error),
        );
        if (!failed) continue;
        throw error;
      } finally {
        clearInterval(heartbeat);
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
    tryClaimGraphBuild: (id, owner, lease) =>
      createRegistryRepository().tryClaimGraphBuild(id, owner, lease),
    refreshGraphBuildLease: (id, owner, lease) =>
      createRegistryRepository().refreshGraphBuildLease(id, owner, lease),
    releaseGraphBuild: (id, owner) => createRegistryRepository().releaseGraphBuild(id, owner),
    completeGraphBuild: (id, owner, generation, result) =>
      createRegistryRepository().completeGraphBuild(id, owner, generation, result),
    failGraphBuild: (id, owner, error) =>
      createRegistryRepository().failGraphBuild(id, owner, error),
  },
  buildGraphGeneration,
  now: () => new Date().toISOString(),
});

export const ensureGraphReady = defaultGraphService.ensureGraphReady;
