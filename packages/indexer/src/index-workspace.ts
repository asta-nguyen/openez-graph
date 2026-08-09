import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

import { getBrainSettings, loadBrainConfig } from "@openez-graph/config";
import {
  countTokens,
  embeddingStorageModel,
  formatEmbeddingInput,
  getEmbeddingProvider,
  splitToTokenLimit,
} from "@openez-graph/core";
import type { EmbeddingProvider } from "@openez-graph/core";
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
] as const;

// Parser version tags stored alongside cached parse results in
// `parsed_documents`. Bump these when parser logic changes so stale cache
// entries are invalidated on the next index/graph build.
const PARSER_VERSION_TS_MORPH = "ts-morph-v1";
const PARSER_VERSION_NATIVE = "native-v1";
const PARSER_VERSION_FALLBACK = "fallback-v1";

/**
 * Map a parser name (returned by `parseDocument`/`parseInline`) to the
 * version tag stored in `parsed_documents.parser_version`. Native
 * tree-sitter results use `native-v1`, the fallback parser uses
 * `fallback-v1`, and every other parser (oxc, tree-sitter, markdown,
 * config, regex) is grouped under `ts-morph-v1` since they share the same
 * chunking/call-extraction contract.
 */
function parserVersionFor(parserName: string): string {
  if (parserName === "tree-sitter-native") return PARSER_VERSION_NATIVE;
  if (parserName === "fallback") return PARSER_VERSION_FALLBACK;
  return PARSER_VERSION_TS_MORPH;
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
): IndexedChunk[] {
  return chunks.flatMap((chunk) => {
    const parts = splitToTokenLimit(chunk.content, targetTokens, overlapTokens);
    if (parts.length <= 1) return chunk;

    return parts.map((content, splitIndex) => ({
      ...chunk,
      content,
      tokenCount: countTokens(content),
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

async function writeEmbeddingsToRepo(
  repo: WorkspaceRepository,
  chunkRows: Array<{ id: string; content: string; path: string; heading?: string | null }>,
  provider: EmbeddingProvider | null,
) {
  if (!provider || chunkRows.length === 0) {
    return { written: 0, failedBatches: 0 };
  }

  const existingIds = new Set<string>();
  const LOOKUP_BATCH_SIZE = 500;
  for (let i = 0; i < chunkRows.length; i += LOOKUP_BATCH_SIZE) {
    const batch = chunkRows.slice(i, i + LOOKUP_BATCH_SIZE);
    const existing = await repo.queryRaw(
      `SELECT chunk_id FROM embeddings
       WHERE provider = ? AND model = ? AND chunk_id IN (${batch.map(() => "?").join(",")})`,
      [provider.provider, embeddingStorageModel(provider), ...batch.map((chunk) => chunk.id)],
    );
    for (const row of existing) {
      existingIds.add(String(row.chunk_id));
    }
  }
  const missingRows = chunkRows.filter((chunk) => !existingIds.has(chunk.id));
  if (missingRows.length === 0) return { written: 0, failedBatches: 0 };

  const rowsToEmbed = missingRows.map((chunk) => ({
    chunk,
    hash: hashContent(formatEmbeddingInput(provider, chunk, "document")),
  }));

  // Deduplicate by input_hash: skip chunks whose formatted input already has an embedding
  const existingHashes = new Set<string>();
  for (let i = 0; i < rowsToEmbed.length; i += LOOKUP_BATCH_SIZE) {
    const batch = rowsToEmbed.slice(i, i + LOOKUP_BATCH_SIZE);
    const hashPlaceholders = batch.map(() => "?").join(",");
    const existing = await repo.queryRaw(
      `SELECT DISTINCT input_hash FROM embeddings
       WHERE provider = ? AND model = ? AND input_hash IN (${hashPlaceholders})`,
      [provider.provider, embeddingStorageModel(provider), ...batch.map((entry) => entry.hash)],
    );
    for (const row of existing) {
      if (row.input_hash) existingHashes.add(String(row.input_hash));
    }
  }
  const toEmbed = rowsToEmbed.filter((entry) => !existingHashes.has(entry.hash));
  const skipped = rowsToEmbed.filter((entry) => existingHashes.has(entry.hash));

  // Reuse existing embeddings for skipped chunks: copy the vector so each chunk
  // has its own embedding row and appears in vector search results.
  let reusedWritten = 0;
  if (skipped.length > 0) {
    const hashToVector = new Map<string, { embedding: Uint8Array; dimensions: number }>();
    const uniqueHashes = [...new Set(skipped.map((entry) => entry.hash))];
    for (let i = 0; i < uniqueHashes.length; i += LOOKUP_BATCH_SIZE) {
      const batch = uniqueHashes.slice(i, i + LOOKUP_BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(",");
      const rows = await repo.queryRaw(
        `SELECT input_hash, embedding, dimensions FROM embeddings
         WHERE provider = ? AND model = ? AND input_hash IN (${placeholders})
         GROUP BY input_hash`,
        [provider.provider, embeddingStorageModel(provider), ...batch],
      );
      for (const row of rows) {
        if (row.input_hash) {
          const emb =
            row.embedding instanceof Uint8Array
              ? row.embedding
              : new Uint8Array(new Float32Array(JSON.parse(String(row.embedding))).buffer);
          hashToVector.set(String(row.input_hash), {
            embedding: emb,
            dimensions: Number(row.dimensions),
          });
        }
      }
    }
    const reuseInputs: Array<{
      chunkId: string;
      provider: string;
      model: string;
      dimensions: number;
      embedding: Uint8Array;
      inputHash: string;
    }> = [];
    for (const entry of skipped) {
      const existing = hashToVector.get(entry.hash);
      if (existing) {
        reuseInputs.push({
          chunkId: entry.chunk.id,
          provider: provider.provider,
          model: embeddingStorageModel(provider),
          dimensions: existing.dimensions,
          embedding: existing.embedding,
          inputHash: entry.hash,
        });
      }
    }
    if (reuseInputs.length > 0) {
      await repo.insertEmbeddings(reuseInputs);
      reusedWritten = reuseInputs.length;
    }
  }

  if (toEmbed.length === 0) return { written: reusedWritten, failedBatches: 0 };

  const BATCH_SIZE = 50;
  let totalWritten = 0;
  let failedBatches = 0;
  const totalBatches = Math.ceil(toEmbed.length / BATCH_SIZE);

  for (let i = 0; i < toEmbed.length; i += BATCH_SIZE) {
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    if (batchNum % 10 === 0 || batchNum === totalBatches) {
      process.stdout.write(
        `\r[embedding] batch ${batchNum}/${totalBatches} (${totalWritten} written)`,
      );
    }
    const batch = toEmbed.slice(i, i + BATCH_SIZE);

    try {
      const vectors = await provider.embed(
        batch.map((entry) => formatEmbeddingInput(provider, entry.chunk, "document")),
      );
      if (vectors.length !== batch.length) {
        failedBatches += 1;
        console.error(
          `Embedding provider returned ${vectors.length} vectors for ${batch.length} chunks`,
        );
        continue;
      }
      const invalidEmbeddingIndex = vectors.findIndex((embedding) => embedding.length === 0);

      if (invalidEmbeddingIndex !== -1) {
        failedBatches += 1;
        console.error(
          `Embedding provider returned empty vector for chunk ${batch[invalidEmbeddingIndex].chunk.id}`,
        );
        continue;
      }

      const dimensions = vectors[0]?.length ?? 0;
      if (vectors.some((embedding) => embedding.length !== dimensions)) {
        failedBatches += 1;
        console.error("Embedding provider returned mixed dimensions");
        continue;
      }

      await repo.insertEmbeddings(
        vectors.map((embedding, index) => ({
          chunkId: batch[index].chunk.id,
          provider: provider.provider,
          model: embeddingStorageModel(provider),
          dimensions,
          embedding: new Uint8Array(new Float32Array(embedding).buffer),
          inputHash: batch[index].hash,
        })),
      );

      totalWritten += vectors.length;
    } catch (error) {
      failedBatches += 1;
      console.error(
        `Embedding batch failed (skipping): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (totalBatches > 0) {
    process.stdout.write("\n");
  }
  return { written: totalWritten + reusedWritten, failedBatches };
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
}

type ParseResult = Awaited<ReturnType<typeof chunkDocument>>;

async function parseInline(
  tasks: ParseTask[],
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, ParseResult>> {
  const results = new Map<string, ParseResult>();

  // ── Batch native tree-sitter parse for Python/Go/Rust files ──
  const TS_LANGS = new Set(["python", "go", "rust"]);
  let native: any = null;
  try {
    const nativePath = require("path").join(__dirname, "native", "index.linux-x64-gnu.node");
    native = require(nativePath);
  } catch {
    try {
      native = require("@openez-graph/native");
    } catch {
      /* not installed */
    }
  }

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
    const nativeResults = native.parseCodeBatch(batchItems);
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
        const symbols: ExtractedSymbol[] = nr.symbols.map((s: any) => ({
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
          chunks = createSymbolChunks(symbols, lines, lang);
        } else {
          chunks = makeFallbackChunks(task.content, lines).chunks;
        }
        // Bound chunks to configured token limits
        chunks = boundChunks(chunks, task.targetTokens, task.overlapTokens);
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
        });
        indexed.chunks = boundChunks(indexed.chunks, task.targetTokens, task.overlapTokens);
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
    });
    // Bound large symbol chunks (e.g. a 1000-line function) to the target
    // token limit. The OxcParser creates one chunk per symbol, which can
    // exceed the limit for very large functions.
    if (indexed.kind === "code") {
      indexed.chunks = boundChunks(indexed.chunks, task.targetTokens, task.overlapTokens);
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
  // Token counting is now scoped via the TokenCounter interface — no global
  // fast-mode toggle to reset. The try/finally is retained for structural
  // stability but no longer toggles global tokenizer state.
  try {
    const registry = createRegistryRepository();
    let workspace: RegistryWorkspace;

    if (input.workspaceId) {
      const w = await registry.getWorkspace(input.workspaceId);
      if (!w) throw new Error(`Workspace '${input.workspaceId}' not found`);
      workspace = w;
    } else if (input.rootPath) {
      workspace = await registry.ensureWorkspace({
        rootPath: path.resolve(input.rootPath),
      });
    } else {
      throw new Error("Either workspaceId or rootPath is required");
    }

    await writeLocalWorkspaceConfig(workspace);

    const repo = createWorkspaceRepository(workspace.rootPath);
    const settings = await getBrainSettings();
    const config = await loadBrainConfig(workspace.rootPath);
    const configuredWorkspace = config.workspaces?.find(
      (candidate) =>
        candidate.id === workspace.id ||
        path.resolve(candidate.root) === path.resolve(workspace.rootPath),
    );
    const includeGlobs = workspace.includeGlobs || configuredWorkspace?.include.join("\n") || "";
    const excludeGlobs = workspace.excludeGlobs || configuredWorkspace?.exclude.join("\n") || "";
    const embeddingProvider = await getEmbeddingProvider();
    const runMode = input.mode ?? "incremental";
    let graphInvalidated = false;

    const invalidateGraph = async () => {
      if (graphInvalidated) return;
      await registry.invalidateWorkspaceGraph(workspace.id);
      graphInvalidated = true;
    };

    if (embeddingProvider) {
      process.stdout.write(
        `[embedding] provider=${embeddingProvider.provider} model=${embeddingProvider.model}\n`,
      );
    } else {
      process.stdout.write(`[embedding] disabled (no provider configured)\n`);
    }

    const reportProgress = async (message: string, progress: number) => {
      await input.onProgress?.({ message, progress });
    };

    if (runMode === "full") {
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

    const existingDocuments = await repo.listDocuments();
    const existingDocumentsByPath = new Map(
      existingDocuments.map((document) => [document.path, document]),
    );

    if (runMode === "incremental") {
      const scannedPaths = new Set(files.map((file) => file.relativePath));
      let deletedAny = false;
      for (const document of existingDocuments) {
        if (!scannedPaths.has(document.path)) {
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
    let embeddingsWritten = 0;
    let embeddingFailures = 0;
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
      const unchangedFiles: Array<{
        existingDocument: NonNullable<Awaited<ReturnType<typeof repo.getDocumentByPath>>>;
      }> = [];
      const filesToRead: typeof files = [];

      for (const file of files) {
        const existingDocument = existingDocumentsByPath.get(file.relativePath);
        // Fast path: skip file read if mtime and size match (incremental only)
        const statUnchanged =
          runMode === "incremental" &&
          existingDocument &&
          existingDocument.mtimeMs === file.mtimeMs &&
          existingDocument.sizeBytes === file.sizeBytes;

        if (statUnchanged) {
          unchangedFiles.push({ existingDocument: existingDocument! });
        } else {
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
        const existingDocument = existingDocumentsByPath.get(file.relativePath);
        const unchanged =
          runMode === "incremental" &&
          existingDocument &&
          existingDocument.contentHash === contentHash;

        if (unchanged) {
          await repo.updateDocument(existingDocument.id, {
            absolutePath: file.absolutePath,
            sizeBytes: file.sizeBytes,
            mtimeMs: file.mtimeMs,
          });
          unchangedFiles.push({ existingDocument });
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

      // Backfill unchanged embeddings only when embeddings are enabled.
      if (embeddingProvider) {
        for (const { existingDocument } of unchangedFiles) {
          const existingChunks = await repo.getChunksByDocument(existingDocument.id);
          const embeddingResult = await writeEmbeddingsToRepo(
            repo,
            existingChunks.map((chunk) => ({
              id: chunk.id,
              content: chunk.content,
              path: existingDocument.path,
              heading: chunk.heading,
            })),
            embeddingProvider,
          );
          embeddingsWritten += embeddingResult.written;
          embeddingFailures += embeddingResult.failedBatches;
        }
      }

      // A true no-op never changes SQLite write pragmas or FTS triggers.
      process.stderr.write(`[t] phase3 parse: ${Date.now() - _T3}ms\n`);
      const _T4 = Date.now();
      if (parseTasks.length > 0) {
        await invalidateGraph();
        // ── Phase 4: Write all results to DB (main thread, transactioned) ──
        repo.setOptimizedWriteMode(true);
        repo.dropFtsTriggers();
        bulkWriteMode = true;
      }

      const allChunkRowsForEmbeddings: Array<{
        id: string;
        content: string;
        path: string;
        heading?: string | null;
      }> = [];

      // ── Phase 4: Batch DB write — collect everything, insert in few big queries ──
      const _dbSub: Record<string, number> = {};
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
          const existingDocument = existingDocumentsByPath.get(file.relativePath);

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
            docIdMap.set(file.relativePath, existingDocument.id);
          } else {
            newDocs.push({
              path: file.relativePath,
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
          const documentId = docIdMap.get(file.relativePath)!;
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

        // Step 3: Collect chunk rows for embeddings — skip graph building (lazy, on-demand)
        for (let fi = 0; fi < parseTasks.length; fi++) {
          const file = parseTasks[fi];
          const indexed = parseResults.get(file.id)!;
          const chunkOffset = chunkOffsets[fi];

          for (let ci = 0; ci < indexed.chunks.length; ci++) {
            allChunkRowsForEmbeddings.push({
              id: allChunkIds[chunkOffset + ci],
              content: indexed.chunks[ci].content,
              path: file.relativePath,
              heading: indexed.chunks[ci].heading,
            });
          }
          chunksWritten += indexed.chunks.length;
          filesUpdated += 1;
        }

        // Step 4: Cache parse results (symbols/imports/calls) so graph build
        // can skip re-parsing. Keyed by document_id, invalidated on content change.
        for (let fi = 0; fi < parseTasks.length; fi++) {
          const file = parseTasks[fi];
          const indexed = parseResults.get(file.id)!;
          const documentId = docIdMap.get(file.relativePath)!;
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

      // Write embeddings outside the DB transaction so remote HTTP requests don't hold the WAL lock
      if (allChunkRowsForEmbeddings.length > 0 && embeddingProvider) {
        await reportProgress(
          `Embedding ${allChunkRowsForEmbeddings.length} chunks via ${embeddingProvider.provider}/${embeddingProvider.model}...`,
          90,
        );
        const embeddingResult = await writeEmbeddingsToRepo(
          repo,
          allChunkRowsForEmbeddings,
          embeddingProvider,
        );
        embeddingsWritten += embeddingResult.written;
        embeddingFailures += embeddingResult.failedBatches;
      }

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
      process.stderr.write(`[t] phase5 fts-restore: ${Date.now() - _T5}ms\n`);
      const _T7 = Date.now();
      await reportProgress("Finalizing index run...", 98);
      await repo.completeIndexRun(runId, {
        status: "completed",
        filesScanned: files.length,
        filesUpdated,
        chunksWritten,
        embeddingsWritten,
        errorMessage:
          embeddingFailures > 0
            ? `${embeddingFailures} embedding batch(es) failed; retry indexing to complete embeddings`
            : undefined,
      });

      const docCount = await repo.getDocumentCount();
      const chunkCountResult = await repo.getChunkCount();
      const nodeCount = await repo.getNodeCount();
      const edgeCount = await repo.getEdgeCount();

      await registry.updateWorkspace(workspace.id, {
        status: "indexed",
        indexingStatus: "completed",
        lastIndexedAt: new Date().toISOString(),
        documentCount: docCount,
        chunkCount: chunkCountResult,
        nodeCount,
        edgeCount,
        lastError: "",
      });

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
        embeddingsWritten,
        errorMessage,
      });

      await registry.updateWorkspace(workspace.id, {
        status: "error",
        indexingStatus: "failed",
        lastError: errorMessage,
      });
      throw error;
    }

    await reportProgress("Index complete", 100);
    process.stderr.write("[t] TOTAL: " + (Date.now() - _T0) + "ms\n");

    return {
      workspaceId: workspace.id,
      filesScanned: files.length,
      filesUpdated,
      chunksWritten,
      embeddingsWritten,
      embeddingFailures,
    };
  } finally {
    // No global tokenizer state to reset — token counting is scoped.
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
): Promise<{ nodeCount: number; edgeCount: number }> {
  const _graphStart = Date.now();

  const repo = createWorkspaceRepository(rootPath);
  const settings = await getBrainSettings();
  const targetTokens = settings.chunking.targetTokens;
  const overlapTokens = settings.chunking.overlapTokens;

  // Clear stale graph artifacts before rebuilding.
  repo.clearGraphArtifacts();

  // Get all documents from DB
  const documents = await repo.listDocuments();
  const graphDocs = documents.filter(
    (d) => d.kind === "code" || d.kind === "markdown" || d.kind === "config",
  );

  if (graphDocs.length === 0) {
    process.stderr.write(`[t] graph-build: 0 docs (${Date.now() - _graphStart}ms)\n`);
    return { nodeCount: await repo.getNodeCount(), edgeCount: await repo.getEdgeCount() };
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
      cached.parserVersion === PARSER_VERSION_TS_MORPH
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
    // Serve cached native docs first; only batch-parse the misses.
    const nativeToParse: typeof nativeDocs = [];
    for (const doc of nativeDocs) {
      const cached = repo.getParsedDocument(doc.id);
      // Cache hit requires matching content_hash AND a current parser
      // version. Native docs may have been cached by the fallback parser
      // (fallback-v1) — those are re-parsed by the native batch when the
      // native extension is available, so only accept native-v1 here.
      if (
        cached &&
        cached.contentHash === doc.contentHash &&
        cached.parserVersion === PARSER_VERSION_NATIVE
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

    let native: any = null;
    if (nativeToParse.length > 0) {
      try {
        const nativePath = require("path").join(__dirname, "native", "index.linux-x64-gnu.node");
        native = require(nativePath);
      } catch {
        try {
          native = require("@openez-graph/native");
        } catch {
          /* not installed — will fall back to parseDocument */
        }
      }
    }

    if (native?.parseCodeBatch && nativeToParse.length > 0) {
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
        const nativeResults = native.parseCodeBatch(batchItems);
        for (let i = 0; i < nativeResults.length; i++) {
          const nr = nativeResults[i];
          if (!nr) continue;
          const filePath = batchDocPaths[i];
          const doc = nativeToParse.find((d) => d.path === filePath)!;
          const lang = doc.language ?? inferDocumentKind(doc.path).language ?? "text";
          const definedSymbols = nr.symbols.map((s: any) => ({
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
    return { nodeCount: await repo.getNodeCount(), edgeCount: await repo.getEdgeCount() };
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

  // Batch insert all nodes
  const nodeIds = await repo.insertGraphNodesBatch(allNodeInputs);

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
  const globalSymbolNodes = await repo.loadAllSymbolNodes();
  const _callMeta = `{"heuristic":true,"confidence":"low"}`;
  for (const call of pendingCallEdges) {
    const callerNodeId = symbolNodeIdsByFileAndName.get(`${call.filePath}\0${call.callerName}`);
    if (!callerNodeId) continue;
    // Resolve call targets first in the caller file, then through the global symbol map
    const calleeNodeId =
      symbolNodeIdsByFileAndName.get(`${call.filePath}\0${call.calleeName}`) ??
      globalSymbolNodes.get(call.calleeName);
    if (!calleeNodeId || callerNodeId === calleeNodeId) continue;
    allEdges.push({
      fromNodeId: callerNodeId,
      toNodeId: calleeNodeId,
      type: "calls",
      metadata: _callMeta,
    });
  }

  // Batch insert all edges in one transaction
  await repo.transaction(async () => {
    await repo.insertEdges(allEdges);
  });

  process.stderr.write(
    `[t] graph-build: ${Date.now() - _graphStart}ms (${parsedFiles.size} files, ${allNodeInputs.length} nodes, ${allEdges.length} edges)\n`,
  );

  const nodeCount = await repo.getNodeCount();
  const edgeCount = await repo.getEdgeCount();
  return { nodeCount, edgeCount };
}
