import { exactTokenCounter } from "@openez-graph/core";

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
    // Export wrappers don't have their own name — recurse into the inner
    // declaration before the getNodeId check below would skip them.
    if (node.type === "ExportNamedDeclaration") {
      if (node.declaration) {
        const inner = extractSymbols([node.declaration as OxcNode], source);
        for (const s of inner) {
          s.symbol.exported = true;
          results.push(s);
        }
      }
      continue;
    }
    if (node.type === "ExportDefaultDeclaration") {
      if (node.declaration) {
        const inner = extractSymbols([node.declaration as OxcNode], source);
        for (const s of inner) {
          s.symbol.exported = true;
          results.push(s);
        }
      }
      continue;
    }

    // VariableDeclaration must be handled before the getNodeId guard below:
    // VariableDeclaration nodes have .declarations[], not .id, so getNodeId
    // returns null and would skip them. This handles both exported and
    // non-exported arrow/function expressions assigned to variables.
    if (node.type === "VariableDeclaration") {
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
      case "TSInterfaceDeclaration":
        symbolType = "interface";
        break;
      case "TSTypeAliasDeclaration":
        symbolType = "type";
        break;
      case "TSEnumDeclaration":
        symbolType = "enum";
        break;
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

    // For class declarations, also extract methods as first-class symbols
    // with qualified `ClassName.methodName` naming so they appear in the
    // public definedSymbols list and the graph.
    if (node.type === "ClassDeclaration") {
      for (const methodAst of extractClassMethods(node, name, source)) {
        results.push(methodAst);
      }
    }
  }

  return results;
}

/**
 * Extract class methods (and arrow-function properties) from a ClassDeclaration
 * body as first-class SymbolAst entries. Each method is named
 * `ClassName.methodName` to avoid collisions with free functions of the same
 * name. The body node is the method's FunctionExpression/ArrowFunctionExpression
 * value so call extraction walks the method's own scope.
 */
function extractClassMethods(classNode: OxcNode, className: string, source: string): SymbolAst[] {
  const methods: SymbolAst[] = [];
  const classBody = classNode.body as OxcNode | undefined;
  if (!classBody || !Array.isArray(classBody.body)) return methods;

  for (const member of classBody.body as OxcNode[]) {
    // MethodDefinition: { run() { ... } } or { constructor() { ... } }
    if (member.type === "MethodDefinition") {
      const key = member.key as OxcNode | undefined;
      if (key?.type !== "Identifier" || typeof key.name !== "string") continue;
      const value = member.value as OxcNode | undefined;
      if (!value) continue;
      const methodName = key.name;
      const qualifiedName = `${className}.${methodName}`;
      const startLine = source.slice(0, value.start).split("\n").length;
      const endLine = source.slice(0, value.end).split("\n").length;
      methods.push({
        symbol: {
          name: qualifiedName,
          symbolType: "method",
          type: "method",
          exported: false,
          startLine,
          endLine,
        },
        node: value,
      });
    }
    // PropertyDefinition with an arrow/function initializer:
    // { handler = () => { ... } }
    if (member.type === "PropertyDefinition") {
      const key = member.key as OxcNode | undefined;
      if (key?.type !== "Identifier" || typeof key.name !== "string") continue;
      const init = member.value as OxcNode | undefined;
      if (!init) continue;
      const isArrow = init.type === "ArrowFunctionExpression";
      const isFunc = init.type === "FunctionExpression";
      if (!isArrow && !isFunc) continue;
      const propName = key.name;
      const qualifiedName = `${className}.${propName}`;
      const startLine = source.slice(0, init.start).split("\n").length;
      const endLine = source.slice(0, init.end).split("\n").length;
      methods.push({
        symbol: {
          name: qualifiedName,
          symbolType: "method",
          type: "method",
          exported: false,
          startLine,
          endLine,
        },
        node: init,
      });
    }
  }

  return methods;
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
    if (symbol.symbolType !== "function" && symbol.symbolType !== "method") continue;
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
 * FunctionExpression) within each function/method symbol's subtree and return
 * them as additional SymbolAst entries. This ensures calls inside a nested
 * function are attributed to the nested symbol, not the outer one. These
 * nested callables are also included in the public `definedSymbols` list so
 * they appear as first-class graph symbols.
 */
function discoverNestedCallables(topLevel: SymbolAst[], source: string): SymbolAst[] {
  const nested: SymbolAst[] = [];
  for (const { symbol, node } of topLevel) {
    // Walk function and method bodies for nested callable declarations.
    // Class symbols themselves are not walked here — their methods are
    // already extracted as separate top-level symbols by extractClassMethods.
    if (symbol.symbolType !== "function" && symbol.symbolType !== "method") continue;
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
    const counter = input.counter ?? exactTokenCounter;
    const oxc = getOxc();
    if (!oxc) {
      // Fallback: simple line-based chunking
      const lines = input.content.split("\n");
      const chunks: IndexedChunk[] = [
        {
          heading: input.relativePath,
          content: input.content,
          tokenCount: counter.count(input.content),
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
    const importPaths = extractImports(body);
    // Discover nested callable declarations so calls inside them attribute to
    // the inner symbol, not the outer one. These nested callables are now
    // included in the public definedSymbols list so they appear as first-class
    // graph symbols (nodes + call edges).
    const nestedCallables = discoverNestedCallables(symbolAsts, input.content);
    const allSymbolAsts = [...symbolAsts, ...nestedCallables];
    const allSymbols = allSymbolAsts.map((s) => s.symbol);
    const { callExpressions, calledIdentifiers } = extractCalls(allSymbolAsts);
    const lines = input.content.split("\n");

    const chunks = createSymbolChunks(allSymbols, lines, language ?? "typescript", counter);

    return {
      parser: this.name,
      language,
      kind: "code",
      chunks,
      importPaths,
      wikilinks: [],
      definedSymbols: allSymbols,
      calledIdentifiers: [...calledIdentifiers],
      callExpressions,
    };
  }
}
