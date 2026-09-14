import { exactTokenCounter, type TokenCounter } from "@openez-graph/core";

import {
  makeFallbackChunks,
  parseGo,
  parsePython,
  parseRuby,
  parseRust,
  type IndexedCodeResult,
} from "../languages";
import {
  goConfig,
  parseWithTreeSitter,
  pythonConfig,
  rubyConfig,
  rustConfig,
  javaConfig,
} from "../tree-sitter";
import type { CodeParser, ParseInput, ParsedDocument } from "./types";

const LANGUAGE_CONFIGS = {
  python: pythonConfig,
  go: goConfig,
  rust: rustConfig,
  ruby: rubyConfig,
  java: javaConfig,
} as const;

const REGEX_FALLBACKS: Partial<
  Record<string, (content: string, counter: TokenCounter) => IndexedCodeResult>
> = {
  python: parsePython,
  go: parseGo,
  rust: parseRust,
  ruby: parseRuby,
};

type TreeSitterLanguage = keyof typeof LANGUAGE_CONFIGS;

function isTreeSitterLanguage(language: string): language is TreeSitterLanguage {
  return language in LANGUAGE_CONFIGS;
}

/**
 * Parses Python/Go/Rust/Ruby/Java using tree-sitter (WASM AST).
 * Falls back to the regex parser if tree-sitter fails (grammar unavailable,
 * parse error, etc.). Java has no language-specific regex parser and uses a
 * raw fallback chunk instead.
 */
export class TreeSitterParser implements CodeParser {
  readonly name = "tree-sitter";

  canParse(_path: string, language: string | null, kind: string): boolean {
    return kind === "code" && language !== null && isTreeSitterLanguage(language);
  }

  async parse(input: ParseInput, language: string | null, _kind: string): Promise<ParsedDocument> {
    const counter = input.counter ?? exactTokenCounter;
    if (!language || !isTreeSitterLanguage(language)) {
      return this.regexFallback(input, language, counter);
    }

    const config = LANGUAGE_CONFIGS[language];
    const tsResult = await parseWithTreeSitter(config, input.content, counter);
    const result =
      tsResult ??
      REGEX_FALLBACKS[language]?.(input.content, counter) ??
      makeFallbackChunks(input.content, input.content.split("\n"), counter);

    return {
      parser: tsResult ? this.name : "regex",
      language,
      kind: "code",
      chunks: result.chunks,
      importPaths: result.importPaths,
      wikilinks: [],
      definedSymbols: result.definedSymbols,
      calledIdentifiers: result.calledIdentifiers,
      callExpressions: result.callExpressions,
    };
  }

  private regexFallback(
    input: ParseInput,
    language: string | null,
    counter: TokenCounter,
  ): ParsedDocument {
    const fallbackParser = language ? REGEX_FALLBACKS[language] : undefined;
    const fallback = fallbackParser
      ? fallbackParser(input.content, counter)
      : makeFallbackChunks(input.content, input.content.split("\n"), counter);

    return {
      parser: "regex",
      language,
      kind: "code",
      ...fallback,
      wikilinks: [],
    };
  }
}
