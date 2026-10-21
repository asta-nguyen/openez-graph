import path from "node:path";

import { exactTokenCounter, type TokenCounter } from "@openez-graph/core";

import {
  makeFallbackChunks,
  parseGo,
  parsePython,
  parseRuby,
  parseRust,
  type IndexedCodeResult,
} from "../languages";
import { extractPythonBindings, markPythonCallShadowing } from "../python-resolver";
import {
  cppConfig,
  cppHeaderConfig,
  goConfig,
  parseWithTreeSitter,
  pythonConfig,
  rubyConfig,
  rustConfig,
} from "../tree-sitter";
import type { CodeParser, ParseInput, ParsedDocument } from "./types";

const LANGUAGE_CONFIGS = {
  python: pythonConfig,
  go: goConfig,
  rust: rustConfig,
  ruby: rubyConfig,
  cpp: cppConfig,
} as const;

const REGEX_FALLBACKS: Record<
  string,
  (content: string, counter: TokenCounter) => IndexedCodeResult
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
 * Parses Python/Go/Rust/Ruby/C++ using tree-sitter (WASM AST).
 * Falls back to the regex parser if tree-sitter fails (grammar unavailable,
 * parse error, etc.) — matching the spec's resilience guidance. C++ has no
 * regex parser by design: a failed C++ parse degrades to generic text
 * chunks with no graph records (never throws).
 */
/** C++ has no regex parser — a failed/unavailable AST degrades to generic
 *  text chunks with no graph records. */
function cppGenericFallback(content: string, counter: TokenCounter): IndexedCodeResult {
  return {
    ...makeFallbackChunks(content, content.split("\n"), counter),
    definedSymbols: [],
    calledIdentifiers: [],
    callExpressions: [],
  };
}

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

    // `.h` files use the strict header config: any syntax error rejects the
    // whole parse, matching the native cpp-header behavior.
    const config =
      language === "cpp" && path.extname(input.relativePath) === ".h"
        ? cppHeaderConfig
        : LANGUAGE_CONFIGS[language];
    const tsResult = await parseWithTreeSitter(config, input.content, counter);
    const result =
      tsResult ??
      (language === "cpp"
        ? cppGenericFallback(input.content, counter)
        : REGEX_FALLBACKS[language](input.content, counter));

    // Python bindings and local-shadow marks are extracted once in
    // TypeScript over the source so the WASM and regex paths agree; see
    // docs/agent-devkit/changes/2026-10-20-39-python-index-accuracy.
    const isPython = language === "python";
    const callExpressions = result.callExpressions ?? [];
    if (isPython) {
      markPythonCallShadowing(input.content, result.definedSymbols ?? [], callExpressions);
    }

    return {
      parser: tsResult ? this.name : "regex",
      language,
      kind: "code",
      chunks: result.chunks,
      importPaths: result.importPaths,
      wikilinks: [],
      definedSymbols: result.definedSymbols,
      calledIdentifiers: result.calledIdentifiers,
      callExpressions,
      importBindings: isPython
        ? extractPythonBindings(input.content, result.definedSymbols ?? [])
        : undefined,
    };
  }

  private regexFallback(
    input: ParseInput,
    language: string | null,
    counter: TokenCounter,
  ): ParsedDocument {
    const fallback =
      language && REGEX_FALLBACKS[language]
        ? REGEX_FALLBACKS[language](input.content, counter)
        : {
            chunks: [],
            importPaths: [],
            definedSymbols: [],
            calledIdentifiers: [],
            callExpressions: [],
          };

    return {
      parser: "regex",
      language,
      kind: "code",
      ...fallback,
      wikilinks: [],
    };
  }
}
