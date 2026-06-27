import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { getBrainSettings } from "@openez-graph/config";
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

  const allNodeIds: string[] = [documentId, ...chunkIds];

  await repo.deleteEdgesByNodeIds(allNodeIds);
  await repo.deleteGraphNodesByRefId(documentId);
  await repo.deleteChunksByDocument(documentId);
}

// Synchronous version — better-sqlite3 is sync, so we skip Promise overhead.
// Used in the indexer hot path inside a transaction.
function resetDocumentArtifactsSync(repo: WorkspaceRepository, documentId: string) {
  const chunks = repo.getChunksByDocumentSync(documentId);
  const chunkIds = chunks.map((c) => c.id);

  const allNodeIds: string[] = [documentId, ...chunkIds];

  repo.deleteEdgesByNodeIdsSync(allNodeIds);
  repo.deleteGraphNodesByRefIdSync(documentId);
  repo.deleteChunksByDocumentSync(documentId);
}

async function chunkDocument(input: {
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

export async function indexWorkspace(input: {
  workspaceId?: string;
  rootPath?: string;
  mode?: "incremental" | "full";
  abortSignal?: AbortSignal;
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
  const runMode = input.mode ?? "incremental";

  const reportProgress = async (message: string, progress: number) => {
    await input.onProgress?.({ message, progress });
  };

  if (runMode === "full") {
    await repo.resetAll();
  }

  const runId = await repo.createIndexRun({ mode: runMode });
  const graphRunId = await repo.createGraphRun({ mode: runMode });

  await reportProgress("Scanning workspace files...", 5);

  const files = await scanWorkspaceFiles({
    rootPath: workspace.rootPath,
    include: workspace.includeGlobs || "",
    exclude: workspace.excludeGlobs || ""
  });

  const workspaceFileResolver = createWorkspaceFileResolver(
    workspace.rootPath,
    files.map((file) => ({
      relativePath: file.relativePath,
      absolutePath: file.absolutePath
    }))
  );

  let filesUpdated = 0;
  let chunksWritten = 0;
  const symbolNodeIdsByName = new Map<string, string>();
  const pendingCallEdges: Array<{ callerName: string; calleeName: string }> = [];

  try {
    await reportProgress(
      files.length === 0 ? "No files matched the workspace filters" : `Queued ${files.length} file(s) for indexing`,
      files.length === 0 ? 100 : 10
    );

    // ── Batch-read all files in parallel (15ms vs sequential ~200ms) ──
    const fileContents = await Promise.all(
      files.map((file) => fs.readFile(file.absolutePath, "utf8"))
    );

    // ── Pre-parse all files before the DB transaction ──
    // Parsing is CPU-bound (TypeScript compiler); DB writes are I/O-bound.
    // Separating them keeps the transaction short.
    const parsedFiles: Array<{
      file: typeof files[number];
      content: string;
      contentHash: string;
      indexed: Awaited<ReturnType<typeof chunkDocument>>;
      existingDocument: Awaited<ReturnType<typeof repo.getDocumentByPath>> | null;
    }> = [];
    for (const [index, file] of files.entries()) {
      if (input.abortSignal?.aborted) {
        throw new Error("Indexing cancelled");
      }
      const content = fileContents[index];
      const contentHash = hashContent(content);

      let existingDocument: Awaited<ReturnType<typeof repo.getDocumentByPath>> | null = null;
      if (runMode === "incremental") {
        existingDocument = await repo.getDocumentByPath(file.relativePath);
        if (
          existingDocument &&
          existingDocument.contentHash === contentHash &&
          existingDocument.mtimeMs === file.mtimeMs
        ) {
          continue;
        }
      }

      const indexed = await chunkDocument({
        relativePath: file.relativePath,
        absolutePath: file.absolutePath,
        content,
        targetTokens: settings.chunking.targetTokens,
        overlapTokens: settings.chunking.overlapTokens
      });

      parsedFiles.push({ file, content, contentHash, indexed, existingDocument });
    }

    // ── Wrap all DB writes in a single transaction for bulk speed ──
    // Use sync methods throughout — better-sqlite3 is synchronous, so
    // async/await just adds unnecessary Promise microtask overhead.
    await repo.transaction(async () => {
    for (const [index, { file, contentHash, indexed, existingDocument }] of parsedFiles.entries()) {
      if (input.abortSignal?.aborted) {
        throw new Error("Indexing cancelled");
      }
      const progress = Math.min(95, 10 + Math.round((index / Math.max(parsedFiles.length, 1)) * 85));
      if (index % 10 === 0 || index === parsedFiles.length - 1) {
        await reportProgress(`Indexing ${file.relativePath}`, progress);
      }

      let documentId: string;

      if (existingDocument) {
        resetDocumentArtifactsSync(repo, existingDocument.id);
        repo.updateDocumentSync(existingDocument.id, {
          absolutePath: file.absolutePath,
          kind: indexed.kind,
          language: indexed.language,
          contentHash,
          sizeBytes: file.sizeBytes,
          mtimeMs: file.mtimeMs
        });
        documentId = existingDocument.id;
      } else {
        documentId = repo.insertDocumentSync({
          path: file.relativePath,
          absolutePath: file.absolutePath,
          kind: indexed.kind,
          language: indexed.language,
          contentHash,
          sizeBytes: file.sizeBytes,
          mtimeMs: file.mtimeMs
        });
      }

      const fileNodeId = repo.upsertGraphNodeSync({
        type: "file",
        label: file.relativePath,
        refId: documentId,
        metadata: JSON.stringify({
          path: file.relativePath,
          kind: indexed.kind,
          language: indexed.language
        })
      });

      const chunkIds = repo.insertChunksSync(
        indexed.chunks.map((chunk, chunkIndex) => ({
          documentId,
          chunkIndex,
          heading: chunk.heading,
          content: chunk.content,
          tokenCount: chunk.tokenCount,
          contentHash: chunk.contentHash,
          metadata: JSON.stringify(chunk.metadata),
          path: file.relativePath
        }))
      );

      // ── Collect all nodes and edges for this file, then batch-insert ──
      const pendingEdges: Array<{
        fromNodeId: string;
        toNodeId: string;
        type: string;
        weight?: number;
        metadata?: string;
      }> = [];

      // Stage 1: chunk nodes
      const chunkNodeInputs = chunkIds.map((chunkId, ci) => ({
        type: "chunk",
        label: `${file.relativePath}#${ci}`,
        refId: chunkId,
        metadata: JSON.stringify(indexed.chunks[ci].metadata)
      }));
      const chunkNodeIds = repo.upsertGraphNodesSync(chunkNodeInputs);

      // Stage 2: symbol nodes (only for chunks that have a symbolName)
      const symbolNodeInputs: Array<{ type: string; label: string; refId?: string; metadata?: string }> = [];
      for (const [ci, chunkId] of chunkIds.entries()) {
        const symbolName = indexed.chunks[ci].symbolName;
        if (symbolName) {
          symbolNodeInputs.push({
            type: "symbol",
            label: symbolName,
            refId: chunkId,
            metadata: JSON.stringify({
              symbolType: indexed.chunks[ci].symbolType,
              filePath: file.relativePath
            })
          });
        }
      }
      const symbolNodeIds = repo.upsertGraphNodesSync(symbolNodeInputs);

      // Build edges for chunks and symbols
      let symbolIdx = 0;
      for (const [ci, chunkId] of chunkIds.entries()) {
        pendingEdges.push({
          fromNodeId: fileNodeId,
          toNodeId: chunkNodeIds[ci],
          type: "contains"
        });

        const symbolName = indexed.chunks[ci].symbolName;
        if (symbolName) {
          const symbolNodeId = symbolNodeIds[symbolIdx];
          pendingEdges.push({
            fromNodeId: fileNodeId,
            toNodeId: symbolNodeId,
            type: "defines"
          });
          pendingEdges.push({
            fromNodeId: symbolNodeId,
            toNodeId: chunkNodeIds[ci],
            type: "represented_by"
          });
          symbolNodeIdsByName.set(symbolName, symbolNodeId);
          symbolIdx++;
        }
      }

      // Stage 3: import + entity nodes
      const importNodeInputs: Array<{ type: string; label: string; refId?: string; metadata?: string }> = [];
      const importMetadatas: Array<string | undefined> = [];
      for (const importPath of indexed.importPaths) {
        const resolvedImportPath = workspaceFileResolver?.resolveImport(file.relativePath, importPath, indexed.language ?? undefined);
        if (!resolvedImportPath) continue;
        importNodeInputs.push({
          type: "file",
          label: resolvedImportPath,
          metadata: JSON.stringify({ path: resolvedImportPath })
        });
        importMetadatas.push(importPath);
      }

      const entityNodeInputs = indexed.wikilinks.map((link) => ({
        type: "entity",
        label: link,
        metadata: "{}"
      }));

      const importNodeIds = repo.upsertGraphNodesSync(importNodeInputs);
      const entityNodeIds = repo.upsertGraphNodesSync(entityNodeInputs);

      // Build import + entity edges
      for (const [i, targetNodeId] of importNodeIds.entries()) {
        pendingEdges.push({
          fromNodeId: fileNodeId,
          toNodeId: targetNodeId,
          type: "imports",
          metadata: JSON.stringify({ importPath: importMetadatas[i] })
        });
      }

      for (const entityNodeId of entityNodeIds) {
        pendingEdges.push({
          fromNodeId: fileNodeId,
          toNodeId: entityNodeId,
          type: "mentions"
        });
      }

      // Batch-insert all edges for this file.
      repo.insertEdgesSync(pendingEdges);

      pendingCallEdges.push(...indexed.callExpressions);

      chunksWritten += chunkIds.length;
      filesUpdated += 1;
    }

    // ── Resolve call edges in bulk ──
    // Instead of 6000 individual findGraphNode SELECTs, load all symbol
    // node IDs in one query and resolve in memory.
    const allSymbolNodeIds = await repo.listNodeIdsByType("symbol");
    // Merge with the in-memory map (more recent) for lookups.
    const symbolLookup = new Map<string, string>([...allSymbolNodeIds, ...symbolNodeIdsByName]);

    const insertedCallEdges = new Set<string>();
    const callEdgeInputs: Array<{
      fromNodeId: string;
      toNodeId: string;
      type: string;
      weight?: number;
      metadata?: string;
    }> = [];
    for (const callExpression of pendingCallEdges) {
      const callerNodeId = symbolLookup.get(callExpression.callerName);
      const calleeNodeId = symbolLookup.get(callExpression.calleeName);
      if (!callerNodeId || !calleeNodeId || callerNodeId === calleeNodeId) continue;

      const edgeKey = `${callerNodeId}:${calleeNodeId}:calls`;
      if (insertedCallEdges.has(edgeKey)) continue;
      insertedCallEdges.add(edgeKey);

      callEdgeInputs.push({
        fromNodeId: callerNodeId,
        toNodeId: calleeNodeId,
        type: "calls",
        weight: 0.35,
        metadata: JSON.stringify({ heuristic: true, callee: callExpression.calleeName })
      });
    }
    repo.insertEdgesSync(callEdgeInputs);
    }); // end transaction

    await reportProgress("Finalizing index run...", 98);
    await repo.completeIndexRun(runId, {
      status: "completed",
      filesScanned: files.length,
      filesUpdated,
      chunksWritten
    });

    const docCount = await repo.getDocumentCount();
    const chunkCountResult = await repo.getChunkCount();
    const nodeCount = await repo.getNodeCount();
    const edgeCount = await repo.getEdgeCount();

    await repo.completeGraphRun(graphRunId, {
      status: "completed",
      nodesCreated: nodeCount,
      edgesCreated: edgeCount,
    });

    await registry.updateWorkspace(workspace.id, {
      status: "indexed",
      indexingStatus: "completed",
      graphStatus: "completed",
      lastIndexedAt: new Date().toISOString(),
      lastGraphBuiltAt: new Date().toISOString(),
      documentCount: docCount,
      chunkCount: chunkCountResult,
      nodeCount,
      edgeCount,
      lastError: ""
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isCancelled = errorMessage === "Indexing cancelled";
    const runStatus = isCancelled ? "cancelled" : "failed";
    const registryStatus = isCancelled ? "error" : "error";
    const registryIndexingStatus = isCancelled ? "cancelled" : "failed";
    await repo.completeIndexRun(runId, {
      status: runStatus,
      filesScanned: files.length,
      filesUpdated,
      chunksWritten,
      errorMessage: isCancelled ? undefined : errorMessage,
    });

    await repo.completeGraphRun(graphRunId, {
      status: isCancelled ? "cancelled" : "failed",
      nodesCreated: 0,
      edgesCreated: 0,
      errorMessage: isCancelled ? undefined : errorMessage,
    });

    await registry.updateWorkspace(workspace.id, {
      status: registryStatus,
      indexingStatus: registryIndexingStatus,
      graphStatus: "failed",
      lastError: isCancelled ? "" : errorMessage,
    });
    if (!isCancelled) throw error;
  }

  await reportProgress("Index complete", 100);

  return {
    workspaceId: workspace.id,
    filesScanned: files.length,
    filesUpdated,
    chunksWritten
  };
}
