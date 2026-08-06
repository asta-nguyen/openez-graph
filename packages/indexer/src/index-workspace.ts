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
import { inferDocumentKind } from "./languages";
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

  for (let i = 0; i < toEmbed.length; i += BATCH_SIZE) {
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
  for (const [i, task] of tasks.entries()) {
    const indexed = await chunkDocument({
      relativePath: task.relativePath,
      absolutePath: task.absolutePath,
      content: task.content,
      targetTokens: task.targetTokens,
      overlapTokens: task.overlapTokens,
    });
    indexed.chunks = boundChunks(indexed.chunks, task.targetTokens, task.overlapTokens);
    results.set(task.id, indexed);
    onProgress?.(i + 1, tasks.length);
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
    if (parseTasks.length > 0) {
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

    // Write parsed files to DB — ALL files in ONE transaction
    await repo.transaction(async () => {
      for (const [idx, file] of parseTasks.entries()) {
        if (idx % 100 === 0) {
          const progress = Math.min(
            95,
            50 + Math.round((idx / Math.max(parseTasks.length, 1)) * 45),
          );
          await reportProgress(`Writing ${idx}/${parseTasks.length}...`, progress);
        }

        const indexed = parseResults.get(file.id)!;
        const contentHash = hashContent(file.content);
        const existingDocument = existingDocumentsByPath.get(file.relativePath);

        let documentId: string;
        let fileExistingSymbols: Map<string, string>;

        if (existingDocument) {
          fileExistingSymbols = await resetChangedFileArtifacts(
            repo,
            existingDocument.id,
            file.relativePath,
          );
          await repo.updateDocument(existingDocument.id, {
            absolutePath: file.absolutePath,
            kind: indexed.kind,
            language: indexed.language,
            contentHash,
            sizeBytes: file.sizeBytes,
            mtimeMs: file.mtimeMs,
          });
          documentId = existingDocument.id;
        } else {
          documentId = await repo.insertDocument({
            path: file.relativePath,
            absolutePath: file.absolutePath,
            kind: indexed.kind,
            language: indexed.language,
            contentHash,
            sizeBytes: file.sizeBytes,
            mtimeMs: file.mtimeMs,
          });
          fileExistingSymbols = new Map();
        }

        const fileNodeId = await repo.upsertGraphNode({
          type: "file",
          label: file.relativePath,
          refId: documentId,
          metadata: JSON.stringify({
            path: file.relativePath,
            kind: indexed.kind,
            language: indexed.language,
          }),
        });

        const chunkIds = await repo.insertChunks(
          indexed.chunks.map((chunk, chunkIndex) => ({
            documentId,
            chunkIndex,
            heading: chunk.heading,
            content: chunk.content,
            tokenCount: chunk.tokenCount,
            contentHash: chunk.contentHash,
            metadata: JSON.stringify(chunk.metadata),
          })),
        );

        const chunkNodeInputs = chunkIds.map((chunkId, ci) => ({
          type: "chunk",
          label: `${file.relativePath}#${ci}`,
          refId: chunkId,
          metadata: JSON.stringify(indexed.chunks[ci].metadata),
        }));
        const chunkNodeIds = await repo.insertGraphNodesBatch(chunkNodeInputs);

        const edges: Array<{
          fromNodeId: string;
          toNodeId: string;
          type: string;
          metadata?: string;
        }> = [];
        const reusedSymbolIds = new Set<string>();

        for (const [ci, chunkId] of chunkIds.entries()) {
          const chunkNodeId = chunkNodeIds[ci];
          edges.push({ fromNodeId: fileNodeId, toNodeId: chunkNodeId, type: "contains" });

          const metadataObj = (indexed.chunks[ci].metadata ?? {}) as Record<string, unknown>;
          const symbolName =
            (metadataObj.symbolName as string | undefined) ?? indexed.chunks[ci].symbolName;
          if (symbolName) {
            const fileSymbolKey = `${file.relativePath}\0${symbolName}`;
            let symbolNodeId = symbolNodeIdsByFileAndName.get(fileSymbolKey);

            if (!symbolNodeId) {
              const existingSymbolId = fileExistingSymbols.get(symbolName);
              if (existingSymbolId) {
                repo.updateSymbolNode(
                  existingSymbolId,
                  chunkId,
                  JSON.stringify({
                    symbolType: indexed.chunks[ci].symbolType,
                    filePath: file.relativePath,
                    language: indexed.language,
                    parser: indexed.parser,
                  }),
                );
                symbolNodeId = existingSymbolId;
              } else {
                symbolNodeId = await repo.upsertGraphNode({
                  type: "symbol",
                  label: symbolName,
                  refId: chunkId,
                  metadata: JSON.stringify({
                    symbolType: indexed.chunks[ci].symbolType,
                    filePath: file.relativePath,
                    language: indexed.language,
                    parser: indexed.parser,
                  }),
                });
              }
              symbolNodeIdsByFileAndName.set(fileSymbolKey, symbolNodeId);
            }

            reusedSymbolIds.add(symbolNodeId);
            edges.push({ fromNodeId: fileNodeId, toNodeId: symbolNodeId, type: "defines" });
            edges.push({ fromNodeId: symbolNodeId, toNodeId: chunkNodeId, type: "represented_by" });
          }
        }

        // Delete stale symbol nodes (existed before but not seen in this parse)
        const staleSymbolIds: string[] = [];
        for (const symbolId of fileExistingSymbols.values()) {
          if (!reusedSymbolIds.has(symbolId)) {
            staleSymbolIds.push(symbolId);
          }
        }
        if (staleSymbolIds.length > 0) {
          repo.deleteGraphNodesByIds(staleSymbolIds);
        }

        for (const importPath of indexed.importPaths) {
          if (typeof importPath !== "string" || importPath.length === 0) continue;

          const resolvedImportPath = workspaceFileResolver?.resolveImport(
            file.relativePath,
            importPath,
            indexed.language ?? undefined,
          );
          if (!resolvedImportPath) continue;
          const targetNodeId = await repo.upsertGraphNode({
            type: "file",
            label: resolvedImportPath,
            metadata: JSON.stringify({ path: resolvedImportPath }),
          });

          edges.push({
            fromNodeId: fileNodeId,
            toNodeId: targetNodeId,
            type: "imports",
            metadata: JSON.stringify({ importPath }),
          });
        }

        for (const link of indexed.wikilinks) {
          const entityNodeId = await repo.upsertGraphNode({
            type: "entity",
            label: link,
            metadata: "{}",
          });

          edges.push({ fromNodeId: fileNodeId, toNodeId: entityNodeId, type: "mentions" });
        }

        // Dedupe edges by from:to:type before insert
        const edgeSet = new Set<string>();
        const dedupedEdges = edges.filter((e) => {
          const key = `${e.fromNodeId}:${e.toNodeId}:${e.type}`;
          if (edgeSet.has(key)) return false;
          edgeSet.add(key);
          return true;
        });
        await repo.insertEdges(dedupedEdges);

        pendingCallEdges.push(
          ...indexed.callExpressions.map((call) => ({
            ...call,
            filePath: file.relativePath,
            parser: indexed.parser,
          })),
        );

        const chunkRows = chunkIds.map((id, i) => ({
          id,
          content: indexed.chunks[i].content,
          path: file.relativePath,
          heading: indexed.chunks[i].heading,
        }));
        allChunkRowsForEmbeddings.push(...chunkRows);
        chunksWritten += chunkIds.length;
        filesUpdated += 1;
      }
    });

    // Write embeddings outside the DB transaction so remote HTTP requests don't hold the WAL lock
    if (allChunkRowsForEmbeddings.length > 0) {
      const embeddingResult = await writeEmbeddingsToRepo(
        repo,
        allChunkRowsForEmbeddings,
        embeddingProvider,
      );
      embeddingsWritten += embeddingResult.written;
      embeddingFailures += embeddingResult.failedBatches;
    }

    // ── Phase 5: Restore FTS triggers + bulk backfill ──
    if (bulkWriteMode) {
      repo.restoreFtsTriggers();
      repo.setOptimizedWriteMode(false);
      bulkWriteMode = false;
    }

    // ── Phase 6: Batch call-edge resolution from in-memory symbol map ──
    // Load all symbol nodes in one query instead of N queries per call expression.
    const globalSymbolNodes = await repo.loadAllSymbolNodes();
    const insertedCallEdges = new Set<string>();
    const callEdges: Array<{
      fromNodeId: string;
      toNodeId: string;
      type: string;
      weight: number;
      metadata: string;
    }> = [];
    for (const callExpression of pendingCallEdges) {
      const callerNodeId = symbolNodeIdsByFileAndName.get(
        `${callExpression.filePath}\0${callExpression.callerName}`,
      );
      const sameFileCallee = symbolNodeIdsByFileAndName.get(
        `${callExpression.filePath}\0${callExpression.calleeName}`,
      );
      const calleeNodeId = sameFileCallee ?? globalSymbolNodes.get(callExpression.calleeName);
      if (!callerNodeId || !calleeNodeId || callerNodeId === calleeNodeId) continue;

      const edgeKey = `${callerNodeId}:${calleeNodeId}:calls`;
      if (insertedCallEdges.has(edgeKey)) continue;
      insertedCallEdges.add(edgeKey);

      // Confidence by parser: ts-morph has type info → medium;
      // tree-sitter and regex are syntax-only → low.
      const confidence = callExpression.parser === "ts-morph" ? "medium" : "low";

      callEdges.push({
        fromNodeId: callerNodeId,
        toNodeId: calleeNodeId,
        type: "calls",
        weight: 0.35,
        metadata: JSON.stringify({
          heuristic: true,
          callee: callExpression.calleeName,
          parser: callExpression.parser,
          confidence,
        }),
      });
    }
    await repo.transaction(async () => {
      await repo.insertEdges(callEdges);
    });

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
  } catch (error) {
    if (bulkWriteMode) {
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

  return {
    workspaceId: workspace.id,
    filesScanned: files.length,
    filesUpdated,
    chunksWritten,
    embeddingsWritten,
    embeddingFailures,
  };
}
