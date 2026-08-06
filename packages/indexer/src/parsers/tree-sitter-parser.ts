import { parseC, parseGo, parsePython, parseRust, type IndexedCodeResult } from "../languages";
import { goConfig, parseWithTreeSitter, pythonConfig, rustConfig } from "../tree-sitter";
import type { CodeParser, ParseInput, ParsedDocument } from "./types";

const LANGUAGE_CONFIGS = {
  python: pythonConfig,
  go: goConfig,
  rust: rustConfig,
} as const;

const REGEX_FALLBACKS: Record<string, (content: string) => IndexedCodeResult> = {
  python: parsePython,
  go: parseGo,
  rust: parseRust,
  c: parseC,
};

type TreeSitterLanguage = keyof typeof LANGUAGE_CONFIGS;

function isTreeSitterLanguage(language: string): language is TreeSitterLanguage {
  return language in LANGUAGE_CONFIGS;
}

// Languages that have a regex fallback but no tree-sitter WASM config
const REGEX_ONLY_LANGUAGES = new Set(["c"]);

/**
 * Parses Python/Go/Rust using tree-sitter (WASM AST).
 * C uses the regex fallback (tree-sitter WASM OOMs on 70k files).
 * Falls back to the regex parser if tree-sitter fails (grammar unavailable,
 * parse error, etc.) — matching the spec's resilience guidance.
 */
export class TreeSitterParser implements CodeParser {
  readonly name = "tree-sitter";

  canParse(_path: string, language: string | null, kind: string): boolean {
    return (
      kind === "code" &&
      language !== null &&
      (isTreeSitterLanguage(language) || REGEX_ONLY_LANGUAGES.has(language))
    );
  }

  async parse(input: ParseInput, language: string | null, _kind: string): Promise<ParsedDocument> {
    if (!language || !isTreeSitterLanguage(language)) {
      return this.regexFallback(input, language);
    }

    const config = LANGUAGE_CONFIGS[language];
    const tsResult = await parseWithTreeSitter(config, input.content);
    const result = tsResult ?? REGEX_FALLBACKS[language](input.content);

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

  private regexFallback(input: ParseInput, language: string | null): ParsedDocument {
    const fallback =
      language && REGEX_FALLBACKS[language]
        ? REGEX_FALLBACKS[language](input.content)
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
