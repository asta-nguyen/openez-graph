import path from "node:path";

import { countTokens } from "@openez-graph/core";

import { hashContent } from "./hash";
import type { IndexedChunk } from "./types";

// ── Language detection ──

export const codeExtensions = new Map<string, string>([
  [".ts", "typescript"],
  [".tsx", "tsx"],
  [".js", "javascript"],
  [".jsx", "jsx"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".mts", "typescript"],
  [".cts", "typescript"],
  [".py", "python"],
  [".go", "go"],
  [".rs", "rust"]
]);

export const configExtensions = new Map<string, string>([
  [".yaml", "yaml"],
  [".yml", "yaml"],
  [".json", "json"],
  [".toml", "toml"]
]);

export const markdownExtensions = new Set([".md", ".mdx"]);

export interface LanguageInfo {
  kind: "markdown" | "code" | "config" | "text";
  language: string | null;
  extension: string;
}

export function inferDocumentKind(filePath: string): LanguageInfo {
  const extension = path.extname(filePath).toLowerCase();

  if (markdownExtensions.has(extension)) {
    return { kind: "markdown", language: "markdown", extension };
  }

  if (codeExtensions.has(extension)) {
    return { kind: "code", language: codeExtensions.get(extension) ?? null, extension };
  }

  if (configExtensions.has(extension)) {
    return { kind: "config", language: configExtensions.get(extension) ?? null, extension };
  }

  return { kind: "text", language: extension.slice(1) || null, extension };
}

// ── Symbol extraction ──

export interface ExtractedSymbol {
  name: string;
  symbolType: string;
  type: string;
  exported: boolean;
  startLine: number;
  endLine: number;
  content?: string;
}

export interface IndexedCodeResult {
  chunks: IndexedChunk[];
  importPaths: string[];
  definedSymbols: ExtractedSymbol[];
  calledIdentifiers: string[];
  callExpressions: Array<{ callerName: string; calleeName: string }>;
}

// ── Python parser ──

function stripPythonAlias(value: string): string {
  return value.trim().replace(/^\(+|\)+$/g, "").split(/\s+as\s+/i)[0]?.trim() ?? "";
}

function parsePythonImportLine(line: string): string[] {
  const trimmed = line.trim().replace(/\s+#.*$/, "");
  const fromMatch = /^from\s+([.\w]+)\s+import\s+(.+)$/.exec(trimmed);
  if (fromMatch) {
    const modulePath = fromMatch[1];
    const importedNames = fromMatch[2]
      .split(",")
      .map(stripPythonAlias)
      .filter((name) => name && name !== "*");

    return [
      modulePath,
      ...importedNames.map((name) => modulePath.endsWith(".") ? `${modulePath}${name}` : `${modulePath}.${name}`)
    ];
  }

  const importMatch = /^import\s+(.+)$/.exec(trimmed);
  if (!importMatch) return [];

  return importMatch[1]
    .split(",")
    .map(stripPythonAlias)
    .filter(Boolean);
}

function normalizePythonCallName(value: string): string {
  const parts = value.split(".").filter(Boolean);
  return parts[parts.length - 1] ?? value;
}

const PYTHON_CALL_IGNORES = new Set([
  "if", "for", "while", "with", "return", "yield",
  "print", "len", "range", "str", "int", "float", "list", "dict", "set", "tuple", "bool",
  "isinstance", "issubclass", "super", "self", "cls"
]);

export function parsePython(content: string): IndexedCodeResult {
  const lines = content.split("\n");
  const definedSymbols: ExtractedSymbol[] = [];
  const importPaths: string[] = [];
  const calledIdentifiers = new Set<string>();
  const callExpressions: Array<{ callerName: string; calleeName: string }> = [];

  const symbolRegex = /^(?:async\s+)?(?:def|class)\s+(\w+)/;
  const moduleDocstring = /^"""/;
  const callRegex = /(\w+(?:\.\w+)*)\s*\(/g;

  let inMultilineString = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (inMultilineString) {
      if (line.includes('"""') || line.includes("'''")) {
        inMultilineString = false;
      }
      continue;
    }

    if (moduleDocstring.test(line.trim())) {
      if (!line.trim().endsWith('"""') && !line.trim().endsWith("'''")) {
        inMultilineString = true;
      }
      continue;
    }

    const trimmed = line.trim();
    const symbolMatch = symbolRegex.exec(trimmed);
    if (symbolMatch) {
      const name = symbolMatch[1];
      const isAsync = trimmed.startsWith("async");
      const stripped = isAsync ? trimmed.slice(6) : trimmed;
      const symbolType = stripped.startsWith("def") ? "function" : "class";
      const exported = !name.startsWith("_");
      const startLine = i + 1;
      const endLine = findBlockEnd(lines, i);
      const content = lines.slice(i, endLine).join("\n");

      definedSymbols.push({ name, symbolType, type: symbolType, exported, startLine, endLine });

      // Extract function calls within the symbol body (skip the def/class
      // header line — its parenthesized params/base class are not calls)
      const bodyContent = lines.slice(i + 1, endLine).join("\n");
      let callMatch;
      const localCallRegex = new RegExp(callRegex);
      while ((callMatch = localCallRegex.exec(bodyContent)) !== null) {
        const rawCalledName = callMatch[1];
        const calledName = normalizePythonCallName(rawCalledName);
        if (!PYTHON_CALL_IGNORES.has(rawCalledName) && !PYTHON_CALL_IGNORES.has(calledName) && calledName !== name) {
          calledIdentifiers.add(calledName);
          callExpressions.push({ callerName: name, calleeName: calledName });
        }
      }
    }

    importPaths.push(...parsePythonImportLine(line));
  }

  const chunks = createSymbolChunks(definedSymbols, lines, "python");
  if (chunks.length === 0) {
    return { ...makeFallbackChunks(content, lines), callExpressions: [] };
  }

  return { chunks, importPaths: [...new Set(importPaths)], definedSymbols, calledIdentifiers: [...calledIdentifiers], callExpressions };
}

// ── Go parser ──

export function parseGo(content: string): IndexedCodeResult {
  const lines = content.split("\n");
  const definedSymbols: ExtractedSymbol[] = [];
  const importPaths: string[] = [];

  const funcRegex = /^func\s+(?:\([^)]*\)\s+)?(\w+)/;
  const typeRegex = /^type\s+(\w+)\s+(?:struct|interface|func|map|chan|\w+)/;
  const constVarRegex = /^(?:const|var)\s+(\w+)/;
  const importRegex = /^import\s+(?:"(\S+)"|\(|(\S+))/;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    const funcMatch = funcRegex.exec(trimmed);
    if (funcMatch) {
      const name = funcMatch[1];
      const exported = name[0] >= "A" && name[0] <= "Z";
      const startLine = i + 1;
      const endLine = findBraceBlockEnd(lines, i);
      definedSymbols.push({
        name,
        symbolType: "function", type: "function",
        exported,
        startLine,
        endLine
      });
      continue;
    }

    const typeMatch = typeRegex.exec(trimmed);
    if (typeMatch) {
      const name = typeMatch[1];
      const exported = name[0] >= "A" && name[0] <= "Z";
      const startLine = i + 1;
      const endLine = findBraceBlockEnd(lines, i);
      definedSymbols.push({
        name,
        symbolType: "type", type: "type",
        exported,
        startLine,
        endLine
      });
      continue;
    }

    const cvMatch = constVarRegex.exec(trimmed);
    if (cvMatch) {
      const name = cvMatch[1];
      const exported = name[0] >= "A" && name[0] <= "Z";
      definedSymbols.push({
        name,
        symbolType: trimmed.startsWith("const") ? "const" : "var",
        type: trimmed.startsWith("const") ? "const" : "var",
        exported,
        startLine: i + 1,
        endLine: i + 1
      });
    }

    const importMatch = importRegex.exec(trimmed);
    if (importMatch) {
      const pkg = importMatch[1] || importMatch[2];
      importPaths.push(pkg);
    }
  }

  const chunks = createSymbolChunks(definedSymbols, lines, "go");
  if (chunks.length === 0) {
    return makeFallbackChunks(content, lines);
  }

  return { chunks, importPaths, definedSymbols, calledIdentifiers: [], callExpressions: [] };
}

// ── Rust parser ──

export function parseRust(content: string): IndexedCodeResult {
  const lines = content.split("\n");
  const definedSymbols: ExtractedSymbol[] = [];
  const importPaths: string[] = [];

  const fnRegex = /^(?:pub\s+)?(?:unsafe\s+)?fn\s+(\w+)/;
  const structRegex = /^(?:pub\s+)?struct\s+(\w+)/;
  const enumRegex = /^(?:pub\s+)?enum\s+(\w+)/;
  const traitRegex = /^(?:pub\s+)?trait\s+(\w+)/;
  const implRegex = /^(?:pub\s+)?impl\s+/;
  const typeRegex = /^(?:pub\s+)?type\s+(\w+)/;
  const constRegex = /^(?:pub\s+)?(?:const|static)\s+(\w+)/;
  const modRegex = /^(?:pub\s+)?mod\s+(\w+)/;
  const useRegex = /^use\s+(\S+)/;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    const fnMatch = fnRegex.exec(trimmed);
    if (fnMatch) {
      const name = fnMatch[1];
      const exported = trimmed.startsWith("pub");
      const startLine = i + 1;
      const endLine = findBraceBlockEnd(lines, i);
      definedSymbols.push({ name, symbolType: "function", type: "function", exported, startLine, endLine });
      continue;
    }

    const structMatch = structRegex.exec(trimmed);
    if (structMatch) {
      const name = structMatch[1];
      const exported = trimmed.startsWith("pub");
      const startLine = i + 1;
      const endLine = findBraceBlockEnd(lines, i);
      definedSymbols.push({ name, symbolType: "struct", type: "struct", exported, startLine, endLine });
      continue;
    }

    const enumMatch = enumRegex.exec(trimmed);
    if (enumMatch) {
      const name = enumMatch[1];
      const exported = trimmed.startsWith("pub");
      const startLine = i + 1;
      const endLine = findBraceBlockEnd(lines, i);
      definedSymbols.push({ name, symbolType: "enum", type: "enum", exported, startLine, endLine });
      continue;
    }

    const traitMatch = traitRegex.exec(trimmed);
    if (traitMatch && !implRegex.test(trimmed)) {
      const name = traitMatch[1];
      const exported = trimmed.startsWith("pub");
      const startLine = i + 1;
      const endLine = findBraceBlockEnd(lines, i);
      definedSymbols.push({ name, symbolType: "trait", type: "trait", exported, startLine, endLine });
      continue;
    }

    const typeMatch = typeRegex.exec(trimmed);
    if (typeMatch) {
      const name = typeMatch[1];
      definedSymbols.push({
        name,
        symbolType: "type", type: "type",
        exported: trimmed.startsWith("pub"),
        startLine: i + 1,
        endLine: i + 1
      });
    }

    const constMatch = constRegex.exec(trimmed);
    if (constMatch) {
      const name = constMatch[1];
      definedSymbols.push({
        name,
        symbolType: "constant", type: "constant",
        exported: trimmed.startsWith("pub"),
        startLine: i + 1,
        endLine: findSemicolonEnd(lines, i)
      });
    }

    const modMatch = modRegex.exec(trimmed);
    if (modMatch && !lines[i + 1]?.trim().startsWith(";")) {
      const name = modMatch[1];
      definedSymbols.push({
        name,
        symbolType: "module", type: "module",
        exported: trimmed.startsWith("pub"),
        startLine: i + 1,
        endLine: findBraceBlockEnd(lines, i)
      });
    }

    const useMatch = useRegex.exec(trimmed);
    if (useMatch) {
      importPaths.push(useMatch[1]);
    }
  }

  const chunks = createSymbolChunks(definedSymbols, lines, "rust");
  if (chunks.length === 0) {
    return makeFallbackChunks(content, lines);
  }

  return { chunks, importPaths, definedSymbols, calledIdentifiers: [], callExpressions: [] };
}

// ── YAML/JSON/TOML config chunkers ──

export function indexConfig(content: string, language: string): IndexedChunk[] {
  switch (language) {
    case "yaml":
      return parseYamlConfig(content);
    case "json":
      return parseJsonConfig(content);
    case "toml":
      return parseTomlConfig(content);
    default:
      return [];
  }
}

function parseYamlConfig(content: string): IndexedChunk[] {
  const chunks: IndexedChunk[] = [];
  const lines = content.split("\n");

  let currentSection: string[] = [];
  let currentKey = "root";
  let sectionStartLine = 1;

  const flush = (endLine: number) => {
    const text = currentSection.join("\n").trim();
    if (!text) return;

    chunks.push({
      heading: currentKey,
      content: text,
      tokenCount: countTokens(text),
      contentHash: hashContent(text),
      metadata: {
        kind: "config",
        language: "yaml",
        section: currentKey,
        startLine: sectionStartLine,
        endLine
      }
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const topLevelMatch = /^(\w[\w\s.-]*?):/.exec(line);

    if (topLevelMatch && (line.trim() === line || line.startsWith(topLevelMatch[1]))) {
      if (currentSection.length > 0) {
        flush(i);
      }
      currentSection = [line];
      currentKey = topLevelMatch[1].trim();
      sectionStartLine = i + 1;
    } else {
      currentSection.push(line);
    }
  }

  flush(lines.length);

  return chunks;
}

function parseJsonConfig(content: string): IndexedChunk[] {
  const chunks: IndexedChunk[] = [];

  try {
    const parsed = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null) {
      return makeFallbackConfigChunk(content, "json");
    }

    const entries = Object.entries(parsed);
    for (const [key, value] of entries) {
      const text = JSON.stringify(value, null, 2);
      chunks.push({
        heading: key,
        content: text,
        tokenCount: countTokens(text),
        contentHash: hashContent(text),
        metadata: {
          kind: "config",
          language: "json",
          section: key,
          valueType: Array.isArray(value) ? "array" : typeof value
        }
      });
    }

    if (chunks.length === 0) {
      return makeFallbackConfigChunk(content, "json");
    }
  } catch {
    return makeFallbackConfigChunk(content, "json");
  }

  return chunks;
}

function parseTomlConfig(content: string): IndexedChunk[] {
  const chunks: IndexedChunk[] = [];
  const lines = content.split("\n");
  let currentSection: string[] = [];
  let currentKey = "root";
  let sectionStartLine = 1;

  const flush = (endLine: number) => {
    const text = currentSection.join("\n").trim();
    if (!text) return;

    chunks.push({
      heading: currentKey,
      content: text,
      tokenCount: countTokens(text),
      contentHash: hashContent(text),
      metadata: {
        kind: "config",
        language: "toml",
        section: currentKey,
        startLine: sectionStartLine,
        endLine
      }
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const sectionMatch = /^\[([^\]]+)\]/.exec(line.trim());

    if (sectionMatch) {
      if (currentSection.length > 0) {
        flush(i);
      }
      currentSection = [line];
      currentKey = sectionMatch[1];
      sectionStartLine = i + 1;
    } else {
      currentSection.push(line);
    }
  }

  flush(lines.length);

  return chunks;
}

function makeFallbackConfigChunk(content: string, language: string): IndexedChunk[] {
  return [
    {
      content,
      tokenCount: countTokens(content),
      contentHash: hashContent(content),
      metadata: {
        kind: "config",
        language
      }
    }
  ];
}

// ── Helpers ──

function findBlockEnd(lines: string[], startIndex: number): number {
  const trimmed = lines[startIndex].trim();
  if (trimmed.endsWith(":") || trimmed.endsWith("\\")) {
    return findIndentedBlockEnd(lines, startIndex + 1);
  }
  return startIndex + 1;
}

function findIndentedBlockEnd(lines: string[], startIndex: number): number {
  const baseIndent = lines[startIndex]?.search(/\S/) ?? 0;
  if (baseIndent === 0) return startIndex;

  for (let i = startIndex; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    const indent = lines[i].search(/\S/);
    if (indent < baseIndent || indent === 0) {
      return i;
    }
  }
  return lines.length;
}

function findBraceBlockEnd(lines: string[], startIndex: number): number {
  let braceCount = 0;
  let found = false;

  for (let i = startIndex; i < lines.length; i++) {
    for (const char of lines[i]) {
      if (char === "{") {
        braceCount++;
        found = true;
      } else if (char === "}") {
        braceCount--;
      }
    }
    if (found && braceCount <= 0) {
      return i + 1;
    }
  }
  return lines.length;
}

function findSemicolonEnd(lines: string[], startIndex: number): number {
  for (let i = startIndex; i < lines.length; i++) {
    if (lines[i].trim().endsWith(";")) {
      return i + 1;
    }
  }
  return startIndex + 1;
}

function createSymbolChunks(
  symbols: ExtractedSymbol[],
  allLines: string[],
  language: string
): IndexedChunk[] {
  return symbols.map((symbol) => {
    const content = symbol.content || allLines.slice(symbol.startLine - 1, symbol.endLine).join("\n");
    return {
      heading: symbol.name,
      content,
      tokenCount: countTokens(content),
      contentHash: hashContent(content),
      symbolName: symbol.name,
      symbolType: symbol.symbolType,
      metadata: {
        kind: "code",
        language,
        symbolName: symbol.name,
        symbolType: symbol.symbolType,
        exported: symbol.exported,
        startLine: symbol.startLine,
        endLine: symbol.endLine
      }
    };
  });
}

function makeFallbackChunks(content: string, lines: string[]): IndexedCodeResult {
  const chunks: IndexedChunk[] = [];
  for (let index = 0; index < lines.length; index += 80) {
    const slice = lines.slice(index, index + 80).join("\n").trim();
    if (!slice) continue;

    chunks.push({
      content: slice,
      tokenCount: countTokens(slice),
      contentHash: hashContent(slice),
      metadata: {
        kind: "code",
        fallback: true,
        startLine: index + 1,
        endLine: Math.min(index + 80, lines.length)
      }
    });
  }

  return { chunks, importPaths: [], definedSymbols: [], calledIdentifiers: [], callExpressions: [] };
}
