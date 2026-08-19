import { indexMarkdown } from "../markdown";
import type { CodeParser, ParseInput, ParsedDocument } from "./types";

export class MarkdownParser implements CodeParser {
  readonly name = "markdown";

  canParse(_path: string, language: string | null, kind: string): boolean {
    return kind === "markdown" && language === "markdown";
  }

  parse(input: ParseInput, _language: string | null, _kind: string): ParsedDocument {
    const result = indexMarkdown({
      content: input.content,
      targetTokens: input.targetTokens,
      overlapTokens: input.overlapTokens,
      counter: input.counter,
    });

    return {
      parser: this.name,
      language: "markdown",
      kind: "markdown",
      chunks: result.chunks,
      importPaths: [],
      wikilinks: result.wikilinks,
      definedSymbols: [],
      calledIdentifiers: [],
      callExpressions: [],
    };
  }
}
