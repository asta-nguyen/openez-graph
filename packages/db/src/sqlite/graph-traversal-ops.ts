import path from "node:path";

import type { NativeDatabase } from "./shared-types";
import { safeParseJson } from "./utils";
import { type GraphOpsDeps, type GraphStmts } from "./graph-ops-shared";

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

/**
 * Factory for graph traversal and lifecycle operations extracted from
 * `createGraphOps()`.
 *
 * `ensureGraphBuilt` depends on `getMeta`/`setMeta` from the parent
 * repository; those are passed in via `deps` to avoid a circular dependency
 * on the meta/lifecycle module that will be extracted in a later task.
 *
 * `graphNeighbors` calls `ensureGraphBuilt` via a closure-injected function so
 * it does not depend on the node/edge ops modules.
 */
export function createGraphTraversalOps(
  native: NativeDatabase,
  _stmts: GraphStmts,
  deps: GraphOpsDeps,
) {
  const ensureGraphBuilt = (): void => {
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
  };

  return {
    // ── Graph Traversal ──

    async graphNeighbors(labelOrId: string, depth: number, limit = 50) {
      ensureGraphBuilt();
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

    // ── Graph Lifecycle ──

    clearGraphArtifacts(): void {
      native.exec("DELETE FROM graph_edges");
      native.exec("DELETE FROM graph_nodes");
    },

    ensureGraphBuilt,
  };
}
