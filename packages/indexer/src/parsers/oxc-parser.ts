import { countTokens } from "@openez-graph/core";

import { hashContent } from "../hash";
import { codeSearchText, createSymbolChunks, type ExtractedSymbol } from "../languages";
import type { IndexedChunk } from "../types";
import type { CodeParser, ParseInput, ParsedDocument } from "./types";

const TS_LANGUAGES = new Set(["typescript", "tsx", "javascript", "jsx"]);

// Lazy-load oxc-parser
let _oxc: any | null | undefined;
function getOxc(): any | null {
  if (_oxc !== undefined) return _oxc;
  try {
    _oxc = require("oxc-parser");
  } catch {
    _oxc = null;
  }
  return _oxc;
}

interface OxcNode {
  type: string;
  start: number;
  end: number;
  [key: string]: any;
}

function getNodeId(node: OxcNode): string | null {
  // oxc AST: identifier nodes have .name, function/class declarations have .id
  if (node.type === "Identifier" && typeof node.name === "string") return node.name;
  if (node.id && node.id.type === "Identifier") return node.id.name;
  return null;
}

function extractSymbols(body: OxcNode[], source: string): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];
  const lines = source.split("\n");

  for (const node of body) {
    // Handle export wrappers first — they have no name but wrap inner declarations.
    if (node.type === "ExportNamedDeclaration" && node.declaration) {
      const inner = extractSymbols([node.declaration], source);
      for (const s of inner) {
        s.exported = true;
        symbols.push(s);
      }
      continue;
    }
    if (node.type === "ExportDefaultDeclaration" && node.declaration) {
      const inner = extractSymbols([node.declaration], source);
      for (const s of inner) {
        s.exported = true;
        symbols.push(s);
      }
      continue;
    }
    // VariableDeclaration: const foo = () => {} — name is on declarations[].id
    if (node.type === "VariableDeclaration") {
      for (const decl of node.declarations ?? []) {
        if (decl.id?.type === "Identifier") {
          const declName = decl.id.name;
          const isArrow = decl.init?.type === "ArrowFunctionExpression";
          const isFunc = decl.init?.type === "FunctionExpression";
          if (isArrow || isFunc) {
            const startLine = source.slice(0, decl.start).split("\n").length;
            const endLine = source.slice(0, decl.end).split("\n").length;
            symbols.push({
              name: declName,
              symbolType: "function",
              type: "function",
              exported: false,
              startLine,
              endLine,
            });
          }
        }
      }
      continue;
    }

    const name = getNodeId(node);
    if (!name) continue;

    let symbolType = "function";
    let exported = false;

    switch (node.type) {
      case "FunctionDeclaration":
        symbolType = "function";
        break;
      case "ClassDeclaration":
        symbolType = "class";
        break;
      default:
        continue;
    }

    const startLine = source.slice(0, node.start).split("\n").length;
    const endLine = source.slice(0, node.end).split("\n").length;
    symbols.push({
      name,
      symbolType,
      type: symbolType,
      exported,
      startLine,
      endLine,
    });
  }

  return symbols;
}

function extractImports(body: OxcNode[]): string[] {
  const imports: string[] = [];
  for (const node of body) {
    if (node.type === "ImportDeclaration" && node.source?.value) {
      imports.push(node.source.value);
    } else if (node.type === "ExportNamedDeclaration" && node.source?.value) {
      imports.push(node.source.value);
    } else if (node.type === "ExportAllDeclaration" && node.source?.value) {
      imports.push(node.source.value);
    }
  }
  return imports;
}

function calleeName(node: OxcNode): string | null {
  if (node.type === "Identifier" && node.name) return node.name;
  if (node.type === "MemberExpression") {
    const obj = calleeName(node.object as OxcNode);
    const prop = node.property as OxcNode;
    const propStr =
      prop?.type === "Identifier" ? prop.name : prop?.type === "StringLiteral" ? prop.value : null;
    if (obj && propStr) return `${obj}.${propStr}`;
    if (propStr) return propStr;
    if (obj) return obj;
  }
  return null;
}

function extractCallExpressions(
  body: OxcNode[],
): Array<{ callerName: string; calleeName: string }> {
  const calls: Array<{ callerName: string; calleeName: string }> = [];

  function walk(node: OxcNode | null | undefined, caller: string) {
    if (!node || typeof node !== "object") return;

    // Track enclosing function
    let currentCaller = caller;
    if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression"
    ) {
      const id = getNodeId(node);
      if (id) currentCaller = id;
    }

    if (node.type === "CallExpression") {
      const callee = calleeName(node.callee as OxcNode);
      if (callee && currentCaller) {
        calls.push({ callerName: currentCaller, calleeName: callee });
      }
    }

    for (const key of Object.keys(node)) {
      if (key === "type" || key === "start" || key === "end") continue;
      const val = (node as any)[key];
      if (Array.isArray(val)) {
        for (const child of val) walk(child as OxcNode, currentCaller);
      } else if (val && typeof val === "object" && val.type) {
        walk(val as OxcNode, currentCaller);
      }
    }
  }

  for (const node of body) walk(node, "<module>");
  return calls;
}

/**
 * Fast TS/JS parser using oxc-parser (Rust-based, 13x faster than babel).
 * Replaces ts-morph for cold-start performance.
 */
export class OxcParser implements CodeParser {
  readonly name = "oxc";

  canParse(_path: string, language: string | null, kind: string): boolean {
    return kind === "code" && language !== null && TS_LANGUAGES.has(language);
  }

  parse(input: ParseInput, language: string | null, _kind: string): ParsedDocument {
    const oxc = getOxc();
    if (!oxc) {
      // Fallback: simple line-based chunking
      const lines = input.content.split("\n");
      const chunks: IndexedChunk[] = [
        {
          id: "",
          heading: input.relativePath,
          content: input.content,
          tokenCount: countTokens(input.content),
          contentHash: hashContent(input.content),
          metadata: {},
        },
      ];
      return {
        parser: "fallback",
        language,
        kind: "code",
        chunks,
        importPaths: [],
        wikilinks: [],
        definedSymbols: [],
        calledIdentifiers: [],
        callExpressions: [],
      };
    }

    const result = oxc.parseSync(input.relativePath, input.content);
    const body = result.program.body as OxcNode[];
    const symbols = extractSymbols(body, input.content);
    const importPaths = extractImports(body);
    const callExpressions = extractCallExpressions(body);
    const lines = input.content.split("\n");

    const chunks = createSymbolChunks(symbols, lines, language ?? "typescript");

    return {
      parser: this.name,
      language,
      kind: "code",
      chunks,
      importPaths,
      wikilinks: [],
      definedSymbols: symbols,
      calledIdentifiers: callExpressions.map((c) => c.calleeName),
      callExpressions,
    };
  }
}
