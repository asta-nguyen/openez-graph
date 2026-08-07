import crypto from "node:crypto";
import path from "node:path";

import type { NativeDatabase, StreamTimestampHolder } from "./shared-types";
import { safeParseJson } from "./utils";

/**
 * Prepared statements used by the graph node/edge operations.
 *
 * These are prepared once in `createWorkspaceRepository()` and reused across
 * thousands of calls. Only the statements needed by this module are declared
 * here; the remaining statements stay in `repository.ts` and will be split out
 * by later tasks.
 */
export interface GraphStmts {
  nodeByTypeLabel: ReturnType<NativeDatabase["prepare"]>;
  nodeByTypeLabelRef: ReturnType<NativeDatabase["prepare"]>;
  insertNode: ReturnType<NativeDatabase["prepare"]>;
  upsertNodeByTypeLabel: ReturnType<NativeDatabase["prepare"]>;
  updateNode: ReturnType<NativeDatabase["prepare"]>;
  deleteNodesByRefId: ReturnType<NativeDatabase["prepare"]>;
  insertEdge: ReturnType<NativeDatabase["prepare"]>;
}

/**
 * Dependencies that `ensureGraphBuilt` needs from the parent repository.
 *
 * `ensureGraphBuilt` reads/writes the `index_meta` table via `getMeta`/`setMeta`
 * (which still live in `repository.ts`). Passing them in keeps the graph module
 * decoupled from the meta/lifecycle operations that will be extracted later.
 */
export interface GraphOpsDeps {
  getMeta: (key: string) => string | null;
  setMeta: (key: string, value: string) => void;
}

const RESOLVABLE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".md",
  ".mdx",
  ".py",
];

function resolveImportPath(
  importerPath: string,
  importPath: string,
  language: string,
  knownPaths: Set<string>,
): string | null {
  if (language === "python") {
    const basePath = importPath.replace(/\./g, "/");
    const direct = `${basePath}.py`;
    if (knownPaths.has(direct)) return direct;
    const init = `${basePath}/__init__.py`;
    if (knownPaths.has(init)) return init;
    return null;
  }
  const importerDir = path.dirname(importerPath);
  const baseCandidate = path.posix.normalize(path.posix.join(importerDir, importPath));
  if (knownPaths.has(baseCandidate)) return baseCandidate;
  for (const ext of RESOLVABLE_EXTENSIONS) {
    const withExt = `${baseCandidate}${ext}`;
    if (knownPaths.has(withExt)) return withExt;
  }
  for (const ext of RESOLVABLE_EXTENSIONS) {
    const indexFile = `${baseCandidate}/index${ext}`;
    if (knownPaths.has(indexFile)) return indexFile;
  }
  return null;
}

function mapNodeRow(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    type: String(row.type),
    label: String(row.label),
    refId: row.ref_id ? String(row.ref_id) : null,
    metadata: String(row.metadata ?? "{}"),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * Factory for graph node/edge operations extracted from
 * `createWorkspaceRepository()`.
 *
 * Behavior is identical to the original inline implementations — this is a
 * pure code-move. `streamNow` is shared via a mutable holder so that
 * `refreshStreamTimestamp()` (defined in `document-repository.ts`) stays
 * visible to the graph/edge stream methods here.
 *
 * `ensureGraphBuilt` depends on `getMeta`/`setMeta` from the parent
 * repository; those are passed in via `deps` to avoid a circular dependency
 * on the meta/lifecycle module that will be extracted in a later task.
 */
export function createGraphOps(
  native: NativeDatabase,
  stmts: GraphStmts,
  streamNow: StreamTimestampHolder,
  deps: GraphOpsDeps,
) {
  return {
    async getNodeCount(): Promise<number> {
      const row = native.prepare("SELECT count(*) AS count FROM graph_nodes").get() as {
        count: number;
      };
      return row?.count ?? 0;
    },

    async getEdgeCount(): Promise<number> {
      const row = native.prepare("SELECT count(*) AS count FROM graph_edges").get() as {
        count: number;
      };
      return row?.count ?? 0;
    },

    // ── Graph Node Operations ──

    async upsertGraphNode(input: {
      type: string;
      label: string;
      refId?: string;
      metadata?: string;
    }): Promise<string> {
      if (input.type === "symbol") {
        if (input.refId) {
          const existing = stmts.nodeByTypeLabelRef.get(input.type, input.label, input.refId) as
            | Record<string, unknown>
            | undefined;
          if (existing) {
            const nextMetadata = input.metadata ?? String(existing.metadata ?? "{}");
            if (nextMetadata !== existing.metadata) {
              stmts.updateNode.run(
                input.refId,
                nextMetadata,
                new Date().toISOString(),
                existing.id,
              );
            }
            return String(existing.id);
          }
        }
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        stmts.insertNode.run(
          id,
          input.type,
          input.label,
          input.refId ?? null,
          input.metadata ?? "{}",
          now,
          now,
        );
        return id;
      }

      // Non-symbol nodes: (type, label) is unique — use ON CONFLICT ... RETURNING (one query)
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const row = stmts.upsertNodeByTypeLabel.get(
        id,
        input.type,
        input.label,
        input.refId ?? null,
        input.metadata ?? "{}",
        now,
        now,
      ) as { id: string };
      return String(row.id);
    },

    async insertGraphNodesBatch(
      inputs: Array<{ type: string; label: string; refId?: string; metadata?: string }>,
    ): Promise<string[]> {
      if (inputs.length === 0) return [];
      const now = new Date().toISOString();
      const ids: string[] = inputs.map(() => crypto.randomUUID());
      const BATCH = 2000;
      for (let i = 0; i < inputs.length; i += BATCH) {
        const batch = inputs.slice(i, i + BATCH);
        const placeholders = batch.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(",");
        const params: unknown[] = [];
        for (let j = 0; j < batch.length; j++) {
          const item = batch[j];
          params.push(
            ids[i + j],
            item.type,
            item.label,
            item.refId ?? null,
            item.metadata ?? "{}",
            now,
            now,
          );
        }
        native
          .prepare(
            `INSERT INTO graph_nodes (id, type, label, ref_id, metadata, created_at, updated_at) VALUES ${placeholders} ON CONFLICT(type, label) WHERE type != 'symbol' DO UPDATE SET metadata = excluded.metadata, updated_at = excluded.updated_at`,
          )
          .run(...params);
      }
      return ids;
    },

    async upsertGraphNodesBatch(
      inputs: Array<{ type: string; label: string; refId?: string; metadata?: string }>,
    ): Promise<Array<{ label: string; id: string }>> {
      if (inputs.length === 0) return [];
      const now = new Date().toISOString();
      const BATCH = 500;
      const results: Array<{ label: string; id: string }> = [];

      for (let i = 0; i < inputs.length; i += BATCH) {
        const batch = inputs.slice(i, i + BATCH);
        const placeholders = batch.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(",");
        const params: unknown[] = [];
        for (const item of batch) {
          const id = crypto.randomUUID();
          params.push(
            id,
            item.type,
            item.label,
            item.refId ?? null,
            item.metadata ?? "{}",
            now,
            now,
          );
        }
        const rows = native
          .prepare(
            `INSERT INTO graph_nodes (id, type, label, ref_id, metadata, created_at, updated_at) VALUES ${placeholders}
             ON CONFLICT(type, label) WHERE type != 'symbol' DO UPDATE SET ref_id = COALESCE(excluded.ref_id, graph_nodes.ref_id), metadata = excluded.metadata, updated_at = excluded.updated_at
             RETURNING id, label`,
          )
          .all(...params) as Array<{ id: string; label: string }>;
        results.push(...rows.map((r) => ({ label: r.label, id: String(r.id) })));
      }
      return results;
    },

    async getGraphNode(id: string) {
      const row = native.prepare("SELECT * FROM graph_nodes WHERE id = ?").get(id) as
        | Record<string, unknown>
        | undefined;
      return row ? mapNodeRow(row) : null;
    },

    async findGraphNode(type: string, label: string) {
      const row = stmts.nodeByTypeLabel.get(type, label) as Record<string, unknown> | undefined;
      return row ? mapNodeRow(row) : null;
    },

    async deleteGraphNodesByRefId(refId: string) {
      stmts.deleteNodesByRefId.run(refId, refId);
    },

    async findFileNode(relativePath: string) {
      const row = stmts.nodeByTypeLabel.get("file", relativePath) as
        | Record<string, unknown>
        | undefined;
      return row ? mapNodeRow(row) : null;
    },

    async getSymbolNodesByFilePath(filePath: string) {
      const rows = native
        .prepare(
          "SELECT * FROM graph_nodes WHERE type = 'symbol' AND json_extract(metadata, '$.filePath') = ?",
        )
        .all(filePath) as Array<Record<string, unknown>>;
      return rows.map(mapNodeRow);
    },

    deleteOutgoingEdges(nodeId: string, types?: string[]) {
      if (types && types.length > 0) {
        const placeholders = types.map(() => "?").join(",");
        native
          .prepare(`DELETE FROM graph_edges WHERE from_node_id = ? AND type IN (${placeholders})`)
          .run(nodeId, ...types);
      } else {
        native.prepare("DELETE FROM graph_edges WHERE from_node_id = ?").run(nodeId);
      }
    },

    updateSymbolNode(id: string, refId: string, metadata: string) {
      stmts.updateNode.run(refId, metadata, new Date().toISOString(), id);
    },

    deleteGraphNodesByIds(ids: string[]) {
      if (ids.length === 0) return;
      const placeholders = ids.map(() => "?").join(",");
      native.prepare(`DELETE FROM graph_nodes WHERE id IN (${placeholders})`).run(...ids);
    },

    deleteChunkNodesByChunkIds(chunkIds: string[]) {
      if (chunkIds.length === 0) return;
      const placeholders = chunkIds.map(() => "?").join(",");
      native
        .prepare(`DELETE FROM graph_nodes WHERE type = 'chunk' AND ref_id IN (${placeholders})`)
        .run(...chunkIds);
    },

    // ── Graph Edge Operations ──

    async insertEdge(input: {
      fromNodeId: string;
      toNodeId: string;
      type: string;
      weight?: number;
      metadata?: string;
    }): Promise<string> {
      const id = crypto.randomUUID();
      stmts.insertEdge.run(
        id,
        input.fromNodeId,
        input.toNodeId,
        input.type,
        input.weight ?? 1,
        input.metadata ?? "{}",
        new Date().toISOString(),
      );
      return id;
    },

    async insertEdges(
      inputs: Array<{
        fromNodeId: string;
        toNodeId: string;
        type: string;
        weight?: number;
        metadata?: string;
      }>,
    ): Promise<void> {
      if (inputs.length === 0) return;
      const now = new Date().toISOString();
      const BATCH = 2000;
      for (let i = 0; i < inputs.length; i += BATCH) {
        const batch = inputs.slice(i, i + BATCH);
        const placeholders = batch.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(",");
        const params: unknown[] = [];
        for (const item of batch) {
          params.push(
            crypto.randomUUID(),
            item.fromNodeId,
            item.toNodeId,
            item.type,
            item.weight ?? 1,
            item.metadata ?? "{}",
            now,
          );
        }
        native
          .prepare(
            `INSERT INTO graph_edges (id, from_node_id, to_node_id, type, weight, metadata, created_at) VALUES ${placeholders} ON CONFLICT(from_node_id, to_node_id, type) DO NOTHING`,
          )
          .run(...params);
      }
    },

    async deleteEdgesByNodeIds(nodeIds: string[]) {
      if (nodeIds.length === 0) return;
      const placeholders = nodeIds.map(() => "?").join(",");
      native
        .prepare(
          `DELETE FROM graph_edges WHERE from_node_id IN (${placeholders}) OR to_node_id IN (${placeholders})`,
        )
        .run(...nodeIds, ...nodeIds);
    },

    // ── Graph Traversal ──

    async graphNeighbors(labelOrId: string, depth: number, limit = 50) {
      this.ensureGraphBuilt();
      const seedNodes = native
        .prepare("SELECT * FROM graph_nodes WHERE id = ? OR label = ? ORDER BY id = ? DESC LIMIT 1")
        .all(labelOrId, labelOrId, labelOrId) as Array<Record<string, unknown>>;

      if (seedNodes.length === 0) {
        return { nodes: [], edges: [] };
      }

      const seedId = String(seedNodes[0].id);
      const visited = new Set<string>();
      const resultNodes: Array<Record<string, unknown>> = [
        { ...seedNodes[0], metadata: safeParseJson(String(seedNodes[0].metadata ?? ""), {}) },
      ];
      const resultEdges: Array<Record<string, unknown>> = [];
      const resultEdgeIds = new Set<string>();
      let currentBatch = [seedId];
      visited.add(seedId);

      for (let hop = 0; hop < Math.max(0, depth); hop++) {
        if (currentBatch.length === 0) break;

        const placeholders = currentBatch.map(() => "?").join(",");
        const edges = native
          .prepare(
            `SELECT * FROM graph_edges WHERE (from_node_id IN (${placeholders}) OR to_node_id IN (${placeholders})) LIMIT ?`,
          )
          .all(...currentBatch, ...currentBatch, limit) as Array<Record<string, unknown>>;

        const nextBatch: string[] = [];
        for (const edge of edges) {
          const fromId = String(edge.from_node_id);
          const toId = String(edge.to_node_id);
          if (!visited.has(fromId) && visited.size < limit) {
            nextBatch.push(fromId);
            visited.add(fromId);
          }
          if (!visited.has(toId) && visited.size < limit) {
            nextBatch.push(toId);
            visited.add(toId);
          }
          const edgeId = String(edge.id);
          if (
            visited.has(fromId) &&
            visited.has(toId) &&
            !resultEdgeIds.has(edgeId) &&
            resultEdges.length < limit
          ) {
            resultEdgeIds.add(edgeId);
            resultEdges.push(edge);
          }
        }

        for (const nodeId of nextBatch) {
          const node = native.prepare("SELECT * FROM graph_nodes WHERE id = ?").get(nodeId) as
            | Record<string, unknown>
            | undefined;
          if (node) {
            resultNodes.push({ ...node, metadata: safeParseJson(String(node.metadata ?? ""), {}) });
          }
        }

        currentBatch = nextBatch;
      }

      return { nodes: resultNodes, edges: resultEdges };
    },

    // ── Streaming inserts (graph nodes/edges) ──

    streamGraphNode(input: {
      id: string;
      type: string;
      label: string;
      refId?: string | null;
      metadata?: string;
    }): void {
      const now = streamNow.value;
      stmts.insertNode.run(
        input.id,
        input.type,
        input.label,
        input.refId ?? null,
        input.metadata ?? "{}",
        now,
        now,
      );
    },

    streamGraphNodesBatch(
      inputs: Array<{
        id: string;
        type: string;
        label: string;
        refId?: string | null;
        metadata?: string;
      }>,
    ): void {
      if (inputs.length === 0) return;
      const BATCH = 500;
      const now = streamNow.value;
      for (let i = 0; i < inputs.length; i += BATCH) {
        const batch = inputs.slice(i, i + BATCH);
        const placeholders = batch.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(",");
        const params: unknown[] = [];
        for (const n of batch) {
          params.push(n.id, n.type, n.label, n.refId ?? null, n.metadata ?? "{}", now, now);
        }
        native
          .prepare(
            `INSERT INTO graph_nodes (id, type, label, ref_id, metadata, created_at, updated_at) VALUES ${placeholders}`,
          )
          .run(...params);
      }
    },

    streamEdgesBatch(
      inputs: Array<{
        id: string;
        fromNodeId: string;
        toNodeId: string;
        type: string;
        weight?: number;
        metadata?: string;
      }>,
    ): void {
      if (inputs.length === 0) return;
      const BATCH = 500;
      const now = streamNow.value;
      for (let i = 0; i < inputs.length; i += BATCH) {
        const batch = inputs.slice(i, i + BATCH);
        const placeholders = batch.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(",");
        const params: unknown[] = [];
        for (const e of batch) {
          params.push(
            e.id,
            e.fromNodeId,
            e.toNodeId,
            e.type,
            e.weight ?? 1,
            e.metadata ?? "{}",
            now,
          );
        }
        native
          .prepare(
            `INSERT INTO graph_edges (id, from_node_id, to_node_id, type, weight, metadata, created_at) VALUES ${placeholders}`,
          )
          .run(...params);
      }
    },

    streamEdge(input: {
      id: string;
      fromNodeId: string;
      toNodeId: string;
      type: string;
      weight?: number;
      metadata?: string;
    }): void {
      stmts.insertEdge.run(
        input.id,
        input.fromNodeId,
        input.toNodeId,
        input.type,
        input.weight ?? 1,
        input.metadata ?? "{}",
        streamNow.value,
      );
    },

    // ── Graph Lifecycle ──

    clearGraphArtifacts(): void {
      native.exec("DELETE FROM graph_edges");
      native.exec("DELETE FROM graph_nodes");
    },

    ensureGraphBuilt(): void {
      if (deps.getMeta("graph_pending") !== "1") return;
      native.exec("BEGIN IMMEDIATE");
      try {
        if (deps.getMeta("graph_pending") !== "1") {
          native.exec("COMMIT");
          return;
        }
        native.exec("DELETE FROM graph_edges");
        native.exec("DELETE FROM graph_nodes");
        const now = new Date().toISOString();
        native.exec(`INSERT INTO graph_nodes (id, type, label, ref_id, metadata, created_at, updated_at)
          SELECT 'fn_' || d.id, 'file', d.path, d.id, json_object('path', d.path, 'kind', d.kind, 'language', coalesce(d.language, '')), '${now}', '${now}'
          FROM documents d`);
        native.exec(`INSERT INTO graph_nodes (id, type, label, ref_id, metadata, created_at, updated_at)
          SELECT 'sn_' || c.id, 'symbol', json_extract(c.metadata, '$.symbolName'), c.id,
            json_object('symbolType', json_extract(c.metadata, '$.symbolType'), 'filePath', d.path),
            '${now}', '${now}'
          FROM chunks c
          INNER JOIN documents d ON d.id = c.document_id
          WHERE json_extract(c.metadata, '$.symbolName') IS NOT NULL`);
        native.exec(`INSERT OR IGNORE INTO graph_edges (id, from_node_id, to_node_id, type, weight, metadata, created_at)
          SELECT 'de_' || c.id, 'fn_' || c.document_id, 'sn_' || c.id, 'defines', 1, '{}', '${now}'
          FROM chunks c
          WHERE json_extract(c.metadata, '$.symbolName') IS NOT NULL`);
        const importRows = native
          .prepare(
            `
          SELECT c.id AS chunk_id, c.document_id, d.path AS importer_path,
            json_extract(c.metadata, '$.importPaths') AS imports,
            coalesce(d.language, '') AS language
          FROM chunks c
          INNER JOIN documents d ON d.id = c.document_id
          WHERE c.chunk_index = 0
            AND json_extract(c.metadata, '$.importPaths') IS NOT NULL
        `,
          )
          .all() as Array<{
          chunk_id: string;
          document_id: string;
          importer_path: string;
          imports: string;
          language: string;
        }>;
        const allPaths = new Set(
          (native.prepare("SELECT path FROM documents").all() as Array<{ path: string }>).map(
            (r) => r.path,
          ),
        );
        const edgeBatch: Array<{
          id: string;
          fromNodeId: string;
          toNodeId: string;
          type: string;
          metadata?: string;
        }> = [];
        let edgeIdx = 0;
        for (const row of importRows) {
          let paths: string[];
          try {
            paths = JSON.parse(row.imports) as string[];
          } catch {
            continue;
          }
          for (const imp of paths) {
            if (typeof imp !== "string" || imp.length === 0) continue;
            const resolved = resolveImportPath(row.importer_path, imp, row.language, allPaths);
            if (!resolved) continue;
            edgeBatch.push({
              id: `im_${row.chunk_id}_${edgeIdx++}`,
              fromNodeId: `fn_${row.document_id}`,
              toNodeId: `fn_${(native.prepare("SELECT id FROM documents WHERE path = ?").get(resolved) as { id: string } | undefined)?.id}`,
              type: "imports",
              metadata: JSON.stringify({ importPath: imp }),
            });
          }
        }
        const validEdges = edgeBatch.filter((e) => e.toNodeId !== "fn_undefined");
        if (validEdges.length > 0) {
          const EBATCH = 500;
          for (let i = 0; i < validEdges.length; i += EBATCH) {
            const batch = validEdges.slice(i, i + EBATCH);
            const placeholders = batch.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(",");
            const params: unknown[] = [];
            for (const e of batch) {
              params.push(e.id, e.fromNodeId, e.toNodeId, e.type, 1, e.metadata ?? "{}", now);
            }
            native
              .prepare(
                `INSERT OR IGNORE INTO graph_edges (id, from_node_id, to_node_id, type, weight, metadata, created_at) VALUES ${placeholders}`,
              )
              .run(...params);
          }
        }
        deps.setMeta("graph_pending", "0");
        native.exec("COMMIT");
      } catch (error) {
        try {
          native.exec("ROLLBACK");
        } catch {}
        throw error;
      }
    },

    async loadAllSymbolNodes(): Promise<Map<string, string>> {
      const rows = native
        .prepare("SELECT label, id FROM graph_nodes WHERE type = 'symbol'")
        .all() as Array<{ label: string; id: string }>;
      const map = new Map<string, string>();
      for (const row of rows) {
        if (!map.has(row.label)) map.set(row.label, String(row.id));
      }
      return map;
    },
  };
}
