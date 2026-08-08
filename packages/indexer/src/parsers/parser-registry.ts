import { inferDocumentKind } from "../languages";
import type { CodeParser, ParseInput, ParsedDocument } from "./types";
import { ConfigParser } from "./config-parser";
import { FallbackParser } from "./fallback-parser";
import { MarkdownParser } from "./markdown-parser";
import { OxcParser } from "./oxc-parser";
import { TreeSitterParser } from "./tree-sitter-parser";

/**
 * Ordered list of parsers. The first parser whose canParse() returns true
 * wins. Order matters: specific parsers before general ones, and the
 * fallback parser must be last (it always returns true).
 */
const parsers: CodeParser[] = [
  new MarkdownParser(),
  new ConfigParser(),
  new OxcParser(),
  new TreeSitterParser(),
  new FallbackParser(),
];

/**
 * Select the best parser for a file path based on its extension/kind.
 * Returns null only if no parser matches (shouldn't happen — FallbackParser
 * always matches).
 */
export function getParserForPath(filePath: string): CodeParser {
  const info = inferDocumentKind(filePath);

  for (const parser of parsers) {
    if (parser.canParse(filePath, info.language, info.kind)) {
      return parser;
    }
  }

  // Should never reach here because FallbackParser.canParse() always returns true
  return parsers[parsers.length - 1];
}

/**
 * Parse a file using the appropriate parser from the registry.
 * This is the single entry point that replaces the per-language branching
 * previously in chunkDocument().
 */
export async function parseDocument(input: ParseInput): Promise<ParsedDocument> {
  const parser = getParserForPath(input.relativePath);
  const info = inferDocumentKind(input.relativePath);
  return parser.parse(input, info.language, info.kind);
}

export type { CodeParser, ParseInput, ParsedDocument, ParsedSymbol } from "./types";
