import { fastTokenCounter } from "@openez-graph/core";
import type { ChunkMetadata, IndexedChunk } from "../types";
import type { CodeParser, ParseInput, ParsedDocument } from "./types";

/**
 * Last-resort parser: produces a single chunk covering the whole file.
 * No symbols, imports, or calls — just raw content for FTS/embedding.
 */
export class FallbackParser implements CodeParser {
  readonly name = "fallback";

  canParse(): boolean {
    return true;
  }

  parse(input: ParseInput, language: string | null, kind: string): ParsedDocument {
    const counter = input.counter ?? fastTokenCounter;
    const lines = input.content.split("\n");
    const metadata: ChunkMetadata = {
      kind,
      startLine: 1,
      endLine: lines.length,
    };
    if (language) metadata.language = language;
    const chunk: IndexedChunk = {
      content: input.content,
      tokenCount: counter.count(input.content),
      contentHash: Bun.hash(input.content).toString(16),
      metadata,
    };

    return {
      parser: this.name,
      language,
      // SAFETY: kind is inferred by the parser registry from file extension
      // and is always one of "markdown" | "code" | "config" | "text".
      kind: kind as ParsedDocument["kind"],
      chunks: [chunk],
      importPaths: [],
      wikilinks: [],
      definedSymbols: [],
      calledIdentifiers: [],
      callExpressions: [],
    };
  }
}
