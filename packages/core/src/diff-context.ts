import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { createWorkspaceRepository } from "@openez-graph/db";

export interface ChangedHunkRange {
  start: number;
  end: number;
}

/**
 * Maximum allowed length for a Git ref or rev expression.
 * Git refs are limited to 1024 bytes internally; we use a conservative
 * 256-char cap that covers all realistic branch/tag/rev expressions.
 */
const MAX_GIT_REF_LENGTH = 256;

/**
 * Pattern for a single Git rev expression component.
 *
 * Allows alphanumerics and the characters that appear in branch names,
 * tag names, and relative rev expressions: `.` `_` `/` `-` `^` `~` `@` `{` `}`.
 * The first character must be alphanumeric or `@` (for `@{N}` / `@`-shorthand).
 * A leading `-` is explicitly rejected to prevent git option injection.
 * The component must NOT end with `.` (rejects `HEAD..`, `main..` which are
 * incomplete range expressions). Trailing `-` is allowed (git permits
 * branch names like `feature-`).
 */
const GIT_REV_COMPONENT = /[A-Za-z0-9@](?:[A-Za-z0-9._/^~@{}-]*[A-Za-z0-9_^~@{}-])?/;

/**
 * Full rev expression: one or two components separated by `..` or `...`
 * (for commit ranges like `main..HEAD` or `main...HEAD`).
 * The `..` separator is matched explicitly so `a..b..c` (double range) is
 * rejected — git does not support nested ranges.
 */
const GIT_REF_PATTERN = new RegExp(
  `^${GIT_REV_COMPONENT.source}(\\.\\.${GIT_REV_COMPONENT.source})?$`,
);

/**
 * Validates that a Git ref is safe to pass as a positional argument to
 * `git diff` / `git show`.
 *
 * This prevents **option injection**: although `execFileSync` does not invoke
 * a shell, git itself parses arguments starting with `-` as options. A
 * malicious ref like `--output=/etc/passwd` or `--upload-pack=...` would be
 * interpreted as a git option rather than a ref.
 *
 * Accepted shapes:
 *   - Branch / tag names: `main`, `feature/cli-diff`, `v1.2.3`
 *   - Relative refs: `HEAD`, `HEAD~1`, `HEAD^2`, `HEAD@{1}`
 *   - Commit ranges: `main..HEAD`, `main...HEAD`
 *   - Remote refs: `origin/main`
 *
 * Rejected:
 *   - Anything starting with `-` (option injection)
 *   - Null bytes, newlines, carriage returns
 *   - Shell metacharacters (`;`, `&`, `|`, `$`, backticks, spaces)
 *   - Empty strings or strings longer than {@link MAX_GIT_REF_LENGTH}
 */
export function isValidGitRef(ref: string): boolean {
  if (typeof ref !== "string" || ref.length === 0 || ref.length > MAX_GIT_REF_LENGTH) {
    return false;
  }
  if (ref.includes("\0") || ref.includes("\n") || ref.includes("\r")) {
    return false;
  }
  // Reject double ranges like a..b..c — git does not support nested ranges.
  // The regex component charset includes `.` (for v1.2.3), so `b..c` would
  // otherwise match as a single component.
  const dotDotMatches = ref.match(/\.\./g);
  if (dotDotMatches && dotDotMatches.length > 1) return false;
  return GIT_REF_PATTERN.test(ref);
}

/**
 * Derives the old-side revision for `git show <rev>:<path>` from a ref.
 *
 * - `undefined` or `null` → `"HEAD"` (default diff target)
 * - `"HEAD"`, `"main"`, `"v1.2.3"` → returned as-is (single rev)
 * - `"main..HEAD"` → `"main"` (left side of `..` — two-dot range)
 * - `"main...HEAD"` → merge-base of `main` and `HEAD` (three-dot range;
 *   `git diff A...B` compares merge-base(A,B) against B, not A against B)
 *
 * `git show A..B:path` and `git show A...B:path` both silently return empty
 * output (exit 0, no content), so the old side must be resolved before use.
 * For three-dot ranges, the old side is the merge-base, not the left ref.
 */
export function resolveOldRef(ref: string | undefined, rootPath?: string): string {
  if (!ref) return "HEAD";
  const dotIdx = ref.indexOf("...");
  if (dotIdx > 0) {
    // Three-dot range: old side is merge-base(A, B)
    const left = ref.slice(0, dotIdx);
    const right = ref.slice(dotIdx + 3);
    try {
      const mergeBase = execFileSync("git", ["merge-base", left, right], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        ...(rootPath ? { cwd: rootPath } : {}),
      }).trim();
      return mergeBase || left;
    } catch {
      // merge-base may fail if refs don't share history — fall back to left
      return left;
    }
  }
  const twoDotIdx = ref.indexOf("..");
  if (twoDotIdx > 0) return ref.slice(0, twoDotIdx);
  return ref;
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
  /** How this symbol changed relative to the old revision.
   * - `added`: symbol is new in the current file (no matching old symbol)
   * - `modified`: symbol exists in both old and current, with changed lines
   * - `deleted`: symbol was removed (only appears in oldSymbols/deletedSymbols)
   *
   * For files with status `added`, all current symbols are `added`.
   * For files with status `modified`, symbols overlapping old-side hunks
   * are `modified` if they also exist in the old blob, or `added` if they
   * are newly introduced within the modified region.
   */
  changeType: "added" | "modified" | "deleted";
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
  /**
   * Callers from the current graph, populated only when a matching current
   * graph node exists for this symbol name. A historical graph is not
   * reconstructed — these edges reflect the current call graph state.
   */
  callers?: Array<{ name: string; filePath?: string }>;
  /**
   * Callees from the current graph, populated only when a matching current
   * graph node exists for this symbol name.
   */
  callees?: Array<{ name: string; filePath?: string }>;
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
  /**
   * Non-fatal warnings for this file (e.g. historical blob could not be
   * loaded). The file is still analyzed with current-side data.
   */
  warnings?: string[];
}

export interface DiffContextReport {
  targetRef: string;
  totalFilesChanged: number;
  totalSymbolsAffected: number;
  files: ModifiedFileContext[];
  formattedSummary: string;
  /**
   * Non-fatal warnings collected across all files (e.g. historical blob
   * extraction failures). The report is still valid but may be incomplete.
   */
  warnings?: string[];
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
        else if (oldCount > 0 && currentFile.status !== "deleted")
          // Deletion-only hunk (+L,0): no new lines were added, but the
          // symbol at the deletion point in the new file is still affected.
          // Emit a point range at newStart (clamped to line 1) so symbol
          // intersection still fires. Deleted files are excluded — their
          // symbols come from oldSymbols/deletedSymbols, not current ranges.
          currentFile.ranges.push({
            start: Math.max(1, newStart),
            end: Math.max(1, newStart),
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
 * Looks up callers and callees for a symbol name from the current graph.
 * Returns empty arrays if no current graph node matches. Used for historical
 * symbols per the plan: "Current graph edges are used for historical symbols
 * only when a current graph node exists; a historical graph is not
 * reconstructed."
 */
async function lookupCurrentGraphEdges(
  repo: ReturnType<typeof createWorkspaceRepository>,
  filePath: string,
  symbolName: string,
  callerLimit: number,
): Promise<{
  callers: Array<{ name: string; filePath?: string }>;
  callees: Array<{ name: string; filePath?: string }>;
}> {
  const escapedName = String(symbolName || "").replace(/[%_\\]/g, "\\$&");
  const node = (await repo.queryRaw(
    `SELECT id FROM graph_nodes
     WHERE type = 'symbol'
       AND json_extract(metadata, '$.filePath') = ?
       AND (label = ? OR label LIKE ? ESCAPE '\\')
     LIMIT 1`,
    [filePath, symbolName, `%::${escapedName}`],
  )) as Array<{ id: string }>;

  if (!node[0]?.id) return { callers: [], callees: [] };

  const nodeId = node[0].id;
  const callers: Array<{ name: string; filePath?: string }> = [];
  const callees: Array<{ name: string; filePath?: string }> = [];

  const incomingEdges = (await repo.queryRaw(
    `SELECT n.label, n.metadata
     FROM graph_edges e
     JOIN graph_nodes n ON n.id = e.from_node_id
     WHERE e.to_node_id = ? AND e.type = 'calls'
     LIMIT ?`,
    [nodeId, callerLimit],
  )) as Array<{ label: string; metadata: string }>;

  for (const inEdge of incomingEdges) {
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(inEdge.metadata || "{}");
    } catch {
      // Malformed metadata — skip filePath extraction
    }
    callers.push({
      name: inEdge.label,
      filePath: meta.filePath ? String(meta.filePath) : meta.path ? String(meta.path) : undefined,
    });
  }

  const outgoingEdges = (await repo.queryRaw(
    `SELECT n.label, n.metadata
     FROM graph_edges e
     JOIN graph_nodes n ON n.id = e.to_node_id
     WHERE e.from_node_id = ? AND e.type = 'calls'
     LIMIT ?`,
    [nodeId, callerLimit],
  )) as Array<{ label: string; metadata: string }>;

  for (const outEdge of outgoingEdges) {
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(outEdge.metadata || "{}");
    } catch {
      // Malformed metadata — skip filePath extraction
    }
    callees.push({
      name: outEdge.label,
      filePath: meta.filePath ? String(meta.filePath) : meta.path ? String(meta.path) : undefined,
    });
  }

  return { callers, callees };
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

  if (options.ref && !isValidGitRef(options.ref)) {
    throw new Error(
      `Invalid git ref '${options.ref}': ref must not start with '-', must not contain shell metacharacters or control characters, and must be a valid rev expression (e.g. HEAD, HEAD~1, main, origin/main, main..HEAD).`,
    );
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
  } catch (err) {
    const stderr =
      err && typeof err === "object" && "stderr" in err
        ? String((err as { stderr: unknown }).stderr ?? "").trim()
        : "";
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to execute git diff${options.ref ? ` for ref '${options.ref}'` : ""}: ${stderr || message}`,
    );
  }

  // The old revision whose blobs we load for historical symbol parsing.
  // For both default (HEAD) and --staged, the old side of the diff is HEAD.
  // For an explicit ref, the old side is that ref.
  // For a range ref (A..B or A...B), the old side is A (the left side).
  // `git show A..B:path` silently returns empty output, so we must extract
  // the left side before using it with `git show`.
  const oldRev = resolveOldRef(options.ref, resolvedRoot);

  const parsedDiffs = parseGitDiffHunks(diffOutput);
  const fileContexts: ModifiedFileContext[] = [];
  const reportWarnings: string[] = [];
  let totalSymbolsAffected = 0;

  for (const fileDiff of parsedDiffs) {
    const affectedSymbols: AffectedSymbol[] = [];
    const fileImports: string[] = [];
    // Cache for lookupCurrentGraphEdges results — the same symbol may be
    // looked up in both the current-side (affectedSymbols) and historical
    // (oldSymbols/deletedSymbols) paths. Avoiding duplicate SQL queries.
    const graphEdgesCache = new Map<
      string,
      {
        callers: Array<{ name: string; filePath?: string }>;
        callees: Array<{ name: string; filePath?: string }>;
      }
    >();
    const cachedLookupGraphEdges = async (symbolName: string) => {
      // ponytail: graph follows the working tree; build an index-backed graph before adding staged edges.
      if (options.staged) return { callers: [], callees: [] };
      const cached = graphEdgesCache.get(symbolName);
      if (cached) return cached;
      const result = await lookupCurrentGraphEdges(
        repo,
        fileDiff.filePath,
        symbolName,
        callerLimit,
      );
      graphEdgesCache.set(symbolName, result);
      return result;
    };
    const rangesToMatch = fileDiff.status === "deleted" ? [] : fileDiff.ranges;
    let symbolsList: Array<{
      name: string;
      symbolType?: string;
      kind?: string;
      exported?: boolean;
      startLine?: number;
      endLine?: number;
      parentSymbol?: string;
      receiver?: string;
    }> = [];
    let usedStagedBlob = false;

    if (options.staged && options.parseBlob && fileDiff.status !== "deleted") {
      const stagedContent = execFileSync("git", ["show", `:${fileDiff.filePath}`], {
        cwd: resolvedRoot,
        encoding: "utf8",
        maxBuffer: 5 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stagedSymbols = await options.parseBlob({
        relativePath: fileDiff.filePath,
        content: stagedContent,
      });
      symbolsList = stagedSymbols.map((s) => ({
        name: s.name,
        symbolType: s.symbolType,
        exported: s.exported,
        startLine: s.startLine,
        endLine: s.endLine,
        parentSymbol: s.parentSymbol,
      }));
      usedStagedBlob = true;
    }

    // Query parsed_documents for file AST symbols
    const doc =
      fileDiff.status === "deleted" ? undefined : await repo.getDocumentByPath(fileDiff.filePath);
    if (doc) {
      // Query file-level imports dependencies. The graph follows the working
      // tree, so it cannot safely enrich a staged-only report.
      if (!options.staged) {
        const fileEdges = (await repo.queryRaw(
          `SELECT target.label
         FROM graph_edges e
         JOIN graph_nodes source ON source.id = e.from_node_id
         JOIN graph_nodes target ON target.id = e.to_node_id
         WHERE source.type = 'file'
           AND source.label = ?
          AND e.type = 'imports'`,
          [doc.path],
        )) as Array<{ label: string }>;

        for (const edge of fileEdges) {
          fileImports.push(edge.label);
        }
      }

      // Parsed documents represent the working tree. For --staged, symbols
      // must instead come from the index blob above so unstaged edits cannot
      // change the reported staged context.
      let usedLiveParse = false;
      if (!usedStagedBlob && options.parseBlob) {
        const absPath = path.join(resolvedRoot, fileDiff.filePath);
        try {
          const currentContent = fs.readFileSync(absPath, "utf8");
          const currentHash = createHash("sha256").update(currentContent).digest("hex");
          if (currentHash !== doc.contentHash) {
            // File is stale — parse current content on-the-fly
            const liveSymbols = await options.parseBlob({
              relativePath: fileDiff.filePath,
              content: currentContent,
            });
            symbolsList = liveSymbols.map((s) => ({
              name: s.name,
              symbolType: s.symbolType,
              exported: s.exported,
              startLine: s.startLine,
              endLine: s.endLine,
              parentSymbol: s.parentSymbol,
            }));
            usedLiveParse = true;
          }
        } catch {
          // File may not exist yet (e.g., added then deleted in worktree).
          // Fall through to parsed_documents below.
        }
      }

      if (!usedStagedBlob && !usedLiveParse) {
        const parsed = await repo.queryRaw(
          "SELECT symbols FROM parsed_documents WHERE document_id = ?",
          [doc.id],
        );
        if (parsed[0]?.symbols) {
          try {
            symbolsList = JSON.parse(String(parsed[0].symbols));
          } catch {
            // Corrupt symbols JSON — leave symbolsList empty
          }
        }
      }
    }

    for (const s of symbolsList) {
      const symStart = Number(s.startLine || 1);
      const symEnd = Number(s.endLine || symStart);

      if (!rangesToMatch.some((r) => r.start <= symEnd && r.end >= symStart)) continue;

      const { callers, callees } = await cachedLookupGraphEdges(s.name);
      const changeType: "added" | "modified" =
        fileDiff.status === "added"
          ? "added"
          : fileDiff.oldRanges.some((r) => r.start <= symEnd && r.end >= symStart)
            ? "modified"
            : "added";

      affectedSymbols.push({
        name: s.name,
        kind: s.symbolType || s.kind || "symbol",
        startLine: symStart,
        endLine: symEnd,
        exported: Boolean(s.exported),
        parentSymbol: s.parentSymbol ?? s.receiver,
        callers,
        callees,
        changeType,
      });
      totalSymbolsAffected++;
    }

    // Historical symbol support: parse old Git blob and map old ranges.
    // Only when a parseBlob callback is provided.
    let oldSymbols: HistoricalSymbol[] | undefined;
    let deletedSymbols: HistoricalSymbol[] | undefined;
    let fileWarnings: string[] | undefined;
    let oldBlobSymbolNames: Set<string> | undefined;

    if (options.parseBlob && fileDiff.status !== "added") {
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
        // Collect old symbol names for changeType identity comparison.
        // Line overlap alone is insufficient: a rename (foo→bar at same
        // lines) should mark bar as "added" and foo as "deleted", not
        // "modified". A symbol shifted by insertion (same name, different
        // lines) should remain "modified".
        oldBlobSymbolNames = new Set(oldBlobSymbols.map((s) => s.name));

        if (fileDiff.status === "deleted") {
          // All old symbols are deleted. Attach current-graph caller/callee
          // edges when a matching current node still exists (plan: "Current
          // graph edges are used for historical symbols only when a current
          // graph node exists").
          deletedSymbols = await Promise.all(
            oldBlobSymbols.map(async (s) => {
              const edges = await cachedLookupGraphEdges(s.name);
              return {
                name: s.name,
                kind: s.symbolType,
                startLine: s.startLine,
                endLine: s.endLine,
                exported: s.exported,
                ...(s.parentSymbol ? { parentSymbol: s.parentSymbol } : {}),
                changeType: "deleted" as const,
                ...(edges.callers.length > 0 ? { callers: edges.callers } : {}),
                ...(edges.callees.length > 0 ? { callees: edges.callees } : {}),
              };
            }),
          );
          // Count deleted symbols so the header reflects the full impact
          totalSymbolsAffected += deletedSymbols.length;
        } else if (fileDiff.oldRanges.length > 0) {
          // Map old-side hunk ranges to old symbols. Attach current-graph
          // caller/callee edges when a matching current node exists.
          const currentNames = new Set(affectedSymbols.map((s) => s.name));
          oldSymbols = await Promise.all(
            oldBlobSymbols
              .filter((s) =>
                fileDiff.oldRanges.some((r) => r.start <= s.endLine && r.end >= s.startLine),
              )
              .map(async (s) => {
                const edges = await cachedLookupGraphEdges(s.name);
                return {
                  name: s.name,
                  kind: s.symbolType,
                  startLine: s.startLine,
                  endLine: s.endLine,
                  exported: s.exported,
                  ...(s.parentSymbol ? { parentSymbol: s.parentSymbol } : {}),
                  changeType: currentNames.has(s.name)
                    ? ("modified" as const)
                    : ("deleted" as const),
                  ...(edges.callers.length > 0 ? { callers: edges.callers } : {}),
                  ...(edges.callees.length > 0 ? { callees: edges.callees } : {}),
                };
              }),
          );
          // Count symbols removed within this modified file (old symbols
          // that no longer exist in the current file) so the header
          // reflects the full impact, not just whole-file deletions.
          const removedInFile = oldSymbols.filter((s) => s.changeType === "deleted").length;
          totalSymbolsAffected += removedInFile;
          // Also populate deletedSymbols for symbols removed within a
          // modified file, so clients can find all deleted symbols in one
          // place regardless of whether the file was deleted or modified.
          if (removedInFile > 0) {
            deletedSymbols = oldSymbols.filter((s) => s.changeType === "deleted");
          }
        }
      } catch (blobErr) {
        // Blob may not exist at oldRev (e.g., added file) or git show may
        // fail. Surface a structured warning so the client knows historical
        // symbols are missing for this file, rather than silently dropping.
        const reason = blobErr instanceof Error ? blobErr.message : String(blobErr);
        const warning = `Historical blob extraction failed for ${oldBlobPath} at ${oldRev}: ${reason}`;
        fileWarnings = [warning];
        reportWarnings.push(warning);
      }
    }

    // Post-process affectedSymbols changeType using old blob symbol names.
    // Line overlap compares different coordinate systems when an insertion
    // shifts an otherwise unchanged symbol. Match against the old blob so
    // renames/new symbols remain "added" while shifted symbols are "modified".
    if (oldBlobSymbolNames && fileDiff.status === "modified") {
      for (const sym of affectedSymbols) {
        sym.changeType = oldBlobSymbolNames.has(sym.name) ? "modified" : "added";
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
      ...(fileWarnings && fileWarnings.length > 0 ? { warnings: fileWarnings } : {}),
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
            `  • ${kindIcon} ${sym.name} [L${sym.startLine}-L${sym.endLine}] (${sym.changeType})`,
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
    ...(reportWarnings.length > 0 ? { warnings: reportWarnings } : {}),
  };
}
