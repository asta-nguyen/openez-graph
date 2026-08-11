import fs from "node:fs";
import path from "node:path";

import { eq } from "drizzle-orm";

import { getRegistryDb, getRegistryNativeDb } from "./registry-db";
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
    status: row.status as RegistryWorkspace["status"],
    indexingStatus: row.indexingStatus as RegistryWorkspace["indexingStatus"],
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
  const native = getRegistryNativeDb();

  return {
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
      native
        .prepare(
          `INSERT INTO workspaces (id, name, root_path, include_globs, exclude_globs, status, indexing_status, graph_status, document_count, chunk_count, node_count, edge_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'pending', 'pending', 'pending', 0, 0, 0, 0, ?, ?)`,
        )
        .run(
          input.id,
          input.name,
          normalizedRootPath,
          input.includeGlobs ?? "",
          input.excludeGlobs ?? "",
          now,
          now,
        );

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
      const sets: string[] = ["updated_at = ?"];
      const params: unknown[] = [new Date().toISOString()];

      if (updates.status !== undefined) {
        sets.push("status = ?");
        params.push(updates.status);
      }
      if (updates.indexingStatus !== undefined) {
        sets.push("indexing_status = ?");
        params.push(updates.indexingStatus);
      }
      if (updates.graphStatus !== undefined) {
        sets.push("graph_status = ?");
        params.push(updates.graphStatus);
      }
      if (updates.indexGeneration !== undefined) {
        sets.push("index_generation = ?");
        params.push(updates.indexGeneration);
      }
      if (updates.graphGeneration !== undefined) {
        sets.push("graph_generation = ?");
        params.push(updates.graphGeneration);
      }
      if (updates.lastIndexedAt !== undefined) {
        sets.push("last_indexed_at = ?");
        params.push(updates.lastIndexedAt);
      }
      if (updates.lastGraphBuiltAt !== undefined) {
        sets.push("last_graph_built_at = ?");
        params.push(updates.lastGraphBuiltAt);
      }
      if (updates.documentCount !== undefined) {
        sets.push("document_count = ?");
        params.push(updates.documentCount);
      }
      if (updates.chunkCount !== undefined) {
        sets.push("chunk_count = ?");
        params.push(updates.chunkCount);
      }
      if (updates.nodeCount !== undefined) {
        sets.push("node_count = ?");
        params.push(updates.nodeCount);
      }
      if (updates.edgeCount !== undefined) {
        sets.push("edge_count = ?");
        params.push(updates.edgeCount);
      }
      if (updates.lastError !== undefined) {
        sets.push("last_error = ?");
        params.push(updates.lastError);
      }

      params.push(id);
      native.prepare(`UPDATE workspaces SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    },

    async invalidateWorkspaceGraph(id: string): Promise<number> {
      const row = native
        .prepare(
          `UPDATE workspaces
           SET index_generation = index_generation + 1,
               graph_status = CASE WHEN graph_status = 'running' THEN 'running' ELSE 'pending' END,
               updated_at = ?
           WHERE id = ?
           RETURNING index_generation`,
        )
        .get(new Date().toISOString(), id) as { index_generation: number } | undefined;

      if (!row) {
        throw new Error(`Workspace '${id}' not found`);
      }

      return Number(row.index_generation);
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
      const result = native
        .prepare(
          `UPDATE workspaces
           SET graph_status = 'running',
               graph_build_owner = ?,
               graph_build_epoch = graph_build_epoch + 1,
               graph_lease_expires_at = ?,
               updated_at = ?
           WHERE id = ?
             AND (graph_status != 'running' OR graph_lease_expires_at IS NULL OR graph_lease_expires_at < ?)
           RETURNING graph_build_epoch`,
        )
        .get(ownerToken, leaseExpiresAt, now, id, now) as { graph_build_epoch: number } | undefined;
      return result ? Number(result.graph_build_epoch) : null;
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
      const result = native
        .prepare(
          `UPDATE workspaces
           SET graph_lease_expires_at = ?, updated_at = ?
           WHERE id = ? AND graph_status = 'running' AND graph_build_owner = ?`,
        )
        .run(leaseExpiresAt, now, id, ownerToken) as { changes: number };
      return result.changes > 0;
    },

    async releaseGraphBuild(id, ownerToken): Promise<boolean> {
      const result = native
        .prepare(
          `UPDATE workspaces
           SET graph_status = 'pending', graph_build_owner = NULL,
               graph_lease_expires_at = NULL, updated_at = ?
           WHERE id = ? AND graph_status = 'running' AND graph_build_owner = ?`,
        )
        .run(new Date().toISOString(), id, ownerToken) as { changes: number };
      return result.changes > 0;
    },

    async completeGraphBuild(id, ownerToken, generation, result): Promise<boolean> {
      const update = native
        .prepare(
          `UPDATE workspaces
           SET graph_status = 'completed', graph_generation = ?, node_count = ?, edge_count = ?,
               last_graph_built_at = ?, last_error = '', graph_build_owner = NULL,
               graph_lease_expires_at = NULL, updated_at = ?
           WHERE id = ? AND graph_status = 'running' AND graph_build_owner = ?
             AND index_generation = ?`,
        )
        .run(
          generation,
          result.nodeCount,
          result.edgeCount,
          result.completedAt,
          new Date().toISOString(),
          id,
          ownerToken,
          generation,
        ) as { changes: number };
      return update.changes > 0;
    },

    async failGraphBuild(id, ownerToken, error): Promise<boolean> {
      const update = native
        .prepare(
          `UPDATE workspaces
           SET graph_status = 'failed', last_error = ?, graph_build_owner = NULL,
               graph_lease_expires_at = NULL, updated_at = ?
           WHERE id = ? AND graph_status = 'running' AND graph_build_owner = ?`,
        )
        .run(error, new Date().toISOString(), id, ownerToken) as { changes: number };
      return update.changes > 0;
    },

    async deleteWorkspace(id: string): Promise<void> {
      db.delete(schema.workspaces).where(eq(schema.workspaces.id, id)).run();
    },

    async setPinned(id: string, pinned: boolean): Promise<void> {
      if (pinned) {
        // Assign a monotonic pin_order so ordering is deterministic even when
        // multiple workspaces are pinned within the same millisecond.
        const maxRow = native
          .prepare("SELECT MAX(pin_order) AS max_order FROM workspaces WHERE pin_order IS NOT NULL")
          .get() as { max_order: number | null } | undefined;
        const nextOrder = (maxRow?.max_order ?? 0) + 1;
        native
          .prepare("UPDATE workspaces SET pinned_at = ?, pin_order = ? WHERE id = ?")
          .run(new Date().toISOString(), nextOrder, id);
      } else {
        native
          .prepare("UPDATE workspaces SET pinned_at = NULL, pin_order = NULL WHERE id = ?")
          .run(id);
      }
    },

    async getSetting(key: string): Promise<string | null> {
      const row = native.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
        | { value: string }
        | undefined;
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
      native
        .prepare(
          `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(key, stored, now);
    },

    async deleteSetting(key: string): Promise<void> {
      native.prepare("DELETE FROM settings WHERE key = ?").run(key);
    },

    async getAllSettings(): Promise<Record<string, string>> {
      const rows = native.prepare("SELECT key, value FROM settings").all() as Array<{
        key: string;
        value: string;
      }>;
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
}
