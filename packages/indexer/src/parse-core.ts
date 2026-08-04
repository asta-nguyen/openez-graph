import { indexCode } from "./code";
import { hashContent } from "./hash";
import { indexConfig, inferDocumentKind, parseGo, parsePython, parseRust } from "./languages";
import { indexMarkdown } from "./markdown";
import type { IndexedChunk } from "./types";

export interface ParseTask {
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

const EMPTY = {
  importPaths: [] as string[],
  wikilinks: [] as string[],
  definedSymbols: [] as Array<{ name: string; type: string; exported: boolean }>,
  calledIdentifiers: [] as string[],
  callExpressions: [] as Array<{ callerName: string; calleeName: string }>
};

function fallbackChunk(content: string, kind: string, language?: string): IndexedChunk {
  return {
    content,
    tokenCount: Math.ceil(content.length / 4),
    contentHash: hashContent(content),
    metadata: { kind, language, startLine: 1, endLine: content.split("\n").length }
  };
}

export function chunkDocument(input: {
  relativePath: string;
  absolutePath: string;
  content: string;
  targetTokens: number;
  overlapTokens: number;
}) {
  const info = inferDocumentKind(input.relativePath);

  if (info.kind === "markdown") {
    const result = indexMarkdown({ content: input.content, targetTokens: input.targetTokens, overlapTokens: input.overlapTokens });
    return { kind: info.kind, language: info.language, chunks: result.chunks, ...EMPTY, wikilinks: result.wikilinks };
  }

  if (info.kind === "config") {
    return { kind: info.kind, language: info.language, chunks: indexConfig(input.content, info.language ?? ""), ...EMPTY };
  }

  if (info.kind === "code") {
    if (info.language === "typescript" || info.language === "tsx" || info.language === "javascript" || info.language === "jsx") {
      const r = indexCode(input.content, input.absolutePath);
      return { kind: info.kind, language: info.language, chunks: r.chunks, importPaths: r.importPaths, wikilinks: [] as string[], definedSymbols: r.definedSymbols, calledIdentifiers: r.calledIdentifiers, callExpressions: r.callExpressions };
    }
    if (info.language === "python") {
      const r = parsePython(input.content);
      return { kind: info.kind, language: info.language, chunks: r.chunks, importPaths: r.importPaths, wikilinks: [] as string[], definedSymbols: r.definedSymbols, calledIdentifiers: r.calledIdentifiers, callExpressions: r.callExpressions };
    }
    if (info.language === "go") {
      const r = parseGo(input.content);
      return { kind: info.kind, language: info.language, chunks: r.chunks, importPaths: r.importPaths, wikilinks: [] as string[], definedSymbols: r.definedSymbols, calledIdentifiers: r.calledIdentifiers, callExpressions: r.callExpressions };
    }
    if (info.language === "rust") {
      const r = parseRust(input.content);
      return { kind: info.kind, language: info.language, chunks: r.chunks, importPaths: r.importPaths, wikilinks: [] as string[], definedSymbols: r.definedSymbols, calledIdentifiers: r.calledIdentifiers, callExpressions: r.callExpressions };
    }
    return { kind: info.kind, language: info.language, chunks: [fallbackChunk(input.content, "code", info.language ?? undefined)], ...EMPTY };
  }

  return { kind: info.kind, language: info.language, chunks: [fallbackChunk(input.content, info.kind)], ...EMPTY };
}

export type ParseResult = ReturnType<typeof chunkDocument>;
