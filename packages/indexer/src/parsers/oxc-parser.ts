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

/**
 * Internal pairing of a public symbol with the AST node that covers its body.
 * The public symbol only stores `startLine`/`endLine`, which are not precise
 * enough for subtree selection during call extraction. The node retains the
 * raw `start`/`end` offsets and the full subtree we need to walk.
 */
type SymbolAst = { symbol: ExtractedSymbol; node: OxcNode };

/**
 * Extract top-level (and exported) symbols from the program body.
 * Returns both the public symbols and their matching AST nodes so callers can
 * walk each symbol's subtree for call extraction.
 */
function extractSymbols(body: OxcNode[], source: string): SymbolAst[] {
  const results: SymbolAst[] = [];

  for (const node of body) {
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
      case "TSInterfaceDeclaration":
        symbolType = "interface";
        break;
      case "TSTypeAliasDeclaration":
        symbolType = "type";
        break;
      case "TSEnumDeclaration":
        symbolType = "enum";
        break;
      case "VariableDeclaration":
        // const foo = () => {} or const foo = function() {}
        for (const decl of node.declarations ?? []) {
          if (decl.id?.type === "Identifier") {
            const declName = decl.id.name;
            const isArrow = decl.init?.type === "ArrowFunctionExpression";
            const isFunc = decl.init?.type === "FunctionExpression";
            if (isArrow || isFunc) {
              const startLine = source.slice(0, decl.start).split("\n").length;
              const endLine = source.slice(0, decl.end).split("\n").length;
              // Associate the symbol with the function initializer node so its
              // body subtree is walked for call extraction.
              const bodyNode = (decl.init as OxcNode) ?? decl;
              results.push({
                symbol: {
                  name: declName,
                  symbolType: "function",
                  type: "function",
                  exported: node.exportKind === "value" || (node as any).exported,
                  startLine,
                  endLine,
                },
                node: bodyNode,
              });
            }
          }
        }
        continue;
      case "ExportNamedDeclaration":
        // Re-export — extract the inner declaration
        if (node.declaration) {
          const inner = extractSymbols([node.declaration as OxcNode], source);
          for (const s of inner) {
            s.symbol.exported = true;
            results.push(s);
          }
        }
        continue;
      case "ExportDefaultDeclaration":
        if (node.declaration) {
          const inner = extractSymbols([node.declaration as OxcNode], source);
          for (const s of inner) {
            s.symbol.exported = true;
            results.push(s);
          }
        }
        continue;
      default:
        continue;
    }

    const startLine = source.slice(0, node.start).split("\n").length;
    const endLine = source.slice(0, node.end).split("\n").length;
    results.push({
      symbol: {
        name,
        symbolType,
        type: symbolType,
        exported,
        startLine,
        endLine,
      },
      node,
    });
  }

  return results;
}

/**
 * Child keys we recurse into when walking an AST subtree. Covers the common
 * structural fields produced by oxc for statements, expressions, and TS nodes.
 */
const WALK_KEYS = new Set([
  "body",
  "declarations",
  "init",
  "expression",
  "callee",
  "object",
  "property",
  "argument",
  "arguments",
  "declaration",
  "consequent",
  "alternate",
  "left",
  "right",
  "test",
  "update",
]);

/**
 * Recursively walk an AST value (node or array), invoking the visitor for each
 * node detected by `typeof value.type === 'string'`. A `WeakSet` guards against
 * circular references. Primitives and null are ignored.
 */
function walkNodes(
  value: unknown,
  visitor: (node: OxcNode) => void,
  visited: WeakSet<object>,
  skipTypes?: ReadonlySet<string>,
  isRoot = false,
): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walkNodes(item, visitor, visited, skipTypes, false);
    return;
  }
  if (visited.has(value as object)) return;
  visited.add(value as object);
  const node = value as Record<string, unknown>;
  const nodeType = node.type;
  if (typeof nodeType === "string") {
    visitor(node as unknown as OxcNode);
    // If this node introduces a nested callable scope, do not descend into it —
    // its calls belong to the inner symbol, not the outer one being walked.
    // The root node is never skipped (it is the symbol's own scope).
    if (!isRoot && skipTypes?.has(nodeType)) return;
  }
  for (const key of Object.keys(node)) {
    if (!WALK_KEYS.has(key)) continue;
    walkNodes(node[key], visitor, visited, skipTypes, false);
  }
}

/**
 * Node types that introduce a new callable scope. Calls inside one of these
 * belong to the inner callable, not the outer symbol being walked.
 */
const NESTED_CALLABLE = new Set([
  "FunctionDeclaration",
  "ArrowFunctionExpression",
  "FunctionExpression",
]);

/**
 * Resolve a callee node to a human-readable name.
 * - Identifier -> identifier.name
 * - MemberExpression -> object.name + "." + property.name
 * - other -> null (skip)
 */
function calleeName(callee: OxcNode): string | null {
  if (callee.type === "Identifier" && typeof callee.name === "string") {
    return callee.name;
  }
  if (callee.type === "MemberExpression") {
    const object = callee.object as OxcNode | undefined;
    const property = callee.property as OxcNode | undefined;
    if (object?.type === "Identifier" && property?.type === "Identifier") {
      return `${object.name}.${property.name}`;
    }
  }
  return null;
}

/**
 * Walk each symbol's AST subtree and collect call expressions, attributing
 * calls to the owning symbol. Calls nested inside a nested callable
 * declaration are skipped so they attribute to the inner function instead.
 */
function extractCalls(symbolAsts: SymbolAst[]): {
  callExpressions: Array<{ callerName: string; calleeName: string }>;
  calledIdentifiers: Set<string>;
} {
  const callExpressions: Array<{ callerName: string; calleeName: string }> = [];
  const calledIdentifiers = new Set<string>();

  for (const { symbol, node } of symbolAsts) {
    // Only function-like symbols can contain calls.
    if (symbol.symbolType !== "function") continue;
    const visited = new WeakSet<object>();
    walkNodes(
      node,
      (current: OxcNode) => {
        if (current.type === "CallExpression") {
          const name = calleeName(current.callee as OxcNode);
          if (name) {
            callExpressions.push({ callerName: symbol.name, calleeName: name });
            calledIdentifiers.add(name);
          }
        }
      },
      visited,
      // Skip nested callable declarations: their bodies belong to inner symbols.
      NESTED_CALLABLE,
      // The symbol's own node is the root — never skip it.
      true,
    );
  }

  return { callExpressions, calledIdentifiers };
}

/**
 * Discover nested callable declarations (FunctionDeclaration, named
 * FunctionExpression) within each function symbol's subtree and return them as
 * additional SymbolAst entries. This ensures calls inside a nested function are
 * attributed to the nested symbol, not the outer one. The public
 * `definedSymbols` list is NOT extended — only the internal call-extraction
 * walk uses these entries.
 */
function discoverNestedCallables(topLevel: SymbolAst[], source: string): SymbolAst[] {
  const nested: SymbolAst[] = [];
  for (const { symbol, node } of topLevel) {
    if (symbol.symbolType !== "function") continue;
    const visited = new WeakSet<object>();
    walkNodes(
      node,
      (current: OxcNode) => {
        if (current === node) return; // skip the root (already a symbol)
        // Nested FunctionDeclaration — always has an .id Identifier.
        if (current.type === "FunctionDeclaration" && current.id?.type === "Identifier") {
          const startLine = source.slice(0, current.start).split("\n").length;
          const endLine = source.slice(0, current.end).split("\n").length;
          nested.push({
            symbol: {
              name: current.id.name,
              symbolType: "function",
              type: "function",
              exported: false,
              startLine,
              endLine,
            },
            node: current,
          });
        }
        // Named FunctionExpression — has an .id Identifier.
        if (current.type === "FunctionExpression" && current.id?.type === "Identifier") {
          const startLine = source.slice(0, current.start).split("\n").length;
          const endLine = source.slice(0, current.end).split("\n").length;
          nested.push({
            symbol: {
              name: current.id.name,
              symbolType: "function",
              type: "function",
              exported: false,
              startLine,
              endLine,
            },
            node: current,
          });
        }
      },
      visited,
      // Do NOT skip nested callables here — we want to find ALL of them,
      // including deeply nested ones. The skip logic only applies to call
      // extraction, not to symbol discovery.
    );
  }
  return nested;
}

/**
 * Extract local import binding names for call resolution.
 * - ImportDefaultSpecifier  -> .local.name
 * - ImportNamespaceSpecifier -> .local.name
 * - ImportSpecifier          -> .local.name
 */
function extractImportBindings(body: OxcNode[]): string[] {
  const bindings: string[] = [];
  for (const node of body) {
    if (node.type !== "ImportDeclaration") continue;
    for (const spec of (node.specifiers ?? []) as OxcNode[]) {
      const local = (spec as any).local as OxcNode | undefined;
      if (local?.type === "Identifier" && typeof local.name === "string") {
        bindings.push(local.name);
      }
    }
  }
  return bindings;
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
    const symbolAsts = extractSymbols(body, input.content);
    const symbols = symbolAsts.map((s) => s.symbol);
    const importPaths = extractImports(body);
    // Local import bindings are extracted by `extractImportBindings` (defined
    // below) for downstream call resolution. ParsedDocument has no field for
    // them yet (schema is frozen), so the result is not stored here; a later
    // task wires it into graph building.
    // Discover nested callable declarations so calls inside them attribute to
    // the inner symbol, not the outer one. These are internal-only — the public
    // definedSymbols list is unchanged.
    const nestedCallables = discoverNestedCallables(symbolAsts, input.content);
    const { callExpressions, calledIdentifiers } = extractCalls([
      ...symbolAsts,
      ...nestedCallables,
    ]);
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
      calledIdentifiers: [...calledIdentifiers],
      callExpressions,
    };
  }
}
