import type { IndexedChunk } from "../types";

/**
 * Minimal symbol shape that all parsers produce.
 * ts-morph returns this smaller shape (no line ranges — those live on chunks);
 * tree-sitter and regex parsers return the fuller ExtractedSymbol with ranges.
 */
export interface ParsedSymbol {
  name: string;
  symbolType: string;
  type: string;
  exported: boolean;
  startLine?: number;
  endLine?: number;
  decorators?: string[];
  receiver?: string;
}

/**
 * Result of parsing a single source file.
 * Extends the raw IndexedCodeResult with parser identification so downstream
 * graph building can tag nodes/edges with which parser produced them.
 */
export interface ParsedDocument {
  parser: string;
  language: string | null;
  kind: "markdown" | "code" | "config" | "text";
  chunks: IndexedChunk[];
  importPaths: string[];
  wikilinks: string[];
  definedSymbols: ParsedSymbol[];
  calledIdentifiers: string[];
  callExpressions: Array<{ callerName: string; calleeName: string }>;
}

export interface ParseInput {
  relativePath: string;
  absolutePath: string;
  content: string;
  targetTokens: number;
  overlapTokens: number;
}

/**
 * A parser for a specific class of source files.
 * Implementations: TsMorphParser (TS/JS), TreeSitterParser (Python/Go/Rust),
 * RegexParser (Python/Go/Rust fallback), MarkdownParser, ConfigParser, FallbackParser.
 */
export interface CodeParser {
  /** Parser name for metadata tagging (e.g. "ts-morph", "tree-sitter", "regex"). */
  readonly name: string;
  /** Return true if this parser can handle the given file path. */
  canParse(path: string, language: string | null, kind: string): boolean;
  /**
   * Parse the file content into a ParsedDocument.
   * The language and kind are inferred from the path by the registry and
   * passed in so parsers don't need to re-infer.
   */
  parse(
    input: ParseInput,
    language: string | null,
    kind: string,
  ): Promise<ParsedDocument> | ParsedDocument;
}
