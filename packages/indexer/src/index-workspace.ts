import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

import { getBrainSettings, loadBrainConfig } from "@openez-graph/config";
import {
  countTokens,
  embeddingStorageModel,
  formatEmbeddingInput,
  getEmbeddingProvider,
  splitToTokenLimit
} from "@openez-graph/core";
import type { EmbeddingProvider } from "@openez-graph/core";
import {
  createRegistryRepository,
  createWorkspaceRepository,
  writeLocalWorkspaceConfig
} from "@openez-graph/db";
import type { RegistryWorkspace, WorkspaceRepository } from "@openez-graph/db";

import { hashContent } from "./hash";
import { chunkDocument, type ParseTask, type ParseResult } from "./parse-core";
import { scanWorkspaceFiles } from "./scanner";
import type { FileToIndex, IndexedChunk, IndexWorkspaceSummary } from "./types";

const RESOLVABLE_SOURCE_EXTENSIONS = [
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
  ".md", ".mdx",
  ".py"
] as const;

function normalizeRelativePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

export function createWorkspaceFileResolver(
  workspaceRoot: string,
  files: Array<{ relativePath: string; absolutePath: string }>
) {
  const knownRelativePaths = new Set(files.map((file) => normalizeRelativePath(file.relativePath)));
  const absoluteToRelative = new Map(
    files.map((file) => [path.resolve(file.absolutePath), normalizeRelativePath(file.relativePath)])
  );

  function toWorkspaceRelative(candidateAbsolutePath: string): string | null {
    const resolvedAbsolute = path.resolve(candidateAbsolutePath);
    const mapped = absoluteToRelative.get(resolvedAbsolute);
    if (mapped) return mapped;

    const relativeToWorkspace = normalizeRelativePath(path.relative(workspaceRoot, resolvedAbsolute));
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

  function resolvePythonRelativeImport(importerRelativePath: string, importPath: string): string | null {
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
    resolveImport(importerRelativePath: string, importPath: string, language?: string): string | null {
      if (language === "python") {
        const resolved = resolvePythonImport(importerRelativePath, importPath);
        if (resolved) return resolved;
      }

      if (importPath.startsWith(".")) {
        return resolveRelativeImport(importerRelativePath, importPath);
      }

      return null;
    }
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
  relativePath: string
): Promise<Map<string, string>> {
  const chunks = await repo.getChunksByDocument(documentId);
  const chunkIds = chunks.map((c) => c.id);

  if (chunkIds.length > 0) {
    await repo.deleteEmbeddingsByChunkIds(chunkIds);
  }

  // Find file node and delete its outgoing edges (will be rebuilt)
  const fileNode = await repo.findFileNode(relativePath);
  if (fileNode) {
    repo.deleteOutgoingEdges(fileNode.id, ["defines", "imports", "mentions"]);
  }

  // Get existing symbol nodes for this file, delete their outgoing edges (will be rebuilt)
  const symbolNodes = await repo.getSymbolNodesByFilePath(relativePath);
  const existingSymbolNodes = new Map<string, string>();
  for (const sym of symbolNodes) {
    repo.deleteOutgoingEdges(sym.id, ["calls"]);
    existingSymbolNodes.set(sym.label, sym.id);
  }

  await repo.deleteChunksByDocument(documentId);

  return existingSymbolNodes;
}

export function boundChunks(chunks: IndexedChunk[], targetTokens: number, overlapTokens: number): IndexedChunk[] {
  return chunks.flatMap((chunk) => {
    const parts = splitToTokenLimit(chunk.content, targetTokens, overlapTokens);
    if (parts.length <= 1) return chunk;

    return parts.map((content, splitIndex) => ({
      ...chunk,
      content,
      tokenCount: countTokens(content),
      contentHash: hashContent(content),
      metadata: { ...chunk.metadata, splitIndex, splitCount: parts.length }
    }));
  });
}

async function writeEmbeddingsToRepo(
  repo: WorkspaceRepository,
  chunkRows: Array<{ id: string; content: string; path: string; heading?: string | null }>,
  provider: EmbeddingProvider | null
) {
  if (!provider || chunkRows.length === 0) {
    return 0;
  }

  const existing = await repo.queryRaw(
    `SELECT chunk_id FROM embeddings
     WHERE provider = ? AND model = ? AND chunk_id IN (${chunkRows.map(() => "?").join(",")})`,
    [provider.provider, embeddingStorageModel(provider), ...chunkRows.map((chunk) => chunk.id)]
  );
  const existingIds = new Set(existing.map((row) => String(row.chunk_id)));
  const missingRows = chunkRows.filter((chunk) => !existingIds.has(chunk.id));
  if (missingRows.length === 0) return 0;

  try {
    const vectors = await provider.embed(
      missingRows.map((chunk) => formatEmbeddingInput(provider, chunk, "document"))
    );
    if (vectors.length !== missingRows.length) {
      console.error(`Embedding provider returned ${vectors.length} vectors for ${missingRows.length} chunks`);
      return 0;
    }
    const invalidEmbeddingIndex = vectors.findIndex((embedding) => embedding.length === 0);

    if (invalidEmbeddingIndex !== -1) {
      console.error(`Embedding provider returned empty vector for chunk ${missingRows[invalidEmbeddingIndex].id}`);
      return 0;
    }

    const dimensions = vectors[0]?.length ?? 0;
    if (vectors.some((embedding) => embedding.length !== dimensions)) {
      console.error("Embedding provider returned mixed dimensions");
      return 0;
    }

    await repo.insertEmbeddings(
      vectors.map((embedding, index) => ({
        chunkId: missingRows[index].id,
        provider: provider.provider,
        model: embeddingStorageModel(provider),
        dimensions,
        embedding: JSON.stringify(embedding)
      }))
    );

    return vectors.length;
  } catch (error) {
    console.error(`Embedding failed (skipping): ${error instanceof Error ? error.message : String(error)}`);
    return 0;
  }
}

async function parseInline(
  tasks: ParseTask[],
  onProgress?: (done: number, total: number) => void
): Promise<Map<string, ParseResult>> {
  const results = new Map<string, ParseResult>();
  for (const [i, task] of tasks.entries()) {
    const indexed = await chunkDocument({
      relativePath: task.relativePath,
      absolutePath: task.absolutePath,
      content: task.content,
      targetTokens: task.targetTokens,
      overlapTokens: task.overlapTokens
    });
    indexed.chunks = boundChunks(indexed.chunks, task.targetTokens, task.overlapTokens);
    results.set(task.id, indexed);
    onProgress?.(i + 1, tasks.length);
  }
  return results;
}

function resolveWorkerPath(): string {
  const baseDir = path.dirname(fsSync.realpathSync(process.argv[1] || __filename));
  const candidates = [
    path.join(baseDir, "..", "..", "..", "packages", "indexer", "src", "parse-worker.cjs"),
    path.join(baseDir, "parse-worker.cjs"),
  ];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (fsSync.existsSync(resolved)) return resolved;
  }
  throw new Error("parse-worker not found — run build first");
}

// Persistent worker pool — reused across batches to avoid worker spawn cost
class WorkerPool {
  private workers: Worker[] = [];
  private busy: boolean[] = [];
  private taskIndex = 0;
  private done = 0;
  private total = 0;
  private onProgress?: (done: number, total: number) => void;

  constructor(workerPath: string, workerCount: number) {
    for (let i = 0; i < workerCount; i++) {
      this.workers.push(new Worker(workerPath));
      this.busy.push(false);
    }
  }

  async parseBatch(
    tasks: ParseTask[],
    onProgress?: (done: number, total: number) => void
  ): Promise<Map<string, ParseResult>> {
    const results = new Map<string, ParseResult>();
    this.taskIndex = 0;
    this.done = 0;
    this.total = tasks.length;
    this.onProgress = onProgress;

    const feedWorker = async (worker: Worker) => {
      while (this.taskIndex < tasks.length) {
        const myIndex = this.taskIndex++;
        const task = tasks[myIndex];
        const result = await new Promise<{ id: string; result: ParseResult }>((resolve, reject) => {
          const onMessage = (msg: { id: string; result: ParseResult }) => {
            worker.off("message", onMessage);
            worker.off("error", onError);
            resolve(msg);
          };
          const onError = (err: Error) => {
            worker.off("message", onMessage);
            worker.off("error", onError);
            reject(err);
          };
          worker.on("message", onMessage);
          worker.on("error", onError);
          worker.postMessage(task);
        });
        results.set(result.id, result.result);
        this.done++;
        this.onProgress?.(this.done, this.total);
      }
    };

    await Promise.all(this.workers.map((w) => feedWorker(w)));
    return results;
  }

  terminate(): void {
    for (const w of this.workers) w.terminate();
    this.workers = [];
  }
}

async function parseWithWorkers(
  tasks: ParseTask[],
  onProgress?: (done: number, total: number) => void
): Promise<Map<string, ParseResult>> {
  const results = new Map<string, ParseResult>();
  const workerPath = resolveWorkerPath();
  const cpuCount = os.availableParallelism?.() ?? os.cpus().length;
  const workerCount = Math.min(cpuCount - 1, 4, tasks.length);
  let done = 0;

  const workers: Worker[] = [];
  for (let i = 0; i < workerCount; i++) {
    workers.push(new Worker(workerPath));
  }

  let taskIndex = 0;
  async function feedWorker(worker: Worker): Promise<void> {
    while (taskIndex < tasks.length) {
      const myIndex = taskIndex++;
      const task = tasks[myIndex];
      const result = await new Promise<{ id: string; result: ParseResult }>((resolve, reject) => {
        const onMessage = (msg: { id: string; result: ParseResult }) => {
          worker.off("message", onMessage);
          worker.off("error", onError);
          resolve(msg);
        };
        const onError = (err: Error) => {
          worker.off("message", onMessage);
          worker.off("error", onError);
          reject(err);
        };
        worker.on("message", onMessage);
        worker.on("error", onError);
        worker.postMessage(task);
      });
      results.set(result.id, result.result);
      done++;
      onProgress?.(done, tasks.length);
    }
  }

  try {
    await Promise.all(workers.map((w) => feedWorker(w)));
  } finally {
    for (const w of workers) w.terminate();
  }
  return results;
}

export async function indexWorkspace(input: {
  workspaceId?: string;
  rootPath?: string;
  mode?: "incremental" | "full";
  onProgress?: (progress: { message: string; progress: number }) => Promise<void> | void;
}): Promise<IndexWorkspaceSummary> {
  const registry = createRegistryRepository();
  let workspace: RegistryWorkspace;

  if (input.workspaceId) {
    const w = await registry.getWorkspace(input.workspaceId);
    if (!w) throw new Error(`Workspace '${input.workspaceId}' not found`);
    workspace = w;
  } else if (input.rootPath) {
    workspace = await registry.ensureWorkspace({
      rootPath: path.resolve(input.rootPath)
    });
  } else {
    throw new Error("Either workspaceId or rootPath is required");
  }

  await writeLocalWorkspaceConfig(workspace);

  const settings = await getBrainSettings();
  const config = await loadBrainConfig(workspace.rootPath);
  const configuredWorkspace = config.workspaces?.find(
    (candidate) => candidate.id === workspace.id || path.resolve(candidate.root) === path.resolve(workspace.rootPath)
  );
  const includeGlobs = workspace.includeGlobs || configuredWorkspace?.include.join("\n") || "";
  const excludeGlobs = workspace.excludeGlobs || configuredWorkspace?.exclude.join("\n") || "";
  const embeddingProvider = getEmbeddingProvider();
  const runMode = input.mode ?? "incremental";

  const reportProgress = async (message: string, progress: number) => {
    await input.onProgress?.({ message, progress });
  };

  const repo = createWorkspaceRepository(workspace.rootPath);

  const runId = await repo.createIndexRun({ mode: runMode });

  await reportProgress("Scanning workspace files...", 5);

  // Fast path: stat files from DB first. If all match, skip directory walk.
  const existingDocuments = await repo.listDocuments();

  let files: FileToIndex[];

  if (existingDocuments.length > 0 && !includeGlobs) {
    // Fast path: stat DB files in parallel, skip directory walk if all match
    const STAT_CONCURRENCY = 64;
    const cachedResults: Array<{ doc: typeof existingDocuments[0]; file: FileToIndex } | null> = new Array(existingDocuments.length);
    let allMatch = true;
    let statIdx = 0;
    async function cachedStatWorker() {
      while (statIdx < existingDocuments.length) {
        const i = statIdx++;
        const doc = existingDocuments[i];
        const absPath = path.join(workspace.rootPath, doc.path);
        try {
          const stat = await fs.stat(absPath);
          if (stat.size === doc.sizeBytes && Math.trunc(stat.mtimeMs) === doc.mtimeMs) {
            cachedResults[i] = {
              doc,
              file: { absolutePath: absPath, relativePath: doc.path, sizeBytes: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) }
            };
          } else {
            allMatch = false;
            return;
          }
        } catch {
          allMatch = false;
          return;
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(STAT_CONCURRENCY, existingDocuments.length) }, () => cachedStatWorker())
    );

    if (allMatch) {
      files = cachedResults.map((r) => r!.file);
    } else {
      files = await scanWorkspaceFiles({
        rootPath: workspace.rootPath,
        include: includeGlobs,
        exclude: excludeGlobs
      });
    }
  } else {
    // No existing documents or custom include — full scan
    files = await scanWorkspaceFiles({
      rootPath: workspace.rootPath,
      include: includeGlobs,
      exclude: excludeGlobs
    });
  }

  const existingDocumentsByPath = new Map(existingDocuments.map((document) => [document.path, document]));

  // Delete documents for files that no longer exist on disk
  const scannedPaths = new Set(files.map((file) => file.relativePath));
  for (const document of existingDocuments) {
    if (!scannedPaths.has(document.path)) {
      await resetDocumentArtifacts(repo, document.id);
      await repo.deleteDocument(document.id);
    }
  }

  const workspaceFileResolver = createWorkspaceFileResolver(
    workspace.rootPath,
    files.map((file) => ({
      relativePath: file.relativePath,
      absolutePath: file.absolutePath
    }))
  );

  let filesUpdated = 0;
  let chunksWritten = 0;
  let embeddingsWritten = 0;
  let bulkWriteMode = false;
  const symbolNodeIdsByFileAndName = new Map<string, string>();

  try {
    await reportProgress(
      files.length === 0 ? "No files matched the workspace filters" : `Queued ${files.length} file(s) for indexing`,
      files.length === 0 ? 100 : 10
    );

    // ── Phase 1: Check which files changed (fast DB lookups, no file reads) ──
    const parseTasks: ParseTask[] = [];
    const unchangedFiles: Array<{
      file: typeof files[0];
      existingDocument: Awaited<ReturnType<typeof repo.listDocuments>>[number];
      existingChunks: Awaited<ReturnType<typeof repo.getChunksByDocument>>;
    }> = [];
    const filesToRead: typeof files = [];

    for (const file of files) {
      const existingDocument = existingDocumentsByPath.get(file.relativePath);
      // Fast path: skip file read if mtime and size match (incremental only)
      const statUnchanged =
        existingDocument &&
        existingDocument.mtimeMs === file.mtimeMs &&
        existingDocument.sizeBytes === file.sizeBytes;

      if (statUnchanged) {
        unchangedFiles.push({ file, existingDocument: existingDocument!, existingChunks: [] });
      } else {
        filesToRead.push(file);
      }
    }

    // ── Phase 2-4: Pipelined batched read + parse + write ──
    const BATCH_SIZE = 1000;
    const cpuCount = os.availableParallelism?.() ?? os.cpus().length;
    const allChunkRowsForEmbeddings: Array<{ id: string; content: string; path: string; heading?: string | null }> = [];

    // Backfill unchanged embeddings only when embeddings are enabled.
    if (embeddingProvider) {
      for (const { existingDocument } of unchangedFiles) {
        const existingChunks = await repo.getChunksByDocument(existingDocument.id);
        embeddingsWritten += await writeEmbeddingsToRepo(
          repo,
          existingChunks.map((chunk) => ({
            id: chunk.id,
            content: chunk.content,
            path: existingDocument.path,
            heading: chunk.heading
          })),
          embeddingProvider
        );
      }
    }

    if (filesToRead.length > 0) {
      repo.setOptimizedWriteMode(true);
      repo.dropFtsTriggers();
      bulkWriteMode = true;

      const workerPath = resolveWorkerPath();
      const workerCount = Math.min(
        cpuCount - 1,
        filesToRead.length,
        Math.ceil(filesToRead.length / 50)
      );
      const pool = new WorkerPool(workerPath, workerCount);

      async function readAndHashBatch(batchFiles: typeof files): Promise<ParseTask[]> {
        const fileContents = new Map<string, string>();
        const READ_CONCURRENCY = 32;
        let readIndex = 0;
        async function readWorker() {
          while (readIndex < batchFiles.length) {
            const i = readIndex++;
            fileContents.set(batchFiles[i].relativePath, await fs.readFile(batchFiles[i].absolutePath, "utf8"));
          }
        }
        await Promise.all(
          Array.from({ length: Math.min(READ_CONCURRENCY, batchFiles.length) }, () => readWorker())
        );

        const batchParseTasks: ParseTask[] = [];
        const isColdBatch = existingDocumentsByPath.size === 0;
        for (const file of batchFiles) {
          const content = fileContents.get(file.relativePath)!;
          const contentHash = isColdBatch ? `${file.mtimeMs}:${file.sizeBytes}` : hashContent(content);
          const existingDocument = existingDocumentsByPath.get(file.relativePath);
          const unchanged = existingDocument && existingDocument.contentHash === contentHash;

          if (unchanged) {
            await repo.updateDocument(existingDocument.id, {
              absolutePath: file.absolutePath,
              sizeBytes: file.sizeBytes,
              mtimeMs: file.mtimeMs
            });
            unchangedFiles.push({ file, existingDocument, existingChunks: [] });
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
              overlapTokens: settings.chunking.overlapTokens
            });
          }
        }
        return batchParseTasks;
      }

      async function writeBatch(
        batchParseTasks: ParseTask[],
        parseResults: Map<string, ParseResult>,
        batchStart: number
      ): Promise<void> {
        if (batchParseTasks.length === 0) return;

        // Separate new files from existing (cold path = all new)
        const newFiles: ParseTask[] = [];
        const existingFiles: ParseTask[] = [];
        for (const file of batchParseTasks) {
          if (existingDocumentsByPath.has(file.relativePath)) {
            existingFiles.push(file);
          } else {
            newFiles.push(file);
          }
        }

        await repo.transaction(async () => {
          repo.refreshStreamTimestamp();
          const docIdMap = new Map<string, string>();
          for (const file of newFiles) {
            const indexed = parseResults.get(file.id)!;
            const docId = crypto.randomUUID();
            repo.streamDocument({
              id: docId,
              path: file.relativePath,
              absolutePath: file.absolutePath,
              kind: indexed.kind,
              language: indexed.language,
              contentHash: file.contentHash,
              sizeBytes: file.sizeBytes,
              mtimeMs: file.mtimeMs
            });
            docIdMap.set(file.relativePath, docId);
          }

          // ── Handle existing files (update + reset artifacts) ──
          for (const file of existingFiles) {
            const indexed = parseResults.get(file.id)!;
            const existingDocument = existingDocumentsByPath.get(file.relativePath)!;
            const fileExistingSymbols = await resetChangedFileArtifacts(repo, existingDocument.id, file.relativePath);
            await repo.updateDocument(existingDocument.id, {
              absolutePath: file.absolutePath,
              kind: indexed.kind,
              language: indexed.language,
              contentHash: file.contentHash,
              sizeBytes: file.sizeBytes,
              mtimeMs: file.mtimeMs
            });
            docIdMap.set(file.relativePath, existingDocument.id);
            (file as ParseTask & { _existingSymbols?: Map<string, string> })._existingSymbols = fileExistingSymbols;
          }

          const fileNodeIds: string[] = new Array(batchParseTasks.length);
          for (const [fi, file] of batchParseTasks.entries()) {
            const indexed = parseResults.get(file.id)!;
            const nodeId = crypto.randomUUID();
            repo.streamGraphNode({
              id: nodeId,
              type: "file",
              label: file.relativePath,
              refId: docIdMap.get(file.relativePath)!,
              metadata: JSON.stringify({ path: file.relativePath, kind: indexed.kind, language: indexed.language })
            });
            fileNodeIds[fi] = nodeId;
          }

          const allChunkIds: string[] = [];
          for (const file of batchParseTasks) {
            const indexed = parseResults.get(file.id)!;
            const documentId = docIdMap.get(file.relativePath)!;
            const lang = indexed.language ?? "";
            for (const [ci, chunk] of indexed.chunks.entries()) {
              const chunkId = crypto.randomUUID();
              const metadataJson = JSON.stringify(chunk.metadata);
              repo.streamChunk({
                id: chunkId,
                documentId,
                chunkIndex: ci,
                heading: chunk.heading ?? null,
                content: chunk.content,
                tokenCount: chunk.tokenCount,
                contentHash: chunk.contentHash,
                metadata: metadataJson
              });
              allChunkIds.push(chunkId);
            }
          }

          const isColdIndex = existingFiles.length === 0 && batchStart === 0;
          let chunkIdx = 0;
          if (!isColdIndex) {
          const edgeSet = new Set<string>();
          function streamEdge(fromNodeId: string, toNodeId: string, type: string, metadata?: string) {
            const key = `${fromNodeId}:${toNodeId}:${type}`;
            if (edgeSet.has(key)) return;
            edgeSet.add(key);
            repo.streamEdge({ id: crypto.randomUUID(), fromNodeId, toNodeId, type, metadata });
          }
          for (const [fi, file] of batchParseTasks.entries()) {
            const indexed = parseResults.get(file.id)!;
            const fileNodeId = fileNodeIds[fi];
            const hasGraphData = indexed.definedSymbols.length > 0 || indexed.importPaths.length > 0 || indexed.wikilinks.length > 0;

            if (hasGraphData) {
              const fileExistingSymbols = (file as ParseTask & { _existingSymbols?: Map<string, string> })._existingSymbols ?? new Map<string, string>();
              const reusedSymbolIds = new Set<string>();

              for (const [ci] of indexed.chunks.entries()) {
                const chunkId = allChunkIds[chunkIdx + ci];
                const metadataObj = (indexed.chunks[ci].metadata ?? {}) as Record<string, unknown>;
                const symbolName = (metadataObj.symbolName as string | undefined) ?? indexed.chunks[ci].symbolName;
                if (symbolName) {
                  const fileSymbolKey = `${file.relativePath}\0${symbolName}`;
                  let symbolNodeId = symbolNodeIdsByFileAndName.get(fileSymbolKey);

                  if (!symbolNodeId) {
                    const existingSymbolId = fileExistingSymbols.get(symbolName);
                    if (existingSymbolId) {
                      repo.updateSymbolNode(existingSymbolId, chunkId, JSON.stringify({ symbolType: indexed.chunks[ci].symbolType, filePath: file.relativePath }));
                      symbolNodeId = existingSymbolId;
                    } else {
                      // Stream symbol node immediately — no pending placeholder
                      symbolNodeId = crypto.randomUUID();
                      repo.streamGraphNode({
                        id: symbolNodeId,
                        type: "symbol",
                        label: symbolName,
                        refId: chunkId,
                        metadata: JSON.stringify({ symbolType: indexed.chunks[ci].symbolType, filePath: file.relativePath })
                      });
                    }
                    symbolNodeIdsByFileAndName.set(fileSymbolKey, symbolNodeId);
                  }

                  reusedSymbolIds.add(symbolNodeId);
                  streamEdge(fileNodeId, symbolNodeId, "defines");
                }
              }

              // Stale symbol cleanup
              const staleSymbolIds: string[] = [];
              for (const symbolId of fileExistingSymbols.values()) {
                if (!reusedSymbolIds.has(symbolId)) staleSymbolIds.push(symbolId);
              }
              if (staleSymbolIds.length > 0) repo.deleteGraphNodesByIds(staleSymbolIds);

              // Imports — stream edges directly
              for (const importPath of indexed.importPaths) {
                if (typeof importPath !== "string" || importPath.length === 0) continue;
                const resolvedImportPath = workspaceFileResolver?.resolveImport(file.relativePath, importPath, indexed.language ?? undefined);
                if (!resolvedImportPath) continue;
                const targetNodeId = await repo.upsertGraphNode({ type: "file", label: resolvedImportPath, metadata: JSON.stringify({ path: resolvedImportPath }) });
                streamEdge(fileNodeId, targetNodeId, "imports", JSON.stringify({ importPath }));
              }

              // Wikilinks — stream edges directly
              for (const link of indexed.wikilinks) {
                const entityNodeId = await repo.upsertGraphNode({ type: "entity", label: link, metadata: "{}" });
                streamEdge(fileNodeId, entityNodeId, "mentions");
              }
            }

            chunkIdx += indexed.chunks.length;
          }
          }

          if (embeddingProvider) {
            chunkIdx = 0;
            for (const file of batchParseTasks) {
              const indexed = parseResults.get(file.id)!;
              allChunkRowsForEmbeddings.push(...indexed.chunks.map((_, i) => ({
                id: allChunkIds[chunkIdx + i],
                content: indexed.chunks[i].content,
                path: file.relativePath,
                heading: indexed.chunks[i].heading
              })));
              chunkIdx += indexed.chunks.length;
            }
          }


          // ── Stats ──
          for (const file of batchParseTasks) {
            chunksWritten += parseResults.get(file.id)!.chunks.length;
            filesUpdated += 1;
          }

          // Progress
          const overall = batchStart + batchParseTasks.length;
          const progress = Math.min(95, 50 + Math.round((overall / Math.max(filesToRead.length, 1)) * 45));
          await reportProgress(`Writing ${overall}/${filesToRead.length}...`, progress);
        });

        symbolNodeIdsByFileAndName.clear();
      }

      // Pipelined loop: parse batch N+1 while writing batch N
      let prevParsePromise: Promise<Map<string, ParseResult>> | null = null;
      let prevBatchTasks: ParseTask[] | null = null;
      let prevBatchStart = 0;

      for (let batchStart = 0; batchStart < filesToRead.length; batchStart += BATCH_SIZE) {
        const batchEnd = Math.min(batchStart + BATCH_SIZE, filesToRead.length);
        const batchFiles = filesToRead.slice(batchStart, batchEnd);

        // Read + hash current batch (overlaps with previous batch's parse)
        const currentTasks = await readAndHashBatch(batchFiles);

        // Wait for previous batch's parse to finish, then write it
        if (prevParsePromise !== null) {
          const prevResults = await prevParsePromise;
          await writeBatch(prevBatchTasks!, prevResults, prevBatchStart);
          prevResults.clear();
          prevBatchTasks = null;
        }

        // Start parsing current batch (will overlap with next batch's read)
        if (currentTasks.length > 0) {
          const batchProgress = (done: number, total: number) => {
            const overall = batchStart + Math.round((done / total) * (batchEnd - batchStart));
            reportProgress(`Parsing ${overall}/${filesToRead.length} files...`, Math.min(50, 10 + Math.round((overall / Math.max(filesToRead.length, 1)) * 40)));
          };
          // Use workers for all batches >= 50 files (parallel parsing)
          if (currentTasks.length >= 50 && cpuCount >= 2) {
            prevParsePromise = pool.parseBatch(currentTasks, batchProgress);
          } else {
            prevParsePromise = parseInline(currentTasks, batchProgress);
          }
          prevBatchTasks = currentTasks;
          prevBatchStart = batchStart;
        }
      }

      // Write the last batch
      if (prevParsePromise !== null) {
        const prevResults = await prevParsePromise;
        await writeBatch(prevBatchTasks!, prevResults, prevBatchStart);
        prevResults.clear();
      }

      pool.terminate();
    }

    // Write embeddings outside the DB transaction so remote HTTP requests don't hold the WAL lock
    if (allChunkRowsForEmbeddings.length > 0) {
      embeddingsWritten += await writeEmbeddingsToRepo(repo, allChunkRowsForEmbeddings, embeddingProvider);
    }

    if (bulkWriteMode) {
      repo.restoreFtsTriggers();
      repo.setOptimizedWriteMode(false);
      bulkWriteMode = false;
    }

    // ── Phase 6: Call-edge resolution skipped during index — resolve lazily on first query ──

    repo.setOptimizedWriteMode(false);

    await reportProgress("Finalizing index run...", 98);
    await repo.completeIndexRun(runId, {
      status: "completed",
      filesScanned: files.length,
      filesUpdated,
      chunksWritten,
      embeddingsWritten
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
      lastError: ""
    });
  } catch (error) {
    if (bulkWriteMode) {
      try { repo.restoreFtsTriggers(); } catch { /* preserve original indexing error */ }
      repo.setOptimizedWriteMode(false);
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    await repo.completeIndexRun(runId, {
      status: "failed",
      filesScanned: files.length,
      filesUpdated,
      chunksWritten,
      embeddingsWritten,
      errorMessage
    });

    await registry.updateWorkspace(workspace.id, {
      status: "error",
      indexingStatus: "failed",
      lastError: errorMessage
    });
    throw error;
  }

  await reportProgress("Index complete", 100);

  return {
    workspaceId: workspace.id,
    filesScanned: files.length,
    filesUpdated,
    chunksWritten,
    embeddingsWritten
  };
}
