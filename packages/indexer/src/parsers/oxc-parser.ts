import { exactTokenCounter } from "@openez-graph/core";

import { createSymbolChunks, type ExtractedSymbol } from "../languages";
import type { IndexedChunk } from "../types";
import type { CodeParser, ParseInput, ParsedDocument } from "./types";

const TS_LANGUAGES = new Set(["typescript", "tsx", "javascript", "jsx"]);

// Lazy-load oxc-parser
let _oxc: any | null | undefined;
function getOxc(): any | null {
  if (_oxc !== undefined) return _oxc;
  try {
    _oxc = require("oxc-parser");
  } catch (requireError) {
    console.debug("[openez] oxc-parser unavailable:", requireError);
    _oxc = null;
  }
  return _oxc;
}

interface OxcNode {
  type: string;
  start: number;
  end: number;
  name?: string;
  id?: OxcNode;
  declaration?: OxcNode;
  declarations?: OxcNode[];
  init?: OxcNode;
  exportKind?: string;
  exported?: boolean;
  body?: OxcNode | OxcNode[];
  key?: OxcNode;
  value?: OxcNode;
  kind?: string;
  static?: boolean;
  object?: OxcNode;
  property?: OxcNode;
  argument?: OxcNode;
  left?: OxcNode;
  elements?: (OxcNode | null)[];
  properties?: OxcNode[];
  params?: OxcNode[];
  callee?: OxcNode;
  param?: OxcNode;
  source?: { value?: string };
}

type OxcValue = OxcNode | OxcValue[] | string | number | boolean | null | undefined;

function isString(v: OxcValue): v is string {
  return String(v) === v;
}

function isNonNullObject(v: OxcValue): v is OxcNode | OxcValue[] {
  return v !== null && v instanceof Object;
}

function getNodeId(node: OxcNode): string | null {
  // oxc AST: identifier nodes have .name, function/class declarations have .id
  if (node.type === "Identifier" && isString(node.name)) return node.name;
  if (node.id && node.id.type === "Identifier") return node.id.name ?? null;
  return null;
}

/**
 * Internal pairing of a public symbol with the AST node that covers its body.
 * The public symbol only stores `startLine`/`endLine`, which are not precise
 * enough for subtree selection during call extraction. The node retains the
 * raw `start`/`end` offsets and the full subtree we need to walk.
 */
type SymbolAst = { symbol: ExtractedSymbol; node: OxcNode; capturesClassThis?: boolean };

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
        const inner = extractSymbols([node.declaration], source);
        for (const s of inner) {
          s.symbol.exported = true;
          results.push(s);
        }
      }
      continue;
    }
    if (node.type === "ExportDefaultDeclaration") {
      if (node.declaration) {
        const inner = extractSymbols([node.declaration], source);
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
        if (decl.id?.type === "Identifier" && isString(decl.id.name)) {
          const declName = decl.id.name;
          const isArrow = decl.init?.type === "ArrowFunctionExpression";
          const isFunc = decl.init?.type === "FunctionExpression";
          if (isArrow || isFunc) {
            const startLine = source.slice(0, decl.start).split("\n").length;
            const endLine = source.slice(0, decl.end).split("\n").length;
            // Associate the symbol with the function initializer node so its
            // body subtree is walked for call extraction.
            const bodyNode = decl.init ?? decl;
            results.push({
              symbol: {
                name: declName,
                symbolType: "function",
                type: "function",
                exported: node.exportKind === "value" || node.exported === true,
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
  const addedNames = new Set<string>();
  const classBody = classNode.body;
  if (!classBody || Array.isArray(classBody)) return methods;
  const memberList = classBody.body;
  if (!Array.isArray(memberList)) return methods;

  for (const member of memberList) {
    // MethodDefinition: { run() { ... } } or { constructor() { ... } }
    if (member.type === "MethodDefinition") {
      const key = member.key;
      if (key?.type !== "Identifier" || !isString(key.name)) continue;
      const value = member.value;
      if (!value) continue;
      const methodName = key.name;
      const memberKind = member.kind === "get" || member.kind === "set" ? member.kind : null;
      const staticPrefix = member.static === true ? `${className}.static.` : `${className}.`;
      const qualifiedName = memberKind
        ? `${className}.${member.static === true ? "static." : ""}${memberKind}.${methodName}`
        : `${staticPrefix}${methodName}`;
      if (addedNames.has(qualifiedName)) continue;
      addedNames.add(qualifiedName);
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
      const key = member.key;
      if (key?.type !== "Identifier" || !isString(key.name)) continue;
      const init = member.value;
      if (!init) continue;
      const isArrow = init.type === "ArrowFunctionExpression";
      const isFunc = init.type === "FunctionExpression";
      if (!isArrow && !isFunc) continue;
      const propName = key.name;
      const qualifiedName =
        member.static === true ? `${className}.static.${propName}` : `${className}.${propName}`;
      if (addedNames.has(qualifiedName)) continue;
      addedNames.add(qualifiedName);
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
 * Recursively walk an AST value (node or array), invoking the visitor for each
 * node detected by `typeof value.type === 'string'`. A `WeakSet` guards against
 * circular references. Primitives and null are ignored.
 */
function walkNodes(
  value: OxcValue,
  visitor: (node: OxcNode) => void,
  visited: WeakSet<object>,
  skippedScopes?: WeakSet<object>,
  isRoot = false,
): void {
  if (!isNonNullObject(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) walkNodes(item, visitor, visited, skippedScopes, false);
    return;
  }
  if (visited.has(value)) return;
  visited.add(value);

  if (!isRoot && skippedScopes?.has(value)) return;

  // SAFETY: oxc-parser AST nodes are objects with a string .type property;
  // the walk only visits values from oxc-parser's parseSync output.
  const node = value as OxcNode;
  if (isString(node.type)) {
    visitor(node);
  }
  // SAFETY: Object.entries on an oxc AST object returns child properties
  // that are OxcValue (nodes, arrays, or primitives) per the oxc AST schema.
  const entries = Object.entries(value) as [string, OxcValue][];
  for (const [key, child] of entries) {
    if (key === "parent") continue;
    walkNodes(child, visitor, visited, skippedScopes, false);
  }
}

/**
 * Resolve a callee node to a human-readable name.
 * - Identifier -> identifier.name
 * - MemberExpression -> object.name + "." + property.name
 * - other -> null (skip)
 */
function calleeName(callee: OxcNode): string | null {
  if (callee.type === "Identifier" && isString(callee.name)) {
    return callee.name;
  }
  if (callee.type === "ThisExpression") return "this";
  if (callee.type === "MemberExpression") {
    const object = callee.object;
    const property = callee.property;
    const objectName = object ? calleeName(object) : null;
    if (objectName && property?.type === "Identifier" && isString(property.name)) {
      return `${objectName}.${property.name}`;
    }
  }
  return null;
}

function collectPatternBindings(pattern: OxcNode | undefined, bindings: Set<string>): void {
  if (!pattern) return;
  if (pattern.type === "Identifier" && isString(pattern.name)) {
    bindings.add(pattern.name);
    return;
  }
  if (pattern.type === "RestElement") {
    collectPatternBindings(pattern.argument, bindings);
    return;
  }
  if (pattern.type === "AssignmentPattern") {
    collectPatternBindings(pattern.left, bindings);
    return;
  }
  if (pattern.type === "ArrayPattern") {
    for (const element of pattern.elements ?? []) {
      collectPatternBindings(element ?? undefined, bindings);
    }
    return;
  }
  if (pattern.type === "ObjectPattern") {
    for (const property of pattern.properties ?? []) {
      if (property.type === "Property") {
        collectPatternBindings(property.value, bindings);
      } else {
        collectPatternBindings(property, bindings);
      }
    }
  }
}

function collectLocalBindings(node: OxcNode, skippedScopes: WeakSet<object>): Set<string> {
  const bindings = new Set<string>();
  collectPatternBindings(node.id, bindings);
  for (const parameter of node.params ?? []) {
    collectPatternBindings(parameter, bindings);
  }
  walkNodes(
    node,
    (current: OxcNode) => {
      if (current.type === "VariableDeclarator") {
        collectPatternBindings(current.id, bindings);
      } else if (current.type === "CatchClause") {
        collectPatternBindings(current.param, bindings);
      }
    },
    new WeakSet<object>(),
    skippedScopes,
    true,
  );
  return bindings;
}

/**
 * Walk each symbol's AST subtree and collect call expressions, attributing
 * calls to the owning symbol. Calls nested inside a nested callable
 * declaration are skipped so they attribute to the inner function instead.
 */
interface ExtractCallsResult {
  callExpressions: Array<{ callerName: string; calleeName: string }>;
  calledIdentifiers: Set<string>;
}

function extractCalls(symbolAsts: SymbolAst[]): ExtractCallsResult {
  const callExpressions: Array<{ callerName: string; calleeName: string }> = [];
  const calledIdentifiers = new Set<string>();
  const staticSymbolNames = new Set(
    symbolAsts.map(({ symbol }) => symbol.name).filter((name) => name.includes(".static.")),
  );
  const classNames = new Set(
    symbolAsts
      .filter(({ symbol }) => symbol.symbolType === "class")
      .map(({ symbol }) => symbol.name),
  );

  for (const { symbol, node, capturesClassThis } of symbolAsts) {
    // Only function-like symbols can contain calls.
    if (symbol.symbolType !== "function" && symbol.symbolType !== "method") continue;
    const visited = new WeakSet<object>();
    const skippedScopes = new WeakSet<object>(
      symbolAsts.filter((entry) => entry.node !== node).map((entry) => entry.node),
    );
    const localBindings = collectLocalBindings(node, skippedScopes);
    walkNodes(
      node,
      (current: OxcNode) => {
        if (current.type === "CallExpression" && current.callee) {
          const rawName = calleeName(current.callee);
          const className = symbol.name.includes(".") ? symbol.name.split(".")[0] : null;
          let name = rawName;
          if (
            rawName?.startsWith("this.") &&
            (symbol.symbolType === "method" || capturesClassThis === true) &&
            className
          ) {
            const memberName = rawName.slice("this.".length);
            name = symbol.name.includes(".static.")
              ? `${className}.static.${memberName}`
              : `${className}.${memberName}`;
          } else if (rawName && rawName.includes(".")) {
            const [receiver, ...memberParts] = rawName.split(".");
            const staticName = `${receiver}.static.${memberParts.join(".")}`;
            if (
              classNames.has(receiver) &&
              !localBindings.has(receiver) &&
              staticSymbolNames.has(staticName)
            ) {
              name = staticName;
            }
          }
          if (name) {
            callExpressions.push({ callerName: symbol.name, calleeName: name });
            calledIdentifiers.add(name);
          }
        }
      },
      visited,
      skippedScopes,
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
  type NestedCandidate = { name: string; node: OxcNode; capturesClassThis?: boolean };
  const candidates: NestedCandidate[] = [];
  const registeredBodyNodes = new Set<OxcNode>();

  function registerCandidate(name: string, bodyNode: OxcNode): void {
    if (registeredBodyNodes.has(bodyNode)) return;
    registeredBodyNodes.add(bodyNode);
    candidates.push({ name, node: bodyNode });
  }

  for (const { symbol, node } of topLevel) {
    if (symbol.symbolType !== "function" && symbol.symbolType !== "method") continue;
    walkNodes(
      node,
      (current: OxcNode) => {
        if (current === node) return;
        if (
          current.type === "FunctionDeclaration" &&
          current.id?.type === "Identifier" &&
          isString(current.id.name)
        ) {
          registerCandidate(current.id.name, current);
        }
        if (
          current.type === "FunctionExpression" &&
          current.id?.type === "Identifier" &&
          isString(current.id.name)
        ) {
          registerCandidate(current.id.name, current);
        }
        if (
          current.type === "VariableDeclarator" &&
          current.id?.type === "Identifier" &&
          isString(current.id.name) &&
          (current.init?.type === "ArrowFunctionExpression" ||
            current.init?.type === "FunctionExpression")
        ) {
          registerCandidate(current.id.name, current.init);
        }
      },
      new WeakSet<object>(),
    );
  }

  const qualifiedNames = new Map<OxcNode, string>();
  const candidateByNode = new Map<OxcNode, NestedCandidate>(
    candidates.map((candidate) => [candidate.node, candidate]),
  );
  const containers = [
    ...topLevel,
    ...candidates.map((item) => ({ symbol: { name: item.name }, node: item.node })),
  ].sort((left, right) => left.node.start - right.node.start || right.node.end - left.node.end);
  const containingSymbol = (
    candidate: NestedCandidate,
  ): (typeof containers)[number] | undefined => {
    let closest: (typeof containers)[number] | undefined;
    for (const container of containers) {
      if (
        container.node === candidate.node ||
        container.node.start > candidate.node.start ||
        container.node.end < candidate.node.end ||
        (closest &&
          container.node.end - container.node.start >= closest.node.end - closest.node.start)
      ) {
        continue;
      }
      closest = container;
    }
    return closest;
  };
  const parents = new Map<OxcNode, SymbolAst | { symbol: { name: string }; node: OxcNode }>();
  for (const candidate of candidates) {
    const closest = containingSymbol(candidate);
    if (closest) parents.set(candidate.node, closest);
  }

  const capturesClassThis = (candidate: (typeof candidates)[number]): boolean => {
    if (candidate.capturesClassThis !== undefined) return candidate.capturesClassThis;
    if (candidate.node.type !== "ArrowFunctionExpression") return false;
    const parent = parents.get(candidate.node);
    if (!parent) return false;
    const parentCandidate = candidateByNode.get(parent.node);
    const inherited = parentCandidate
      ? capturesClassThis(parentCandidate)
      : "symbolType" in parent.symbol && parent.symbol.symbolType === "method";
    candidate.capturesClassThis = inherited;
    return inherited;
  };
  for (const candidate of candidates) {
    candidate.capturesClassThis = capturesClassThis(candidate);
  }

  const qualify = (candidate: NestedCandidate): string => {
    const cached = qualifiedNames.get(candidate.node);
    if (cached) return cached;
    const parent = parents.get(candidate.node);
    if (!parent) return candidate.name;
    const parentCandidate = candidateByNode.get(parent.node);
    const parentName = parentCandidate ? qualify(parentCandidate) : parent.symbol.name;
    const qualified = `${parentName}.${candidate.name}`;
    qualifiedNames.set(candidate.node, qualified);
    return qualified;
  };

  return candidates.map((candidate) => {
    const qualifiedName = qualify(candidate);
    const bodyNode = candidate.node;
    const startLine = source.slice(0, bodyNode.start).split("\n").length;
    const endLine = source.slice(0, bodyNode.end).split("\n").length;
    return {
      symbol: {
        name: qualifiedName,
        symbolType: "function",
        type: "function",
        exported: false,
        startLine,
        endLine,
      },
      node: bodyNode,
      capturesClassThis: candidate.capturesClassThis,
    };
  });
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
      const chunks: IndexedChunk[] = [
        {
          heading: input.relativePath,
          content: input.content,
          tokenCount: counter.count(input.content),
          contentHash: Bun.hash(input.content).toString(16),
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
    // SAFETY: oxc-parser returns ESTree-compatible nodes with .type/.start/.end
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
