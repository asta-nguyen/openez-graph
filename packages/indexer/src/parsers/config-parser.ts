import { indexConfig } from "../languages";
import type { CodeParser, ParseInput, ParsedDocument } from "./types";

export class ConfigParser implements CodeParser {
  readonly name = "config";

  canParse(_path: string, _language: string | null, kind: string): boolean {
    return kind === "config";
  }

  parse(input: ParseInput, language: string | null, _kind: string): ParsedDocument {
    const configChunks = indexConfig(input.content, language ?? "", input.counter);

    return {
      parser: this.name,
      language,
      kind: "config",
      chunks: configChunks,
      importPaths: [],
      wikilinks: [],
      definedSymbols: [],
      calledIdentifiers: [],
      callExpressions: [],
    };
  }
}
