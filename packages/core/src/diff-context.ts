import { execFileSync } from "node:child_process";
import path from "node:path";

import { createWorkspaceRepository } from "@openez-graph/db";

export interface ChangedHunkRange {
  start: number;
  end: number;
}

export interface FileDiffHunks {
  filePath: string;
  oldPath?: string;
  status: "modified" | "added" | "deleted";
  /** Ranges in the current working tree (the `+` side of each hunk). */
  ranges: ChangedHunkRange[];
  /** Ranges in the old file (the `-` side of each hunk). */
  oldRanges: ChangedHunkRange[];
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

/**
 * A symbol from the old revision of a file, parsed from a Git blob.
 * Used to track deleted and historically renamed symbols.
 */
export interface HistoricalSymbol {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  exported: boolean;
  parentSymbol?: string;
  /** How this symbol changed relative to the current tree. */
  changeType: "added" | "modified" | "deleted";
}

export interface ModifiedFileContext {
  filePath: string;
  status: "modified" | "added" | "deleted";
  changedLineRanges: ChangedHunkRange[];
  affectedSymbols: AffectedSymbol[];
  /**
   * Symbols from the old revision that overlap the old-side hunk ranges.
   * Only populated when a `parseBlob` callback is provided.
   */
  oldSymbols?: HistoricalSymbol[];
  /**
   * Symbols that existed in the old revision but no longer exist in the
   * current tree (deleted files or removed symbols).
   * Only populated when a `parseBlob` callback is provided.
   */
  deletedSymbols?: HistoricalSymbol[];
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
 * Minimal symbol shape that a blob parser must return.
 * The indexer's `ParsedSymbol` satisfies this interface.
 */
export interface BlobSymbol {
  name: string;
  symbolType: string;
  exported: boolean;
  startLine: number;
  endLine: number;
  parentSymbol?: string;
}

/**
 * Callback that parses source content into symbols in memory.
 * The caller (CLI/MCP) provides this by wrapping the indexer's `parseDocument`.
 * Historical blobs are never written to the workspace DB.
 */
export type BlobParser = (input: {
  relativePath: string;
  content: string;
}) => Promise<BlobSymbol[]>;

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
      let oldPath = "";
      let targetPath = "";
      const match = line.match(
        /^diff --git (?:a\/([^\s"]+)|"a\/(.+?)") (?:b\/([^\s"]+)|"b\/(.+?)")$/,
      );
      if (match) {
        oldPath = match[1] || match[2] || "";
        targetPath = match[3] || match[4] || match[1] || match[2] || "";
      } else {
        const parts = line.split(" ");
        if (parts.length >= 4) {
          oldPath = parts[2].replace(/^a\//, "").replace(/^"|"$/g, "");
          targetPath = parts.slice(3).join(" ").replace(/^b\//, "").replace(/^"|"$/g, "");
        }
      }
      currentFile = {
        filePath: targetPath,
        ...(oldPath ? { oldPath } : {}),
        status: "modified",
        ranges: [],
        oldRanges: [],
      };
    } else if (line.startsWith("new file mode")) {
      if (currentFile) {
        currentFile.status = "added";
        delete currentFile.oldPath;
      }
    } else if (line.startsWith("deleted file mode")) {
      if (currentFile) currentFile.status = "deleted";
    } else if (line.startsWith("rename from ")) {
      if (currentFile) currentFile.oldPath = line.slice("rename from ".length);
    } else if (line.startsWith("rename to ")) {
      if (currentFile) currentFile.filePath = line.slice("rename to ".length);
    } else if (line.startsWith("@@ ")) {
      const hunkMatch = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (hunkMatch && currentFile) {
        const oldStart = parseInt(hunkMatch[1], 10);
        const oldCount = hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1;
        const newStart = parseInt(hunkMatch[3], 10);
        const newCount = hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1;
        if (oldCount > 0)
          currentFile.oldRanges.push({ start: oldStart, end: oldStart + oldCount - 1 });
        if (newCount > 0)
          currentFile.ranges.push({ start: newStart, end: newStart + newCount - 1 });
      }
    }
  }

  if (currentFile) {
    files.push(currentFile);
  }

  return files;
}

/**
 * When analyzing staged diffs with unstaged working-tree changes present, maps
 * line ranges from the staged blob (INDEX) to current working-tree coordinates.
 */
export function mapStagedRangesToWorkingTree(
  stagedRanges: ChangedHunkRange[],
  unstagedDiffText: string,
): ChangedHunkRange[] {
  if (!unstagedDiffText.trim()) return stagedRanges.map(({ start, end }) => ({ start, end }));

  const lines = unstagedDiffText.split("\n");
  const hunks: Array<{
    aStart: number;
    aCount: number;
    bStart: number;
    bCount: number;
    delta: number;
  }> = [];

  for (const line of lines) {
    if (line.startsWith("@@ ")) {
      const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (match) {
        const aStart = parseInt(match[1], 10);
        const aCount = match[2] !== undefined ? parseInt(match[2], 10) : 1;
        const bStart = parseInt(match[3], 10);
        const bCount = match[4] !== undefined ? parseInt(match[4], 10) : 1;
        hunks.push({
          aStart,
          aCount,
          bStart,
          bCount,
          delta: bCount - aCount,
        });
      }
    }
  }

  if (hunks.length === 0) return stagedRanges.map(({ start, end }) => ({ start, end }));

  return stagedRanges.map((range) => {
    let start = range.start;
    let end = range.end;

    for (const h of hunks) {
      const aEnd = h.aCount === 0 ? h.aStart : h.aStart + h.aCount - 1;

      // Compare every hunk with immutable index coordinates. `start` and `end`
      // below are working-tree coordinates after earlier hunks have been applied.
      if (range.end < h.aStart) {
        // Range is before this hunk, unaffected
        continue;
      } else if (range.start > aEnd) {
        // Range is after this hunk, shift by delta
        start += h.delta;
        end += h.delta;
      } else {
        // Range overlaps the unstaged hunk
        start = Math.min(start, h.bStart);
        end = Math.max(end + h.delta, h.bStart + Math.max(0, h.bCount - 1));
      }
    }

    return { start: Math.max(1, start), end: Math.max(1, end) };
  });
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
    /**
     * Optional callback to parse historical Git blobs into symbols.
     * When provided, `oldSymbols` and `deletedSymbols` are populated for
     * modified and deleted files. Historical blobs are parsed in memory
     * and never written to the workspace DB.
     */
    parseBlob?: BlobParser;
  } = {},
): Promise<DiffContextReport> {
  if (options.ref && options.staged) {
    throw new Error("Cannot combine a git ref with staged changes");
  }

  const resolvedRoot = path.resolve(rootPath);
  const repo = createWorkspaceRepository(resolvedRoot);
  const callerLimit = options.limit ?? 5;

  const gitArgs = ["diff", "--no-color", "--src-prefix=a/", "--dst-prefix=b/"];
  if (options.staged) gitArgs.push("--staged");
  else if (options.ref) {
    gitArgs.push(options.ref);
  } else {
    gitArgs.push("HEAD");
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

  // The old revision whose blobs we load for historical symbol parsing.
  // For both default (HEAD) and --staged, the old side of the diff is HEAD.
  // For an explicit ref, the old side is that ref.
  const oldRev = options.ref ?? "HEAD";

  const parsedDiffs = parseGitDiffHunks(diffOutput);
  const fileContexts: ModifiedFileContext[] = [];
  let totalSymbolsAffected = 0;

  for (const fileDiff of parsedDiffs) {
    const affectedSymbols: AffectedSymbol[] = [];
    const fileImports: string[] = [];
    let rangesToMatch = fileDiff.status === "deleted" ? [] : fileDiff.ranges;

    if (options.staged && fileDiff.status !== "deleted") {
      try {
        const unstagedDiff = execFileSync(
          "git",
          ["diff", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "--", fileDiff.filePath],
          {
            cwd: resolvedRoot,
            encoding: "utf8",
            maxBuffer: 5 * 1024 * 1024,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        rangesToMatch = mapStagedRangesToWorkingTree(fileDiff.ranges, unstagedDiff);
      } catch {}
    }

    // Query parsed_documents for file AST symbols
    const doc =
      fileDiff.status === "deleted" ? undefined : await repo.getDocumentByPath(fileDiff.filePath);
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
        const overlaps = rangesToMatch.some((r) => r.start <= symEnd && r.end >= symStart);

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

    // Historical symbol support: parse old Git blob and map old ranges.
    // Only when a parseBlob callback is provided.
    let oldSymbols: HistoricalSymbol[] | undefined;
    let deletedSymbols: HistoricalSymbol[] | undefined;

    if (options.parseBlob) {
      const oldBlobPath = fileDiff.oldPath ?? fileDiff.filePath;
      try {
        const oldContent = execFileSync("git", ["show", `${oldRev}:${oldBlobPath}`], {
          cwd: resolvedRoot,
          encoding: "utf8",
          maxBuffer: 5 * 1024 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const oldBlobSymbols = await options.parseBlob({
          relativePath: oldBlobPath,
          content: oldContent,
        });

        if (fileDiff.status === "deleted") {
          // All old symbols are deleted
          deletedSymbols = oldBlobSymbols.map((s) => ({
            name: s.name,
            kind: s.symbolType,
            startLine: s.startLine,
            endLine: s.endLine,
            exported: s.exported,
            ...(s.parentSymbol ? { parentSymbol: s.parentSymbol } : {}),
            changeType: "deleted" as const,
          }));
        } else if (fileDiff.oldRanges.length > 0) {
          // Map old-side hunk ranges to old symbols
          const currentNames = new Set(affectedSymbols.map((s) => s.name));
          oldSymbols = oldBlobSymbols
            .filter((s) =>
              fileDiff.oldRanges.some((r) => r.start <= s.endLine && r.end >= s.startLine),
            )
            .map((s) => ({
              name: s.name,
              kind: s.symbolType,
              startLine: s.startLine,
              endLine: s.endLine,
              exported: s.exported,
              ...(s.parentSymbol ? { parentSymbol: s.parentSymbol } : {}),
              changeType: currentNames.has(s.name) ? ("modified" as const) : ("deleted" as const),
            }));
        }
      } catch {
        // Blob may not exist at oldRev (e.g., added file) or git show may fail.
        // Silently skip historical symbol extraction for this file.
      }
    }

    fileContexts.push({
      filePath: fileDiff.filePath,
      status: fileDiff.status,
      changedLineRanges: rangesToMatch,
      affectedSymbols,
      ...(oldSymbols && oldSymbols.length > 0 ? { oldSymbols } : {}),
      ...(deletedSymbols && deletedSymbols.length > 0 ? { deletedSymbols } : {}),
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
      if (f.deletedSymbols && f.deletedSymbols.length > 0) {
        summaryLines.push(`  • 📛 Deleted symbols (${f.deletedSymbols.length}):`);
        for (const sym of f.deletedSymbols) {
          summaryLines.push(`    └── 💀 ${sym.name} [L${sym.startLine}-L${sym.endLine}] (deleted)`);
        }
      }
      if (f.oldSymbols && f.oldSymbols.length > 0) {
        summaryLines.push(`  • 📜 Old symbols (${f.oldSymbols.length}):`);
        for (const sym of f.oldSymbols) {
          summaryLines.push(
            `    ├── 📝 ${sym.name} [L${sym.startLine}-L${sym.endLine}] (${sym.changeType})`,
          );
        }
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
