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
  splitToTokenLimit
} from "@openez-graph/core";
import type { EmbeddingProvider } from "@openez-graph/core";
import {
  createRegistryRepository,
  createWorkspaceRepository,
  writeLocalWorkspaceConfig
} from "@openez-graph/db";
import type { RegistryWorkspace, WorkspaceRepository } from "@openez-graph/db";

import { indexCode } from "./code";
import { hashContent } from "./hash";
import { indexMarkdown } from "./markdown";
import { parseGo, parsePython, parseRust, indexConfig, inferDocumentKind } from "./languages";
import { scanWorkspaceFiles } from "./scanner";
import type { IndexedChunk, IndexWorkspaceSummary } from "./types";

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

export async function chunkDocument(input: {
  relativePath: string;
  absolutePath: string;
  content: string;
  targetTokens: number;
  overlapTokens: number;
}) {
  const info = inferDocumentKind(input.relativePath);

  if (info.kind === "markdown") {
    const result = indexMarkdown({
      content: input.content,
      targetTokens: input.targetTokens,
      overlapTokens: input.overlapTokens
    });

    return {
      kind: info.kind,
      language: info.language,
      chunks: result.chunks,
      importPaths: [] as string[],
      wikilinks: result.wikilinks,
      definedSymbols: [] as Array<{ name: string; type: string; exported: boolean }>,
      calledIdentifiers: [] as string[],
      callExpressions: [] as Array<{ callerName: string; calleeName: string }>
    };
  }

  if (info.kind === "config") {
    const configChunks = indexConfig(input.content, info.language ?? "");
    return {
      kind: info.kind,
      language: info.language,
      chunks: configChunks,
      importPaths: [] as string[],
      wikilinks: [] as string[],
      definedSymbols: [] as Array<{ name: string; type: string; exported: boolean }>,
      calledIdentifiers: [] as string[],
      callExpressions: [] as Array<{ callerName: string; calleeName: string }>
    };
  }

  if (info.kind === "code") {
    if (info.language === "typescript" || info.language === "tsx" || info.language === "javascript" || info.language === "jsx") {
      const result = indexCode(input.content, input.absolutePath);
      return {
        kind: info.kind,
        language: info.language,
        chunks: result.chunks,
        importPaths: result.importPaths,
        wikilinks: [] as string[],
        definedSymbols: result.definedSymbols,
        calledIdentifiers: result.calledIdentifiers,
        callExpressions: result.callExpressions
      };
    }

    if (info.language === "python") {
      const result = parsePython(input.content);
      return {
        kind: info.kind,
        language: info.language,
        chunks: result.chunks,
        importPaths: result.importPaths,
        wikilinks: [] as string[],
        definedSymbols: result.definedSymbols,
        calledIdentifiers: result.calledIdentifiers,
        callExpressions: result.callExpressions
      };
    }

    if (info.language === "go") {
      const result = parseGo(input.content);
      return {
        kind: info.kind,
        language: info.language,
        chunks: result.chunks,
        importPaths: result.importPaths,
        wikilinks: [] as string[],
        definedSymbols: result.definedSymbols,
        calledIdentifiers: result.calledIdentifiers,
        callExpressions: result.callExpressions
      };
    }

    if (info.language === "rust") {
      const result = parseRust(input.content);
      return {
        kind: info.kind,
        language: info.language,
        chunks: result.chunks,
        importPaths: result.importPaths,
        wikilinks: [] as string[],
        definedSymbols: result.definedSymbols,
        calledIdentifiers: result.calledIdentifiers,
        callExpressions: result.callExpressions
      };
    }

    const fallbackChunk: IndexedChunk = {
      content: input.content,
      tokenCount: Math.ceil(input.content.length / 4),
      contentHash: hashContent(input.content),
      metadata: {
        kind: "code",
        language: info.language,
        startLine: 1,
        endLine: input.content.split("\n").length
      }
    };
    return {
      kind: info.kind,
      language: info.language,
      chunks: [fallbackChunk],
      importPaths: [] as string[],
      wikilinks: [] as string[],
      definedSymbols: [] as Array<{ name: string; type: string; exported: boolean }>,
      calledIdentifiers: [] as string[],
      callExpressions: [] as Array<{ callerName: string; calleeName: string }>
    };
  }

  const fallbackChunk: IndexedChunk = {
    content: input.content,
    tokenCount: Math.ceil(input.content.length / 4),
    contentHash: hashContent(input.content),
    metadata: {
      kind: info.kind,
      startLine: 1,
      endLine: input.content.split("\n").length
    }
  };

  return {
    kind: info.kind,
    language: info.language,
    chunks: [fallbackChunk],
    importPaths: [] as string[],
    wikilinks: [] as string[],
    definedSymbols: [] as Array<{ name: string; type: string; exported: boolean }>,
    calledIdentifiers: [] as string[],
    callExpressions: [] as Array<{ callerName: string; calleeName: string }>
  };
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

  const repo = createWorkspaceRepository(workspace.rootPath);
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

  if (runMode === "full") {
    await repo.resetAll();
  }

  const runId = await repo.createIndexRun({ mode: runMode });

  await reportProgress("Scanning workspace files...", 5);

  const files = await scanWorkspaceFiles({
    rootPath: workspace.rootPath,
    include: includeGlobs,
    exclude: excludeGlobs
  });

  if (runMode === "incremental") {
    const scannedPaths = new Set(files.map((file) => file.relativePath));
    for (const document of await repo.listDocuments()) {
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
      absolutePath: file.absolutePath
    }))
  );

  let filesUpdated = 0;
  let chunksWritten = 0;
  let embeddingsWritten = 0;
  const symbolNodeIdsByFileAndName = new Map<string, string>();
  const pendingCallEdges: Array<{ callerName: string; calleeName: string; filePath: string }> = [];

  try {
    await reportProgress(
      files.length === 0 ? "No files matched the workspace filters" : `Queued ${files.length} file(s) for indexing`,
      files.length === 0 ? 100 : 10
    );

    // ── Phase 1: Read all files in parallel (concurrency-limited) ──
    const fileContents = new Map<string, string>();
    const READ_CONCURRENCY = 32;
    let readIndex = 0;
    async function readWorker() {
      while (readIndex < files.length) {
        const i = readIndex++;
        fileContents.set(files[i].relativePath, await fs.readFile(files[i].absolutePath, "utf8"));
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(READ_CONCURRENCY, files.length) }, () => readWorker())
    );

    // ── Phase 2: Check which files changed (main thread, fast DB lookups) ──
    const parseTasks: ParseTask[] = [];
    const unchangedFiles: Array<{
      file: typeof files[0];
      existingDocument: NonNullable<Awaited<ReturnType<typeof repo.getDocumentByPath>>>;
      existingChunks: Awaited<ReturnType<typeof repo.getChunksByDocument>>;
    }> = [];

    for (const file of files) {
      const content = fileContents.get(file.relativePath)!;
      const contentHash = hashContent(content);
      const existingDocument = await repo.getDocumentByPath(file.relativePath);
      const existingChunks = existingDocument ? await repo.getChunksByDocument(existingDocument.id) : [];
      const unchanged =
        runMode === "incremental" &&
        existingDocument &&
        existingDocument.contentHash === contentHash &&
        existingDocument.mtimeMs === file.mtimeMs;

      if (unchanged) {
        unchangedFiles.push({ file, existingDocument: existingDocument!, existingChunks });
      } else {
        parseTasks.push({
          id: file.relativePath,
          content,
          relativePath: file.relativePath,
          absolutePath: file.absolutePath,
          sizeBytes: file.sizeBytes,
          mtimeMs: file.mtimeMs,
          targetTokens: settings.chunking.targetTokens,
          overlapTokens: settings.chunking.overlapTokens
        });
      }
    }

    // ── Phase 3: Parse changed files ──
    const parseResults = await parseInline(parseTasks, (done, total) => {
      reportProgress(`Parsing ${done}/${total} files...`, Math.min(50, 10 + Math.round((done / Math.max(total, 1)) * 40)));
    });

    // ── Phase 4: Write all results to DB (main thread, transactioned) ──
    repo.setOptimizedWriteMode(true);
    repo.dropFtsTriggers();

    // Write unchanged file embeddings
    for (const { file, existingDocument, existingChunks } of unchangedFiles) {
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

    const allChunkRowsForEmbeddings: Array<{ id: string; content: string; path: string; heading?: string | null }> = [];

    // Write parsed files to DB — ALL files in ONE transaction
    await repo.transaction(async () => {
      for (const [idx, file] of parseTasks.entries()) {
        if (idx % 100 === 0) {
          const progress = Math.min(95, 50 + Math.round((idx / Math.max(parseTasks.length, 1)) * 45));
          await reportProgress(`Writing ${idx}/${parseTasks.length}...`, progress);
        }

        const indexed = parseResults.get(file.id)!;
        const contentHash = hashContent(file.content);
        const existingDocument = await repo.getDocumentByPath(file.relativePath);

        let documentId: string;

        if (existingDocument) {
          await resetDocumentArtifacts(repo, existingDocument.id);
          await repo.updateDocument(existingDocument.id, {
            absolutePath: file.absolutePath,
            kind: indexed.kind,
            language: indexed.language,
            contentHash,
            sizeBytes: file.sizeBytes,
            mtimeMs: file.mtimeMs
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
            mtimeMs: file.mtimeMs
          });
        }

        const fileNodeId = await repo.upsertGraphNode({
          type: "file",
          label: file.relativePath,
          refId: documentId,
          metadata: JSON.stringify({
            path: file.relativePath,
            kind: indexed.kind,
            language: indexed.language
          })
        });

        const chunkIds = await repo.insertChunks(
          indexed.chunks.map((chunk, chunkIndex) => ({
            documentId,
            chunkIndex,
            heading: chunk.heading,
            content: chunk.content,
            tokenCount: chunk.tokenCount,
            contentHash: chunk.contentHash,
            metadata: JSON.stringify(chunk.metadata)
          }))
        );

        const chunkNodeInputs = chunkIds.map((chunkId, ci) => ({
          type: "chunk",
          label: `${file.relativePath}#${ci}`,
          refId: chunkId,
          metadata: JSON.stringify(indexed.chunks[ci].metadata)
        }));
        const chunkNodeIds = await repo.insertGraphNodesBatch(chunkNodeInputs);

        const edges: Array<{ fromNodeId: string; toNodeId: string; type: string; metadata?: string }> = [];

        for (const [ci, chunkId] of chunkIds.entries()) {
          const chunkNodeId = chunkNodeIds[ci];
          edges.push({ fromNodeId: fileNodeId, toNodeId: chunkNodeId, type: "contains" });

          const metadataObj = (indexed.chunks[ci].metadata ?? {}) as Record<string, unknown>;
          const symbolName = (metadataObj.symbolName as string | undefined) ?? indexed.chunks[ci].symbolName;
          if (symbolName) {
            const fileSymbolKey = `${file.relativePath}\0${symbolName}`;
            const symbolNodeId = symbolNodeIdsByFileAndName.get(fileSymbolKey) ?? await repo.upsertGraphNode({
              type: "symbol",
              label: symbolName,
              refId: chunkId,
              metadata: JSON.stringify({
                symbolType: indexed.chunks[ci].symbolType,
                filePath: file.relativePath
              })
            });

            edges.push({ fromNodeId: fileNodeId, toNodeId: symbolNodeId, type: "defines" });
            edges.push({ fromNodeId: symbolNodeId, toNodeId: chunkNodeId, type: "represented_by" });

            symbolNodeIdsByFileAndName.set(fileSymbolKey, symbolNodeId);
          }
        }

        for (const importPath of indexed.importPaths) {
          if (typeof importPath !== "string" || importPath.length === 0) continue;

          const resolvedImportPath = workspaceFileResolver?.resolveImport(file.relativePath, importPath, indexed.language ?? undefined);
          if (!resolvedImportPath) continue;

          const targetNodeId = await repo.upsertGraphNode({
            type: "file",
            label: resolvedImportPath,
            metadata: JSON.stringify({ path: resolvedImportPath })
          });

          edges.push({ fromNodeId: fileNodeId, toNodeId: targetNodeId, type: "imports", metadata: JSON.stringify({ importPath }) });
        }

        for (const link of indexed.wikilinks) {
          const entityNodeId = await repo.upsertGraphNode({
            type: "entity",
            label: link,
            metadata: "{}"
          });

          edges.push({ fromNodeId: fileNodeId, toNodeId: entityNodeId, type: "mentions" });
        }

        await repo.insertEdges(edges);

        pendingCallEdges.push(...indexed.callExpressions.map((call) => ({ ...call, filePath: file.relativePath })));

        const chunkRows = chunkIds.map((id, i) => ({
          id,
          content: indexed.chunks[i].content,
          path: file.relativePath,
          heading: indexed.chunks[i].heading
        }));
        allChunkRowsForEmbeddings.push(...chunkRows);
        chunksWritten += chunkIds.length;
        filesUpdated += 1;
      }
    });

    // Write embeddings outside the DB transaction so remote HTTP requests don't hold the WAL lock
    if (allChunkRowsForEmbeddings.length > 0) {
      embeddingsWritten += await writeEmbeddingsToRepo(repo, allChunkRowsForEmbeddings, embeddingProvider);
    }

    // ── Phase 5: Restore FTS triggers + bulk backfill ──
    repo.restoreFtsTriggers();
    repo.setOptimizedWriteMode(false);

    // ── Phase 6: Batch call-edge resolution from in-memory symbol map ──
    // Load all symbol nodes in one query instead of N queries per call expression.
    const globalSymbolNodes = await repo.loadAllSymbolNodes();
    const insertedCallEdges = new Set<string>();
    const callEdges: Array<{ fromNodeId: string; toNodeId: string; type: string; weight: number; metadata: string }> = [];
    for (const callExpression of pendingCallEdges) {
      const callerNodeId = symbolNodeIdsByFileAndName.get(`${callExpression.filePath}\0${callExpression.callerName}`);
      const sameFileCallee = symbolNodeIdsByFileAndName.get(`${callExpression.filePath}\0${callExpression.calleeName}`);
      const calleeNodeId = sameFileCallee ?? globalSymbolNodes.get(callExpression.calleeName);
      if (!callerNodeId || !calleeNodeId || callerNodeId === calleeNodeId) continue;

      const edgeKey = `${callerNodeId}:${calleeNodeId}:calls`;
      if (insertedCallEdges.has(edgeKey)) continue;
      insertedCallEdges.add(edgeKey);

      callEdges.push({
        fromNodeId: callerNodeId,
        toNodeId: calleeNodeId,
        type: "calls",
        weight: 0.35,
        metadata: JSON.stringify({ heuristic: true, callee: callExpression.calleeName })
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
    // Restore FTS triggers + normal pragma mode even on failure
    try { repo.restoreFtsTriggers(); } catch { /* already restored or never dropped */ }
    repo.setOptimizedWriteMode(false);

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
