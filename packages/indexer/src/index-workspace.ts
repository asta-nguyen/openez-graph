import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

import { getBrainSettings, loadBrainConfig } from "@openez-graph/config";
import { fastTokenCounter, type TokenCounter } from "@openez-graph/core";
import {
  createRegistryRepository,
  createWorkspaceRepository,
  writeLocalWorkspaceConfig,
} from "@openez-graph/db";
import type { RegistryWorkspace, WorkspaceRepository } from "@openez-graph/db";

import { hashContent } from "./hash";
import {
  createSymbolChunks,
  inferDocumentKind,
  makeFallbackChunks,
  type ExtractedSymbol,
} from "./languages";
import { parseDocument } from "./parsers";
import { scanWorkspaceFiles } from "./scanner";
import type { IndexedChunk, IndexWorkspaceSummary } from "./types";

const RESOLVABLE_SOURCE_EXTENSIONS = [
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
  ".rb",
] as const;

// Parser version tags stored alongside cached parse results in
// `parsed_documents`. Bump these when parser logic changes so stale cache
// entries are invalidated on the next index/graph build.
const PARSER_VERSION_OXC = "oxc-v2";
const PARSER_VERSION_NATIVE = "native-v1";
const PARSER_VERSION_FALLBACK = "fallback-v1";
const INDEX_LEASE_DURATION_MS = 60_000;
const INDEX_HEARTBEAT_INTERVAL_MS = 15_000;

function indexLeaseExpiry(): string {
  return new Date(Date.now() + INDEX_LEASE_DURATION_MS).toISOString();
}

/**
 * Native tree-sitter parser surface used by the indexer. The native extension
 * is optional (platform-specific .node binary); when unavailable the indexer
 * falls back to the WASM/regex parsers and tags cache rows `fallback-v1`.
 */
export interface NativeParser {
  readonly id: "native-v1";
  parseCodeBatch(items: Array<{ language: string; content: string }>): Array<{
    symbols: Array<{
      name: string;
      symbolType: string;
      exported: boolean;
      startLine: number;
      endLine: number;
      receiver?: string;
    }>;
    importPaths: string[];
    calledIdentifiers: string[];
    callExpressions: Array<{ callerName: string; calleeName: string }>;
  } | null>;
}

let _nativeParser: NativeParser | null | undefined;

/**
 * Resolve the native tree-sitter parser once and cache the result. Returns
 * `null` when the platform-specific native extension is unavailable — callers
 * then fall back to the registry parsers and tag cached rows `fallback-v1`.
 * The resolved capability also drives parsed_documents cache validation: a
 * cache row is only reused when its `parser_version` matches the parser that
 * the current capability would use (`native-v1` vs `fallback-v1`).
 */
export function resolveNativeParser(): NativeParser | null {
  if (_nativeParser !== undefined) return _nativeParser;
  try {
    const nativePath = path.join(__dirname, "native", "index.linux-x64-gnu.node");
    _nativeParser = require(nativePath) as NativeParser;
  } catch {
    try {
      _nativeParser = require("@openez-graph/native") as NativeParser;
    } catch {
      _nativeParser = null;
    }
  }
  return _nativeParser;
}

/**
 * Reset the cached native parser resolution. Exposed for tests that need to
 * simulate the native extension being unavailable.
 */
export function resetNativeParserCache(): void {
  _nativeParser = undefined;
}

/**
 * Map a parser name (returned by `parseDocument`/`parseInline`) to the
 * version tag stored in `parsed_documents.parser_version`. Native
 * tree-sitter results use `native-v1`, the fallback parser uses
 * `fallback-v1`, and every other parser (oxc, markdown, config, regex)
 * is grouped under `oxc-v2` since they share the same chunking/call-
 * extraction contract. Non-native tree-sitter/regex fallbacks for
 * Python/Go/Rust use `fallback-v1` so cache validation matches the
 * expected version when the native extension is unavailable.
 */
function parserVersionFor(parserName: string): string {
  if (parserName === "tree-sitter-native") return PARSER_VERSION_NATIVE;
  if (parserName === "fallback" || parserName === "tree-sitter" || parserName === "regex")
    return PARSER_VERSION_FALLBACK;
  return PARSER_VERSION_OXC;
}

function normalizeRelativePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

export function createWorkspaceFileResolver(
  workspaceRoot: string,
  files: Array<{ relativePath: string; absolutePath: string }>,
) {
  const knownRelativePaths = new Set(files.map((file) => normalizeRelativePath(file.relativePath)));
  const absoluteToRelative = new Map(
    files.map((file) => [
      path.resolve(file.absolutePath),
      normalizeRelativePath(file.relativePath),
    ]),
  );

  function toWorkspaceRelative(candidateAbsolutePath: string): string | null {
    const resolvedAbsolute = path.resolve(candidateAbsolutePath);
    const mapped = absoluteToRelative.get(resolvedAbsolute);
    if (mapped) return mapped;

    const relativeToWorkspace = normalizeRelativePath(
      path.relative(workspaceRoot, resolvedAbsolute),
    );
    if (relativeToWorkspace.startsWith("../")) return null;

    return knownRelativePaths.has(relativeToWorkspace) ? relativeToWorkspace : null;
  }

  function resolveRelativeImport(importerRelativePath: string, importPath: string): string | null {
    const importerDirectory = path.dirname(path.resolve(workspaceRoot, importerRelativePath));
    const baseCandidate = path.resolve(importerDirectory, importPath);
    const directMatch = toWorkspaceRelative(baseCandidate);
    if (directMatch) return directMatch;

    for (const extension of RESOLVABLE_SOURCE_EXTENSIONS) {
      const withExtension = toWorkspaceRelative(`${baseCandidate}${extension}`);
      if (withExtension) return withExtension;
    }

    for (const extension of RESOLVABLE_SOURCE_EXTENSIONS) {
      const asIndexFile = toWorkspaceRelative(path.join(baseCandidate, `index${extension}`));
      if (asIndexFile) return asIndexFile;
    }

    return null;
  }

  function resolvePythonModulePath(modulePath: string): string | null {
    const basePath = normalizeRelativePath(modulePath.replace(/\./g, "/"));

    const directPath = `${basePath}.py`;
    if (knownRelativePaths.has(directPath)) return directPath;

    const initPath = `${basePath}/__init__.py`;
    if (knownRelativePaths.has(initPath)) return initPath;

    return null;
  }

  function resolvePythonRelativeImport(
    importerRelativePath: string,
    importPath: string,
  ): string | null {
    const dotMatch = /^(\.+)(.*)$/.exec(importPath);
    if (!dotMatch) return null;

    const level = dotMatch[1].length;
    const remainder = dotMatch[2].replace(/^\./, "");
    let baseDirectory = normalizeRelativePath(path.dirname(importerRelativePath));

    for (let index = 1; index < level; index++) {
      baseDirectory = normalizeRelativePath(path.dirname(baseDirectory));
    }

    const modulePath = remainder
      ? normalizeRelativePath(path.join(baseDirectory, remainder.replace(/\./g, "/")))
      : baseDirectory;

    return resolvePythonModulePath(modulePath);
  }

  function resolvePythonImport(importerRelativePath: string, importPath: string): string | null {
    if (importPath.startsWith(".")) {
      const resolved = resolvePythonRelativeImport(importerRelativePath, importPath);
      if (resolved) return resolved;
    }

    return resolvePythonModulePath(importPath);
  }

  return {
    resolveImport(
      importerRelativePath: string,
      importPath: string,
      language?: string,
    ): string | null {
      if (language === "python") {
        const resolved = resolvePythonImport(importerRelativePath, importPath);
        if (resolved) return resolved;
      }

      if (language === "ruby") {
        return resolveRelativeImport(importerRelativePath, importPath);
      }

      if (importPath.startsWith(".")) {
        return resolveRelativeImport(importerRelativePath, importPath);
      }

      return null;
    },
  };
}

async function resetDocumentArtifacts(repo: WorkspaceRepository, documentId: string) {
  const chunks = await repo.getChunksByDocument(documentId);
  const chunkIds = chunks.map((c) => c.id);

  if (chunkIds.length > 0) {
    await repo.deleteEmbeddingsByChunkIds(chunkIds);
  }

  await repo.deleteGraphNodesByRefId(documentId);
  await repo.deleteChunksByDocument(documentId);
}

/**
 * Reset artifacts for a file that changed content, preserving stable graph node identities.
 * - Deletes old chunk nodes and chunk rows (content-dependent)
 * - Deletes outgoing edges from the file node (contains, defines, imports, mentions)
 * - Deletes outgoing edges from the file's symbol nodes (represented_by, calls)
 * - Preserves the file node and symbol nodes (identity = path / filePath+name)
 * Caller must reconcile symbol nodes after re-parsing.
 */
async function resetChangedFileArtifacts(
  repo: WorkspaceRepository,
  documentId: string,
  relativePath: string,
): Promise<Map<string, string>> {
  const chunks = await repo.getChunksByDocument(documentId);
  const chunkIds = chunks.map((c) => c.id);

  if (chunkIds.length > 0) {
    await repo.deleteEmbeddingsByChunkIds(chunkIds);
  }

  // Delete old chunk graph nodes only (preserve symbol nodes)
  repo.deleteChunkNodesByChunkIds(chunkIds);

  // Find file node and delete its outgoing edges (will be rebuilt)
  const fileNode = await repo.findFileNode(relativePath);
  if (fileNode) {
    repo.deleteOutgoingEdges(fileNode.id, ["contains", "defines", "imports", "mentions"]);
  }

  // Get existing symbol nodes for this file, delete their outgoing edges (will be rebuilt)
  const symbolNodes = await repo.getSymbolNodesByFilePath(relativePath);
  const existingSymbolNodes = new Map<string, string>();
  for (const sym of symbolNodes) {
    repo.deleteOutgoingEdges(sym.id, ["represented_by", "calls"]);
    existingSymbolNodes.set(sym.label, sym.id);
  }

  await repo.deleteChunksByDocument(documentId);

  return existingSymbolNodes;
}

export function boundChunks(
  chunks: IndexedChunk[],
  targetTokens: number,
  overlapTokens: number,
  counter: TokenCounter = fastTokenCounter,
): IndexedChunk[] {
  return chunks.flatMap((chunk) => {
    const parts = counter.split(chunk.content, targetTokens, overlapTokens);
    if (parts.length <= 1) return chunk;

    return parts.map((content, splitIndex) => ({
      ...chunk,
      content,
      tokenCount: counter.count(content),
      contentHash: hashContent(content),
      metadata: { ...chunk.metadata, splitIndex, splitCount: parts.length },
    }));
  });
}

export async function chunkDocument(input: {
  relativePath: string;
  absolutePath: string;
  content: string;
  targetTokens: number;
  overlapTokens: number;
  counter?: TokenCounter;
}) {
  const parsed = await parseDocument(input);
  return {
    kind: parsed.kind,
    language: parsed.language,
    parser: parsed.parser,
    chunks: parsed.chunks,
    importPaths: parsed.importPaths,
    wikilinks: parsed.wikilinks,
    definedSymbols: parsed.definedSymbols,
    calledIdentifiers: parsed.calledIdentifiers,
    callExpressions: parsed.callExpressions,
  };
}

interface ParseTask {
  id: string;
  content: string;
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
  mtimeMs: number;
  targetTokens: number;
  overlapTokens: number;
  counter: TokenCounter;
}

type ParseResult = Awaited<ReturnType<typeof chunkDocument>>;

async function parseInline(
  tasks: ParseTask[],
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, ParseResult>> {
  const results = new Map<string, ParseResult>();

  // ── Batch native tree-sitter parse for Python/Go/Rust files ──
  const TS_LANGS = new Set(["python", "go", "rust"]);
  const native = resolveNativeParser();

  const batchTasks: ParseTask[] = [];
  const otherTasks: ParseTask[] = [];
  if (native?.parseCodeBatch) {
    for (const task of tasks) {
      const info = inferDocumentKind(task.relativePath);
      if (info.kind === "code" && info.language && TS_LANGS.has(info.language)) {
        batchTasks.push(task);
      } else {
        otherTasks.push(task);
      }
    }
  } else {
    otherTasks.push(...tasks);
  }

  // Batch parse all tree-sitter files in one rayon-parallel call
  if (batchTasks.length > 0) {
    const _batchStart = Date.now();
    const batchItems = batchTasks.map((t) => ({
      language: inferDocumentKind(t.relativePath).language!,
      content: t.content,
    }));
    // Use parseCodeBatch — rayon-parallel tree-sitter parse for Python/Go/Rust
    const nativeResults = native!.parseCodeBatch(batchItems);
    process.stderr.write(
      `[t]   native-batch: ${Date.now() - _batchStart}ms (${batchTasks.length} files)\n`,
    );
    for (let i = 0; i < batchTasks.length; i++) {
      const task = batchTasks[i];
      const nr = nativeResults[i];
      if (nr) {
        const lang = batchItems[i].language;
        const lines = task.content.split("\n");
        // Build symbol-aware chunks so code_context can match symbol names
        // to chunks via metadata.symbolName. Fall back to line-based chunks
        // only when no symbols were extracted.
        const symbols: ExtractedSymbol[] = nr.symbols.map((s) => ({
          name: s.name,
          symbolType: s.symbolType,
          type: s.symbolType,
          exported: s.exported,
          startLine: s.startLine,
          endLine: s.endLine,
          ...(s.receiver ? { receiver: s.receiver } : {}),
        }));
        let chunks: any[];
        if (symbols.length > 0) {
          chunks = createSymbolChunks(symbols, lines, lang, task.counter);
        } else {
          chunks = makeFallbackChunks(task.content, lines, task.counter).chunks;
        }
        // Bound chunks to configured token limits
        chunks = boundChunks(chunks, task.targetTokens, task.overlapTokens, task.counter);
        results.set(task.id, {
          kind: "code",
          language: lang,
          parser: "tree-sitter-native",
          chunks,
          importPaths: nr.importPaths,
          wikilinks: [],
          definedSymbols: symbols,
          calledIdentifiers: nr.calledIdentifiers,
          callExpressions: nr.callExpressions.slice(0, 20),
        });
      } else {
        // Native returned null — fall back to individual parse
        const indexed = await chunkDocument({
          relativePath: task.relativePath,
          absolutePath: task.absolutePath,
          content: task.content,
          targetTokens: task.targetTokens,
          overlapTokens: task.overlapTokens,
          counter: task.counter,
        });
        indexed.chunks = boundChunks(
          indexed.chunks,
          task.targetTokens,
          task.overlapTokens,
          task.counter,
        );
        results.set(task.id, indexed);
      }
      onProgress?.(results.size, tasks.length);
    }
  }

  // Parse remaining files (TS/JS, markdown, config)
  for (const task of otherTasks) {
    const indexed = await chunkDocument({
      relativePath: task.relativePath,
      absolutePath: task.absolutePath,
      content: task.content,
      targetTokens: task.targetTokens,
      overlapTokens: task.overlapTokens,
      counter: task.counter,
    });
    // Bound large symbol chunks (e.g. a 1000-line function) to the target
    // token limit. The OxcParser creates one chunk per symbol, which can
    // exceed the limit for very large functions.
    if (indexed.kind === "code") {
      indexed.chunks = boundChunks(
        indexed.chunks,
        task.targetTokens,
        task.overlapTokens,
        task.counter,
      );
    }
    results.set(task.id, indexed);
    onProgress?.(results.size, tasks.length);
  }

  return results;
}

export async function indexWorkspace(input: {
  workspaceId?: string;
  rootPath?: string;
  mode?: "incremental" | "full";
  onProgress?: (progress: { message: string; progress: number }) => Promise<void> | void;
}): Promise<IndexWorkspaceSummary> {
  // Token counting is scoped via the TokenCounter interface — no global
  // state to reset. The try/finally ensures cleanup of the indexing lease,
  // heartbeat, and FTS write mode even when indexing fails.
  let registry: ReturnType<typeof createRegistryRepository> | undefined;
  let indexingClaimed = false;
  let claimedWorkspaceId: string | undefined;
  let indexingOwnerToken: string | undefined;
  let indexingHeartbeat: ReturnType<typeof setInterval> | undefined;
  let indexingLeaseLost = false;
  try {
    const activeRegistry = createRegistryRepository();
    registry = activeRegistry;
    let workspace: RegistryWorkspace;

    if (input.workspaceId) {
      const w = await activeRegistry.getWorkspace(input.workspaceId);
      if (!w) throw new Error(`Workspace '${input.workspaceId}' not found`);
      workspace = w;
    } else if (input.rootPath) {
      workspace = await activeRegistry.ensureWorkspace({
        rootPath: path.resolve(input.rootPath),
      });
    } else {
      throw new Error("Either workspaceId or rootPath is required");
    }

    indexingOwnerToken = crypto.randomUUID();
    if (
      !(await activeRegistry.tryClaimIndexing(workspace.id, indexingOwnerToken, indexLeaseExpiry()))
    ) {
      throw new Error(`Workspace '${workspace.id}' is already being indexed`);
    }
    indexingClaimed = true;
    claimedWorkspaceId = workspace.id;
    let heartbeatBusy = false;
    indexingHeartbeat = setInterval(() => {
      if (heartbeatBusy || indexingLeaseLost || !indexingOwnerToken) return;
      heartbeatBusy = true;
      void activeRegistry
        .refreshIndexingLease(workspace.id, indexingOwnerToken, indexLeaseExpiry())
        .then((refreshed) => {
          if (!refreshed) indexingLeaseLost = true;
        })
        .catch(() => {
          indexingLeaseLost = true;
        })
        .finally(() => {
          heartbeatBusy = false;
        });
    }, INDEX_HEARTBEAT_INTERVAL_MS);

    const assertIndexingLease = async () => {
      if (indexingLeaseLost || !indexingOwnerToken) {
        throw new Error(`Indexing lease lost for workspace '${workspace.id}'`);
      }
      const refreshed = await activeRegistry.refreshIndexingLease(
        workspace.id,
        indexingOwnerToken,
        indexLeaseExpiry(),
      );
      if (!refreshed) {
        indexingLeaseLost = true;
        throw new Error(`Indexing lease lost for workspace '${workspace.id}'`);
      }
    };

    await writeLocalWorkspaceConfig(workspace);

    const repo = createWorkspaceRepository(workspace.rootPath);
    const settings = await getBrainSettings(workspace.rootPath);
    const config = await loadBrainConfig(workspace.rootPath);
    const configuredWorkspace = config.workspaces?.find(
      (candidate) =>
        candidate.id === workspace.id ||
        path.resolve(candidate.root) === path.resolve(workspace.rootPath),
    );
    const includeGlobs = workspace.includeGlobs || configuredWorkspace?.include.join("\n") || "";
    const excludeGlobs = workspace.excludeGlobs || configuredWorkspace?.exclude.join("\n") || "";
    const runMode = input.mode ?? "incremental";
    const chunkingFingerprint = hashContent(JSON.stringify(settings.chunking));
    const forceRechunk =
      runMode === "incremental" && repo.getMeta("chunking_fingerprint") !== chunkingFingerprint;
    let graphInvalidated = false;

    const invalidateGraph = async () => {
      if (graphInvalidated) return;
      await activeRegistry.invalidateWorkspaceGraph(workspace.id);
      graphInvalidated = true;
    };

    const reportProgress = async (message: string, progress: number) => {
      await input.onProgress?.({ message, progress });
    };

    if (runMode === "full") {
      await assertIndexingLease();
      repo.resetIndexArtifacts();
      await invalidateGraph();
    }

    const runId = await repo.createIndexRun({ mode: runMode });

    await reportProgress("Scanning workspace files...", 5);

    const files = await scanWorkspaceFiles({
      rootPath: workspace.rootPath,
      include: includeGlobs,
      exclude: excludeGlobs,
    });
    await assertIndexingLease();

    const existingDocuments = await repo.listDocuments();
    const existingDocumentsByPath = new Map(
      existingDocuments.map((document) => [normalizeRelativePath(document.path), document]),
    );

    if (runMode === "incremental") {
      const scannedPaths = new Set(files.map((file) => normalizeRelativePath(file.relativePath)));
      let deletedAny = false;
      for (const document of existingDocuments) {
        if (!scannedPaths.has(normalizeRelativePath(document.path))) {
          await resetDocumentArtifacts(repo, document.id);
          await repo.deleteDocument(document.id);
          deletedAny = true;
        }
      }
      if (deletedAny) {
        await invalidateGraph();
      }
    }

    const workspaceFileResolver = createWorkspaceFileResolver(
      workspace.rootPath,
      files.map((file) => ({
        relativePath: file.relativePath,
        absolutePath: file.absolutePath,
      })),
    );

    let filesUpdated = 0;
    let chunksWritten = 0;
    let bulkWriteMode = false;
    let needsWriteModeRestore = false;
    // FTS inputs collected during transaction, inserted after finalize (no DB contention)
    let ftsInputsForBackground: Array<{
      chunkId: string;
      path: string;
      heading: string | null;
      language: string | null;
      content: string;
      metadata: string;
    }> = [];
    const _T0 = Date.now();
    const symbolNodeIdsByFileAndName = new Map<string, string>();
    const pendingCallEdges: Array<{
      callerName: string;
      calleeName: string;
      filePath: string;
      parser: string;
    }> = [];

    try {
      await reportProgress(
        files.length === 0
          ? "No files matched the workspace filters"
          : `Queued ${files.length} file(s) for indexing`,
        files.length === 0 ? 100 : 10,
      );

      // ── Phase 1: Check which files changed (fast DB lookups, no file reads) ──
      const parseTasks: ParseTask[] = [];
      const filesToRead: typeof files = [];

      for (const file of files) {
        const existingDocument = existingDocumentsByPath.get(
          normalizeRelativePath(file.relativePath),
        );
        // Fast path: skip file read if mtime and size match (incremental only)
        const statUnchanged =
          runMode === "incremental" &&
          !forceRechunk &&
          existingDocument &&
          existingDocument.mtimeMs === file.mtimeMs &&
          existingDocument.sizeBytes === file.sizeBytes;

        if (!statUnchanged) {
          filesToRead.push(file);
        }
      }

      // ── Phase 2: Read only changed files in parallel (concurrency-limited) ──
      process.stderr.write(
        `[t] phase1 stat-check: ${Date.now() - _T0}ms (${filesToRead.length} to read)\n`,
      );
      const _T1 = Date.now();
      const fileContents = new Map<string, string>();
      const READ_CONCURRENCY = 32;
      let readIndex = 0;
      async function readWorker() {
        while (readIndex < filesToRead.length) {
          const i = readIndex++;
          fileContents.set(
            filesToRead[i].relativePath,
            await fs.readFile(filesToRead[i].absolutePath, "utf8"),
          );
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(READ_CONCURRENCY, filesToRead.length) }, () => readWorker()),
      );

      // ── Phase 2b: Verify content hash for changed files ──
      process.stderr.write(`[t] phase2 file-read: ${Date.now() - _T1}ms\n`);
      const _T2 = Date.now();
      for (const file of filesToRead) {
        const content = fileContents.get(file.relativePath)!;
        const contentHash = hashContent(content);
        const existingDocument = existingDocumentsByPath.get(
          normalizeRelativePath(file.relativePath),
        );
        const unchanged =
          runMode === "incremental" &&
          !forceRechunk &&
          existingDocument &&
          existingDocument.contentHash === contentHash;

        if (unchanged) {
          await repo.updateDocument(existingDocument.id, {
            absolutePath: file.absolutePath,
            sizeBytes: file.sizeBytes,
            mtimeMs: file.mtimeMs,
          });
        } else {
          parseTasks.push({
            id: file.relativePath,
            content,
            relativePath: file.relativePath,
            absolutePath: file.absolutePath,
            sizeBytes: file.sizeBytes,
            mtimeMs: file.mtimeMs,
            targetTokens: settings.chunking.targetTokens,
            overlapTokens: settings.chunking.overlapTokens,
            // Indexing uses the fast chars/4 counter — BPE encoding is 100x
            // slower and unnecessary for chunk-size budgeting. Retrieval
            // budgeting continues to use exactTokenCounter (countTokens).
            counter: fastTokenCounter,
          });
        }
      }

      // ── Phase 3: Parse changed files ──
      process.stderr.write(
        `[t] phase2b hash-check: ${Date.now() - _T2}ms (${parseTasks.length} to parse)\n`,
      );
      const _T3 = Date.now();
      const parseResults = await parseInline(parseTasks, (done, total) => {
        reportProgress(
          `Parsing ${done}/${total} files...`,
          Math.min(50, 10 + Math.round((done / Math.max(total, 1)) * 40)),
        );
      });

      // A true no-op never changes SQLite write pragmas or FTS triggers.
      process.stderr.write(`[t] phase3 parse: ${Date.now() - _T3}ms\n`);
      await assertIndexingLease();
      const _T4 = Date.now();
      if (parseTasks.length > 0) {
        await invalidateGraph();
        // ── Phase 4: Write all results to DB (main thread, transactioned) ──
        repo.setOptimizedWriteMode(true);
        repo.dropFtsTriggers();
        bulkWriteMode = true;
      }

      // ── Phase 4: Batch DB write — collect everything, insert in few big queries ──
      const _dbSub: Record<string, number> = {};
      await assertIndexingLease();
      await repo.transaction(async () => {
        const _dbT0 = Date.now();
        // Step 1: Handle existing documents (reset artifacts + update) in bulk
        const newDocs: Array<{
          path: string;
          absolutePath: string;
          kind: string;
          language?: string | null;
          contentHash: string;
          sizeBytes: number;
          mtimeMs: number;
        }> = [];
        const docIdMap = new Map<string, string>(); // relativePath -> documentId

        for (const file of parseTasks) {
          const indexed = parseResults.get(file.id)!;
          const contentHash = hashContent(file.content);
          const existingDocument = existingDocumentsByPath.get(
            normalizeRelativePath(file.relativePath),
          );

          if (existingDocument) {
            await resetChangedFileArtifacts(repo, existingDocument.id, file.relativePath);
            await repo.updateDocument(existingDocument.id, {
              absolutePath: file.absolutePath,
              kind: indexed.kind,
              language: indexed.language,
              contentHash,
              sizeBytes: file.sizeBytes,
              mtimeMs: file.mtimeMs,
            });
            docIdMap.set(normalizeRelativePath(file.relativePath), existingDocument.id);
          } else {
            newDocs.push({
              path: normalizeRelativePath(file.relativePath),
              absolutePath: file.absolutePath,
              kind: indexed.kind,
              language: indexed.language,
              contentHash,
              sizeBytes: file.sizeBytes,
              mtimeMs: file.mtimeMs,
            });
          }
        }

        // Batch insert all new documents in one query
        _dbSub["existing-update"] = Date.now() - _dbT0;
        const _dbT1 = Date.now();
        if (newDocs.length > 0) {
          const newDocIds = await repo.insertDocumentsBatch(newDocs);
          for (let i = 0; i < newDocs.length; i++) {
            docIdMap.set(newDocs[i].path, newDocIds[i]);
          }
        }

        // Step 2: Batch insert ALL chunks across all files in one call
        const allChunkInputs: Array<{
          documentId: string;
          chunkIndex: number;
          heading: string | null;
          content: string;
          tokenCount: number;
          contentHash: string;
          metadata: string;
        }> = [];
        const chunkFileMap: Array<{ fileRelativePath: string; chunkIndex: number }> = [];
        for (const file of parseTasks) {
          const indexed = parseResults.get(file.id)!;
          const documentId = docIdMap.get(normalizeRelativePath(file.relativePath))!;
          for (let ci = 0; ci < indexed.chunks.length; ci++) {
            const chunk = indexed.chunks[ci];
            allChunkInputs.push({
              documentId,
              chunkIndex: ci,
              heading: chunk.heading ?? null,
              content: chunk.content,
              tokenCount: chunk.tokenCount,
              contentHash: chunk.contentHash,
              metadata: JSON.stringify(chunk.metadata),
            });
            chunkFileMap.push({ fileRelativePath: file.relativePath, chunkIndex: ci });
          }
        }
        const allChunkIds = await repo.insertChunks(allChunkInputs);
        _dbSub["insert-chunks"] = Date.now() - _dbT1;

        // Precompute chunk offsets (prefix sum) for O(1) lookup
        const chunkOffsets: number[] = new Array(parseTasks.length);
        let totalChunks = 0;
        for (let fi = 0; fi < parseTasks.length; fi++) {
          chunkOffsets[fi] = totalChunks;
          totalChunks += parseResults.get(parseTasks[fi].id)!.chunks.length;
        }

        // Collect FTS inputs for bulk insert after transaction (triggers down — no double-write)
        const ftsInputs = ftsInputsForBackground;
        for (let fi = 0; fi < parseTasks.length; fi++) {
          const file = parseTasks[fi];
          const indexed = parseResults.get(file.id)!;
          const chunkOffset = chunkOffsets[fi];
          for (let ci = 0; ci < indexed.chunks.length; ci++) {
            const chunk = indexed.chunks[ci];
            ftsInputs.push({
              chunkId: allChunkIds[chunkOffset + ci],
              path: file.relativePath,
              heading: chunk.heading ?? null,
              language: indexed.language ?? null,
              content: chunk.content,
              metadata: JSON.stringify(chunk.metadata),
            });
          }
        }
        _dbSub["collect-fts"] = Date.now() - _dbT1;

        // Step 3: Cache parse results — graph building remains lazy/on-demand.
        for (let fi = 0; fi < parseTasks.length; fi++) {
          const file = parseTasks[fi];
          const indexed = parseResults.get(file.id)!;
          const chunkOffset = chunkOffsets[fi];

          chunksWritten += indexed.chunks.length;
          filesUpdated += 1;
        }

        // Step 4: Cache parse results (symbols/imports/calls) so graph build
        // can skip re-parsing. Keyed by document_id, invalidated on content change.
        for (let fi = 0; fi < parseTasks.length; fi++) {
          const file = parseTasks[fi];
          const indexed = parseResults.get(file.id)!;
          const documentId = docIdMap.get(normalizeRelativePath(file.relativePath))!;
          const contentHash = hashContent(file.content);
          repo.insertParsedDocument({
            documentId,
            contentHash,
            symbols: JSON.stringify(indexed.definedSymbols ?? []),
            imports: JSON.stringify(indexed.importPaths ?? []),
            calls: JSON.stringify(indexed.callExpressions ?? []),
            calledIdentifiers: JSON.stringify(indexed.calledIdentifiers ?? []),
            parserVersion: parserVersionFor(indexed.parser),
          });
        }

        // Graph (nodes + edges + call edges) is built lazily on first
        // graph_neighbors/code_context query — see buildGraphFromIndexedFiles()

        await reportProgress(`Writing ${parseTasks.length}/${parseTasks.length}...`, 95);
      });
      process.stderr.write(`[t]   db sub: ${JSON.stringify(_dbSub)}\n`);

      // ── Phase 5: FTS insert (triggers still down — no double-write) + restore ──
      process.stderr.write(`[t] phase4 db-write: ${Date.now() - _T4}ms\n`);
      const _T5 = Date.now();

      // Insert FTS entries while triggers are still down (no trigger overhead)
      if (ftsInputsForBackground.length > 0) {
        _ftsBuildingWorkspaces.set(workspace.id, true);
        const _ftsT = Date.now();
        try {
          await repo.bulkInsertFts(ftsInputsForBackground);
          process.stderr.write(
            `[t]   fts-insert: ${Date.now() - _ftsT}ms (${ftsInputsForBackground.length} entries)\n`,
          );
        } finally {
          _ftsBuildingWorkspaces.delete(workspace.id);
        }
      }

      // Now restore FTS triggers (entries already inserted, no backfill needed)
      if (bulkWriteMode) {
        repo.restoreFtsTriggersOnly();
        needsWriteModeRestore = true;
        bulkWriteMode = false;
      }
      repo.setMeta("chunking_fingerprint", chunkingFingerprint);
      process.stderr.write(`[t] phase5 fts-restore: ${Date.now() - _T5}ms\n`);
      const _T7 = Date.now();
      await reportProgress("Finalizing index run...", 98);
      await assertIndexingLease();
      await repo.completeIndexRun(runId, {
        status: "completed",
        filesScanned: files.length,
        filesUpdated,
        chunksWritten,
        embeddingsWritten: 0,
      });

      const docCount = await repo.getDocumentCount();
      const chunkCountResult = await repo.getChunkCount();
      const nodeCount = await repo.getNodeCount();
      const edgeCount = await repo.getEdgeCount();

      const completed = await activeRegistry.completeIndexing(workspace.id, indexingOwnerToken!, {
        documentCount: docCount,
        chunkCount: chunkCountResult,
        nodeCount,
        edgeCount,
        completedAt: new Date().toISOString(),
      });
      if (!completed) {
        process.stderr.write(
          `[openez] Index lease was lost before completion; another owner may have taken over.\n`,
        );
      }

      // Switch out of optimized write mode AFTER all writes are done.
      // Doing it earlier causes fsync to flush ~70MB of dirty pages mid-finalize.
      if (needsWriteModeRestore) {
        repo.setOptimizedWriteMode(false);
      }
      process.stderr.write(`[t] phase7 finalize: ${Date.now() - _T7}ms\n`);
    } catch (error) {
      if (bulkWriteMode || needsWriteModeRestore) {
        try {
          repo.restoreFtsTriggers();
        } catch {
          /* preserve original indexing error */
        }
        repo.setOptimizedWriteMode(false);
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      await repo.completeIndexRun(runId, {
        status: "failed",
        filesScanned: files.length,
        filesUpdated,
        chunksWritten,
        embeddingsWritten: 0,
        errorMessage,
      });

      if (indexingOwnerToken) {
        await activeRegistry.failIndexing(workspace.id, indexingOwnerToken, errorMessage);
      }
      throw error;
    }

    await reportProgress("Index complete", 100);
    process.stderr.write("[t] TOTAL: " + (Date.now() - _T0) + "ms\n");

    return {
      workspaceId: workspace.id,
      filesScanned: files.length,
      filesUpdated,
      chunksWritten,
      embeddingsWritten: 0,
      embeddingFailures: 0,
    };
  } finally {
    if (indexingHeartbeat) clearInterval(indexingHeartbeat);
    if (registry && indexingClaimed && claimedWorkspaceId) {
      try {
        await registry.releaseIndexing(
          claimedWorkspaceId,
          indexingOwnerToken!,
          "Indexing aborted before completion",
        );
      } catch {
        // Preserve the original indexing error if registry cleanup fails.
      }
    }
  }
}

// ── Background FTS tracking ──
// When FTS is building in background, code_query should wait for it.
const _ftsBuildingWorkspaces = new Map<string, boolean>();

export async function waitForFts(workspaceId: string): Promise<void> {
  // Poll until background FTS build finishes (typically <3s)
  let waited = 0;
  while (_ftsBuildingWorkspaces.has(workspaceId) && waited < 10000) {
    await new Promise((r) => setTimeout(r, 100));
    waited += 100;
  }
}

// ── Lazy graph builder ──
// Called on first graph_neighbors/code_context query.
// Re-parses files with parseDocument (TS/JS/Markdown/config) and native
// batch (Python/Go/Rust), inserts graph nodes + edges + call edges.
// One-time cost (~5s for 2K files). Subsequent queries use cached graph.

/**
 * Build graph artifacts for one captured index generation. Graph lifecycle
 * state is intentionally owned by graph-service.ts; this function only
 * persists nodes and edges for the root resolved by that service.
 */
export async function buildGraphGeneration(
  _workspaceId: string,
  rootPath: string,
  _generation: number,
  buildEpoch: number,
): Promise<{ nodeCount: number; edgeCount: number; published: boolean }> {
  const _graphStart = Date.now();

  const repo = createWorkspaceRepository(rootPath);
  const settings = await getBrainSettings(rootPath);
  const targetTokens = settings.chunking.targetTokens;
  const overlapTokens = settings.chunking.overlapTokens;

  // Get all documents from DB
  const documents = await repo.listDocuments();
  const graphDocs = documents.filter(
    (d) => d.kind === "code" || d.kind === "markdown" || d.kind === "config",
  );

  if (graphDocs.length === 0) {
    process.stderr.write(`[t] graph-build: 0 docs (${Date.now() - _graphStart}ms)\n`);
    const published = repo.replaceGraphArtifacts({ buildEpoch, nodes: [], edges: [] });
    return { nodeCount: 0, edgeCount: 0, published };
  }

  // Read file contents
  const fs = await import("node:fs/promises");

  // Split documents: native-parseable (python/go/rust) vs registry-parseable
  const NATIVE_LANGS = new Set(["python", "go", "rust"]);
  const nativeDocs: typeof graphDocs = [];
  const registryDocs: typeof graphDocs = [];
  for (const doc of graphDocs) {
    const lang = doc.language ?? inferDocumentKind(doc.path).language ?? "text";
    if (doc.kind === "code" && NATIVE_LANGS.has(lang)) {
      nativeDocs.push(doc);
    } else {
      registryDocs.push(doc);
    }
  }

  // ── Parse registry docs (TS/JS/Markdown/config) with parseDocument ──
  type ParsedFile = {
    filePath: string;
    language: string | null;
    kind: string;
    parser: string;
    definedSymbols: Array<{ name: string; symbolType: string; type: string; exported: boolean }>;
    importPaths: string[];
    calledIdentifiers: string[];
    callExpressions: Array<{ callerName: string; calleeName: string }>;
  };

  const parsedFiles = new Map<string, ParsedFile>();

  for (const doc of registryDocs) {
    // Try cache first — skip re-parsing if content_hash matches and the
    // parser version is current (cache invalidation on parser logic change).
    const cached = repo.getParsedDocument(doc.id);
    if (
      cached &&
      cached.contentHash === doc.contentHash &&
      (cached.parserVersion === PARSER_VERSION_OXC ||
        cached.parserVersion === PARSER_VERSION_FALLBACK)
    ) {
      parsedFiles.set(doc.path, {
        filePath: doc.path,
        language: doc.language,
        kind: doc.kind,
        parser: "cached",
        definedSymbols: cached.symbols ? JSON.parse(cached.symbols) : [],
        importPaths: cached.imports ? JSON.parse(cached.imports) : [],
        calledIdentifiers: cached.calledIdentifiers ? JSON.parse(cached.calledIdentifiers) : [],
        callExpressions: cached.calls ? JSON.parse(cached.calls) : [],
      });
      continue;
    }

    try {
      const content = await fs.readFile(doc.absolutePath, "utf8");
      const parsed = await parseDocument({
        relativePath: doc.path,
        absolutePath: doc.absolutePath,
        content,
        targetTokens,
        overlapTokens,
      });
      parsedFiles.set(doc.path, {
        filePath: doc.path,
        language: parsed.language,
        kind: parsed.kind,
        parser: parsed.parser,
        definedSymbols: parsed.definedSymbols,
        importPaths: parsed.importPaths,
        calledIdentifiers: parsed.calledIdentifiers,
        callExpressions: parsed.callExpressions,
      });
      // Cache the parse result so future graph builds skip re-parsing.
      repo.insertParsedDocument({
        documentId: doc.id,
        contentHash: doc.contentHash,
        symbols: JSON.stringify(parsed.definedSymbols ?? []),
        imports: JSON.stringify(parsed.importPaths ?? []),
        calls: JSON.stringify(parsed.callExpressions ?? []),
        calledIdentifiers: JSON.stringify(parsed.calledIdentifiers ?? []),
        parserVersion: parserVersionFor(parsed.parser),
      });
    } catch {
      /* file may have been deleted */
    }
  }

  // ── Parse native docs (Python/Go/Rust) with native batch, fallback to parseDocument ──
  if (nativeDocs.length > 0) {
    // Resolve the native parser capability once. The expected cache version
    // for native-language docs depends on this: `native-v1` when the native
    // extension is available, `fallback-v1` when it is not (the fallback
    // parser would re-parse them). A cache row is only reused when both the
    // content hash AND this expected version match.
    const nativeCapability = resolveNativeParser();
    const expectedNativeVersion = nativeCapability
      ? PARSER_VERSION_NATIVE
      : PARSER_VERSION_FALLBACK;

    // Serve cached native docs first; only batch-parse the misses.
    const nativeToParse: typeof nativeDocs = [];
    for (const doc of nativeDocs) {
      const cached = repo.getParsedDocument(doc.id);
      if (
        cached &&
        cached.contentHash === doc.contentHash &&
        cached.parserVersion === expectedNativeVersion
      ) {
        parsedFiles.set(doc.path, {
          filePath: doc.path,
          language: doc.language,
          kind: doc.kind,
          parser: "cached",
          definedSymbols: cached.symbols ? JSON.parse(cached.symbols) : [],
          importPaths: cached.imports ? JSON.parse(cached.imports) : [],
          calledIdentifiers: cached.calledIdentifiers ? JSON.parse(cached.calledIdentifiers) : [],
          callExpressions: cached.calls ? JSON.parse(cached.calls) : [],
        });
      } else {
        nativeToParse.push(doc);
      }
    }

    if (nativeCapability?.parseCodeBatch && nativeToParse.length > 0) {
      const batchItems: Array<{ language: string; content: string }> = [];
      const batchDocPaths: string[] = [];
      for (const doc of nativeToParse) {
        try {
          const content = await fs.readFile(doc.absolutePath, "utf8");
          const lang = doc.language ?? inferDocumentKind(doc.path).language ?? "text";
          batchItems.push({ language: lang, content });
          batchDocPaths.push(doc.path);
        } catch {
          /* file may have been deleted */
        }
      }

      if (batchItems.length > 0) {
        const nativeResults = nativeCapability.parseCodeBatch(batchItems);
        for (let i = 0; i < nativeResults.length; i++) {
          const nr = nativeResults[i];
          if (!nr) continue;
          const filePath = batchDocPaths[i];
          const doc = nativeToParse.find((d) => d.path === filePath)!;
          const lang = doc.language ?? inferDocumentKind(doc.path).language ?? "text";
          const definedSymbols = nr.symbols.map((s) => ({
            name: s.name,
            symbolType: s.symbolType,
            type: s.symbolType,
            exported: s.exported,
          }));
          const callExpressions = nr.callExpressions.slice(0, 20);
          parsedFiles.set(filePath, {
            filePath,
            language: lang,
            kind: "code",
            parser: "tree-sitter-native",
            definedSymbols,
            importPaths: nr.importPaths,
            calledIdentifiers: nr.calledIdentifiers,
            callExpressions,
          });
          // Cache the native parse result.
          repo.insertParsedDocument({
            documentId: doc.id,
            contentHash: doc.contentHash,
            symbols: JSON.stringify(definedSymbols),
            imports: JSON.stringify(nr.importPaths ?? []),
            calls: JSON.stringify(callExpressions),
            calledIdentifiers: JSON.stringify(nr.calledIdentifiers ?? []),
            parserVersion: PARSER_VERSION_NATIVE,
          });
        }
      }
    }

    // Fallback: parse native docs that weren't handled by native batch
    for (const doc of nativeToParse) {
      if (parsedFiles.has(doc.path)) continue;
      try {
        const content = await fs.readFile(doc.absolutePath, "utf8");
        const parsed = await parseDocument({
          relativePath: doc.path,
          absolutePath: doc.absolutePath,
          content,
          targetTokens,
          overlapTokens,
        });
        parsedFiles.set(doc.path, {
          filePath: doc.path,
          language: parsed.language,
          kind: parsed.kind,
          parser: parsed.parser,
          definedSymbols: parsed.definedSymbols,
          importPaths: parsed.importPaths,
          calledIdentifiers: parsed.calledIdentifiers,
          callExpressions: parsed.callExpressions,
        });
        // Cache the fallback parse result.
        repo.insertParsedDocument({
          documentId: doc.id,
          contentHash: doc.contentHash,
          symbols: JSON.stringify(parsed.definedSymbols ?? []),
          imports: JSON.stringify(parsed.importPaths ?? []),
          calls: JSON.stringify(parsed.callExpressions ?? []),
          calledIdentifiers: JSON.stringify(parsed.calledIdentifiers ?? []),
          parserVersion: parserVersionFor(parsed.parser),
        });
      } catch {
        /* file may have been deleted */
      }
    }
  }

  if (parsedFiles.size === 0) {
    process.stderr.write(`[t] graph-build: 0 parsed (${Date.now() - _graphStart}ms)\n`);
    const published = repo.replaceGraphArtifacts({ buildEpoch, nodes: [], edges: [] });
    return { nodeCount: 0, edgeCount: 0, published };
  }

  // ── Build known files set for import resolution ──
  const knownFiles = graphDocs.map((d) => ({
    relativePath: d.path,
    absolutePath: d.absolutePath,
  }));
  const resolver = createWorkspaceFileResolver(rootPath, knownFiles);

  // ── Build nodes ──
  const allNodeInputs: Array<{ type: string; label: string; refId?: string; metadata?: string }> =
    [];
  const allEdges: Array<{ fromNodeId: string; toNodeId: string; type: string; metadata?: string }> =
    [];
  const symbolNodeIdsByFileAndName = new Map<string, string>();
  const pendingCallEdges: Array<{ callerName: string; calleeName: string; filePath: string }> = [];

  // Map: filePath -> { fileNodeIdx, symNodeStart, symCount }
  const _symMeta: Array<{
    filePath: string;
    fileNodeIdx: number;
    symNodeStart: number;
    symCount: number;
  }> = [];

  // Map: filePath -> doc.id (for chunk lookups)
  const docIdByPath = new Map<string, string>();
  for (const doc of graphDocs) {
    docIdByPath.set(doc.path, doc.id);
  }

  for (const [filePath, parsed] of parsedFiles) {
    const doc = graphDocs.find((d) => d.path === filePath);
    if (!doc) continue;
    const language = parsed.language ?? doc.language ?? "text";

    // Load chunks for this document to map symbolName -> chunkId
    const chunks = await repo.getChunksByDocument(doc.id);
    const chunkIdBySymbolName = new Map<string, string>();
    for (const chunk of chunks) {
      try {
        const meta = JSON.parse(chunk.metadata);
        if (meta.symbolName) {
          chunkIdBySymbolName.set(meta.symbolName, chunk.id);
        }
      } catch {
        /* ignore malformed metadata */
      }
    }

    // File node
    const fileNodeIdx = allNodeInputs.length;
    allNodeInputs.push({
      type: "file",
      label: filePath,
      refId: doc.id,
      metadata: JSON.stringify({ path: filePath, language }),
    });

    // Symbol nodes (cap 30)
    const symbols = parsed.definedSymbols.slice(0, 30);
    const symNodeStart = allNodeInputs.length;
    for (const sym of symbols) {
      const refId = chunkIdBySymbolName.get(sym.name) ?? null;
      allNodeInputs.push({
        type: "symbol",
        label: sym.name,
        refId: refId ?? undefined,
        metadata: JSON.stringify({
          symbolType: sym.symbolType,
          filePath,
          language,
          parser: parsed.parser,
        }),
      });
    }

    // Call expressions (cap 20)
    for (const call of parsed.callExpressions.slice(0, 20)) {
      pendingCallEdges.push({ callerName: call.callerName, calleeName: call.calleeName, filePath });
    }

    _symMeta.push({ filePath, fileNodeIdx, symNodeStart, symCount: symbols.length });
  }

  // Generate IDs in memory so nodes and edges can be atomically swapped into
  // the live graph only after the complete snapshot has been assembled.
  const nodeIds = allNodeInputs.map(() => crypto.randomUUID());

  // ── Build edges ──
  // Maps for node lookup
  const fileNodeIdsByPath = new Map<string, string>();
  for (const meta of _symMeta) {
    const fileNodeId = nodeIds[meta.fileNodeIdx];
    if (fileNodeId) fileNodeIdsByPath.set(meta.filePath, fileNodeId);

    for (let si = 0; si < meta.symCount; si++) {
      const symNodeId = nodeIds[meta.symNodeStart + si];
      symbolNodeIdsByFileAndName.set(
        `${meta.filePath}\0${allNodeInputs[meta.symNodeStart + si].label}`,
        symNodeId,
      );
      if (fileNodeId && symNodeId && fileNodeId !== symNodeId) {
        allEdges.push({ fromNodeId: fileNodeId, toNodeId: symNodeId, type: "defines" });
      }
    }
  }

  // Import edges
  for (const [filePath, parsed] of parsedFiles) {
    const importerNode = fileNodeIdsByPath.get(filePath);
    if (!importerNode) continue;
    const language = parsed.language ?? "text";
    const seenTargets = new Set<string>();
    for (const importPath of parsed.importPaths) {
      const targetPath = resolver.resolveImport(filePath, importPath, language);
      if (!targetPath) continue;
      if (seenTargets.has(targetPath)) continue; // deduplicate
      seenTargets.add(targetPath);
      const targetNode = fileNodeIdsByPath.get(targetPath);
      if (!targetNode || targetNode === importerNode) continue;
      allEdges.push({ fromNodeId: importerNode, toNodeId: targetNode, type: "imports" });
    }
  }

  // Call edges
  const globalSymbolNodes = new Map<string, string>();
  for (const [key, nodeId] of symbolNodeIdsByFileAndName) {
    const label = key.slice(key.indexOf("\0") + 1);
    if (!globalSymbolNodes.has(label)) globalSymbolNodes.set(label, nodeId);
  }
  const _callMeta = `{"heuristic":true,"confidence":"low"}`;
  for (const call of pendingCallEdges) {
    const callerNodeId = symbolNodeIdsByFileAndName.get(`${call.filePath}\0${call.callerName}`);
    if (!callerNodeId) continue;
    // Resolve call targets with lexical scope awareness:
    // 1. Try qualified name (callerName.calleeName) — handles nested functions
    //    that shadow top-level symbols (e.g. `two.helper` called from `two`)
    // 2. Try same-file unqualified name
    // 3. Try global symbol map (cross-file resolution)
    const lexicalNames: string[] = [];
    if (!call.calleeName.includes(".")) {
      let scope = call.callerName;
      for (;;) {
        lexicalNames.push(`${scope}.${call.calleeName}`);
        const separator = scope.lastIndexOf(".");
        if (separator < 0) break;
        scope = scope.slice(0, separator);
      }
    }
    lexicalNames.push(call.calleeName);
    const calleeNodeId =
      lexicalNames
        .map((name) => symbolNodeIdsByFileAndName.get(`${call.filePath}\0${name}`))
        .find((id): id is string => Boolean(id)) ?? globalSymbolNodes.get(call.calleeName);
    if (!calleeNodeId || callerNodeId === calleeNodeId) continue;
    allEdges.push({
      fromNodeId: callerNodeId,
      toNodeId: calleeNodeId,
      type: "calls",
      metadata: _callMeta,
    });
  }

  const uniqueEdges = [
    ...new Map(
      allEdges.map((edge) => [`${edge.fromNodeId}\0${edge.toNodeId}\0${edge.type}`, edge]),
    ).values(),
  ];
  const published = repo.replaceGraphArtifacts({
    buildEpoch,
    nodes: allNodeInputs.map((node, index) => ({ ...node, id: nodeIds[index] })),
    edges: uniqueEdges.map((edge) => ({ ...edge, id: crypto.randomUUID() })),
  });

  process.stderr.write(
    `[t] graph-build: ${Date.now() - _graphStart}ms (${parsedFiles.size} files, ${allNodeInputs.length} nodes, ${uniqueEdges.length} edges)\n`,
  );

  return { nodeCount: allNodeInputs.length, edgeCount: uniqueEdges.length, published };
}
