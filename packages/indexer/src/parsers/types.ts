import type { TokenCounter } from "@openez-graph/core";

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
 * A static import/require binding: local name -> module specifier + the export
 * name it refers to ("default" for default imports, "*" for namespace and
 * CommonJS require bindings). `typeOnly` marks TypeScript `import type` /
 * `import { type X }` specifiers — they join file-level dependency edges but
 * never resolve `calls` targets.
 */
export interface ImportBinding {
  local: string;
  module: string;
  imported: string;
  typeOnly?: boolean;
  /** Byte range of the block/function that owns this binding — present only
   *  for function-local `require` bindings; absent for module-scope imports. */
  scopeStart?: number;
  scopeEnd?: number;
}

/**
 * A static export exposed by a module.
 * - local: `name` maps to the same-file symbol `local` (includes CJS
 *   `exports.name`/`module.exports.name`/object-literal assignments and ESM
 *   `export { x as name }` without a source).
 * - reexport: `name` forwards to `imported` in `module` (`export {x as name} from`).
 * - star: wildcard re-export (`export * from`) — expanded at graph build time.
 * `typeOnly` marks TypeScript `export type` / `export { type X }` specifiers —
 * they never resolve `calls` targets.
 */
export interface ExportBinding {
  name: string;
  kind: "local" | "reexport" | "star";
  local?: string;
  module?: string;
  imported?: string;
  typeOnly?: boolean;
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
  callExpressions: Array<{
    callerName: string;
    calleeName: string;
    /** Byte offset of the call site — used to match scoped require bindings. */
    start?: number;
    /** The callee's root identifier is a param/local variable visible at the
     *  call site (e.g. `run(NS) { NS.x() }`) — it cannot be a module import. */
    shadowedLocal?: boolean;
  }>;
  /** Static ESM import + CommonJS require bindings (oxc only). */
  importBindings?: ImportBinding[];
  /** Static ESM/CommonJS export table (oxc only). */
  exportBindings?: ExportBinding[];
}

export interface ParseInput {
  relativePath: string;
  absolutePath: string;
  content: string;
  targetTokens: number;
  overlapTokens: number;
  /**
   * Token-counting strategy used when chunking. Indexing passes
   * `fastTokenCounter` (chars/4) to avoid BPE on the hot path; retrieval and
   * tests default to `exactTokenCounter`. Parsers thread this through to all
   * chunk-producing helpers.
   */
  counter?: TokenCounter;
}

/**
 * A parser for a specific class of source files.
 * Implementations: OxcParser (TS/JS), TreeSitterParser (Python/Go/Rust/Ruby),
 * RegexParser (Python/Go/Rust/Ruby fallback), MarkdownParser, ConfigParser, FallbackParser.
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
