import path from "node:path";

import { exactTokenCounter, type TokenCounter } from "@openez-graph/core";

import { hashContent } from "./hash";
import { extractPythonBindings, pythonImpliedImportPaths } from "./python-resolver";
import type { IndexedChunk } from "./types";

export function codeSearchText(text: string): string {
  const terms = text.match(/[A-Z]?[a-z0-9]+|[A-Z]+(?=[A-Z][a-z]|\b)/g) ?? [];
  const unique = new Set<string>();
  for (let i = 0; i < terms.length && unique.size < 256; i++) {
    const term = terms[i].toLowerCase();
    if (term.length > 1) unique.add(term);
  }
  return Array.from(unique).join(" ");
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
  [".rs", "rust"],
  [".rb", "ruby"],
  [".rake", "ruby"],
  [".gemspec", "ruby"],
  // C++ (no C parser exists, so `.h` maps to cpp; lowercase `.c` stays
  // unindexed). Uppercase `.C` is added here too — `inferDocumentKind`
  // preserves the raw-case extension for this key.
  [".cpp", "cpp"],
  [".cc", "cpp"],
  [".cxx", "cpp"],
  [".c++", "cpp"],
  [".hpp", "cpp"],
  [".hh", "cpp"],
  [".hxx", "cpp"],
  [".h++", "cpp"],
  [".h", "cpp"],
  [".C", "cpp"],
]);

export const configExtensions = new Map<string, string>([
  [".yaml", "yaml"],
  [".yml", "yaml"],
  [".json", "json"],
  [".toml", "toml"],
]);

export const styleExtensions = new Map<string, string>([
  [".css", "css"],
  [".scss", "scss"],
  [".sass", "scss"],
  [".less", "less"],
]);

export const templateExtensions = new Map<string, string>([
  [".slim", "slim"],
  [".haml", "haml"],
]);

export const scriptExtensions = new Map<string, string>([
  [".coffee", "coffeescript"],
  [".litcoffee", "coffeescript"],
]);

export const markdownExtensions = new Set([".md", ".mdx"]);

export interface LanguageInfo {
  kind: "markdown" | "code" | "config" | "text";
  language: string | null;
  extension: string;
}

export function inferDocumentKind(filePath: string): LanguageInfo {
  const rawExtension = path.extname(filePath);
  // `.C` is the only case-sensitive C++ extension — keep its raw case so it
  // can map to cpp while lowercase `.c` remains unindexed.
  const extension = rawExtension === ".C" ? rawExtension : rawExtension.toLowerCase();

  if (markdownExtensions.has(extension)) {
    return { kind: "markdown", language: "markdown", extension };
  }

  if (codeExtensions.has(extension)) {
    return { kind: "code", language: codeExtensions.get(extension) ?? null, extension };
  }

  if (styleExtensions.has(extension)) {
    return { kind: "code", language: styleExtensions.get(extension) ?? null, extension };
  }

  if (templateExtensions.has(extension)) {
    return { kind: "code", language: templateExtensions.get(extension) ?? null, extension };
  }

  if (scriptExtensions.has(extension)) {
    return { kind: "code", language: scriptExtensions.get(extension) ?? null, extension };
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
  options: {
    hashComments?: boolean;
    backtickStrings?: boolean;
    tripleStrings?: boolean;
    rawStrings?: boolean;
    byteStrings?: boolean;
  } = {},
): string {
  let result = content;
  if (options.tripleStrings) {
    result = result.replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, (m) => m.replace(/[^\n]/g, " "));
  }
  if (options.hashComments) {
    result = result.replace(/#[^\n]*/g, (m) => " ".repeat(m.length));
  } else {
    result = result
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
  }
  if (options.backtickStrings) {
    result = result.replace(/`[\s\S]*?`/g, (m) => m.replace(/[^\n]/g, " "));
  }
  if (options.rawStrings) {
    result = result.replace(/r(#*)"[\s\S]*?"\1/g, (m) => m.replace(/[^\n]/g, " "));
  }
  result = result
    .replace(/"(?:\\.|[^"\\])*"/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/'(?:\\.|[^'\\])*'/g, (m) => m.replace(/[^\n]/g, " "));
  return result;
}

// ── Python parser ──

/** Last dotted segment — `calledIdentifiers` keep final segments while
 *  `callExpressions[].calleeName` keeps the qualifier for the resolver. */
function pythonCallIdentifier(value: string): string {
  const parts = value.split(".").filter(Boolean);
  return parts[parts.length - 1] ?? value;
}

const PYTHON_CALL_IGNORES = new Set([
  "if",
  "for",
  "while",
  "with",
  "return",
  "yield",
  "print",
  "len",
  "range",
  "str",
  "int",
  "float",
  "list",
  "dict",
  "set",
  "tuple",
  "bool",
  "isinstance",
  "issubclass",
  "super",
  "self",
  "cls",
]);

export function parsePython(
  content: string,
  counter: TokenCounter = exactTokenCounter,
): IndexedCodeResult {
  const lines = content.split("\n");
  const codeLines = stripNonCode(content, { hashComments: true, tripleStrings: true }).split("\n");
  const definedSymbols: ExtractedSymbol[] = [];
  // Import paths are implied by the shared binding extractor so multiline
  // parenthesized imports and relative imports (`from . import x` → `.x`)
  // match the tree-sitter parsers.
  const importPaths = pythonImpliedImportPaths(extractPythonBindings(content));
  const calledIdentifiers = new Set<string>();
  const callExpressions: Array<{ callerName: string; calleeName: string }> = [];

  const symbolRegex = /^(?:async\s+)?(?:def|class)\s+(\w+)/;
  const callRegex = /(\w+(?:\.\w+)*)\s*\(/g;
  const decoratorRegex = /^@(\w+(?:\.\w+)*)/;

  let pendingDecorators: Array<{ name: string; lineIndex: number }> = [];
  const symbolStack: Array<{ name: string; endLine: number }> = [];

  // A `name(` match is a call only when the root is an identifier — `.name(`
  // after `)`, `]`, `}`, or a string quote belongs to a call result or
  // literal (`super().x()`, `x[0].y()`).
  const callHasNameRoot = (lineStr: string, index: number): boolean => {
    if (lineStr[index - 1] !== ".") return true;
    const before = lineStr[index - 2];
    return before === undefined || /[\w]/.test(before);
  };

  for (let i = 0; i < lines.length; i++) {
    while (symbolStack.length > 0 && i >= symbolStack[symbolStack.length - 1].endLine) {
      symbolStack.pop();
    }

    const trimmed = codeLines[i].trim();

    const decoratorMatch = decoratorRegex.exec(trimmed);
    if (decoratorMatch) {
      pendingDecorators.push({ name: decoratorMatch[1], lineIndex: i });
      const decoratorCalls = decoratorMatch[1];
      const decoratorCalledName = pythonCallIdentifier(decoratorCalls);
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
      const decoratorStartLine =
        pendingDecorators.length > 0 ? pendingDecorators[0].lineIndex + 1 : i + 1;
      const startLine = decoratorStartLine;

      const content = lines.slice(startLine - 1, endLine).join("\n");

      definedSymbols.push({
        name,
        symbolType,
        type: symbolType,
        exported,
        startLine,
        endLine,
        decorators: decoratorNames,
      });

      for (let lineIdx = i; lineIdx < endLine; lineIdx++) {
        const lineStr = codeLines[lineIdx];
        if (lineIdx > i) {
          const innerTrimmed = lineStr.trim();
          // Skip nested definitions and their decorator lines entirely —
          // their calls are attributed to the nested symbol's own scan.
          if (decoratorRegex.test(innerTrimmed)) continue;
          if (symbolRegex.test(innerTrimmed)) {
            lineIdx = findBlockEnd(codeLines, lineIdx) - 1;
            continue;
          }
        }
        callRegex.lastIndex = 0;
        let callMatch: RegExpExecArray | null;
        while ((callMatch = callRegex.exec(lineStr)) !== null) {
          const rawCalledName = callMatch[1];
          if (!callHasNameRoot(lineStr, callMatch.index)) continue;
          const calledName = pythonCallIdentifier(rawCalledName);
          if (
            !PYTHON_CALL_IGNORES.has(rawCalledName) &&
            !PYTHON_CALL_IGNORES.has(calledName) &&
            rawCalledName !== name &&
            !(lineIdx === i && rawCalledName === rawName)
          ) {
            calledIdentifiers.add(calledName);
            callExpressions.push({ callerName: name, calleeName: rawCalledName });
          }
        }
      }

      for (const dec of pendingDecorators) {
        const decIdentifier = pythonCallIdentifier(dec.name);
        if (
          !PYTHON_CALL_IGNORES.has(dec.name) &&
          !PYTHON_CALL_IGNORES.has(decIdentifier) &&
          dec.name !== name
        ) {
          calledIdentifiers.add(decIdentifier);
          callExpressions.push({ callerName: name, calleeName: dec.name });
        }

        const decLine = codeLines[dec.lineIndex];
        let decCallMatch;
        const decCallRegex = new RegExp(callRegex);
        while ((decCallMatch = decCallRegex.exec(decLine)) !== null) {
          const rawCalledName = decCallMatch[1];
          if (!callHasNameRoot(decLine, decCallMatch.index)) continue;
          const calledName = pythonCallIdentifier(rawCalledName);
          if (
            !PYTHON_CALL_IGNORES.has(rawCalledName) &&
            !PYTHON_CALL_IGNORES.has(calledName) &&
            rawCalledName !== name &&
            rawCalledName !== dec.name
          ) {
            calledIdentifiers.add(calledName);
            callExpressions.push({ callerName: name, calleeName: rawCalledName });
          }
        }
      }

      pendingDecorators = [];
      symbolStack.push({ name, endLine });
    }
  }

  const chunks = createSymbolChunks(definedSymbols, lines, "python", counter);
  if (chunks.length === 0) {
    return {
      ...makeFallbackChunks(content, lines, counter),
      importPaths,
    };
  }

  return {
    chunks,
    importPaths,
    definedSymbols,
    calledIdentifiers: [...calledIdentifiers],
    callExpressions,
  };
}

// ── Go parser ──

const GO_CALL_IGNORES = new Set([
  "if",
  "for",
  "switch",
  "select",
  "case",
  "go",
  "defer",
  "return",
  "make",
  "len",
  "cap",
  "append",
  "copy",
  "delete",
  "panic",
  "recover",
  "new",
  "print",
  "println",
  "close",
  "complex",
  "real",
  "imag",
]);

function normalizeGoCallName(value: string): string {
  // Strip generic instantiation (`pkg.F[T]` → `pkg.F`); keep the selector so
  // graph resolution can map the qualifier to an import binding.
  return value.split("[")[0] ?? value;
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

export function parseGo(
  content: string,
  counter: TokenCounter = exactTokenCounter,
): IndexedCodeResult {
  const lines = content.split("\n");
  const codeLines = stripNonCode(content, { backtickStrings: true }).split("\n");
  const definedSymbols: ExtractedSymbol[] = [];
  const calledIdentifiers = new Set<string>();
  const callExpressions: Array<{ callerName: string; calleeName: string }> = [];

  const funcRegex = /^func\s+(?:\(([^)]*)\)\s+)?(\w+)/;
  const typeRegex = /^type\s+(\w+)\s+(?:struct|interface|func|map|chan|\w+)/;
  const constVarRegex = /^(?:const|var)\s+(\w+(?:\s*,\s*\w+)*)/;
  const constVarGroupStart = /^(const|var)\s*\(/;
  const constVarGroupEnd = /^\)/;
  const constVarSpecRegex = /^(\w+(?:\s*,\s*\w+)*)/;
  const callRegex = /(\w+(?:\.\w+)*)\s*(?:\[[^\]]*\])?\s*\(/g;

  const importPaths = parseGoImports(lines);
  let inConstVarGroup: "const" | "var" | null = null;
  const activeFunctions: Array<{
    name: string;
    symbolName: string;
    receiverName?: string;
    receiverType?: string;
    endLine: number;
  }> = [];

  for (let i = 0; i < codeLines.length; i++) {
    const currentLineNum = i + 1;
    const lineStr = codeLines[i];
    const trimmed = lineStr.trim();

    while (
      activeFunctions.length > 0 &&
      activeFunctions[activeFunctions.length - 1].endLine < currentLineNum
    ) {
      activeFunctions.pop();
    }

    const funcMatch = funcRegex.exec(trimmed);
    if (funcMatch) {
      const receiver = funcMatch[1]?.trim();
      const name = funcMatch[2];
      // `(s *Stack[T])` → var `s`, type `Stack[T]` — whitespace split keeps
      // the generic arguments like the tree-sitter paths.
      const receiverParts =
        receiver
          ?.replace(/^\(+|\)+$/g, "")
          .trim()
          .split(/\s+/) ?? [];
      const receiverName = receiverParts[0];
      const receiverType = receiverParts[receiverParts.length - 1]?.replace(/^\*/, "");
      const exported = name[0] >= "A" && name[0] <= "Z";
      const startLine = currentLineNum;
      const endLine = findBraceBlockEnd(codeLines, i);
      const symbolName = receiverType ? `${receiverType}::${name}` : name;
      definedSymbols.push({
        name: symbolName,
        symbolType: "function",
        type: "function",
        exported,
        startLine,
        endLine,
        ...(receiver ? { receiver: receiver.trim() } : {}),
      });
      if (endLine > currentLineNum) {
        activeFunctions.push({ name, symbolName, receiverName, receiverType, endLine });
      }
    }

    const typeMatch = typeRegex.exec(trimmed);
    if (typeMatch) {
      const name = typeMatch[1];
      const exported = name[0] >= "A" && name[0] <= "Z";
      const startLine = currentLineNum;
      const endLine = findBraceBlockEnd(codeLines, i);
      definedSymbols.push({
        name,
        symbolType: "type",
        type: "type",
        exported,
        startLine,
        endLine,
      });
    }

    // Package-level const/var symbols only — locals inside a function body
    // are not graph symbols. Grouped specs (`const ( ... )`) yield one symbol
    // per identifier; the blank identifier is skipped.
    const groupStart = constVarGroupStart.exec(trimmed);
    if (groupStart && activeFunctions.length === 0) {
      inConstVarGroup = groupStart[1] as "const" | "var";
    } else if (inConstVarGroup) {
      if (constVarGroupEnd.test(trimmed)) {
        inConstVarGroup = null;
      } else if (activeFunctions.length === 0) {
        const specMatch = constVarSpecRegex.exec(trimmed);
        if (specMatch) {
          for (const name of specMatch[1].split(",").map((n) => n.trim())) {
            if (name === "_") continue;
            const exported = name[0] >= "A" && name[0] <= "Z";
            definedSymbols.push({
              name,
              symbolType: inConstVarGroup,
              type: inConstVarGroup,
              exported,
              startLine: currentLineNum,
              endLine: currentLineNum,
            });
          }
        }
      }
    }
    const cvMatch = constVarRegex.exec(trimmed);
    if (cvMatch && !groupStart && activeFunctions.length === 0) {
      const kind = trimmed.startsWith("const") ? "const" : "var";
      for (const name of cvMatch[1].split(",").map((n) => n.trim())) {
        if (name === "_") continue;
        const exported = name[0] >= "A" && name[0] <= "Z";
        definedSymbols.push({
          name,
          symbolType: kind,
          type: kind,
          exported,
          startLine: currentLineNum,
          endLine: currentLineNum,
        });
      }
    }

    if (activeFunctions.length > 0) {
      const active = activeFunctions[activeFunctions.length - 1];
      callRegex.lastIndex = 0;
      let callMatch: RegExpExecArray | null;
      while ((callMatch = callRegex.exec(lineStr)) !== null) {
        const rawCalledName = callMatch[1];
        const calledName = normalizeGoCallName(rawCalledName);
        const calleeName =
          active.receiverName &&
          rawCalledName.startsWith(`${active.receiverName}.`) &&
          active.receiverType
            ? `${active.receiverType}::${calledName.split(".").pop()}`
            : calledName;
        if (
          !GO_CALL_IGNORES.has(rawCalledName) &&
          !GO_CALL_IGNORES.has(calledName) &&
          calleeName !== active.symbolName
        ) {
          calledIdentifiers.add(calleeName);
          callExpressions.push({ callerName: active.symbolName, calleeName });
        }
      }
    }
  }

  const chunks = createSymbolChunks(definedSymbols, lines, "go", counter);
  if (chunks.length === 0) {
    return { ...makeFallbackChunks(content, lines, counter), importPaths };
  }

  return {
    chunks,
    importPaths,
    definedSymbols,
    calledIdentifiers: [...calledIdentifiers],
    callExpressions,
  };
}

// ── Rust parser ──

const RUST_CALL_IGNORES = new Set([
  "if",
  "while",
  "for",
  "loop",
  "match",
  "return",
  "let",
  "as",
  "in",
  "println",
  "print",
  "eprintln",
  "eprint",
  "format",
  "vec",
  "Box",
  "Some",
  "None",
  "Ok",
  "Err",
  "String",
  "str",
  "Vec",
  "Option",
  "Result",
  "self",
  "Self",
  "true",
  "false",
]);

const RUST_CALL_PATH_REGEX = /^\w+(?:::\w+)*(?:\.\w+)*$/;

function stripRustTurbofish(value: string): string {
  let result = "";
  let depth = 0;
  for (let i = 0; i < value.length; i++) {
    if (depth === 0 && value.startsWith("::<", i)) {
      depth = 1;
      i += 2;
      continue;
    }
    if (depth > 0) {
      if (value[i] === "<") depth++;
      else if (value[i] === ">") depth--;
      continue;
    }
    result += value[i];
  }
  return result;
}

/**
 * Preserve the qualified Rust call path (`crate::util::run`, `x.run`,
 * `Self::new`) with whitespace removed and turbofish arguments stripped
 * (`parse::<u8>` → `parse`). Returns "" when the callee is not a plain
 * identifier path (`iter().map`, `[1].iter`) — those never resolve.
 */
export function normalizeRustCallName(value: string): string {
  const stripped = value.replace(/\s+/g, "");
  const path = stripRustTurbofish(stripped);
  return RUST_CALL_PATH_REGEX.test(path) ? path : "";
}

/** Last `::`/`.`-separated segment of a normalized Rust call path. */
export function lastRustCallSegment(value: string): string {
  return value.split(/[.:]/).filter(Boolean).pop() ?? value;
}

// ── Rust shadow marker ──

const RUST_SHADOW_KEYWORDS = new Set([
  "let",
  "mut",
  "ref",
  "in",
  "if",
  "else",
  "while",
  "for",
  "loop",
  "match",
  "fn",
  "return",
  "break",
  "continue",
  "self",
  "Self",
  "crate",
  "super",
  "where",
  "move",
  "const",
  "static",
  "type",
  "as",
  "pub",
  "use",
  "mod",
  "impl",
  "struct",
  "enum",
  "trait",
  "Some",
  "None",
  "Ok",
  "Err",
  "true",
  "false",
]);

function rustBoundNamesInRegion(region: string): string[] {
  const names: string[] = [];
  const re = /[A-Za-z_]\w*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(region)) !== null) {
    const w = m[0];
    if (/^[A-Z]/.test(w) || RUST_SHADOW_KEYWORDS.has(w) || w === "_") continue;
    names.push(w);
  }
  return names;
}

/**
 * Collect names bound by signature params, let/for/if-let/while-let/
 * closure-param/match-arm pattern regions inside a line range. Match scanning
 * masks literals; elsewhere over-marking is safer than missing a local binding.
 */
function rustLocalBindingsInRange(
  codeLines: string[],
  startLine: number,
  endLine: number,
): Set<string> {
  const body = codeLines.slice(startLine - 1, endLine).join("\n");
  const maskLiteral = (literal: string) => literal.replace(/[^\n]/g, " ");
  const scanBody = body
    .replace(/(?:br|r)(#{0,})"[\s\S]*?"\1/g, maskLiteral)
    .replace(/"(?:\\[\s\S]|[^"\\])*"/g, maskLiteral)
    .replace(/b?'(?:\\[\s\S]|[^'\\])'/g, maskLiteral);
  const bound = new Set<string>();
  const collect = (region: string) => rustBoundNamesInRegion(region).forEach((n) => bound.add(n));
  const collectPatternBindings = (region: string) => {
    let genericDepth = 0;
    let cursor = 0;
    for (const m of region.matchAll(/[A-Za-z_]\w*/g)) {
      const index = m.index ?? 0;
      while (cursor < index) {
        if (region[cursor] === "<") genericDepth++;
        else if (region[cursor] === ">" && genericDepth > 0) genericDepth--;
        cursor++;
      }
      const name = m[0];
      const before = region.slice(0, index).trimEnd();
      const after = region.slice(index + name.length).trimStart();
      if (
        genericDepth > 0 ||
        RUST_SHADOW_KEYWORDS.has(name) ||
        name === "_" ||
        before.endsWith("::") ||
        after.startsWith("::") ||
        after.startsWith(":") ||
        after.startsWith("(") ||
        after.startsWith("{")
      ) {
        continue;
      }
      bound.add(name);
    }
  };
  // Capitalized names are valid bindings too; only collect them before the
  // type separator so type names do not become false local shadows.
  const collectUppercaseTypedBindings = (region: string) => {
    for (const m of region.matchAll(/(?:^|,)\s*(?:(?:mut|ref)\s+)*([A-Z]\w*)\s*:/g)) {
      bound.add(m[1]);
    }
  };

  // Function-signature parameters (`fn f(x: T, mut y: U, ..)`).
  const sig = /\bfn\s+\w+\s*(?:<[^>]*>)?\s*\(([^)]*)\)/.exec(body);
  if (sig) {
    collect(sig[1]);
    collectUppercaseTypedBindings(sig[1]);
  }
  for (const m of body.matchAll(/\blet\s+([^=;]+?)\s*(?:=|;|:)/g)) {
    const index = m.index ?? 0;
    if (/\b(?:if|while)\s+$/.test(body.slice(0, index))) continue;
    collectPatternBindings(m[1]);
  }
  for (const m of body.matchAll(/\bfor\s+(.+?)\s+in\b/g)) collectPatternBindings(m[1]);
  for (const m of body.matchAll(/\b(?:if|while)\s+let\s+([^=]+?)\s*=[^=]/g)) {
    collectPatternBindings(m[1]);
  }
  for (const m of body.matchAll(/\|([^|]*)\|/g)) {
    collect(m[1]);
    // Typed closure names are handled separately so type paths stay unbound.
    if (!m[1].includes(":")) collectPatternBindings(m[1]);
    collectUppercaseTypedBindings(m[1]);
  }
  for (const match of scanBody.matchAll(/\bmatch\b/g)) {
    let open = -1;
    let parens = 0;
    let brackets = 0;
    for (let i = (match.index ?? 0) + match[0].length; i < scanBody.length; i++) {
      const char = scanBody[i];
      if (char === "{" && parens === 0 && brackets === 0) {
        let nestedParens = 0;
        let nestedBrackets = 0;
        let nestedBraces = 0;
        let close = -1;
        let hasArm = false;
        for (let j = i + 1; j < scanBody.length; j++) {
          const nested = scanBody[j];
          if (nestedParens === 0 && nestedBrackets === 0 && nestedBraces === 0) {
            if (scanBody.startsWith("=>", j)) {
              hasArm = true;
              break;
            }
            if (nested === "}") {
              close = j;
              break;
            }
          }
          if (nested === "(") nestedParens++;
          else if (nested === ")") nestedParens--;
          else if (nested === "[") nestedBrackets++;
          else if (nested === "]") nestedBrackets--;
          else if (nested === "{") nestedBraces++;
          else if (nested === "}" && nestedBraces > 0) nestedBraces--;
        }
        if (hasArm) {
          open = i + 1;
          break;
        }
        if (close < 0) break;
        i = close;
        continue;
      }
      if (char === ";" && parens === 0 && brackets === 0) break;
      if (char === "(") parens++;
      else if (char === ")") parens--;
      else if (char === "[") brackets++;
      else if (char === "]") brackets--;
    }
    if (open < 0) continue;

    // Arm patterns can nest parentheses, brackets, and struct braces.
    let patternStart = open;
    let parenDepth = 0;
    let bracketDepth = 0;
    let braceDepth = 0;
    let inArmBody = false;
    for (let i = open; i < scanBody.length; i++) {
      const char = scanBody[i];
      if (char === "}" && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) break;
      if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
        if (scanBody.startsWith("=>", i)) {
          const arm = scanBody.slice(patternStart, i);
          const guard = /\bif\b/.exec(arm);
          const guardStart = guard && arm[guard.index - 1] !== "#" ? guard.index : -1;
          collectPatternBindings(guardStart < 0 ? arm : arm.slice(0, guardStart));
          inArmBody = true;
          i++;
          continue;
        }
        if (char === ",") {
          patternStart = i + 1;
          inArmBody = false;
          continue;
        }
      }
      if (char === "(") parenDepth++;
      else if (char === ")") parenDepth--;
      else if (char === "[") bracketDepth++;
      else if (char === "]") bracketDepth--;
      else if (char === "{") braceDepth++;
      else if (char === "}" && braceDepth > 0) {
        braceDepth--;
        if (inArmBody && braceDepth === 0 && parenDepth === 0 && bracketDepth === 0) {
          patternStart = i + 1;
          inArmBody = false;
        }
      }
    }
  }
  return bound;
}

/**
 * Mark `call.shadowedLocal` when the callee's last segment is bound as a
 * local (parameter, let/loop/pattern binding, or closure param) anywhere in
 * the caller's symbol range. Function-granular and conservative: names that
 * appear bound anywhere in the caller body mark all of that caller's
 * matching calls.
 */
export function markRustCallShadowing(
  content: string,
  symbols: Array<{ name: string; startLine?: number; endLine?: number }>,
  calls: Array<{ callerName: string; calleeName: string; shadowedLocal?: boolean }>,
): void {
  if (calls.length === 0) return;
  const codeLines = content
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length))
    .split("\n");
  const bindingsByCaller = new Map<string, Set<string>>();
  const symbolByName = new Map(symbols.map((s) => [s.name, s]));

  for (const call of calls) {
    if (!call.callerName) continue;
    let bound = bindingsByCaller.get(call.callerName);
    if (bound === undefined) {
      bound = new Set<string>();
      const sym = symbolByName.get(call.callerName);
      if (sym?.startLine && sym.endLine && sym.endLine >= sym.startLine) {
        bound = rustLocalBindingsInRange(codeLines, sym.startLine, sym.endLine);
      }
      bindingsByCaller.set(call.callerName, bound);
    }
    const root = call.calleeName.split(/[.:]/)[0];
    if (root && bound.has(root)) call.shadowedLocal = true;
  }
}

export function parseRust(
  content: string,
  counter: TokenCounter = exactTokenCounter,
): IndexedCodeResult {
  const lines = content.split("\n");
  const codeLines = stripNonCode(content, { rawStrings: true, byteStrings: true }).split("\n");
  const definedSymbols: ExtractedSymbol[] = [];
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
  const callRegex = /(\w+(?:::\w+)*(?:::<[^()]*>)?(?:\.\w+(?:::<[^()]*>)?)*)\s*\(/g;

  const importPaths: string[] = [];
  let implContext: string | null = null;
  let implBraceDepth = 0;
  let traitContext: string | null = null;
  let traitBraceDepth = 0;

  const activeFunctions: Array<{ name: string; symbolName: string; endLine: number }> = [];

  for (let i = 0; i < codeLines.length; i++) {
    const currentLineNum = i + 1;
    const lineStr = codeLines[i];
    const trimmed = lineStr.trim();

    while (
      activeFunctions.length > 0 &&
      activeFunctions[activeFunctions.length - 1].endLine < currentLineNum
    ) {
      activeFunctions.pop();
    }

    if (implContext) {
      implBraceDepth += countBraces(lineStr);
      if (implBraceDepth <= 0) {
        implContext = null;
        implBraceDepth = 0;
      }
    }

    if (traitContext) {
      traitBraceDepth += countBraces(lineStr);
      if (traitBraceDepth <= 0) {
        traitContext = null;
        traitBraceDepth = 0;
      }
    }

    const isSymbolLine =
      /^(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?(?:async\s+)?(?:fn|struct|enum|trait|impl|type|const|static|mod|use)\b/.test(
        trimmed,
      );
    if (isSymbolLine) {
      const implForMatch = implForRegex.exec(trimmed);
      if (implForMatch) {
        const traitName = implForMatch[1];
        const typeName = implForMatch[2].trim();
        const startLine = currentLineNum;
        const endLine = findBraceBlockEnd(codeLines, i);
        definedSymbols.push({
          name: `impl ${traitName} for ${typeName}`,
          symbolType: "impl",
          type: "impl",
          exported: false,
          startLine,
          endLine,
        });
        implContext = typeName;
        implBraceDepth = countBraces(lineStr);
        if (implBraceDepth <= 0) implContext = null;
      } else {
        const implMatch = implRegex.exec(trimmed);
        if (implMatch) {
          const typeName = implMatch[1].trim();
          const startLine = currentLineNum;
          const endLine = findBraceBlockEnd(codeLines, i);
          definedSymbols.push({
            name: `impl ${typeName}`,
            symbolType: "impl",
            type: "impl",
            exported: false,
            startLine,
            endLine,
          });
          implContext = typeName;
          implBraceDepth = countBraces(lineStr);
          if (implBraceDepth <= 0) implContext = null;
        }
      }

      const fnMatch = fnRegex.exec(trimmed);
      if (fnMatch) {
        const name = fnMatch[1];
        const exported = trimmed.startsWith("pub");
        const startLine = currentLineNum;
        const endLine = trimmed.endsWith(";") ? currentLineNum : findBraceBlockEnd(codeLines, i);
        const symbolName = implContext
          ? `${implContext}::${name}`
          : traitContext
            ? `${traitContext}::${name}`
            : name;
        definedSymbols.push({
          name: symbolName,
          symbolType: "function",
          type: "function",
          exported,
          startLine,
          endLine,
        });
        if (endLine > currentLineNum) {
          activeFunctions.push({ name, symbolName, endLine });
        }
      }

      const structMatch = structRegex.exec(trimmed);
      if (structMatch) {
        const name = structMatch[1];
        const exported = trimmed.startsWith("pub");
        const startLine = currentLineNum;
        const endLine = findBraceBlockEnd(codeLines, i);
        definedSymbols.push({
          name,
          symbolType: "struct",
          type: "struct",
          exported,
          startLine,
          endLine,
        });
      }

      const enumMatch = enumRegex.exec(trimmed);
      if (enumMatch) {
        const name = enumMatch[1];
        const exported = trimmed.startsWith("pub");
        const startLine = currentLineNum;
        const endLine = findBraceBlockEnd(codeLines, i);
        definedSymbols.push({
          name,
          symbolType: "enum",
          type: "enum",
          exported,
          startLine,
          endLine,
        });
      }

      const traitMatch = traitRegex.exec(trimmed);
      if (traitMatch && !implRegex.test(trimmed) && !implForRegex.test(trimmed)) {
        const name = traitMatch[1];
        const exported = trimmed.startsWith("pub");
        const startLine = currentLineNum;
        const endLine = findBraceBlockEnd(codeLines, i);
        definedSymbols.push({
          name,
          symbolType: "trait",
          type: "trait",
          exported,
          startLine,
          endLine,
        });
        traitContext = name;
        traitBraceDepth = countBraces(lineStr);
        if (traitBraceDepth <= 0) traitContext = null;
      }

      const typeMatch = typeRegex.exec(trimmed);
      if (typeMatch) {
        const name = typeMatch[1];
        const exported = trimmed.startsWith("pub");
        definedSymbols.push({
          name,
          symbolType: "type",
          type: "type",
          exported,
          startLine: currentLineNum,
          endLine: currentLineNum,
        });
      }

      const constMatch = constRegex.exec(trimmed);
      if (constMatch) {
        const name = constMatch[1];
        const exported = trimmed.startsWith("pub");
        definedSymbols.push({
          name,
          symbolType: "const",
          type: "const",
          exported,
          startLine: currentLineNum,
          endLine: currentLineNum,
        });
      }

      const modMatch = modRegex.exec(trimmed);
      if (modMatch) {
        const name = modMatch[1];
        const exported = trimmed.startsWith("pub");
        definedSymbols.push({
          name,
          symbolType: "module",
          type: "module",
          exported,
          startLine: currentLineNum,
          endLine: currentLineNum,
        });
      }

      const useMatch = useRegex.exec(trimmed);
      if (useMatch) {
        importPaths.push(useMatch[1].replace(/;$/, ""));
      }
    }

    if (activeFunctions.length > 0 && lineStr.includes("(")) {
      const active = activeFunctions[activeFunctions.length - 1];
      callRegex.lastIndex = 0;
      let callMatch: RegExpExecArray | null;
      while ((callMatch = callRegex.exec(lineStr)) !== null) {
        const rawCalledName = callMatch[1];
        const calledName = normalizeRustCallName(rawCalledName);
        const calledIdentifier = lastRustCallSegment(calledName);
        if (
          calledName &&
          !RUST_CALL_IGNORES.has(rawCalledName) &&
          !RUST_CALL_IGNORES.has(calledName) &&
          !RUST_CALL_IGNORES.has(calledIdentifier) &&
          calledName !== active.name &&
          calledName !== active.symbolName
        ) {
          calledIdentifiers.add(calledIdentifier);
          callExpressions.push({ callerName: active.symbolName, calleeName: calledName });
        }
      }
    }
  }

  const chunks = createSymbolChunks(definedSymbols, lines, "rust", counter);
  if (chunks.length === 0) {
    return { ...makeFallbackChunks(content, lines, counter), importPaths };
  }

  markRustCallShadowing(content, definedSymbols, callExpressions);

  return {
    chunks,
    importPaths,
    definedSymbols,
    calledIdentifiers: [...calledIdentifiers],
    callExpressions,
  };
}

// ── Ruby parser (regex fallback) ──

function findRubyBlockEnd(codeLines: string[], startIndex: number): number {
  const openingLine = codeLines[startIndex] ?? "";
  if (openingLine.includes(";") && /\bend\s*(?:#.*)?$/.test(openingLine)) {
    return startIndex + 1;
  }

  const baseIndent = codeLines[startIndex]?.search(/\S/) ?? 0;
  for (let i = startIndex + 1; i < codeLines.length; i++) {
    const trimmed = codeLines[i].trim();
    if (trimmed === "") continue;
    const indent = codeLines[i].search(/\S/);
    if (indent < 0) continue;
    if (indent < baseIndent) {
      return i;
    }
    if (
      indent === baseIndent &&
      (trimmed === "end" || trimmed.startsWith("end ") || trimmed.startsWith("end\t"))
    ) {
      return i + 1;
    }
  }
  return codeLines.length;
}

export function parseRuby(
  content: string,
  counter: TokenCounter = exactTokenCounter,
): IndexedCodeResult {
  const lines = content.split("\n");
  const codeLines = stripNonCode(content, { hashComments: true }).split("\n");
  const definedSymbols: ExtractedSymbol[] = [];
  const importPaths: string[] = [];
  const calledIdentifiers = new Set<string>();
  const callExpressions: Array<{ callerName: string; calleeName: string }> = [];

  const symbolRegex =
    /^\s*(?:def\s+(?:self\.)?(\w+[?!]?)|class\s+(\w+(?:::\w+)*)|module\s+(\w+(?:::\w+)*))/;
  const requireRelativeRegex = /\brequire_relative\s+['"]([^'"]+)['"]/g;

  const contextStack: Array<{ name: string; endLine: number }> = [];
  let inBeginBlock = false;

  for (let i = 0; i < codeLines.length; i++) {
    const line = codeLines[i];
    const trimmed = line.trim();

    // =begin/=end document blocks and the __END__ trailer are non-code.
    if (inBeginBlock) {
      if (line.startsWith("=end")) inBeginBlock = false;
      continue;
    }
    if (line.startsWith("=begin")) {
      inBeginBlock = true;
      continue;
    }
    if (line.startsWith("__END__")) break;

    while (contextStack.length > 0 && i >= contextStack[contextStack.length - 1].endLine) {
      contextStack.pop();
    }

    const match = symbolRegex.exec(trimmed);
    if (match) {
      const rawName = match[1] ?? match[2] ?? match[3];
      if (!rawName) continue;
      const isMethod = Boolean(match[1]);
      const symbolType = isMethod ? "function" : match[2] ? "class" : "module";
      const parentName =
        contextStack.length > 0 ? contextStack[contextStack.length - 1].name : null;
      const name = parentName ? `${parentName}::${rawName}` : rawName;
      const endLine = findRubyBlockEnd(codeLines, i);

      definedSymbols.push({
        name,
        symbolType,
        type: symbolType,
        exported: isMethod ? false : !rawName.startsWith("_"),
        startLine: i + 1,
        endLine,
      });

      contextStack.push({ name, endLine });
      continue;
    }

    // require_relative only — the stripped line gates out comments and
    // string literals while the match runs on the raw line to keep the
    // literal path argument (stripNonCode removes string contents).
    if (trimmed.includes("require_relative")) {
      requireRelativeRegex.lastIndex = 0;
      let reqMatch: RegExpExecArray | null;
      while ((reqMatch = requireRelativeRegex.exec(lines[i] ?? "")) !== null) {
        importPaths.push(reqMatch[1]);
      }
    }
  }

  const chunks = createSymbolChunks(definedSymbols, lines, "ruby", counter);
  if (chunks.length === 0) {
    return {
      ...makeFallbackChunks(content, lines, counter),
      importPaths: [...new Set(importPaths)],
    };
  }

  return {
    chunks,
    importPaths: [...new Set(importPaths)],
    definedSymbols,
    calledIdentifiers: [...calledIdentifiers],
    callExpressions,
  };
}

// ── YAML/JSON/TOML config chunkers ──

export function indexConfig(
  content: string,
  language: string,
  counter: TokenCounter = exactTokenCounter,
): IndexedChunk[] {
  switch (language) {
    case "yaml":
      return parseYamlConfig(content, counter);
    case "json":
      return parseJsonConfig(content, counter);
    case "toml":
      return parseTomlConfig(content, counter);
    default:
      return [];
  }
}

function parseYamlConfig(content: string, counter: TokenCounter): IndexedChunk[] {
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
      tokenCount: counter.count(text),
      contentHash: hashContent(text),
      metadata: {
        kind: "config",
        language: "yaml",
        section: currentKey,
        startLine: sectionStartLine,
        endLine,
      },
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

function parseJsonConfig(content: string, counter: TokenCounter): IndexedChunk[] {
  const chunks: IndexedChunk[] = [];

  try {
    const parsed = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null) {
      return makeFallbackConfigChunk(content, "json", counter);
    }

    const entries = Object.entries(parsed);
    for (const [key, value] of entries) {
      const text = JSON.stringify(value, null, 2);
      chunks.push({
        heading: key,
        content: text,
        tokenCount: counter.count(text),
        contentHash: hashContent(text),
        metadata: {
          kind: "config",
          language: "json",
          section: key,
          valueType: Array.isArray(value) ? "array" : typeof value,
        },
      });
    }

    if (chunks.length === 0) {
      return makeFallbackConfigChunk(content, "json", counter);
    }
  } catch {
    return makeFallbackConfigChunk(content, "json", counter);
  }

  return chunks;
}

function parseTomlConfig(content: string, counter: TokenCounter): IndexedChunk[] {
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
      tokenCount: counter.count(text),
      contentHash: hashContent(text),
      metadata: {
        kind: "config",
        language: "toml",
        section: currentKey,
        arrayTable: isArrayTable,
        startLine: sectionStartLine,
        endLine,
      },
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

function makeFallbackConfigChunk(
  content: string,
  language: string,
  counter: TokenCounter,
): IndexedChunk[] {
  return [
    {
      content,
      tokenCount: counter.count(content),
      contentHash: hashContent(content),
      metadata: {
        kind: "config",
        language,
      },
    },
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
    const line = lines[i];
    if (!found && !line.includes("{")) continue;

    for (let j = 0; j < line.length; j++) {
      const char = line[j];
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
  if (!line.includes("{") && !line.includes("}")) return 0;
  let count = 0;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
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

export function createSymbolChunks(
  symbols: ExtractedSymbol[],
  allLines: string[],
  language: string,
  counter: TokenCounter = exactTokenCounter,
): IndexedChunk[] {
  return symbols.map((symbol) => {
    const content =
      symbol.content || allLines.slice(symbol.startLine - 1, symbol.endLine).join("\n");
    return {
      heading: symbol.name,
      content,
      tokenCount: counter.count(content),
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
        ...(symbol.decorators && symbol.decorators.length > 0
          ? { decorators: symbol.decorators }
          : {}),
      },
    };
  });
}

export function makeFallbackChunks(
  content: string,
  lines: string[],
  counter: TokenCounter = exactTokenCounter,
): IndexedCodeResult {
  const chunks: IndexedChunk[] = [];
  for (let index = 0; index < lines.length; index += 80) {
    const slice = lines
      .slice(index, index + 80)
      .join("\n")
      .trim();
    if (!slice) continue;

    chunks.push({
      content: slice,
      tokenCount: counter.count(slice),
      contentHash: hashContent(slice),
      metadata: {
        kind: "code",
        searchText: codeSearchText(slice),
        fallback: true,
        startLine: index + 1,
        endLine: Math.min(index + 80, lines.length),
      },
    });
  }

  return {
    chunks,
    importPaths: [],
    definedSymbols: [],
    calledIdentifiers: [],
    callExpressions: [],
  };
}
