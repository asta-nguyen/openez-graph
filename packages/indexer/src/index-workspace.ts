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
  setFastTokenCount,
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
    const hashToVector = new Map<string, { embedding: string; dimensions: number }>();
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
          hashToVector.set(String(row.input_hash), {
            embedding: String(row.embedding),
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
      embedding: string;
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
          embedding: JSON.stringify(embedding),
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
  contentHash: string;
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
  const TS_LANGS = new Set(["python", "go", "rust", "c"]);
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
    // Use parse_and_chunk_batch — does parse + chunk creation in Rust (rayon parallel)
    const useChunkBatch = !!native.parseAndChunkBatch;
    const nativeResults = useChunkBatch
      ? native.parseAndChunkBatch(batchItems)
      : native.parseCodeBatch(batchItems);
    process.stderr.write(
      `[t]   native-batch: ${Date.now() - _batchStart}ms (${batchTasks.length} files)\n`,
    );
    for (let i = 0; i < batchTasks.length; i++) {
      const task = batchTasks[i];
      const nr = nativeResults[i];
      if (nr) {
        const lang = batchItems[i].language;
        // Chunks come from Rust if using parseAndChunkBatch, otherwise build in JS
        let chunks: any[];
        if (useChunkBatch && nr.chunks) {
          chunks = nr.chunks.map((c: any) => ({
            content: c.content,
            tokenCount: 0,
            contentHash: "",
            metadata: { kind: "code", fallback: true, startLine: c.startLine, endLine: c.endLine },
          }));
        } else {
          const lines = task.content.split("\n");
          chunks = [];
          for (let ci = 0; ci < lines.length; ci += 80) {
            const slice = lines
              .slice(ci, ci + 80)
              .join("\n")
              .trim();
            if (!slice) continue;
            chunks.push({
              content: slice,
              tokenCount: 0,
              contentHash: "",
              metadata: {
                kind: "code",
                fallback: true,
                startLine: ci + 1,
                endLine: Math.min(ci + 80, lines.length),
              },
            });
          }
        }
        results.set(task.id, {
          kind: "code",
          language: lang,
          parser: "tree-sitter-native",
          chunks,
          importPaths: nr.importPaths,
          wikilinks: [],
          definedSymbols: nr.symbols.map((s: any) => ({
            name: s.name,
            symbolType: s.symbolType,
            type: s.symbolType,
            exported: s.exported,
            startLine: s.startLine,
            endLine: s.endLine,
            receiver: s.receiver || undefined,
          })),
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
    // Skip boundChunks for non-native path — chunkDocument already produces reasonable sizes
    // and boundChunks calls countTokens which is slow (387ms/50 files)
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
  // Use fast token counting during indexing — BPE encoding is 100x slower
  setFastTokenCount(true);
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
    for (const document of existingDocuments) {
      if (!scannedPaths.has(document.path)) {
        await resetDocumentArtifacts(repo, document.id);
        await repo.deleteDocument(document.id);
      }
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

    // ── Phase 2-4: Streaming pipeline — read → hash → parse → write in batches ──
    // Process 5000 files at a time to bound memory (71k files × symbols = OOM otherwise).
    process.stderr.write(
      `[t] phase1 stat-check: ${Date.now() - _T0}ms (${filesToRead.length} to read)\n`,
    );
    const _T4 = Date.now();
    const STREAM_BATCH = filesToRead.length > 10000 ? 2000 : 200;
    const allChunkRowsForEmbeddings: Array<{
      id: string;
      content: string;
      path: string;
      heading?: string | null;
    }> = [];

    if (filesToRead.length > 0) {
      repo.setOptimizedWriteMode(true);
      repo.dropFtsTriggers();
      bulkWriteMode = true;
    }

    for (let batchStart = 0; batchStart < filesToRead.length; batchStart += STREAM_BATCH) {
      const batchEnd = Math.min(batchStart + STREAM_BATCH, filesToRead.length);
      const batchFiles = filesToRead.slice(batchStart, batchEnd);

      // ── Read batch in parallel ──
      const batchContents = new Map<string, string>();
      const READ_CONCURRENCY = 32;
      let readIdx = 0;
      async function readBatchWorker() {
        while (readIdx < batchFiles.length) {
          const i = readIdx++;
          batchContents.set(
            batchFiles[i].relativePath,
            await fs.readFile(batchFiles[i].absolutePath, "utf8"),
          );
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(READ_CONCURRENCY, batchFiles.length) }, () =>
          readBatchWorker(),
        ),
      );

      // ── Hash check + build parse tasks ──
      const batchParseTasks: ParseTask[] = [];
      for (const file of batchFiles) {
        const content = batchContents.get(file.relativePath)!;
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
          batchParseTasks.push({
            id: file.relativePath,
            content,
            contentHash,
            relativePath: file.relativePath,
            absolutePath: file.absolutePath,
            sizeBytes: file.sizeBytes,
            mtimeMs: file.mtimeMs,
            targetTokens: settings.chunking.targetTokens,
            overlapTokens: settings.chunking.overlapTokens,
          });
        }
      }

      if (batchParseTasks.length === 0) {
        batchContents.clear();
        continue;
      }

      // ── Parse batch ──
      const batchParseResults = await parseInline(batchParseTasks, (done, _total) => {
        reportProgress(
          `Parsing ${batchStart + done}/${filesToRead.length} files...`,
          Math.min(
            50,
            10 + Math.round(((batchStart + done) / Math.max(filesToRead.length, 1)) * 40),
          ),
        );
      });

      // ── Write batch to DB ──
      await repo.transaction(async () => {
        const newDocs: Array<{
          path: string;
          absolutePath: string;
          kind: string;
          language?: string | null;
          contentHash: string;
          sizeBytes: number;
          mtimeMs: number;
        }> = [];
        const docIdMap = new Map<string, string>();

        for (const task of batchParseTasks) {
          const indexed = batchParseResults.get(task.id)!;
          const existingDocument = existingDocumentsByPath.get(task.relativePath);

          if (existingDocument) {
            await resetChangedFileArtifacts(repo, existingDocument.id, task.relativePath);
            await repo.updateDocument(existingDocument.id, {
              absolutePath: task.absolutePath,
              kind: indexed.kind,
              language: indexed.language,
              contentHash: task.contentHash,
              sizeBytes: task.sizeBytes,
              mtimeMs: task.mtimeMs,
            });
            docIdMap.set(task.relativePath, existingDocument.id);
          } else {
            newDocs.push({
              path: task.relativePath,
              absolutePath: task.absolutePath,
              kind: indexed.kind,
              language: indexed.language,
              contentHash: task.contentHash,
              sizeBytes: task.sizeBytes,
              mtimeMs: task.mtimeMs,
            });
          }
        }

        if (newDocs.length > 0) {
          const newDocIds = await repo.insertDocumentsBatch(newDocs);
          for (let i = 0; i < newDocs.length; i++) {
            docIdMap.set(newDocs[i].path, newDocIds[i]);
          }
        }

        // Insert chunks
        const batchChunkInputs: Array<{
          documentId: string;
          chunkIndex: number;
          heading: string | null;
          content: string;
          tokenCount: number;
          contentHash: string;
          metadata: string;
        }> = [];
        for (const task of batchParseTasks) {
          const indexed = batchParseResults.get(task.id)!;
          const documentId = docIdMap.get(task.relativePath)!;
          for (let ci = 0; ci < indexed.chunks.length; ci++) {
            const chunk = indexed.chunks[ci];
            batchChunkInputs.push({
              documentId,
              chunkIndex: ci,
              heading: chunk.heading ?? null,
              content: chunk.content,
              tokenCount: chunk.tokenCount,
              contentHash: chunk.contentHash,
              metadata: JSON.stringify(chunk.metadata),
            });
          }
        }
        const chunkIds = await repo.insertChunks(batchChunkInputs);

        // Collect embedding rows + count (only if embeddings enabled)
        let ci = 0;
        for (const task of batchParseTasks) {
          const indexed = batchParseResults.get(task.id)!;
          if (embeddingProvider) {
            for (let c = 0; c < indexed.chunks.length; c++) {
              allChunkRowsForEmbeddings.push({
                id: chunkIds[ci],
                content: indexed.chunks[c].content,
                path: task.relativePath,
                heading: indexed.chunks[c].heading,
              });
            }
          }
          ci += indexed.chunks.length;
          chunksWritten += indexed.chunks.length;
          filesUpdated += 1;
        }
      });

      // Free batch memory
      batchContents.clear();
      batchParseResults.clear();

      await reportProgress(
        `Writing ${batchEnd}/${filesToRead.length}...`,
        Math.min(95, 50 + Math.round((batchEnd / Math.max(filesToRead.length, 1)) * 45)),
      );
    }
    process.stderr.write(`[t] phase2-4 stream: ${Date.now() - _T4}ms\n`);

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

    // Write embeddings outside the DB transaction
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

    // ── Phase 5: FTS insert via INSERT...SELECT (no JS param marshalling) + restore ──
    process.stderr.write(`[t] phase4 db-write: ${Date.now() - _T4}ms\n`);
    const _T5 = Date.now();

    _ftsBuildingWorkspaces.set(workspace.id, true);
    const _ftsT = Date.now();
    try {
      const inserted = repo.bulkInsertFtsFromChunks();
      process.stderr.write(`[t]   fts-insert: ${Date.now() - _ftsT}ms (${inserted} entries)\n`);
    } catch (e) {
      process.stderr.write(`[fts] ERROR: ${e}\n`);
    } finally {
      _ftsBuildingWorkspaces.delete(workspace.id);
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

    // Don't restore write mode here — synchronous=NORMAL triggers fsync of all
    // dirty pages accumulated during synchronous=OFF. The DB file on disk is
    // already valid (MEMORY journal means changes are in the main DB file).
    // Next open will use WAL + NORMAL (persisted defaults from workspace-db.ts).
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
}

// ── Background FTS tracking ──
// When FTS is building in background, code_query should wait for it.
const _ftsBuildingWorkspaces = new Map<string, boolean>();

export async function waitForFts(rootPath: string): Promise<void> {
  const workspaceId = path.basename(rootPath);
  // Poll until background FTS build finishes (typically <3s)
  let waited = 0;
  while (_ftsBuildingWorkspaces.has(workspaceId) && waited < 10000) {
    await new Promise((r) => setTimeout(r, 100));
    waited += 100;
  }
}

// ── Lazy graph builder ──
// Called on first graph_neighbors/code_context query.
// Re-parses files with native batch, inserts graph nodes + edges + call edges.
// One-time cost (~5s for 2K files). Subsequent queries use cached graph.

const _graphBuiltWorkspaces = new Set<string>();

export async function buildGraphForWorkspace(rootPath: string): Promise<void> {
  const workspaceId = path.basename(rootPath);
  if (_graphBuiltWorkspaces.has(workspaceId)) return;

  const repo = createWorkspaceRepository(rootPath);
  const nodeCount = repo.getNodeCount();
  if (nodeCount > 0) {
    _graphBuiltWorkspaces.add(workspaceId);
    return;
  }

  // Load native module
  let native: any = null;
  try {
    const nativePath = require("path").join(__dirname, "native", "index.linux-x64-gnu.node");
    native = require(nativePath);
  } catch {
    try {
      native = require("@openez-graph/native");
    } catch {
      return;
    }
  }

  // Get all documents from DB
  const documents = await repo.listDocuments();
  const codeDocs = documents.filter((d) => d.kind === "code");

  // Read file contents
  const fsp = await import("node:fs/promises");

  const NATIVE_LANGS = new Set(["rust", "python", "go", "c"]);
  const TS_LANGS = new Set(["typescript", "tsx", "javascript", "jsx"]);

  // Split files by parser type
  const nativeBatchItems: Array<{ language: string; content: string }> = [];
  const nativeDocPaths: string[] = [];
  const tsDocPaths: string[] = [];
  const tsContents: string[] = [];

  for (const doc of codeDocs) {
    try {
      const content = await fsp.readFile(doc.absolutePath, "utf8");
      const lang = doc.language ?? inferDocumentKind(doc.path).language ?? "text";
      if (NATIVE_LANGS.has(lang)) {
        nativeBatchItems.push({ language: lang, content });
        nativeDocPaths.push(doc.path);
      } else if (TS_LANGS.has(lang)) {
        tsDocPaths.push(doc.path);
        tsContents.push(content);
      }
    } catch {
      /* file may have been deleted */
    }
  }

  // Parse native languages in batch
  const nativeResults = nativeBatchItems.length > 0 ? native.parseCodeBatch(nativeBatchItems) : [];

  // Parse TS/JS with OxcParser
  let { OxcParser } = await import("./parsers/oxc-parser");
  const tsResults: Array<{ symbols: any[]; callExpressions: any[]; importPaths: string[] }> = [];
  for (let i = 0; i < tsDocPaths.length; i++) {
    try {
      const parser = new OxcParser();
      const parsed = parser.parse(
        {
          relativePath: tsDocPaths[i],
          content: tsContents[i],
          contentHash: "",
          absolutePath: "",
          sizeBytes: 0,
          mtimeMs: 0,
          targetTokens: 0,
          overlapTokens: 0,
        },
        "typescript",
        "code",
      );
      tsResults.push({
        symbols: parsed.definedSymbols,
        callExpressions: parsed.callExpressions,
        importPaths: parsed.importPaths,
      });
    } catch {
      tsResults.push({ symbols: [], callExpressions: [], importPaths: [] });
    }
  }

  // Build graph nodes + edges
  const allNodeInputs: Array<{ type: string; label: string; refId?: string; metadata?: string }> =
    [];
  const allEdges: Array<{ fromNodeId: string; toNodeId: string; type: string; metadata?: string }> =
    [];
  const symbolNodeIdsByFileAndName = new Map<string, string>();
  const pendingCallEdges: Array<{ callerName: string; calleeName: string; filePath: string }> = [];
  const pendingImportEdges: Array<{ filePath: string; importPath: string }> = [];

  // Unified structure for processing both native and TS results
  interface FileResult {
    filePath: string;
    docId: string;
    language: string | null;
    symbols: Array<{ name: string; symbolType: string; exported: boolean }>;
    callExpressions: Array<{ callerName: string; calleeName: string }>;
    importPaths: string[];
  }

  const allResults: FileResult[] = [];

  for (let i = 0; i < nativeResults.length; i++) {
    const nr = nativeResults[i];
    if (!nr) continue;
    const doc = codeDocs.find((d) => d.path === nativeDocPaths[i])!;
    allResults.push({
      filePath: nativeDocPaths[i],
      docId: doc.id,
      language: doc.language,
      symbols: nr.symbols,
      callExpressions: nr.callExpressions,
      importPaths: nr.importPaths,
    });
  }

  for (let i = 0; i < tsResults.length; i++) {
    const doc = codeDocs.find((d) => d.path === tsDocPaths[i])!;
    allResults.push({
      filePath: tsDocPaths[i],
      docId: doc.id,
      language: doc.language,
      symbols: tsResults[i].symbols,
      callExpressions: tsResults[i].callExpressions,
      importPaths: tsResults[i].importPaths,
    });
  }

  if (allResults.length === 0) {
    _graphBuiltWorkspaces.add(workspaceId);
    return;
  }

  for (const fr of allResults) {
    // File node
    const fileNodeIdx = allNodeInputs.length;
    allNodeInputs.push({
      type: "file",
      label: fr.filePath,
      refId: fr.docId,
      metadata: JSON.stringify({ path: fr.filePath, language: fr.language }),
    });

    // Symbol nodes (no cap)
    const symNodeStart = allNodeInputs.length;
    for (const sym of fr.symbols) {
      allNodeInputs.push({
        type: "symbol",
        label: sym.name,
        refId: fr.docId,
        metadata: JSON.stringify({
          symbolType: sym.symbolType,
          filePath: fr.filePath,
          language: fr.language,
        }),
      });
    }

    // Call expressions (no cap)
    for (const call of fr.callExpressions) {
      pendingCallEdges.push({
        callerName: call.callerName,
        calleeName: call.calleeName,
        filePath: fr.filePath,
      });
    }

    // Import edges
    for (const imp of fr.importPaths) {
      pendingImportEdges.push({ filePath: fr.filePath, importPath: imp });
    }

    // Store symbol positions for edge building (after we get IDs back)
    (allNodeInputs as any)._symMeta = (allNodeInputs as any)._symMeta || [];
    (allNodeInputs as any)._symMeta.push({
      filePath: fr.filePath,
      fileNodeIdx,
      symNodeStart,
      symCount: fr.symbols.length,
    });
  }

  // Batch insert all nodes
  const nodeIds = await repo.insertGraphNodesBatch(allNodeInputs);

  // Build defines edges
  const symMeta = (allNodeInputs as any)._symMeta || [];
  for (const meta of symMeta) {
    const fileNodeId = nodeIds[meta.fileNodeIdx];
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

  // Resolve call edges
  const globalSymbolNodes = await repo.loadAllSymbolNodes();
  const _callMeta = `{"heuristic":true,"confidence":"low"}`;
  for (const call of pendingCallEdges) {
    const callerNodeId = symbolNodeIdsByFileAndName.get(`${call.filePath}\0${call.callerName}`);
    if (!callerNodeId) continue;
    // Try exact match, then strip qualified prefix (obj.method → method)
    const calleeNodeId =
      symbolNodeIdsByFileAndName.get(`${call.filePath}\0${call.calleeName}`) ??
      globalSymbolNodes.get(call.calleeName) ??
      globalSymbolNodes.get(call.calleeName.split(".").pop()!) ??
      globalSymbolNodes.get(call.calleeName.split("->").pop()!);
    if (!calleeNodeId || callerNodeId === calleeNodeId) continue;
    allEdges.push({
      fromNodeId: callerNodeId,
      toNodeId: calleeNodeId,
      type: "calls",
      metadata: _callMeta,
    });
  }

  // Resolve import edges — link file nodes to imported file nodes
  const fileNodeLabels = new Map<string, string>();
  for (const meta of symMeta) {
    const fid = nodeIds[meta.fileNodeIdx];
    if (fid) fileNodeLabels.set(meta.filePath, fid);
  }
  for (const imp of pendingImportEdges) {
    const fromId = fileNodeLabels.get(imp.filePath);
    if (!fromId) continue;
    // Try to find matching file node by path suffix
    // TS imports: "./foo" → "foo.ts", C includes: "linux/sched.h"
    const importBase = imp.importPath.replace(/^\.\//, "").replace(/^\.\.\//, "");
    for (const [filePath, toId] of fileNodeLabels) {
      if (filePath === imp.filePath) continue;
      const fileBase = filePath.replace(/\.(ts|tsx|js|jsx|rs|py|go|c|h)$/, "");
      if (
        filePath.endsWith(importBase) ||
        fileBase.endsWith(importBase) ||
        importBase.endsWith(fileBase)
      ) {
        allEdges.push({ fromNodeId: fromId, toNodeId: toId, type: "imports" });
        break;
      }
    }
  }

  // Batch insert all edges
  await repo.transaction(async () => {
    await repo.insertEdges(allEdges);
  });

  _graphBuiltWorkspaces.add(workspaceId);
}
