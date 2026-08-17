import { execFileSync } from "node:child_process";
import path from "node:path";

import { createWorkspaceRepository } from "@openez-graph/db";

export interface ChangedHunkRange {
  start: number;
  end: number;
}

export interface FileDiffHunks {
  filePath: string;
  status: "modified" | "added" | "deleted";
  ranges: ChangedHunkRange[];
}

export interface AffectedSymbol {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  exported: boolean;
  parentSymbol?: string;
  callers: Array<{ name: string; filePath?: string }>;
  callees: Array<{ name: string; filePath?: string }>;
}

export interface ModifiedFileContext {
  filePath: string;
  status: "modified" | "added" | "deleted";
  changedLineRanges: ChangedHunkRange[];
  affectedSymbols: AffectedSymbol[];
  imports?: string[];
}

export interface DiffContextReport {
  targetRef: string;
  totalFilesChanged: number;
  totalSymbolsAffected: number;
  files: ModifiedFileContext[];
  formattedSummary: string;
}

/**
 * Parses raw `git diff` output into structured file paths and changed line ranges.
 */
export function parseGitDiffHunks(diffText: string): FileDiffHunks[] {
  const files: FileDiffHunks[] = [];
  const lines = diffText.split("\n");
  let currentFile: FileDiffHunks | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith("diff --git ")) {
      if (currentFile) {
        files.push(currentFile);
      }
      let targetPath = "";
      const match = line.match(
        /^diff --git (?:a\/([^\s"]+)|"a\/(.+?)") (?:b\/([^\s"]+)|"b\/(.+?)")$/,
      );
      if (match) {
        targetPath = match[3] || match[4] || match[1] || match[2] || "";
      } else {
        const parts = line.split(" ");
        if (parts.length >= 4) {
          targetPath = parts.slice(3).join(" ").replace(/^b\//, "").replace(/^"|"$/g, "");
        }
      }
      currentFile = {
        filePath: targetPath,
        status: "modified",
        ranges: [],
      };
    } else if (line.startsWith("new file mode")) {
      if (currentFile) currentFile.status = "added";
    } else if (line.startsWith("deleted file mode")) {
      if (currentFile) currentFile.status = "deleted";
    } else if (line.startsWith("@@ ")) {
      const hunkMatch = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (hunkMatch && currentFile) {
        const start = parseInt(hunkMatch[1], 10);
        const count = hunkMatch[2] ? parseInt(hunkMatch[2], 10) : 1;
        currentFile.ranges.push({
          start,
          end: count === 0 ? start : start + count - 1,
        });
      }
    }
  }

  if (currentFile) {
    files.push(currentFile);
  }

  return files;
}

/**
 * Analyzes git diff against local workspace database to extract affected symbols and callers.
 */
export async function analyzeDiffContext(
  rootPath: string,
  options: {
    ref?: string;
    staged?: boolean;
    limit?: number;
  } = {},
): Promise<DiffContextReport> {
  const resolvedRoot = path.resolve(rootPath);
  const repo = createWorkspaceRepository(resolvedRoot);
  const callerLimit = options.limit ?? 5;

  const gitArgs = ["diff", "--no-color", "--src-prefix=a/", "--dst-prefix=b/"];
  if (options.staged) {
    gitArgs.push("--staged");
  } else if (options.ref) {
    gitArgs.push(options.ref);
  }

  let diffOutput = "";
  try {
    diffOutput = execFileSync("git", gitArgs, {
      cwd: resolvedRoot,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err: any) {
    const stderr = err?.stderr?.toString()?.trim();
    throw new Error(
      `Failed to execute git diff${options.ref ? ` for ref '${options.ref}'` : ""}: ${stderr || err?.message || String(err)}`,
    );
  }

  const parsedDiffs = parseGitDiffHunks(diffOutput);
  const fileContexts: ModifiedFileContext[] = [];
  let totalSymbolsAffected = 0;

  for (const fileDiff of parsedDiffs) {
    const affectedSymbols: AffectedSymbol[] = [];
    const fileImports: string[] = [];

    // Query parsed_documents for file AST symbols
    const doc = await repo.getDocumentByPath(fileDiff.filePath);
    if (doc) {
      // Query file-level imports dependencies
      const fileEdges = (await repo.queryRaw(
        `SELECT target.label
         FROM graph_edges e
         JOIN graph_nodes source ON source.id = e.from_node_id
         JOIN graph_nodes target ON target.id = e.to_node_id
         WHERE source.type = 'file'
           AND source.label = ?
           AND e.type = 'imports'
         LIMIT ?`,
        [doc.path, callerLimit],
      )) as Array<{ label: string }>;

      for (const edge of fileEdges) {
        fileImports.push(edge.label);
      }

      const parsed = await repo.queryRaw(
        "SELECT symbols FROM parsed_documents WHERE document_id = ?",
        [doc.id],
      );

      let symbolsList: any[] = [];
      if (parsed[0]?.symbols) {
        try {
          symbolsList = JSON.parse(String(parsed[0].symbols));
        } catch {}
      }

      for (const s of symbolsList) {
        const symStart = Number(s.startLine || 1);
        const symEnd = Number(s.endLine || symStart);

        // Check if any diff hunk overlaps with this symbol's line range
        const overlaps = fileDiff.ranges.some((r) => r.start <= symEnd && r.end >= symStart);

        if (overlaps) {
          // Query callers and callees from graph scoped to this document & file path
          const callers: Array<{ name: string; filePath?: string }> = [];
          const callees: Array<{ name: string; filePath?: string }> = [];
          const escapedName = String(s.name || "").replace(/[%_\\]/g, "\\$&");

          const node = (await repo.queryRaw(
            `SELECT id FROM graph_nodes
             WHERE type = 'symbol'
               AND json_extract(metadata, '$.filePath') = ?
               AND (label = ? OR label LIKE ? ESCAPE '\\')
             LIMIT 1`,
            [fileDiff.filePath, s.name, `%::${escapedName}`],
          )) as Array<{ id: string }>;

          if (node[0]?.id) {
            const incomingEdges = (await repo.queryRaw(
              `SELECT n.label, n.metadata
               FROM graph_edges e
               JOIN graph_nodes n ON n.id = e.from_node_id
               WHERE e.to_node_id = ? AND e.type = 'calls'
               LIMIT ?`,
              [node[0].id, callerLimit],
            )) as Array<{ label: string; metadata: string }>;

            for (const inEdge of incomingEdges) {
              let meta: Record<string, unknown> = {};
              try {
                meta = JSON.parse(inEdge.metadata || "{}");
              } catch {}
              callers.push({
                name: inEdge.label,
                filePath: meta.filePath
                  ? String(meta.filePath)
                  : meta.path
                    ? String(meta.path)
                    : undefined,
              });
            }

            const outgoingEdges = (await repo.queryRaw(
              `SELECT n.label, n.metadata
               FROM graph_edges e
               JOIN graph_nodes n ON n.id = e.to_node_id
               WHERE e.from_node_id = ? AND e.type = 'calls'
               LIMIT ?`,
              [node[0].id, callerLimit],
            )) as Array<{ label: string; metadata: string }>;

            for (const outEdge of outgoingEdges) {
              let meta: Record<string, unknown> = {};
              try {
                meta = JSON.parse(outEdge.metadata || "{}");
              } catch {}
              callees.push({
                name: outEdge.label,
                filePath: meta.filePath
                  ? String(meta.filePath)
                  : meta.path
                    ? String(meta.path)
                    : undefined,
              });
            }
          }

          affectedSymbols.push({
            name: s.name,
            kind: s.symbolType || s.kind || "symbol",
            startLine: symStart,
            endLine: symEnd,
            exported: Boolean(s.exported),
            parentSymbol: s.parentSymbol,
            callers,
            callees,
          });
          totalSymbolsAffected++;
        }
      }
    }

    fileContexts.push({
      filePath: fileDiff.filePath,
      status: fileDiff.status,
      changedLineRanges: fileDiff.ranges,
      affectedSymbols,
      imports: fileImports.length > 0 ? fileImports : undefined,
    });
  }

  // Format ASCII summary card
  const summaryLines: string[] = [
    "============================================================",
    ` OpenEZ Diff Context: ${fileContexts.length} modified files (${totalSymbolsAffected} symbols affected)`,
    "============================================================",
  ];

  if (fileContexts.length === 0) {
    summaryLines.push("  No modified files found in working tree.");
  } else {
    for (const f of fileContexts) {
      const statusIcon = f.status === "added" ? "✨" : f.status === "deleted" ? "🗑️" : "📁";
      summaryLines.push(`\n${statusIcon} ${f.filePath} (${f.status})`);
      if (f.imports && f.imports.length > 0) {
        summaryLines.push(`  • 📦 Imports: ${f.imports.join(", ")}`);
      }
      if (f.affectedSymbols.length === 0) {
        summaryLines.push("  • (No indexed symbols modified)");
      } else {
        for (const sym of f.affectedSymbols) {
          const kindIcon = sym.kind === "function" || sym.kind === "method" ? "🔹" : "📦";
          summaryLines.push(
            `  • ${kindIcon} ${sym.name} [L${sym.startLine}-L${sym.endLine}] (modified)`,
          );
          if (sym.callers.length > 0) {
            summaryLines.push(`    ├── 👥 Callers (${sym.callers.length} affected):`);
            for (let cIdx = 0; cIdx < sym.callers.length; cIdx++) {
              const c = sym.callers[cIdx];
              const isLastCaller = cIdx === sym.callers.length - 1;
              const subPrefix = isLastCaller ? "    │   └── " : "    │   ├── ";
              summaryLines.push(`${subPrefix}${c.name}${c.filePath ? ` (${c.filePath})` : ""}`);
            }
          }
          if (sym.callees.length > 0) {
            summaryLines.push(`    └── 🔗 Calls: ${sym.callees.map((cal) => cal.name).join(", ")}`);
          }
        }
      }
    }
  }

  summaryLines.push("\n============================================================");

  return {
    targetRef: options.staged ? "--staged" : options.ref || "working-tree",
    totalFilesChanged: fileContexts.length,
    totalSymbolsAffected,
    files: fileContexts,
    formattedSummary: summaryLines.join("\n"),
  };
}
