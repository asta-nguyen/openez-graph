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
import { isNativeDisabled, loadNativeBinding, resetNativeBindingCache } from "./native-binding";
import {
  createSymbolChunks,
  inferDocumentKind,
  makeFallbackChunks,
  type ExtractedSymbol,
} from "./languages";
import { parseDocument } from "./parsers";
import type { ExportBinding, ImportBinding } from "./parsers/types";
import { createTypeScriptModuleResolver } from "./typescript-resolver";
import { createGoResolver, isGoVendorPath, type GoResolver } from "./go-resolver";
import { markRustCallShadowing } from "./languages";
import { createRustResolver, type RustResolver } from "./rust-resolver";
import { createCppResolver, type CppResolver } from "./cpp-resolver";
import { createCSharpResolver, type CSharpResolver } from "./csharp-resolver";
import {
  createPythonModuleResolver,
  createPythonResolver,
  extractPythonBindings,
  markPythonCallShadowing,
  type PythonModuleResolver,
  type PythonResolver,
} from "./python-resolver";
import { createRubyImportResolver, createRubyResolver, type RubyResolver } from "./ruby-resolver";
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
const PARSER_VERSION_OXC = "oxc-v5";
const PARSER_VERSION_NATIVE = "native-v6";
const PARSER_VERSION_FALLBACK = "fallback-v6";

/** C++ headers reject the full native parse on any syntax error. */
function nativeBatchLanguage(language: string, relativePath: string): string {
  return language === "cpp" && relativePath.endsWith(".h") ? "cpp-header" : language;
}

/** OXC-family languages that share binding extraction, module-aware call
 *  resolution, and lifted graph caps. JS/JSX callers keep the JS-only target
 *  policy; TS/TSX callers may reach any OXC-family module. */
const OXC_GRAPH_LANGUAGES = new Set(["javascript", "jsx", "typescript", "tsx"]);
const JS_GRAPH_LANGUAGES = new Set(["javascript", "jsx"]);
const TS_GRAPH_LANGUAGES = new Set(["typescript", "tsx"]);
const INDEX_LEASE_DURATION_MS = 60_000;
const INDEX_HEARTBEAT_INTERVAL_MS = 15_000;

function indexLeaseExpiry(): string {
  return new Date(Date.now() + INDEX_LEASE_DURATION_MS).toISOString();
}

/**
 * Native tree-sitter parser surface used by the indexer. The native extension
 * is optional (platform-specific .node binary); when unavailable the indexer
 * falls back to the WASM/regex parsers and tags cache rows `fallback-v6`.
 */
export interface NativeParser {
  readonly id: "native-v6";
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
 * then fall back to the registry parsers and tag cached rows `fallback-v6`.
 * The resolved capability also drives parsed_documents cache validation: a
 * cache row is only reused when its `parser_version` matches the parser that
 * the current capability would use (`native-v6` vs `fallback-v6`).
 */
export function resolveNativeParser(): NativeParser | null {
  if (isNativeDisabled()) return null;
  if (_nativeParser !== undefined) return _nativeParser;
  _nativeParser = loadNativeBinding() as NativeParser | null;
  return _nativeParser;
}

/**
 * Reset the cached native parser resolution. Exposed for tests that need to
 * simulate the native extension being unavailable.
 */
export function resetNativeParserCache(): void {
  _nativeParser = undefined;
  resetNativeBindingCache();
}

/**
 * Map a parser name (returned by `parseDocument`/`parseInline`) to the
 * version tag stored in `parsed_documents.parser_version`. Native
 * tree-sitter results use `native-v6`, the fallback parser uses
 * `fallback-v6`, and every other parser (oxc, markdown, config, regex)
 * is grouped under `oxc-v5` since they share the same chunking/call-
 * extraction contract. Non-native tree-sitter/regex fallbacks for
 * Python/Go/Rust/Ruby/C# use `fallback-v6` so cache validation matches the
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

  // Python module resolution shares the resolver used by graph call edges:
  // absolute and dot-relative paths resolve through the importer's source
  // roots (workspace root + non-package ancestors), nearest root wins,
  // `a.py` + `a/__init__.py` collisions are ambiguous, and unresolvable or
  // external specifiers return null. See python-resolver.ts.
  let pythonModuleResolver: PythonModuleResolver | null = null;
  let rubyImportResolver: ReturnType<typeof createRubyImportResolver> | null = null;

  return {
    workspaceRelativeFor: toWorkspaceRelative,
    resolveImport(
      importerRelativePath: string,
      importPath: string,
      language?: string,
    ): string | null {
      if (language === "python") {
        pythonModuleResolver ??= createPythonModuleResolver(
          [...knownRelativePaths].filter((p) => p.endsWith(".py")),
        );
        return pythonModuleResolver.resolveModule(
          normalizeRelativePath(importerRelativePath),
          importPath,
        );
      }

      if (language === "ruby") {
        // require_relative resolves literal paths to .rb files only — a
        // same-stem .md or other extension never captures the edge.
        rubyImportResolver ??= createRubyImportResolver({
          workspaceRoot,
          workspaceRelativeFor: toWorkspaceRelative,
        });
        return rubyImportResolver.resolveImport(importerRelativePath, importPath);
      }

      if (language === "cpp") return null; // C++ includes resolve in the TU-aware resolver.

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
    importBindings: parsed.importBindings,
    exportBindings: parsed.exportBindings,
  };
}

/**
 * Serialize the cached `imports` payload for `parsed_documents`. Rows with
 * JavaScript module-binding metadata store an object
 * `{v:1, paths, importBindings, exportBindings}`; everything else keeps the
 * legacy plain string-array shape so non-oxc rows stay unchanged.
 */
function serializeCachedImports(
  paths: string[],
  importBindings?: ImportBinding[],
  exportBindings?: ExportBinding[],
): string {
  if (!importBindings?.length && !exportBindings?.length) {
    return JSON.stringify(paths ?? []);
  }
  return JSON.stringify({
    v: 1,
    paths: paths ?? [],
    importBindings: importBindings ?? [],
    exportBindings: exportBindings ?? [],
  });
}

/** Inverse of serializeCachedImports — accepts both the legacy string-array
 *  shape and the extended object payload. */
function parseCachedImports(raw: string | null): {
  paths: string[];
  importBindings: ImportBinding[];
  exportBindings: ExportBinding[];
} {
  if (!raw) return { paths: [], importBindings: [], exportBindings: [] };
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return { paths: parsed, importBindings: [], exportBindings: [] };
    }
    return {
      paths: Array.isArray(parsed.paths) ? parsed.paths : [],
      importBindings: Array.isArray(parsed.importBindings) ? parsed.importBindings : [],
      exportBindings: Array.isArray(parsed.exportBindings) ? parsed.exportBindings : [],
    };
  } catch {
    return { paths: [], importBindings: [], exportBindings: [] };
  }
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

  // ── Batch native tree-sitter parse for Python/Go/Rust/Ruby/C# files ──
  const TS_LANGS = new Set(["python", "go", "rust", "ruby", "csharp", "cpp"]);
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
      language: nativeBatchLanguage(inferDocumentKind(t.relativePath).language!, t.relativePath),
      content: t.content,
    }));
    // Use parseCodeBatch — rayon-parallel tree-sitter parse for Python/Go/Rust/Ruby
    const nativeResults = native!.parseCodeBatch(batchItems);
    process.stderr.write(
      `[t]   native-batch: ${Date.now() - _batchStart}ms (${batchTasks.length} files)\n`,
    );
    for (let i = 0; i < batchTasks.length; i++) {
      const task = batchTasks[i];
      const nr = nativeResults[i];
      if (nr) {
        const lang = inferDocumentKind(task.relativePath).language ?? "text";
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
        // Python keeps qualified call names + all calls (graph caps are
        // lifted for Python only) and gets bindings + shadow marks here —
        // the native result shape is unchanged. Ruby, Rust, and C# are also
        // uncapped; Rust calls carry the same shadow marker.
        const isPython = lang === "python";
        const isRuby = lang === "ruby";
        const isRust = lang === "rust";
        const isCpp = lang === "cpp";
        const callExpressions =
          lang === "go" || isPython || isRuby || isRust || lang === "csharp" || isCpp
            ? nr.callExpressions
            : nr.callExpressions.slice(0, 20);
        if (isPython) markPythonCallShadowing(task.content, symbols, callExpressions);
        if (isRust) markRustCallShadowing(task.content, symbols, callExpressions);
        results.set(task.id, {
          kind: "code",
          language: lang,
          parser: "tree-sitter-native",
          chunks,
          importPaths: nr.importPaths,
          wikilinks: [],
          definedSymbols: symbols,
          calledIdentifiers: nr.calledIdentifiers,
          callExpressions,
          importBindings: isPython ? extractPythonBindings(task.content, symbols) : undefined,
          exportBindings: undefined,
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

  // Parse remaining files (TS/JS, markdown, config) sequentially
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
            imports: serializeCachedImports(
              indexed.importPaths ?? [],
              indexed.importBindings,
              indexed.exportBindings,
            ),
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

  // Split documents: native-parseable (python/go/rust/ruby/csharp) vs registry-parseable
  const NATIVE_LANGS = new Set(["python", "go", "rust", "ruby", "csharp", "cpp"]);
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
    definedSymbols: Array<{
      name: string;
      symbolType: string;
      type: string;
      exported: boolean;
      startLine?: number;
      endLine?: number;
    }>;
    importPaths: string[];
    calledIdentifiers: string[];
    callExpressions: Array<{
      callerName: string;
      calleeName: string;
      start?: number;
      shadowedLocal?: boolean;
    }>;
    importBindings?: ImportBinding[];
    exportBindings?: ExportBinding[];
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
      const cachedImports = parseCachedImports(cached.imports);
      parsedFiles.set(doc.path, {
        filePath: doc.path,
        language: doc.language,
        kind: doc.kind,
        parser: "cached",
        definedSymbols: cached.symbols ? JSON.parse(cached.symbols) : [],
        importPaths: cachedImports.paths,
        calledIdentifiers: cached.calledIdentifiers ? JSON.parse(cached.calledIdentifiers) : [],
        callExpressions: cached.calls ? JSON.parse(cached.calls) : [],
        importBindings: cachedImports.importBindings,
        exportBindings: cachedImports.exportBindings,
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
        importBindings: parsed.importBindings,
        exportBindings: parsed.exportBindings,
      });
      // Cache the parse result so future graph builds skip re-parsing.
      repo.insertParsedDocument({
        documentId: doc.id,
        contentHash: doc.contentHash,
        symbols: JSON.stringify(parsed.definedSymbols ?? []),
        imports: serializeCachedImports(
          parsed.importPaths ?? [],
          parsed.importBindings,
          parsed.exportBindings,
        ),
        calls: JSON.stringify(parsed.callExpressions ?? []),
        calledIdentifiers: JSON.stringify(parsed.calledIdentifiers ?? []),
        parserVersion: parserVersionFor(parsed.parser),
      });
    } catch {
      /* file may have been deleted */
    }
  }

  // ── Parse native docs (Python/Go/Rust/Ruby) with native batch, fallback to parseDocument ──
  if (nativeDocs.length > 0) {
    // Resolve the native parser capability once. The expected cache version
    // for native-language docs depends on this: `native-v6` when the native
    // extension is available, `fallback-v6` when it is not (the fallback
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
        const cachedImports = parseCachedImports(cached.imports);
        parsedFiles.set(doc.path, {
          filePath: doc.path,
          language: doc.language,
          kind: doc.kind,
          parser: "cached",
          definedSymbols: cached.symbols ? JSON.parse(cached.symbols) : [],
          importPaths: cachedImports.paths,
          calledIdentifiers: cached.calledIdentifiers ? JSON.parse(cached.calledIdentifiers) : [],
          callExpressions: cached.calls ? JSON.parse(cached.calls) : [],
          importBindings: cachedImports.importBindings,
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
          batchItems.push({ language: nativeBatchLanguage(lang, doc.path), content });
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
            startLine: s.startLine,
            endLine: s.endLine,
          }));
          // Python keeps qualified call names + every call; bindings and
          // shadow marks are derived in TypeScript so the native result
          // shape stays unchanged. Calls ride through the shared imports
          // envelope so cached native rows keep their bindings. Ruby, Rust,
          // and C# are also uncapped; Rust calls carry the same shadow marker.
          const isPython = lang === "python";
          const isRuby = lang === "ruby";
          const isRust = lang === "rust";
          const isCpp = lang === "cpp";
          const callExpressions =
            lang === "go" || isPython || isRuby || isRust || lang === "csharp" || isCpp
              ? nr.callExpressions
              : nr.callExpressions.slice(0, 20);
          if (isPython)
            markPythonCallShadowing(batchItems[i].content, definedSymbols, callExpressions);
          if (isRust) markRustCallShadowing(batchItems[i].content, definedSymbols, callExpressions);
          const importBindings = isPython
            ? extractPythonBindings(batchItems[i].content, definedSymbols)
            : undefined;
          parsedFiles.set(filePath, {
            filePath,
            language: lang,
            kind: "code",
            parser: "tree-sitter-native",
            definedSymbols,
            importPaths: nr.importPaths,
            calledIdentifiers: nr.calledIdentifiers,
            callExpressions,
            importBindings,
          });
          // Cache the native parse result.
          repo.insertParsedDocument({
            documentId: doc.id,
            contentHash: doc.contentHash,
            symbols: JSON.stringify(definedSymbols),
            imports: serializeCachedImports(nr.importPaths ?? [], importBindings, undefined),
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
          imports: serializeCachedImports(
            parsed.importPaths ?? [],
            parsed.importBindings,
            parsed.exportBindings,
          ),
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
  const tsResolver = createTypeScriptModuleResolver({
    workspaceRoot: rootPath,
    workspaceRelativeFor: resolver.workspaceRelativeFor,
  });

  // Go module/package resolution is reconstructed from go.mod and source at
  // graph-build time; see docs/agent-devkit/changes/archive/2026-10-20-39-go-indexing-accuracy.
  const goFiles = [...parsedFiles.keys()].filter((p) => parsedFiles.get(p)?.language === "go");
  const goResolver: GoResolver | null =
    goFiles.length > 0 ? createGoResolver({ workspaceRoot: rootPath, goFiles }) : null;

  // Python call resolution runs entirely on parsed data — symbols and
  // import bindings per file plus the workspace .py file set; see
  // docs/agent-devkit/changes/2026-10-20-39-python-index-accuracy.
  const pythonFiles = [...parsedFiles.keys()].filter(
    (p) => parsedFiles.get(p)?.language === "python",
  );
  const pythonResolver: PythonResolver | null =
    pythonFiles.length > 0
      ? createPythonResolver({
          pythonFiles,
          symbolsFor: (file) => parsedFiles.get(file)?.definedSymbols,
          bindingsFor: (file) => parsedFiles.get(file)?.importBindings,
        })
      : null;

  // Ruby call resolution is scope-aware: bare calls bind to a unique method
  // of the caller's own class/module (across reopened-class files) then to a
  // unique top-level method; ::-qualified callees walk the caller's lexical
  // scopes. See docs/agent-devkit/changes/archive/2026-10-20-39-ruby-native-indexing.
  const rubyFiles = [...parsedFiles.keys()].filter((p) => parsedFiles.get(p)?.language === "ruby");
  const rubyResolver: RubyResolver | null =
    rubyFiles.length > 0
      ? createRubyResolver({
          symbols: rubyFiles.flatMap((file) =>
            (parsedFiles.get(file)?.definedSymbols ?? []).map((s) => ({
              filePath: file,
              name: s.name,
              symbolType: s.symbolType,
            })),
          ),
        })
      : null;

  // Rust call resolution is crate/module-aware: `crate`/`self`/`super`
  // paths, `use` bindings, package-library names, and supported method forms
  // resolve to unique in-crate symbols only — see rust-resolver.ts.
  const rustFiles = [...parsedFiles.keys()].filter((p) => parsedFiles.get(p)?.language === "rust");
  const rustResolver: RustResolver | null =
    rustFiles.length > 0
      ? createRustResolver(
          rustFiles.map((file) => {
            const parsed = parsedFiles.get(file);
            return {
              filePath: file,
              symbols: (parsed?.definedSymbols ?? []).map((s) => ({
                ...s,
                type: s.symbolType,
              })),
              importPaths: parsed?.importPaths ?? [],
            };
          }),
          [...parsedFiles.keys()],
          rootPath,
        )
      : null;

  // C++ translation-unit resolution: quoted includes build a per-file
  // visibility closure; calls resolve to unique targets visible from the
  // translation unit — see cpp-resolver.ts.
  const cppFiles = [...parsedFiles.keys()].filter((p) => parsedFiles.get(p)?.language === "cpp");
  const cppResolver: CppResolver | null =
    cppFiles.length > 0
      ? createCppResolver({
          cppFiles,
          symbolsFor: (file) => parsedFiles.get(file)?.definedSymbols ?? [],
          importPathsFor: (file) => parsedFiles.get(file)?.importPaths ?? [],
          workspaceRelativeFor: resolver.workspaceRelativeFor,
          workspaceRoot: rootPath,
        })
      : null;

  // C# call resolution is namespace/using-aware with project-root scoping —
  // see csharp-resolver.ts. Same-type partial calls, explicitly qualified
  // calls, and uniquely bound using-static calls resolve; everything else
  // (variable receivers, inherited members, overloads, ambiguous or
  // cross-root-duplicate identities, external names) produces no edge.
  const csharpFiles = [...parsedFiles.keys()].filter(
    (p) => parsedFiles.get(p)?.language === "csharp",
  );
  const csharpResolver: CSharpResolver | null =
    csharpFiles.length > 0
      ? createCSharpResolver(
          csharpFiles.map((file) => {
            const parsed = parsedFiles.get(file);
            return {
              filePath: file,
              symbols: (parsed?.definedSymbols ?? []).map((s) => ({
                ...s,
                type: s.symbolType,
              })),
              importPaths: parsed?.importPaths ?? [],
            };
          }),
          rootPath,
        )
      : null;

  // ── Build nodes ──
  const allNodeInputs: Array<{ type: string; label: string; refId?: string; metadata?: string }> =
    [];
  const allEdges: Array<{ fromNodeId: string; toNodeId: string; type: string; metadata?: string }> =
    [];
  const symbolNodeIdsByFileAndName = new Map<string, string>();
  // C# occurrence routing: `${file}\0${emissionIndex}` -> node id, so same
  // (file,label) symbols (same-named members in one file) map to their own
  // graph node instead of collapsing to the label's last writer.
  const symbolNodeIdsByFileAndIndex = new Map<string, string>();
  const pendingCallEdges: Array<{
    callerName: string;
    calleeName: string;
    filePath: string;
    start?: number;
    shadowedLocal?: boolean;
  }> = [];

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
    if (language === "go" && isGoVendorPath(filePath)) continue;

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

    // Symbol nodes (cap 30 for non-OXC languages; Go, Python, Ruby, Rust,
    // and C# are uncapped).
    const isOxcFile = OXC_GRAPH_LANGUAGES.has(language);
    const uncapped =
      isOxcFile ||
      language === "go" ||
      language === "python" ||
      language === "ruby" ||
      language === "rust" ||
      language === "csharp" ||
      language === "cpp";
    const symbols = uncapped ? parsed.definedSymbols : parsed.definedSymbols.slice(0, 30);
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

    // Call expressions (cap 20 for non-OXC languages; Go, Python, Ruby,
    // Rust, and C# uncapped)
    const callExpressions = uncapped ? parsed.callExpressions : parsed.callExpressions.slice(0, 20);
    for (const call of callExpressions) {
      pendingCallEdges.push({
        callerName: call.callerName,
        calleeName: call.calleeName,
        filePath,
        start: call.start,
        shadowedLocal: call.shadowedLocal,
      });
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
      symbolNodeIdsByFileAndIndex.set(`${meta.filePath}\0${si}`, symNodeId);
      if (fileNodeId && symNodeId && fileNodeId !== symNodeId) {
        allEdges.push({ fromNodeId: fileNodeId, toNodeId: symNodeId, type: "defines" });
      }
    }
  }

  // Import edges
  for (const [filePath, parsed] of parsedFiles) {
    const importerNode = fileNodeIdsByPath.get(filePath);
    if (!importerNode) continue;
    const seenTargets = new Set<string>();
    for (const importPath of parsed.importPaths) {
      const targetPath = resolveModuleSpecifier(filePath, importPath);
      if (!targetPath) continue;
      if (seenTargets.has(targetPath)) continue; // deduplicate
      seenTargets.add(targetPath);
      const targetNode = fileNodeIdsByPath.get(targetPath);
      if (!targetNode || targetNode === importerNode) continue;
      allEdges.push({ fromNodeId: importerNode, toNodeId: targetNode, type: "imports" });
    }
  }

  // Go symbol type lookup: `${file}\0${name}` -> symbolType, for the Go
  // resolver's package-level-function check.
  const goSymbolTypes = new Map<string, string>();
  for (const meta of _symMeta) {
    const filePath = meta.filePath;
    for (let si = 0; si < meta.symCount; si++) {
      const input = allNodeInputs[meta.symNodeStart + si];
      if (!input.metadata?.includes('"language":"go"')) continue;
      goSymbolTypes.set(`${filePath}\0${input.label}`, JSON.parse(input.metadata).symbolType);
    }
  }

  // Call edges
  const globalSymbolNodes = new Map<string, string>();
  for (const [key, nodeId] of symbolNodeIdsByFileAndName) {
    const label = key.slice(key.indexOf("\0") + 1);
    if (!globalSymbolNodes.has(label)) globalSymbolNodes.set(label, nodeId);
  }

  // ── OXC module-binding resolution maps ──
  // Cross-file OXC-language calls resolve through static ESM imports and
  // CommonJS require bindings to unique module exports; a same-name global
  // symbol is never substituted for a missing or ambiguous import target.
  // TypeScript callers may reach any OXC-family target; JavaScript callers
  // keep the JS-only target policy (the JS→TS guard below).
  const bindingsByFile = new Map<string, Map<string, ImportBinding[]>>();
  const exportsByFile = new Map<string, ExportBinding[]>();
  for (const [filePath, parsed] of parsedFiles) {
    if (!OXC_GRAPH_LANGUAGES.has(parsed.language ?? "")) continue;
    if (parsed.importBindings?.length) {
      const byLocal = new Map<string, ImportBinding[]>();
      for (const binding of parsed.importBindings) {
        const list = byLocal.get(binding.local) ?? [];
        list.push(binding);
        byLocal.set(binding.local, list);
      }
      bindingsByFile.set(filePath, byLocal);
    }
    if (parsed.exportBindings?.length) exportsByFile.set(filePath, parsed.exportBindings);
  }

  /** Pick the import binding that applies at a call site: the innermost
   *  function-local `require` scope containing the call's byte offset wins,
   *  else the module-scope binding. */
  function findImportBinding(
    filePath: string,
    local: string,
    callStart: number | undefined,
  ): ImportBinding | undefined {
    const list = bindingsByFile.get(filePath)?.get(local);
    if (!list) return undefined;
    let moduleScope: ImportBinding | undefined;
    let best: ImportBinding | undefined;
    let bestSize = Infinity;
    for (const binding of list) {
      if (binding.scopeStart === undefined || binding.scopeEnd === undefined) {
        moduleScope ??= binding;
        continue;
      }
      if (
        callStart !== undefined &&
        binding.scopeStart <= callStart &&
        callStart <= binding.scopeEnd
      ) {
        const size = binding.scopeEnd - binding.scopeStart;
        if (size < bestSize) {
          best = binding;
          bestSize = size;
        }
      }
    }
    return best ?? moduleScope;
  }

  /** Resolve a module specifier with the resolver matching the language of
   *  the file that contains it: tsconfig-aware for TS/TSX, the workspace
   *  resolver for everything else. */
  function resolveModuleSpecifier(fromFile: string, specifier: string): string | null {
    const language = parsedFiles.get(fromFile)?.language ?? "";
    // C# importPaths carry full using-directive text — only a binding that
    // resolves to exactly one in-workspace file produces an imports edge.
    // The generic resolver returns null for non-relative specifiers anyway;
    // routing here keeps that guarantee explicit.
    if (language === "csharp") return csharpResolver?.resolveImport(fromFile, specifier) ?? null;
    if (language === "cpp") return cppResolver?.resolveImport(fromFile, specifier) ?? null;
    if (TS_GRAPH_LANGUAGES.has(language)) return tsResolver.resolve(fromFile, specifier);
    return resolver.resolveImport(fromFile, specifier, language);
  }

  /**
   * Collect (filePath, symbolName) candidates an export name resolves to in a
   * module file. `local` and `reexport` entries that match the name take
   * precedence over wildcard `star` re-exports (ESM semantics); more than one
   * explicit match or more than one distinct star target means the export is
   * ambiguous and contributes nothing. `visited` guards re-export cycles.
   */
  function collectModuleExports(
    moduleFile: string,
    exportName: string,
    visited: Set<string>,
  ): Array<{ filePath: string; symbolName: string }> {
    const visitKey = `${moduleFile}\0${exportName}`;
    if (visited.has(visitKey)) return [];
    visited.add(visitKey);
    const entries = exportsByFile.get(moduleFile);
    if (!entries) return [];
    const matched: ExportBinding[] = [];
    const seenMatch = new Set<string>();
    const stars: ExportBinding[] = [];
    for (const entry of entries) {
      // Type-only exports never resolve a `calls` target.
      if (entry.typeOnly) continue;
      if (entry.kind === "star") {
        stars.push(entry);
      } else if (entry.name === exportName) {
        // `exports.f = f; module.exports.f = f` yields identical entries —
        // dedupe by target so only genuinely different definitions conflict.
        const key = `${entry.kind}\0${entry.local ?? ""}\0${entry.module ?? ""}\0${entry.imported ?? ""}`;
        if (seenMatch.has(key)) continue;
        seenMatch.add(key);
        matched.push(entry);
      }
    }
    if (matched.length > 1) return []; // ambiguous duplicate export
    if (matched.length === 1) {
      const entry = matched[0];
      if (entry.kind === "local" && entry.local) {
        if (symbolNodeIdsByFileAndName.has(`${moduleFile}\0${entry.local}`)) {
          return [{ filePath: moduleFile, symbolName: entry.local }];
        }
        // `export { x }` where `x` is itself an import binding forwards to
        // the bound module's export (`import {x} from "./m"; export {x}`).
        const forwarded = bindingsByFile
          .get(moduleFile)
          ?.get(entry.local)
          ?.find((b) => b.scopeStart === undefined);
        if (forwarded && !forwarded.typeOnly && forwarded.imported !== "*") {
          const target = resolveModuleSpecifier(moduleFile, forwarded.module);
          return target ? collectModuleExports(target, forwarded.imported, visited) : [];
        }
        return [];
      }
      if (entry.kind === "reexport" && entry.module && entry.imported) {
        const target = resolveModuleSpecifier(moduleFile, entry.module);
        return target ? collectModuleExports(target, entry.imported, visited) : [];
      }
      return [];
    }
    // `export *` forwards named exports only — never `default`.
    if (exportName === "default") return [];
    const candidates: Array<{ filePath: string; symbolName: string }> = [];
    for (const star of stars) {
      const target = star.module ? resolveModuleSpecifier(moduleFile, star.module) : null;
      if (target) candidates.push(...collectModuleExports(target, exportName, visited));
    }
    return candidates;
  }

  /** Resolve an export name in a module file to exactly one symbol target;
   *  returns null when unresolved or ambiguous. Results are memoized —
   *  barrel-heavy workspaces re-run the same re-export walk per call. */
  const exportResolutionCache = new Map<string, { filePath: string; symbolName: string } | null>();
  function resolveUniqueModuleExport(
    moduleFile: string,
    exportName: string,
  ): { filePath: string; symbolName: string } | null {
    const cacheKey = `${moduleFile}\0${exportName}`;
    if (exportResolutionCache.has(cacheKey)) return exportResolutionCache.get(cacheKey)!;
    const candidates = collectModuleExports(moduleFile, exportName, new Set());
    const distinct = new Map<string, { filePath: string; symbolName: string }>();
    for (const candidate of candidates) {
      distinct.set(`${candidate.filePath}\0${candidate.symbolName}`, candidate);
    }
    const resolved = distinct.size === 1 ? [...distinct.values()][0] : null;
    exportResolutionCache.set(cacheKey, resolved);
    return resolved;
  }

  /**
   * Resolve an OXC-language call expression through its file's module
   * bindings.
   * - `name()` — local bound to a named/default import or destructured
   *   require → that export in the bound workspace module.
   * - `ns.member()` — namespace import/require binding → `member` uniquely
   *   exported by the bound module.
   * - `exports.member()` / `module.exports.member()` — self-module export.
   * Anything else (external packages, computed requires, missing or
   * ambiguous exports, deeper member chains) resolves to null → no edge.
   * A JS/JSX caller whose final resolved target is not a JS/JSX file is
   * dropped — TypeScript callers may reach any OXC-family module.
   */
  function resolveOxcCallTarget(call: {
    calleeName: string;
    filePath: string;
    shadowedLocal?: boolean;
    start?: number;
  }): string | null {
    // A param/local variable with the same name shadows any import binding.
    if (call.shadowedLocal) return null;
    let moduleFile: string | null = null;
    let exportName: string | null = null;

    if (!call.calleeName.includes(".")) {
      const binding = findImportBinding(call.filePath, call.calleeName, call.start);
      if (!binding || binding.imported === "*" || binding.typeOnly) return null;
      moduleFile = resolveModuleSpecifier(call.filePath, binding.module);
      exportName = binding.imported;
    } else {
      let receiver: string;
      let member: string;
      if (call.calleeName.startsWith("module.exports.")) {
        receiver = "module.exports";
        member = call.calleeName.slice("module.exports.".length);
      } else {
        const separator = call.calleeName.indexOf(".");
        receiver = call.calleeName.slice(0, separator);
        member = call.calleeName.slice(separator + 1);
      }
      if (!member || member.includes(".")) return null;
      if (receiver === "exports" || receiver === "module.exports") {
        moduleFile = call.filePath;
      } else {
        const binding = findImportBinding(call.filePath, receiver, call.start);
        if (!binding || binding.imported !== "*" || binding.typeOnly) return null;
        moduleFile = resolveModuleSpecifier(call.filePath, binding.module);
      }
      exportName = member;
    }

    if (!moduleFile || !exportName) return null;
    const resolved = resolveUniqueModuleExport(moduleFile, exportName);
    if (!resolved) return null;
    // JavaScript callers keep the JS-only target policy: a resolved target
    // in a TypeScript (or other non-JS) module is dropped.
    const callerLanguage = parsedFiles.get(call.filePath)?.language ?? "";
    const targetLanguage = parsedFiles.get(resolved.filePath)?.language ?? "";
    if (JS_GRAPH_LANGUAGES.has(callerLanguage) && !JS_GRAPH_LANGUAGES.has(targetLanguage)) {
      return null;
    }
    return symbolNodeIdsByFileAndName.get(`${resolved.filePath}\0${resolved.symbolName}`) ?? null;
  }

  /**
   * Go call resolution: receiver-qualified `Type::method` names keep the
   * same-file lookup; `pkg.Func` resolves through the file's bound import to
   * an exported package-level function declared directly in the imported
   * package; a bare name resolves to a unique package-level function of the
   * caller's own package. A root name in the caller's function-local names
   * (receiver, params, results, `:=`/`var`/`const`) drops the call.
   */
  const resolveGoCall = (call: {
    callerName: string;
    calleeName: string;
    filePath: string;
  }): string | null => {
    if (!goResolver) return null;
    if (call.calleeName.includes("::")) {
      return symbolNodeIdsByFileAndName.get(`${call.filePath}\0${call.calleeName}`) ?? null;
    }
    const ctx = goResolver.contextForFile(call.filePath);
    if (!ctx?.packageName) return null;
    const locals = ctx.localNamesByCaller.get(call.callerName);

    const uniquePackageFunction = (files: string[], name: string): string | null => {
      let found: string | null = null;
      for (const file of files) {
        if (goSymbolTypes.get(`${file}\0${name}`) !== "function") continue;
        const id = symbolNodeIdsByFileAndName.get(`${file}\0${name}`);
        if (!id) continue;
        if (found) return null; // ambiguous
        found = id;
      }
      return found;
    };

    const dotIndex = call.calleeName.indexOf(".");
    if (dotIndex >= 0) {
      const qualifier = call.calleeName.slice(0, dotIndex);
      const member = call.calleeName.slice(dotIndex + 1);
      if (!/^\p{Lu}/u.test(member)) return null; // unexported or nested member
      if (locals?.has(qualifier) || ctx.ambiguousNames.has(qualifier)) return null;
      const target = ctx.imports.get(qualifier);
      if (!target) return null;
      return uniquePackageFunction(
        goResolver.packageFiles(target.dir, target.packageName, false),
        member,
      );
    }

    if (locals?.has(call.calleeName)) return null;
    return uniquePackageFunction(
      goResolver.packageFiles(ctx.packageDir, ctx.packageName, true),
      call.calleeName,
    );
  };

  const _callMeta = `{"heuristic":true,"confidence":"low"}`;
  for (const call of pendingCallEdges) {
    const callerNodeId = symbolNodeIdsByFileAndName.get(`${call.filePath}\0${call.callerName}`);
    if (!callerNodeId) continue;
    // Resolve call targets with lexical scope awareness:
    // 1. Try qualified name (callerName.calleeName) — handles nested functions
    //    that shadow top-level symbols (e.g. `two.helper` called from `two`)
    // 2. Try same-file unqualified name
    // 3. JavaScript files: try module-binding import resolution — a same-name
    //    global symbol is never substituted for a missing import target
    //    Other languages: try global symbol map (cross-file resolution)
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
    const isOxcCaller = OXC_GRAPH_LANGUAGES.has(parsedFiles.get(call.filePath)?.language ?? "");
    const isGoCaller = (parsedFiles.get(call.filePath)?.language ?? "") === "go";
    const isPythonCaller = (parsedFiles.get(call.filePath)?.language ?? "") === "python";
    const isRubyCaller = (parsedFiles.get(call.filePath)?.language ?? "") === "ruby";
    const isRustCaller = (parsedFiles.get(call.filePath)?.language ?? "") === "rust";
    const isCppCaller = (parsedFiles.get(call.filePath)?.language ?? "") === "cpp";
    const isCSharpCaller = (parsedFiles.get(call.filePath)?.language ?? "") === "csharp";
    let calleeNodeId: string | undefined;
    if (isGoCaller) {
      calleeNodeId = resolveGoCall(call) ?? undefined;
    } else if (isPythonCaller) {
      // Python never uses lexical-name guessing or the global symbol map —
      // resolution goes through unique bindings, enclosing scopes, and the
      // self/cls/Class rules in python-resolver.ts.
      const target = pythonResolver?.resolveCall(call);
      calleeNodeId = target
        ? symbolNodeIdsByFileAndName.get(`${target.filePath}\0${target.symbolName}`)
        : undefined;
    } else if (isRubyCaller) {
      // Ruby never uses lexical-name guessing or the global symbol map —
      // resolution is scope-aware via ruby-resolver.ts and unique-only.
      const target = rubyResolver?.resolveCall(call);
      calleeNodeId = target
        ? symbolNodeIdsByFileAndName.get(`${target.filePath}\0${target.symbolName}`)
        : undefined;
    } else if (isCppCaller) {
      // C++ uses translation-unit visibility and unique target resolution.
      const target = cppResolver?.resolveCall({
        filePath: call.filePath,
        callerName: call.callerName,
        calleeName: call.calleeName,
      });
      calleeNodeId = target
        ? symbolNodeIdsByFileAndName.get(`${target.filePath}\0${target.symbolName}`)
        : undefined;
    } else if (isRustCaller) {
      // Rust never uses lexical-name guessing, OXC bindings, or the global
      // symbol map — resolution is crate/module-aware via rust-resolver.ts
      // and emits only unique in-crate targets.
      const target = rustResolver?.resolveCall(
        call.filePath,
        call.callerName,
        call.calleeName,
        call.shadowedLocal,
      );
      calleeNodeId = target
        ? symbolNodeIdsByFileAndName.get(`${target.filePath}\0${target.name}`)
        : undefined;
    } else if (isCSharpCaller) {
      // C# never uses lexical-name guessing, OXC bindings, or the global
      // symbol map — resolution is namespace/using-aware via
      // csharp-resolver.ts and emits only unique targets.
      const target = csharpResolver?.resolveCallOccurrence(
        call.filePath,
        call.callerName,
        call.calleeName,
      );
      calleeNodeId = target
        ? (symbolNodeIdsByFileAndIndex.get(`${target.filePath}\0${target.index}`) ??
          symbolNodeIdsByFileAndName.get(`${target.filePath}\0${target.name}`))
        : undefined;
    } else {
      calleeNodeId = lexicalNames
        .map((name) => symbolNodeIdsByFileAndName.get(`${call.filePath}\0${name}`))
        .find((id): id is string => Boolean(id));
      if (!calleeNodeId) {
        calleeNodeId = isOxcCaller
          ? (resolveOxcCallTarget(call) ?? undefined)
          : globalSymbolNodes.get(call.calleeName);
      }
    }
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
