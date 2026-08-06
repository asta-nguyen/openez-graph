import { hashContent } from "../hash";
import type { IndexedChunk } from "../types";
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
    const lines = input.content.split("\n");
    const chunk: IndexedChunk = {
      content: input.content,
      tokenCount: Math.ceil(input.content.length / 4),
      contentHash: hashContent(input.content),
      metadata: {
        kind,
        ...(language ? { language } : {}),
        startLine: 1,
        endLine: lines.length,
      },
    };

    return {
      parser: this.name,
      language,
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
