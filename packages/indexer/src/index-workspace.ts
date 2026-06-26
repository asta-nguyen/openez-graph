import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { getBrainSettings } from "@openez-graph/config";
import { getEmbeddingProvider } from "@openez-graph/core";
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

  if (chunkIds.length > 0) {
    await repo.deleteEmbeddingsByChunkIds(chunkIds);
  }

  await repo.deleteEdgesByNodeIds(allNodeIds);
  await repo.deleteGraphNodesByRefId(documentId);
  await repo.deleteChunksByDocument(documentId);
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

async function writeEmbeddingsToRepo(
  repo: WorkspaceRepository,
  chunkRows: Array<{ id: string; content: string }>
) {
  const provider = getEmbeddingProvider();
  if (!provider || chunkRows.length === 0) {
    return 0;
  }

  try {
    const vectors = await provider.embed(chunkRows.map((chunk) => chunk.content));
    const invalidEmbeddingIndex = vectors.findIndex((embedding) => embedding.length === 0);

    if (invalidEmbeddingIndex !== -1) {
      console.error(`Embedding provider returned empty vector for chunk ${chunkRows[invalidEmbeddingIndex].id}`);
      return 0;
    }

    const dimensions = vectors[0]?.length ?? 0;
    if (vectors.some((embedding) => embedding.length !== dimensions)) {
      console.error("Embedding provider returned mixed dimensions");
      return 0;
    }

    await repo.insertEmbeddings(
      vectors.map((embedding, index) => ({
        chunkId: chunkRows[index].id,
        provider: provider.provider,
        model: provider.model,
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
  const runMode = input.mode ?? "incremental";

  const reportProgress = async (message: string, progress: number) => {
    await input.onProgress?.({ message, progress });
  };

  const runId = await repo.createIndexRun({ mode: runMode });

  if (runMode === "full") {
    await repo.resetAll();
  }

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
  let embeddingsWritten = 0;
  const symbolNodeIdsByName = new Map<string, string>();
  const pendingCallEdges: Array<{ callerName: string; calleeName: string }> = [];

  try {
    await reportProgress(
      files.length === 0 ? "No files matched the workspace filters" : `Queued ${files.length} file(s) for indexing`,
      files.length === 0 ? 100 : 10
    );

    for (const [index, file] of files.entries()) {
      const progress = Math.min(95, 10 + Math.round((index / Math.max(files.length, 1)) * 85));
      await reportProgress(`Indexing ${file.relativePath}`, progress);

      const content = await fs.readFile(file.absolutePath, "utf8");
      const contentHash = hashContent(content);
      const existingDocument = await repo.getDocumentByPath(file.relativePath);

      if (
        runMode === "incremental" &&
        existingDocument &&
        existingDocument.contentHash === contentHash &&
        existingDocument.mtimeMs === file.mtimeMs
      ) {
        continue;
      }

      const indexed = await chunkDocument({
        relativePath: file.relativePath,
        absolutePath: file.absolutePath,
        content,
        targetTokens: settings.chunking.targetTokens,
        overlapTokens: settings.chunking.overlapTokens
      });

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

      for (const [ci, chunkId] of chunkIds.entries()) {
        const chunkNodeId = await repo.upsertGraphNode({
          type: "chunk",
          label: `${file.relativePath}#${ci}`,
          refId: chunkId,
          metadata: JSON.stringify(indexed.chunks[ci].metadata)
        });

        await repo.insertEdge({
          fromNodeId: fileNodeId,
          toNodeId: chunkNodeId,
          type: "contains"
        });

        const symbolName = indexed.chunks[ci].symbolName;
        if (symbolName) {
          const symbolNodeId = await repo.upsertGraphNode({
            type: "symbol",
            label: symbolName,
            refId: chunkId,
            metadata: JSON.stringify({
              symbolType: indexed.chunks[ci].symbolType,
              filePath: file.relativePath
            })
          });

          await repo.insertEdge({
            fromNodeId: fileNodeId,
            toNodeId: symbolNodeId,
            type: "defines"
          });

          await repo.insertEdge({
            fromNodeId: symbolNodeId,
            toNodeId: chunkNodeId,
            type: "represented_by"
          });

          symbolNodeIdsByName.set(symbolName, symbolNodeId);
        }
      }

      for (const importPath of indexed.importPaths) {
        const resolvedImportPath = workspaceFileResolver?.resolveImport(file.relativePath, importPath, indexed.language ?? undefined);
        if (!resolvedImportPath) continue;

        const targetNodeId = await repo.upsertGraphNode({
          type: "file",
          label: resolvedImportPath,
          metadata: JSON.stringify({ path: resolvedImportPath })
        });

        await repo.insertEdge({
          fromNodeId: fileNodeId,
          toNodeId: targetNodeId,
          type: "imports",
          metadata: JSON.stringify({ importPath })
        });
      }

      for (const link of indexed.wikilinks) {
        const entityNodeId = await repo.upsertGraphNode({
          type: "entity",
          label: link,
          metadata: "{}"
        });

        await repo.insertEdge({
          fromNodeId: fileNodeId,
          toNodeId: entityNodeId,
          type: "mentions"
        });
      }

      pendingCallEdges.push(...indexed.callExpressions);

      const chunkRows = chunkIds.map((id, i) => ({
        id,
        content: indexed.chunks[i].content
      }));

      embeddingsWritten += await writeEmbeddingsToRepo(repo, chunkRows);
      chunksWritten += chunkIds.length;
      filesUpdated += 1;
    }

    const insertedCallEdges = new Set<string>();
    for (const callExpression of pendingCallEdges) {
      const callerNodeId = symbolNodeIdsByName.get(callExpression.callerName) ?? (await repo.findGraphNode("symbol", callExpression.callerName))?.id;
      const calleeNodeId = symbolNodeIdsByName.get(callExpression.calleeName) ?? (await repo.findGraphNode("symbol", callExpression.calleeName))?.id;
      if (!callerNodeId || !calleeNodeId || callerNodeId === calleeNodeId) continue;

      const edgeKey = `${callerNodeId}:${calleeNodeId}:calls`;
      if (insertedCallEdges.has(edgeKey)) continue;
      insertedCallEdges.add(edgeKey);

      await repo.insertEdge({
        fromNodeId: callerNodeId,
        toNodeId: calleeNodeId,
        type: "calls",
        weight: 0.35,
        metadata: JSON.stringify({ heuristic: true, callee: callExpression.calleeName })
      });
    }

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
