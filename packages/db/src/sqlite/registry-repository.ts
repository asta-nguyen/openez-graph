import fs from "node:fs";
import path from "node:path";

import { and, eq, isNull, lt, ne, or, sql } from "drizzle-orm";

import { getRegistryDb } from "./registry-db";
import * as schema from "./schema";
import { decryptValue, encryptValue, isSensitiveKey } from "./secure-storage";
import type { RegistryRepository, RegistryWorkspace } from "./types";

function normalizeRootPath(rootPath: string): string {
  const resolved = path.resolve(rootPath.trim());
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function slugifyWorkspaceSegment(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "workspace";
}

function displayNameForSuffix(baseName: string, suffix: number): string {
  return suffix <= 0 ? baseName : `${baseName} (${suffix + 1})`;
}

function mapWorkspaceRow(row: typeof schema.workspaces.$inferSelect): RegistryWorkspace {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.rootPath,
    includeGlobs: row.includeGlobs || "",
    excludeGlobs: row.excludeGlobs || "",
    // SAFETY: The workspaces table stores status as a TEXT column; application
    // code only writes the literal values defined in the RegistryWorkspace
    // union. The cast narrows the Drizzle `string` inference to that union.
    status: row.status as RegistryWorkspace["status"],
    // SAFETY: indexing_status is a TEXT column whose values are constrained
    // by application code to the RegistryWorkspace["indexingStatus"] union.
    indexingStatus: row.indexingStatus as RegistryWorkspace["indexingStatus"],
    indexBuildOwner: row.indexBuildOwner ?? undefined,
    indexLeaseExpiresAt: row.indexLeaseExpiresAt ?? undefined,
    // SAFETY: graph_status is a TEXT column whose values are constrained
    // by application code to the RegistryWorkspace["graphStatus"] union.
    graphStatus: row.graphStatus as RegistryWorkspace["graphStatus"],
    indexGeneration: row.indexGeneration,
    graphGeneration: row.graphGeneration,
    graphLeaseExpiresAt: row.graphLeaseExpiresAt ?? undefined,
    lastIndexedAt: row.lastIndexedAt ?? undefined,
    lastGraphBuiltAt: row.lastGraphBuiltAt ?? undefined,
    documentCount: row.documentCount,
    chunkCount: row.chunkCount,
    nodeCount: row.nodeCount,
    edgeCount: row.edgeCount,
    lastError: row.lastError ?? undefined,
    pinnedAt: row.pinnedAt ?? undefined,
    pinOrder: row.pinOrder ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Drizzle's bun-sqlite driver types `.run()` as `void` even though the
 * underlying session returns a `Changes` object (`{ changes, lastInsertRowid }`)
 * at runtime. This helper reads the affected-row count safely.
 */
function runChanges(result: any): number {
  // SAFETY: bun-sqlite's Drizzle session returns `import("bun:sqlite").Changes`
  // from `run()` at runtime, but the public builder type is `void`. The `any`
  // parameter accepts the void-typed builder result and reads `changes` safely.
  return result.changes;
}

function compareWorkspaces(a: RegistryWorkspace, b: RegistryWorkspace): number {
  if (a.pinnedAt && !b.pinnedAt) return -1;
  if (!a.pinnedAt && b.pinnedAt) return 1;
  if (a.pinnedAt && b.pinnedAt) {
    // Use monotonic pin_order as the primary tiebreaker (deterministic
    // regardless of wall-clock resolution), then pinned_at as a fallback.
    const aOrder = a.pinOrder ?? -Infinity;
    const bOrder = b.pinOrder ?? -Infinity;
    if (aOrder !== bOrder) return bOrder - aOrder;
    if (a.pinnedAt !== b.pinnedAt) return b.pinnedAt.localeCompare(a.pinnedAt);
  }
  return b.createdAt.localeCompare(a.createdAt);
}

export function createRegistryRepository(): RegistryRepository {
  const db = getRegistryDb();

  const repo: RegistryRepository = {
    async listWorkspaces(): Promise<RegistryWorkspace[]> {
      const rows = db.select().from(schema.workspaces).all();
      return rows.map(mapWorkspaceRow).sort(compareWorkspaces);
    },

    async getWorkspace(id: string): Promise<RegistryWorkspace | null> {
      const row = db.select().from(schema.workspaces).where(eq(schema.workspaces.id, id)).get();
      return row ? mapWorkspaceRow(row) : null;
    },

    async getWorkspaceByPath(rootPath: string): Promise<RegistryWorkspace | null> {
      const normalizedRootPath = normalizeRootPath(rootPath);
      const row = db
        .select()
        .from(schema.workspaces)
        .where(eq(schema.workspaces.rootPath, normalizedRootPath))
        .get();
      if (row) return mapWorkspaceRow(row);

      const allRows = db.select().from(schema.workspaces).all();
      const legacyRow = allRows.find(
        (candidate) => normalizeRootPath(candidate.rootPath) === normalizedRootPath,
      );
      return legacyRow ? mapWorkspaceRow(legacyRow) : null;
    },

    async ensureWorkspace(input): Promise<RegistryWorkspace> {
      const normalizedRootPath = normalizeRootPath(input.rootPath);
      const existing = await this.getWorkspaceByPath(normalizedRootPath);
      if (existing) {
        return existing;
      }

      const requestedName = (
        input.name?.trim() ||
        normalizeRootPath(normalizedRootPath).split(/[\\/]/).pop() ||
        "workspace"
      ).trim();
      const baseId = slugifyWorkspaceSegment(requestedName);
      const allWorkspaces = await this.listWorkspaces();
      const takenIds = new Set(allWorkspaces.map((workspace) => workspace.id));
      const takenNames = new Set(allWorkspaces.map((workspace) => workspace.name));

      let suffix = 0;
      let nextId = baseId;
      let nextName = requestedName;

      while (takenIds.has(nextId) || takenNames.has(nextName)) {
        suffix += 1;
        nextId = `${baseId}-${suffix + 1}`;
        nextName = displayNameForSuffix(requestedName, suffix);
      }

      return this.createWorkspace({
        id: nextId,
        name: nextName,
        rootPath: normalizedRootPath,
        includeGlobs: input.includeGlobs,
        excludeGlobs: input.excludeGlobs,
      });
    },

    async createWorkspace(input: {
      id: string;
      name: string;
      rootPath: string;
      includeGlobs?: string;
      excludeGlobs?: string;
    }): Promise<RegistryWorkspace> {
      const normalizedRootPath = normalizeRootPath(input.rootPath);
      const existing = await this.getWorkspaceByPath(normalizedRootPath);
      if (existing) {
        return existing;
      }

      const now = new Date().toISOString();
      db.insert(schema.workspaces)
        .values({
          id: input.id,
          name: input.name,
          rootPath: normalizedRootPath,
          includeGlobs: input.includeGlobs ?? "",
          excludeGlobs: input.excludeGlobs ?? "",
          status: "pending",
          indexingStatus: "pending",
          graphStatus: "pending",
          documentCount: 0,
          chunkCount: 0,
          nodeCount: 0,
          edgeCount: 0,
          createdAt: now,
          updatedAt: now,
        })
        .run();

      return (await this.getWorkspace(input.id))!;
    },

    async updateWorkspace(
      id: string,
      updates: Partial<
        Pick<
          RegistryWorkspace,
          | "status"
          | "indexingStatus"
          | "graphStatus"
          | "indexGeneration"
          | "graphGeneration"
          | "lastIndexedAt"
          | "lastGraphBuiltAt"
          | "documentCount"
          | "chunkCount"
          | "nodeCount"
          | "edgeCount"
          | "lastError"
        >
      >,
    ): Promise<void> {
      const set: Partial<typeof schema.workspaces.$inferInsert> = {
        updatedAt: new Date().toISOString(),
      };

      if (updates.status !== undefined) {
        set.status = updates.status;
      }
      if (updates.indexingStatus !== undefined) {
        set.indexingStatus = updates.indexingStatus;
        if (updates.indexingStatus !== "running") {
          set.indexBuildOwner = null;
          set.indexLeaseExpiresAt = null;
        }
      }
      if (updates.graphStatus !== undefined) {
        set.graphStatus = updates.graphStatus;
      }
      if (updates.indexGeneration !== undefined) {
        set.indexGeneration = updates.indexGeneration;
      }
      if (updates.graphGeneration !== undefined) {
        set.graphGeneration = updates.graphGeneration;
      }
      if (updates.lastIndexedAt !== undefined) {
        set.lastIndexedAt = updates.lastIndexedAt;
      }
      if (updates.lastGraphBuiltAt !== undefined) {
        set.lastGraphBuiltAt = updates.lastGraphBuiltAt;
      }
      if (updates.documentCount !== undefined) {
        set.documentCount = updates.documentCount;
      }
      if (updates.chunkCount !== undefined) {
        set.chunkCount = updates.chunkCount;
      }
      if (updates.nodeCount !== undefined) {
        set.nodeCount = updates.nodeCount;
      }
      if (updates.edgeCount !== undefined) {
        set.edgeCount = updates.edgeCount;
      }
      if (updates.lastError !== undefined) {
        set.lastError = updates.lastError;
      }

      // SAFETY: `set` is a Partial of the workspaces insert type; only fields
      // present in `updates` are written, and their values match the column
      // types (nullable columns accept null for the lease-clearing branches).
      db.update(schema.workspaces).set(set).where(eq(schema.workspaces.id, id)).run();
    },

    async tryClaimIndexing(
      id: string,
      ownerToken: string,
      leaseExpiresAt: string,
    ): Promise<boolean> {
      const now = new Date().toISOString();
      const result = db
        .update(schema.workspaces)
        .set({
          status: "indexing",
          indexingStatus: "running",
          indexBuildOwner: ownerToken,
          indexLeaseExpiresAt: leaseExpiresAt,
          lastError: "",
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.workspaces.id, id),
            or(
              ne(schema.workspaces.indexingStatus, "running"),
              isNull(schema.workspaces.indexLeaseExpiresAt),
              lt(schema.workspaces.indexLeaseExpiresAt, now),
            ),
          ),
        )
        .run();
      return runChanges(result) > 0;
    },

    async refreshIndexingLease(
      id: string,
      ownerToken: string,
      leaseExpiresAt: string,
    ): Promise<boolean> {
      const now = new Date().toISOString();
      const result = db
        .update(schema.workspaces)
        .set({ indexLeaseExpiresAt: leaseExpiresAt, updatedAt: now })
        .where(
          and(
            eq(schema.workspaces.id, id),
            eq(schema.workspaces.indexingStatus, "running"),
            eq(schema.workspaces.indexBuildOwner, ownerToken),
          ),
        )
        .run();
      return runChanges(result) > 0;
    },

    async releaseIndexing(id: string, ownerToken: string, error: string): Promise<boolean> {
      const now = new Date().toISOString();
      const result = db
        .update(schema.workspaces)
        .set({
          status: "error",
          indexingStatus: "failed",
          indexBuildOwner: null,
          indexLeaseExpiresAt: null,
          lastError: error,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.workspaces.id, id),
            eq(schema.workspaces.indexingStatus, "running"),
            eq(schema.workspaces.indexBuildOwner, ownerToken),
          ),
        )
        .run();
      return runChanges(result) > 0;
    },

    async completeIndexing(
      id: string,
      ownerToken: string,
      result: {
        documentCount: number;
        chunkCount: number;
        nodeCount: number;
        edgeCount: number;
        completedAt: string;
      },
    ): Promise<boolean> {
      const now = new Date().toISOString();
      const update = db
        .update(schema.workspaces)
        .set({
          status: "indexed",
          indexingStatus: "completed",
          lastIndexedAt: result.completedAt,
          documentCount: result.documentCount,
          chunkCount: result.chunkCount,
          nodeCount: result.nodeCount,
          edgeCount: result.edgeCount,
          lastError: "",
          indexBuildOwner: null,
          indexLeaseExpiresAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.workspaces.id, id),
            eq(schema.workspaces.indexingStatus, "running"),
            eq(schema.workspaces.indexBuildOwner, ownerToken),
          ),
        )
        .run();
      return runChanges(update) > 0;
    },

    async failIndexing(id: string, ownerToken: string, error: string): Promise<boolean> {
      // failIndexing and releaseIndexing share the same fenced failure
      // semantics — delegate to avoid duplicating the SQL.
      return repo.releaseIndexing(id, ownerToken, error);
    },

    async invalidateWorkspaceGraph(id: string): Promise<number> {
      const now = new Date().toISOString();
      const row = db
        .update(schema.workspaces)
        .set({
          indexGeneration: sql`${schema.workspaces.indexGeneration} + 1`,
          graphStatus: sql`CASE WHEN ${schema.workspaces.graphStatus} = 'running' THEN 'running' ELSE 'pending' END`,
          updatedAt: now,
        })
        .where(eq(schema.workspaces.id, id))
        .returning({ indexGeneration: schema.workspaces.indexGeneration })
        .get();

      if (!row) {
        throw new Error(`Workspace '${id}' not found`);
      }

      return Number(row.indexGeneration);
    },

    async tryClaimGraphBuild(
      id: string,
      ownerToken: string,
      leaseExpiresAt: string,
    ): Promise<number | null> {
      // Atomic compare-and-set: transition to 'running' only if:
      // 1. status is not 'running', OR
      // 2. status is 'running' but the lease has expired (takeover from dead process)
      const now = new Date().toISOString();
      const result = db
        .update(schema.workspaces)
        .set({
          graphStatus: "running",
          graphBuildOwner: ownerToken,
          graphBuildEpoch: sql`${schema.workspaces.graphBuildEpoch} + 1`,
          graphLeaseExpiresAt: leaseExpiresAt,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.workspaces.id, id),
            or(
              ne(schema.workspaces.graphStatus, "running"),
              isNull(schema.workspaces.graphLeaseExpiresAt),
              lt(schema.workspaces.graphLeaseExpiresAt, now),
            ),
          ),
        )
        .returning({ graphBuildEpoch: schema.workspaces.graphBuildEpoch })
        .get();
      return result ? Number(result.graphBuildEpoch) : null;
    },

    async refreshGraphBuildLease(
      id: string,
      ownerToken: string,
      leaseExpiresAt: string,
    ): Promise<boolean> {
      // Refresh the lease only if we still own it (status is still 'running'
      // and lease hasn't been taken over). Returns false if another process
      // took over or the graph was completed/failed.
      const now = new Date().toISOString();
      const result = db
        .update(schema.workspaces)
        .set({ graphLeaseExpiresAt: leaseExpiresAt, updatedAt: now })
        .where(
          and(
            eq(schema.workspaces.id, id),
            eq(schema.workspaces.graphStatus, "running"),
            eq(schema.workspaces.graphBuildOwner, ownerToken),
          ),
        )
        .run();
      return runChanges(result) > 0;
    },

    async releaseGraphBuild(id, ownerToken): Promise<boolean> {
      const now = new Date().toISOString();
      const result = db
        .update(schema.workspaces)
        .set({
          graphStatus: "pending",
          graphBuildOwner: null,
          graphLeaseExpiresAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.workspaces.id, id),
            eq(schema.workspaces.graphStatus, "running"),
            eq(schema.workspaces.graphBuildOwner, ownerToken),
          ),
        )
        .run();
      return runChanges(result) > 0;
    },

    async completeGraphBuild(id, ownerToken, generation, result): Promise<boolean> {
      const now = new Date().toISOString();
      const update = db
        .update(schema.workspaces)
        .set({
          graphStatus: "completed",
          graphGeneration: generation,
          nodeCount: result.nodeCount,
          edgeCount: result.edgeCount,
          lastGraphBuiltAt: result.completedAt,
          lastError: "",
          graphBuildOwner: null,
          graphLeaseExpiresAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.workspaces.id, id),
            eq(schema.workspaces.graphStatus, "running"),
            eq(schema.workspaces.graphBuildOwner, ownerToken),
            eq(schema.workspaces.indexGeneration, generation),
          ),
        )
        .run();
      return runChanges(update) > 0;
    },

    async failGraphBuild(id, ownerToken, error): Promise<boolean> {
      const now = new Date().toISOString();
      const update = db
        .update(schema.workspaces)
        .set({
          graphStatus: "failed",
          lastError: error,
          graphBuildOwner: null,
          graphLeaseExpiresAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.workspaces.id, id),
            eq(schema.workspaces.graphStatus, "running"),
            eq(schema.workspaces.graphBuildOwner, ownerToken),
          ),
        )
        .run();
      return runChanges(update) > 0;
    },

    async deleteWorkspace(id: string): Promise<void> {
      db.delete(schema.workspaces).where(eq(schema.workspaces.id, id)).run();
    },

    async setPinned(id: string, pinned: boolean): Promise<void> {
      if (pinned) {
        // Assign a monotonic pin_order so ordering is deterministic even when
        // multiple workspaces are pinned within the same millisecond.
        const maxRow = db
          .select({ max: sql<number>`MAX(${schema.workspaces.pinOrder})` })
          .from(schema.workspaces)
          .where(sql`${schema.workspaces.pinOrder} IS NOT NULL`)
          .get();
        // SAFETY: MAX(pin_order) returns NULL when no rows have pin_order set;
        // sql<number> types the alias as `number`, so the null coalesce handles
        // both the no-row (undefined) and empty-set (null) cases at runtime.
        const nextOrder = (maxRow?.max ?? 0) + 1;
        db.update(schema.workspaces)
          .set({ pinnedAt: new Date().toISOString(), pinOrder: nextOrder })
          .where(eq(schema.workspaces.id, id))
          .run();
      } else {
        db.update(schema.workspaces)
          .set({ pinnedAt: null, pinOrder: null })
          .where(eq(schema.workspaces.id, id))
          .run();
      }
    },

    async getSetting(key: string): Promise<string | null> {
      const row = db.select().from(schema.settings).where(eq(schema.settings.key, key)).get();
      if (!row) return null;
      if (isSensitiveKey(key)) {
        try {
          return decryptValue(row.value);
        } catch {
          return null;
        }
      }
      return row.value;
    },

    async setSetting(key: string, value: string): Promise<void> {
      const stored = isSensitiveKey(key) ? encryptValue(value) : value;
      const now = new Date().toISOString();
      db.insert(schema.settings)
        .values({ key, value: stored, updatedAt: now })
        .onConflictDoUpdate({
          target: schema.settings.key,
          set: { value: stored, updatedAt: now },
        })
        .run();
    },

    async deleteSetting(key: string): Promise<void> {
      db.delete(schema.settings).where(eq(schema.settings.key, key)).run();
    },

    async getAllSettings(): Promise<Record<string, string>> {
      const rows = db.select().from(schema.settings).all();
      const result: Record<string, string> = {};
      for (const row of rows) {
        if (isSensitiveKey(row.key)) {
          try {
            result[row.key] = decryptValue(row.value);
          } catch {
            // Skip undecryptable values
          }
        } else {
          result[row.key] = row.value;
        }
      }
      return result;
    },
  };
  return repo;
}
