import path from "node:path";

import { countTokens } from "@openez-graph/core";

import { hashContent } from "./hash";
import type { IndexedChunk } from "./types";

function codeSearchText(text: string): string {
  const identifiers = text.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
  return [...new Set(identifiers.flatMap((identifier) => identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/_/g, " ")
    .split(" ")
    .filter((term) => term.length > 1)))]
    .slice(0, 256)
    .join(" ");
}

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
  decorators?: string[];
  receiver?: string;
}

export interface IndexedCodeResult {
  chunks: IndexedChunk[];
  importPaths: string[];
  definedSymbols: ExtractedSymbol[];
  calledIdentifiers: string[];
  callExpressions: Array<{ callerName: string; calleeName: string }>;
}

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  while (text[index - slashes - 1] === "\\") slashes++;
  return slashes % 2 === 1;
}

function stripNonCode(
  content: string,
  options: { hashComments?: boolean; backtickStrings?: boolean; tripleStrings?: boolean; rustLifetimes?: boolean } = {}
): string {
  let result = "";
  let quote = "";
  let blockComment = false;
  let lineComment = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const next = content[i + 1];
    const triple = content.slice(i, i + 3);

    if (char === "\n") {
      result += "\n";
      lineComment = false;
      continue;
    }

    if (lineComment) {
      result += " ";
      continue;
    }

    if (blockComment) {
      result += " ";
      if (char === "*" && next === "/") {
        result += " ";
        blockComment = false;
        i++;
      }
      continue;
    }

    if (quote) {
      result += " ";
      if (quote.length === 3 && triple === quote) {
        result += "  ";
        quote = "";
        i += 2;
      } else if (quote.length === 1 && char === quote && !isEscaped(content, i)) {
        quote = "";
      }
      continue;
    }

    if (options.hashComments && char === "#") {
      result += " ";
      lineComment = true;
    } else if (!options.hashComments && char === "/" && next === "/") {
      result += "  ";
      lineComment = true;
      i++;
    } else if (!options.hashComments && char === "/" && next === "*") {
      result += "  ";
      blockComment = true;
      i++;
    } else if (options.tripleStrings && (triple === "\"\"\"" || triple === "'''")) {
      result += "   ";
      quote = triple;
      i += 2;
    } else if (options.rustLifetimes && char === "'" && /[A-Za-z_]/.test(next ?? "") && content[i + 2] !== "'") {
      result += char;
    } else if (char === "\"" || char === "'" || (options.backtickStrings && char === "`")) {
      result += " ";
      quote = char;
    } else {
      result += char;
    }
  }

  return result;
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
  const codeLines = stripNonCode(content, { hashComments: true, tripleStrings: true }).split("\n");
  const definedSymbols: ExtractedSymbol[] = [];
  const importPaths: string[] = [];
  const calledIdentifiers = new Set<string>();
  const callExpressions: Array<{ callerName: string; calleeName: string }> = [];

  const symbolRegex = /^(?:async\s+)?(?:def|class)\s+(\w+)/;
  const callRegex = /(\w+(?:\.\w+)*)\s*\(/g;
  const decoratorRegex = /^@(\w+(?:\.\w+)*)/;

  let pendingDecorators: Array<{ name: string; lineIndex: number }> = [];
  const symbolStack: Array<{ name: string; endLine: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    while (symbolStack.length > 0 && i >= symbolStack[symbolStack.length - 1].endLine) {
      symbolStack.pop();
    }

    const trimmed = codeLines[i].trim();

    const decoratorMatch = decoratorRegex.exec(trimmed);
    if (decoratorMatch) {
      pendingDecorators.push({ name: decoratorMatch[1], lineIndex: i });
      const decoratorCalls = decoratorMatch[1];
      const decoratorCalledName = normalizePythonCallName(decoratorCalls);
      if (!PYTHON_CALL_IGNORES.has(decoratorCalledName)) {
        calledIdentifiers.add(decoratorCalledName);
      }
      continue;
    }

    const symbolMatch = symbolRegex.exec(trimmed);
    if (symbolMatch) {
      const rawName = symbolMatch[1];
      const isAsync = trimmed.startsWith("async");
      const stripped = isAsync ? trimmed.slice(6) : trimmed;
      const symbolType = stripped.startsWith("def") ? "function" : "class";
      const exported = !rawName.startsWith("_");
      const endLine = findBlockEnd(codeLines, i);

      const parentName = symbolStack.length > 0 ? symbolStack[symbolStack.length - 1].name : null;
      const name = parentName ? `${parentName}::${rawName}` : rawName;

      const decoratorNames = pendingDecorators.map((d) => d.name);
      const decoratorStartLine = pendingDecorators.length > 0
        ? pendingDecorators[0].lineIndex + 1
        : i + 1;
      const startLine = decoratorStartLine;

      const content = lines.slice(startLine - 1, endLine).join("\n");

      definedSymbols.push({ name, symbolType, type: symbolType, exported, startLine, endLine, decorators: decoratorNames });

      const bodyContent = codeLines.slice(i, endLine).join("\n");
      let callMatch;
      const localCallRegex = new RegExp(callRegex);
      while ((callMatch = localCallRegex.exec(bodyContent)) !== null) {
        const rawCalledName = callMatch[1];
        const calledName = normalizePythonCallName(rawCalledName);
        if (!PYTHON_CALL_IGNORES.has(rawCalledName) && !PYTHON_CALL_IGNORES.has(calledName) && calledName !== rawName && calledName !== name) {
          calledIdentifiers.add(calledName);
          callExpressions.push({ callerName: name, calleeName: calledName });
        }
      }

      for (const dec of pendingDecorators) {
        const decCalledName = normalizePythonCallName(dec.name);
        if (!PYTHON_CALL_IGNORES.has(decCalledName) && decCalledName !== name) {
          calledIdentifiers.add(decCalledName);
          callExpressions.push({ callerName: name, calleeName: decCalledName });
        }

        const decLine = codeLines[dec.lineIndex];
        let decCallMatch;
        const decCallRegex = new RegExp(callRegex);
        while ((decCallMatch = decCallRegex.exec(decLine)) !== null) {
          const rawCalledName = decCallMatch[1];
          const calledName = normalizePythonCallName(rawCalledName);
          if (!PYTHON_CALL_IGNORES.has(rawCalledName) && !PYTHON_CALL_IGNORES.has(calledName) && calledName !== name && calledName !== decCalledName) {
            calledIdentifiers.add(calledName);
            callExpressions.push({ callerName: name, calleeName: calledName });
          }
        }
      }

      pendingDecorators = [];
      symbolStack.push({ name, endLine });
    }

    importPaths.push(...parsePythonImportLine(line));
  }

  const chunks = createSymbolChunks(definedSymbols, lines, "python");
  if (chunks.length === 0) {
    return { ...makeFallbackChunks(content, lines), importPaths: [...new Set(importPaths)] };
  }

  return { chunks, importPaths: [...new Set(importPaths)], definedSymbols, calledIdentifiers: [...calledIdentifiers], callExpressions };
}

// ── Go parser ──

const GO_CALL_IGNORES = new Set([
  "if", "for", "switch", "select", "case", "go", "defer", "return",
  "make", "len", "cap", "append", "copy", "delete", "panic", "recover",
  "new", "print", "println", "close", "complex", "real", "imag"
]);

function normalizeGoCallName(value: string): string {
  const parts = value.split(".").filter(Boolean);
  return parts[parts.length - 1] ?? value;
}

function parseGoImports(lines: string[]): string[] {
  const imports: string[] = [];
  const singleImportRegex = /^import\s+(?:[.\w]+\s+)?"([^"]+)"/;
  const groupedImportPathRegex = /^\s*(?:[.\w]+\s+)?"([^"]+)"/;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    if (trimmed === "import (" || /^import\s*\(/.test(trimmed)) {
      for (let j = i + 1; j < lines.length; j++) {
        const innerTrimmed = lines[j].trim();
        if (innerTrimmed === ")") break;

        const pathMatch = groupedImportPathRegex.exec(lines[j]);
        if (pathMatch) {
          imports.push(pathMatch[1]);
        }
      }
      continue;
    }

    const singleMatch = singleImportRegex.exec(trimmed);
    if (singleMatch) {
      imports.push(singleMatch[1]);
    }
  }

  return imports;
}

export function parseGo(content: string): IndexedCodeResult {
  const lines = content.split("\n");
  const codeLines = stripNonCode(content, { backtickStrings: true }).split("\n");
  const definedSymbols: ExtractedSymbol[] = [];
  const calledIdentifiers = new Set<string>();
  const callExpressions: Array<{ callerName: string; calleeName: string }> = [];

  const funcRegex = /^func\s+(?:\(([^)]*)\)\s+)?(\w+)/;
  const typeRegex = /^type\s+(\w+)\s+(?:struct|interface|func|map|chan|\w+)/;
  const constVarRegex = /^(?:const|var)\s+(\w+)/;
  const callRegex = /(\w+(?:\.\w+)*)\s*\(/g;

  const importPaths = parseGoImports(lines);

  for (let i = 0; i < lines.length; i++) {
    const trimmed = codeLines[i].trim();

    const funcMatch = funcRegex.exec(trimmed);
    if (funcMatch) {
      const receiver = funcMatch[1]?.trim();
      const name = funcMatch[2];
      const receiverParts = receiver?.match(/[A-Za-z_]\w*/g) ?? [];
      const receiverName = receiverParts[0];
      const receiverType = receiverParts[receiverParts.length - 1];
      const exported = name[0] >= "A" && name[0] <= "Z";
      const startLine = i + 1;
      const endLine = findBraceBlockEnd(codeLines, i);
      const symbolName = receiverType ? `${receiverType}::${name}` : name;
      definedSymbols.push({
        name: symbolName,
        symbolType: "function", type: "function",
        exported,
        startLine,
        endLine,
        ...(receiver ? { receiver: receiver.trim() } : {})
      });

      const bodyContent = codeLines.slice(i, endLine).join("\n");
      let callMatch;
      const localCallRegex = new RegExp(callRegex);
      while ((callMatch = localCallRegex.exec(bodyContent)) !== null) {
        const rawCalledName = callMatch[1];
        const calledName = normalizeGoCallName(rawCalledName);
        const calleeName = receiverName && rawCalledName.startsWith(`${receiverName}.`) && receiverType
          ? `${receiverType}::${calledName}`
          : calledName;
        if (!GO_CALL_IGNORES.has(rawCalledName) && !GO_CALL_IGNORES.has(calledName) && calleeName !== symbolName) {
          calledIdentifiers.add(calleeName);
          callExpressions.push({ callerName: symbolName, calleeName });
        }
      }
      continue;
    }

    const typeMatch = typeRegex.exec(trimmed);
    if (typeMatch) {
      const name = typeMatch[1];
      const exported = name[0] >= "A" && name[0] <= "Z";
      const startLine = i + 1;
      const endLine = findBraceBlockEnd(codeLines, i);
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
  }

  const chunks = createSymbolChunks(definedSymbols, lines, "go");
  if (chunks.length === 0) {
    return { ...makeFallbackChunks(content, lines), importPaths };
  }

  return { chunks, importPaths, definedSymbols, calledIdentifiers: [...calledIdentifiers], callExpressions };
}

// ── Rust parser ──

const RUST_CALL_IGNORES = new Set([
  "if", "while", "for", "loop", "match", "return", "let", "as", "in",
  "println", "print", "eprintln", "eprint", "format", "vec", "Box", "Some", "None", "Ok", "Err"
]);

function normalizeRustCallName(value: string): string {
  const parts = value.split("::").filter(Boolean);
  const last = parts[parts.length - 1] ?? value;
  const dotParts = last.split(".");
  return dotParts[dotParts.length - 1] ?? last;
}

export function parseRust(content: string): IndexedCodeResult {
  const lines = content.split("\n");
  const codeLines = stripNonCode(content, { rustLifetimes: true }).split("\n");
  const definedSymbols: ExtractedSymbol[] = [];
  const importPaths: string[] = [];
  const calledIdentifiers = new Set<string>();
  const callExpressions: Array<{ callerName: string; calleeName: string }> = [];

  const fnRegex = /^(?:pub\s+)?(?:unsafe\s+)?(?:async\s+)?fn\s+(\w+)/;
  const structRegex = /^(?:pub\s+)?struct\s+(\w+)/;
  const enumRegex = /^(?:pub\s+)?enum\s+(\w+)/;
  const traitRegex = /^(?:pub\s+)?trait\s+(\w+)/;
  const implRegex = /^(?:pub\s+)?impl\s+(?:<[^>]+>\s+)?([\w<>:,\s]+?)\s*(?:\{|for\s+)/;
  const implForRegex = /^(?:pub\s+)?impl\s+(?:<[^>]+>\s+)?(\w+)\s+for\s+([\w]+(?:<[^>]+>)?)/;
  const typeRegex = /^(?:pub\s+)?type\s+(\w+)/;
  const constRegex = /^(?:pub\s+)?(?:const|static)\s+(\w+)/;
  const modRegex = /^(?:pub\s+)?mod\s+(\w+)/;
  const useRegex = /^(?:pub(?:\([^)]*\))?\s+)?use\s+(.+?);?$/;
  const callRegex = /(\w+(?:::\w+)*(?:\.\w+)*)\s*\(/g;

  let implContext: string | null = null;
  let implBraceDepth = 0;
  let traitContext: string | null = null;
  let traitBraceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = codeLines[i].trim();

    if (implContext) {
      implBraceDepth += countBraces(codeLines[i]);
      if (implBraceDepth <= 0) {
        implContext = null;
        implBraceDepth = 0;
        continue;
      }
    }

    if (traitContext) {
      traitBraceDepth += countBraces(codeLines[i]);
      if (traitBraceDepth <= 0) {
        traitContext = null;
        traitBraceDepth = 0;
        continue;
      }
    }

    const implForMatch = implForRegex.exec(trimmed);
    if (implForMatch) {
      const traitName = implForMatch[1];
      const typeName = implForMatch[2].trim();
      const startLine = i + 1;
      const endLine = findBraceBlockEnd(codeLines, i);
      definedSymbols.push({
        name: `impl ${traitName} for ${typeName}`,
        symbolType: "impl", type: "impl",
        exported: false,
        startLine,
        endLine
      });
      implContext = typeName;
      implBraceDepth = countBraces(codeLines[i]);
      if (implBraceDepth <= 0) implContext = null;
      continue;
    }

    const implMatch = implRegex.exec(trimmed);
    if (implMatch && !implForMatch) {
      const typeName = implMatch[1].trim();
      const startLine = i + 1;
      const endLine = findBraceBlockEnd(codeLines, i);
      definedSymbols.push({
        name: `impl ${typeName}`,
        symbolType: "impl", type: "impl",
        exported: false,
        startLine,
        endLine
      });
      implContext = typeName;
      implBraceDepth = countBraces(codeLines[i]);
      if (implBraceDepth <= 0) implContext = null;
      continue;
    }

    const fnMatch = fnRegex.exec(trimmed);
    if (fnMatch) {
      const name = fnMatch[1];
      const exported = trimmed.startsWith("pub");
      const startLine = i + 1;
      const endLine = trimmed.endsWith(";") ? i + 1 : findBraceBlockEnd(codeLines, i);
      const symbolName = implContext
        ? `${implContext}::${name}`
        : traitContext
          ? `${traitContext}::${name}`
          : name;
      definedSymbols.push({ name: symbolName, symbolType: "function", type: "function", exported, startLine, endLine });

      const bodyContent = codeLines.slice(i, endLine).join("\n");
      let callMatch;
      const localCallRegex = new RegExp(callRegex);
      while ((callMatch = localCallRegex.exec(bodyContent)) !== null) {
        const rawCalledName = callMatch[1];
        const calledName = normalizeRustCallName(rawCalledName);
        if (!RUST_CALL_IGNORES.has(rawCalledName) && !RUST_CALL_IGNORES.has(calledName) && calledName !== name && calledName !== symbolName) {
          calledIdentifiers.add(calledName);
          callExpressions.push({ callerName: symbolName, calleeName: calledName });
        }
      }
      continue;
    }

    const structMatch = structRegex.exec(trimmed);
    if (structMatch) {
      const name = structMatch[1];
      const exported = trimmed.startsWith("pub");
      const startLine = i + 1;
      const endLine = findBraceBlockEnd(codeLines, i);
      definedSymbols.push({ name, symbolType: "struct", type: "struct", exported, startLine, endLine });
      continue;
    }

    const enumMatch = enumRegex.exec(trimmed);
    if (enumMatch) {
      const name = enumMatch[1];
      const exported = trimmed.startsWith("pub");
      const startLine = i + 1;
      const endLine = findBraceBlockEnd(codeLines, i);
      definedSymbols.push({ name, symbolType: "enum", type: "enum", exported, startLine, endLine });
      continue;
    }

    const traitMatch = traitRegex.exec(trimmed);
    if (traitMatch && !implRegex.test(trimmed) && !implForRegex.test(trimmed)) {
      const name = traitMatch[1];
      const exported = trimmed.startsWith("pub");
      const startLine = i + 1;
      const endLine = findBraceBlockEnd(codeLines, i);
      definedSymbols.push({ name, symbolType: "trait", type: "trait", exported, startLine, endLine });
      traitContext = name;
      traitBraceDepth = countBraces(codeLines[i]);
      if (traitBraceDepth <= 0) traitContext = null;
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
    if (modMatch) {
      const name = modMatch[1];
      definedSymbols.push({
        name,
        symbolType: "module", type: "module",
        exported: trimmed.startsWith("pub"),
        startLine: i + 1,
        endLine: trimmed.endsWith(";") ? i + 1 : findBraceBlockEnd(codeLines, i)
      });
    }

    const useMatch = useRegex.exec(trimmed);
    if (useMatch) {
      importPaths.push(useMatch[1].replace(/;$/, ""));
    }
  }

  const chunks = createSymbolChunks(definedSymbols, lines, "rust");
  if (chunks.length === 0) {
    return { ...makeFallbackChunks(content, lines), importPaths };
  }

  return { chunks, importPaths, definedSymbols, calledIdentifiers: [...calledIdentifiers], callExpressions };
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
  let sectionIndent = 0;

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
    if (line.trim() === "" || line.trim().startsWith("#")) {
      currentSection.push(line);
      continue;
    }

    const indent = line.search(/\S/);
    const keyMatch = /^(\s*)([\w][\w\s.-]*?):(\s|$)/.exec(line);
    const bareListItemMatch = /^(\s*)-\s/.exec(line);

    const isTopLevel = indent === 0;
    const isListSection = bareListItemMatch && indent < sectionIndent;

    if ((keyMatch && isTopLevel) || isListSection) {
      if (currentSection.length > 0) {
        flush(i);
      }
      currentSection = [line];
      currentKey = keyMatch ? keyMatch[2].trim() : `list-item-${i + 1}`;
      sectionStartLine = i + 1;
      sectionIndent = indent;
    } else if (keyMatch && indent < sectionIndent) {
      if (currentSection.length > 0) {
        flush(i);
      }
      currentSection = [line];
      currentKey = keyMatch[2].trim();
      sectionStartLine = i + 1;
      sectionIndent = indent;
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
  let isArrayTable = false;

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
        arrayTable: isArrayTable,
        startLine: sectionStartLine,
        endLine
      }
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === "" || trimmed.startsWith("#")) {
      currentSection.push(line);
      continue;
    }

    const arrayTableMatch = /^\[\[([^\]]+)\]\]/.exec(trimmed);
    const tableMatch = /^\[([^\]]+)\]/.exec(trimmed);

    if (arrayTableMatch) {
      if (currentSection.length > 0) {
        flush(i);
      }
      currentSection = [line];
      currentKey = arrayTableMatch[1];
      isArrayTable = true;
      sectionStartLine = i + 1;
    } else if (tableMatch) {
      if (currentSection.length > 0) {
        flush(i);
      }
      currentSection = [line];
      currentKey = tableMatch[1];
      isArrayTable = false;
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

function countBraces(line: string): number {
  let count = 0;
  for (const char of line) {
    if (char === "{") count++;
    else if (char === "}") count--;
  }
  return count;
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
        searchText: codeSearchText(content),
        language,
        symbolName: symbol.name,
        symbolType: symbol.symbolType,
        exported: symbol.exported,
        startLine: symbol.startLine,
        endLine: symbol.endLine,
        ...(symbol.decorators && symbol.decorators.length > 0 ? { decorators: symbol.decorators } : {})
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
        searchText: codeSearchText(slice),
        fallback: true,
        startLine: index + 1,
        endLine: Math.min(index + 80, lines.length)
      }
    });
  }

  return { chunks, importPaths: [], definedSymbols: [], calledIdentifiers: [], callExpressions: [] };
}
