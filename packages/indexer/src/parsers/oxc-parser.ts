import { exactTokenCounter } from "@openez-graph/core";

import { hashContent } from "../hash";
import { createSymbolChunks, type ExtractedSymbol } from "../languages";
import type { IndexedChunk } from "../types";
import type { CodeParser, ExportBinding, ImportBinding, ParseInput, ParsedDocument } from "./types";

const TS_LANGUAGES = new Set(["typescript", "tsx", "javascript", "jsx"]);
// Type-only import/export specifiers (`import type`, `export type`) only exist
// in TypeScript — the flag stays absent on JavaScript payloads.
const TS_ONLY_LANGUAGES = new Set(["typescript", "tsx"]);

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
type SymbolAst = {
  symbol: ExtractedSymbol;
  node: OxcNode;
  capturesClassThis?: boolean;
  /** Set when extracted via `export default <decl>` — the symbol's own name
   *  is not a named export (only "default" is). */
  defaultExport?: boolean;
};

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
        if (inner.length > 0) {
          for (const s of inner) {
            s.symbol.exported = true;
            s.defaultExport = true;
            results.push(s);
          }
        } else if ((node.declaration as OxcNode).type !== "Identifier") {
          // Anonymous `export default <expr>` — give it a stable "default"
          // symbol so default imports of anonymous callables (and other
          // expressions) resolve to a real graph node. `default` is a
          // reserved word so the name cannot collide with user symbols.
          const decl = node.declaration as OxcNode;
          const isClass = decl.type === "ClassDeclaration" || decl.type === "ClassExpression";
          const symbolType = isClass
            ? "class"
            : FUNCTION_NODE_TYPES.has(decl.type)
              ? "function"
              : "variable";
          const startLine = source.slice(0, decl.start).split("\n").length;
          const endLine = source.slice(0, decl.end).split("\n").length;
          results.push({
            symbol: {
              name: "default",
              symbolType,
              type: symbolType,
              exported: true,
              startLine,
              endLine,
            },
            node: decl,
            defaultExport: true,
          });
          // Anonymous default classes expose methods as `default.<name>` so
          // member calls inside them attribute to a real graph symbol —
          // same naming a named default-export class would produce.
          if (isClass) {
            for (const methodAst of extractClassMethods(decl, "default", source)) {
              methodAst.symbol.exported = true;
              methodAst.defaultExport = true;
              results.push(methodAst);
            }
          }
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
  const addedNames = new Set<string>();
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
      const key = member.key as OxcNode | undefined;
      if (key?.type !== "Identifier" || typeof key.name !== "string") continue;
      const init = member.value as OxcNode | undefined;
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
  value: unknown,
  visitor: (node: OxcNode) => void,
  visited: WeakSet<object>,
  skippedScopes?: WeakSet<object>,
  isRoot = false,
): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walkNodes(item, visitor, visited, skippedScopes, false);
    return;
  }
  if (visited.has(value as object)) return;
  visited.add(value as object);

  if (!isRoot && skippedScopes?.has(value as object)) return;

  const node = value as Record<string, unknown>;
  const nodeType = node.type;
  if (typeof nodeType === "string") {
    visitor(node as unknown as OxcNode);
  }
  for (const [key, child] of Object.entries(node)) {
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
  if (callee.type === "Identifier" && typeof callee.name === "string") {
    return callee.name;
  }
  if (callee.type === "ThisExpression") return "this";
  if (callee.type === "MemberExpression") {
    const object = callee.object as OxcNode | undefined;
    const property = callee.property as OxcNode | undefined;
    const objectName = object ? calleeName(object) : null;
    if (objectName && property?.type === "Identifier" && typeof property.name === "string") {
      return `${objectName}.${property.name}`;
    }
  }
  return null;
}

function collectPatternBindings(pattern: OxcNode | undefined, bindings: Set<string>): void {
  if (!pattern) return;
  if (pattern.type === "Identifier" && typeof pattern.name === "string") {
    bindings.add(pattern.name);
    return;
  }
  if (pattern.type === "RestElement") {
    collectPatternBindings(pattern.argument as OxcNode | undefined, bindings);
    return;
  }
  if (pattern.type === "AssignmentPattern") {
    collectPatternBindings(pattern.left as OxcNode | undefined, bindings);
    return;
  }
  if (pattern.type === "ArrayPattern") {
    for (const element of pattern.elements ?? []) {
      collectPatternBindings(element as OxcNode | undefined, bindings);
    }
    return;
  }
  if (pattern.type === "ObjectPattern") {
    for (const property of pattern.properties ?? []) {
      if (property.type === "Property") {
        collectPatternBindings(property.value as OxcNode | undefined, bindings);
      } else {
        collectPatternBindings(property as OxcNode, bindings);
      }
    }
  }
}

const FUNCTION_NODE_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

/** `= require("...")` initializer → static specifier, else null. */
function requireCallModule(init: OxcNode | undefined): string | null {
  const callee = init?.callee as OxcNode | undefined;
  const firstArg = init?.arguments?.[0] as OxcNode | undefined;
  return init?.type === "CallExpression" &&
    callee?.type === "Identifier" &&
    callee.name === "require" &&
    firstArg?.type === "Literal" &&
    typeof firstArg.value === "string"
    ? firstArg.value
    : null;
}

/** Names hoisted to a function's whole body: params, a named
 *  FunctionExpression's self-name, and every `var` declarator in the subtree
 *  (stopping at nested function boundaries — their `var`s are theirs). */
function collectFunctionScopeNames(fnNode: OxcNode, visited: WeakSet<object>): Set<string> {
  const names = new Set<string>();
  collectPatternBindings(fnNode.id as OxcNode | undefined, names);
  for (const parameter of fnNode.params ?? []) {
    collectPatternBindings(parameter as OxcNode, names);
  }
  const collectVars = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) collectVars(item);
      return;
    }
    if (visited.has(value as object)) return;
    visited.add(value as object);
    const node = value as OxcNode;
    if (FUNCTION_NODE_TYPES.has(node.type)) return; // nested function boundary
    if (node.type === "VariableDeclaration" && node.kind === "var") {
      for (const decl of (node.declarations ?? []) as OxcNode[]) {
        // `var x = require(...)` is a module binding only when `require` is unbound.
        if (!names.has("require") && requireCallModule(decl.init as OxcNode | undefined) !== null) {
          continue;
        }
        collectPatternBindings(decl.id as OxcNode | undefined, names);
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === "parent") continue;
      collectVars(child);
    }
  };
  collectVars(fnNode.body);
  return names;
}

interface ScopeFrame {
  /** Names visible inside this frame's subtree. */
  names: Set<string>;
  /** The node that opened the frame — its [start,end] range is the scope's
   *  visibility region for function-local require bindings. */
  node: OxcNode;
  /** Optional visibility override for require-binding ranges — e.g. a
   *  switch's case-scope starts at its first case, after the discriminant. */
  scopeStart?: number;
  scopeEnd?: number;
}

interface ScopedRequireBinding {
  local: string;
  module: string;
  imported: string;
  scopeStart: number;
  scopeEnd: number;
}

interface ScopedWalkState {
  scopes: ScopeFrame[];
  /** Stack of indexes into `scopes` that are function frames — `var` targets
   *  the innermost one. */
  fnScopeStack: number[];
  skippedScopes: WeakSet<object>;
  visited: WeakSet<object>;
  /** VariableDeclaration nodes already collected by an enclosing scope
   *  opener — the generic visit must not re-collect them. */
  collectedDecls: WeakSet<object>;
  rootNode: OxcNode;
  requireBindings: ScopedRequireBinding[];
  requirePaths: string[];
}

/** Collect declaration names owned by a VariableDeclaration into the right
 *  scope — `var` hoists to the innermost function scope, `let`/`const` stay
 *  in the current block frame. `= require("...")` declarators produce scoped
 *  module bindings instead of shadow names when `require` is unbound. */
function collectDeclaratorNames(
  node: OxcNode,
  blockScope: ScopeFrame,
  state: ScopedWalkState,
): void {
  if (state.collectedDecls.has(node)) return;
  state.collectedDecls.add(node);
  const target =
    node.kind === "var"
      ? state.scopes[state.fnScopeStack[state.fnScopeStack.length - 1]]
      : blockScope;
  for (const decl of (node.declarations ?? []) as OxcNode[]) {
    const requireShadowed = state.scopes.some((scope) => scope.names.has("require"));
    const module = requireShadowed ? null : requireCallModule(decl.init as OxcNode | undefined);
    if (module !== null) {
      state.requirePaths.push(module);
      // The binding's visibility matches the declaration's scope: `var`
      // require bindings are visible across the whole function, `let`/`const`
      // only inside their block.
      const id = decl.id as OxcNode | undefined;
      const addBinding = (local: string, imported: string) =>
        state.requireBindings.push({
          local,
          module,
          imported,
          scopeStart: target.scopeStart ?? target.node.start,
          scopeEnd: target.scopeEnd ?? target.node.end,
        });
      if (id?.type === "Identifier" && typeof id.name === "string") {
        addBinding(id.name, "*");
      } else if (id?.type === "ObjectPattern") {
        for (const prop of (id.properties ?? []) as OxcNode[]) {
          const key = prop.key as OxcNode | undefined;
          const value = prop.value as OxcNode | undefined;
          const keyName =
            key?.type === "Identifier"
              ? key.name
              : key?.type === "Literal" && typeof key.value === "string"
                ? key.value
                : null;
          if (prop.type === "Property" && keyName && value?.type === "Identifier") {
            addBinding(value.name, keyName);
          }
        }
      }
      continue;
    }
    collectPatternBindings(decl.id as OxcNode | undefined, target.names);
  }
}

/** Eagerly collect the declarations a block owns — block-scoped bindings
 *  cover their whole block (TDZ), so a `let`/`const`/function/class declared
 *  later in the same block still shadows earlier call sites. */
function collectBlockScopeNames(
  statements: OxcNode[],
  frame: ScopeFrame,
  state: ScopedWalkState,
): void {
  for (const stmt of statements) {
    if (stmt.type === "VariableDeclaration") {
      collectDeclaratorNames(stmt, frame, state);
    } else if (
      (stmt.type === "FunctionDeclaration" ||
        stmt.type === "ClassDeclaration" ||
        stmt.type === "TSEnumDeclaration") &&
      stmt.id?.type === "Identifier"
    ) {
      frame.names.add(stmt.id.name);
    }
  }
}

/**
 * Walk each symbol's AST subtree and collect call expressions, attributing
 * calls to the owning symbol. Scope tracking is lexical: a call is marked
 * `shadowedLocal` only when its callee root is bound by a scope that actually
 * encloses the call site — a `const` in a sibling block does not suppress a
 * valid import resolution. Calls nested inside a nested callable declaration
 * are skipped so they attribute to the inner function instead.
 */
function extractCalls(symbolAsts: SymbolAst[]): {
  callExpressions: Array<{
    callerName: string;
    calleeName: string;
    start: number;
    shadowedLocal?: boolean;
  }>;
  calledIdentifiers: Set<string>;
  scopedRequireBindings: ScopedRequireBinding[];
  scopedRequirePaths: string[];
} {
  const callExpressions: Array<{
    callerName: string;
    calleeName: string;
    start: number;
    shadowedLocal?: boolean;
  }> = [];
  const calledIdentifiers = new Set<string>();
  const scopedRequireBindings: ScopedRequireBinding[] = [];
  const scopedRequirePaths: string[] = [];
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
    const skippedScopes = new WeakSet<object>(
      symbolAsts.filter((entry) => entry.node !== node).map((entry) => entry.node),
    );
    const state: ScopedWalkState = {
      scopes: [],
      fnScopeStack: [],
      skippedScopes,
      visited: new WeakSet<object>(),
      collectedDecls: new WeakSet<object>(),
      rootNode: node,
      requireBindings: scopedRequireBindings,
      requirePaths: scopedRequirePaths,
    };
    // The symbol's own function scope: params, self-name, hoisted `var`s.
    const rootFrame: ScopeFrame = {
      names: collectFunctionScopeNames(node, new WeakSet<object>([node])),
      node,
    };
    state.scopes.push(rootFrame);
    state.fnScopeStack.push(0);

    const inScope = (name: string): boolean => state.scopes.some((s) => s.names.has(name));

    const visit = (value: unknown): void => {
      if (value === null || typeof value !== "object") return;
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (state.visited.has(value as object)) return;
      state.visited.add(value as object);
      if (value !== node && skippedScopes.has(value as object)) return; // nested symbol
      const current = value as OxcNode;

      // Nested (non-symbol) functions open their own scope.
      if (current !== node && FUNCTION_NODE_TYPES.has(current.type)) {
        const frame: ScopeFrame = {
          names: collectFunctionScopeNames(current, new WeakSet<object>()),
          node: current,
        };
        state.scopes.push(frame);
        state.fnScopeStack.push(state.scopes.length - 1);
        for (const [key, child] of Object.entries(current)) {
          if (key === "parent") continue;
          visit(child);
        }
        state.fnScopeStack.pop();
        state.scopes.pop();
        return;
      }

      if (current.type === "BlockStatement" || current.type === "StaticBlock") {
        const frame: ScopeFrame = { names: new Set(), node: current };
        state.scopes.push(frame);
        collectBlockScopeNames((current.body ?? []) as OxcNode[], frame, state);
        for (const [key, child] of Object.entries(current)) {
          if (key === "parent") continue;
          visit(child);
        }
        state.scopes.pop();
        return;
      }

      if (current.type === "SwitchStatement") {
        // The discriminant is evaluated in the enclosing scope — case-block
        // declarations must not shadow it, and require bindings inside cases
        // must not cover the discriminant's position either.
        visit(current.discriminant);
        const firstCase = (current.cases ?? [])[0] as OxcNode | undefined;
        const frame: ScopeFrame = {
          names: new Set(),
          node: current,
          scopeStart: firstCase?.start ?? current.end,
          scopeEnd: current.end,
        };
        state.scopes.push(frame);
        const statements = ((current.cases ?? []) as OxcNode[]).flatMap(
          (c) => (c.consequent ?? []) as OxcNode[],
        );
        collectBlockScopeNames(statements, frame, state);
        for (const caze of (current.cases ?? []) as OxcNode[]) {
          visit(caze);
        }
        state.scopes.pop();
        return;
      }

      if (
        current.type === "ForStatement" ||
        current.type === "ForInStatement" ||
        current.type === "ForOfStatement"
      ) {
        const frame: ScopeFrame = { names: new Set(), node: current };
        state.scopes.push(frame);
        const decl = (current.type === "ForStatement" ? current.init : current.left) as
          | OxcNode
          | undefined;
        if (decl?.type === "VariableDeclaration") collectDeclaratorNames(decl, frame, state);
        for (const [key, child] of Object.entries(current)) {
          if (key === "parent") continue;
          visit(child);
        }
        state.scopes.pop();
        return;
      }

      if (current.type === "CatchClause") {
        const frame: ScopeFrame = { names: new Set(), node: current };
        state.scopes.push(frame);
        collectPatternBindings(current.param as OxcNode | undefined, frame.names);
        for (const [key, child] of Object.entries(current)) {
          if (key === "parent") continue;
          visit(child);
        }
        state.scopes.pop();
        return;
      }

      if (current.type === "VariableDeclaration") {
        // Stragglers not collected by a block/for opener (e.g. `label: let x`).
        const top = state.scopes[state.scopes.length - 1];
        collectDeclaratorNames(current, top, state);
      }

      if (current.type === "CallExpression") {
        const rawName = calleeName(current.callee as OxcNode);
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
          if (classNames.has(receiver) && !inScope(receiver) && staticSymbolNames.has(staticName)) {
            name = staticName;
          }
        }
        if (name) {
          const rootName = name.split(".")[0];
          callExpressions.push({
            callerName: symbol.name,
            calleeName: name,
            start: current.start,
            ...(inScope(rootName) ? { shadowedLocal: true } : {}),
          });
          calledIdentifiers.add(name);
        }
      }

      for (const [key, child] of Object.entries(current)) {
        if (key === "parent") continue;
        visit(child);
      }
    };

    visit(node);
  }

  return { callExpressions, calledIdentifiers, scopedRequireBindings, scopedRequirePaths };
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
        if (current.type === "FunctionDeclaration" && current.id?.type === "Identifier") {
          registerCandidate(current.id.name, current);
        }
        if (current.type === "FunctionExpression" && current.id?.type === "Identifier") {
          registerCandidate(current.id.name, current);
        }
        if (
          current.type === "VariableDeclarator" &&
          current.id?.type === "Identifier" &&
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
 * Extract static module bindings (ESM imports/re-exports and CommonJS
 * require/exports) alongside the symbols the exports declare.
 *
 * importBindings: local name -> { module specifier, imported export name }
 *   ("default" for default imports, "*" for namespace imports and plain
 *   `const x = require()` bindings).
 * exportBindings: this file's export table — `local` maps an export name to a
 *   same-file symbol, `reexport` forwards to another module's export, and
 *   `star` is a wildcard re-export expanded at graph build time.
 * extraSymbolAsts: function/class values assigned via `exports.foo = ...`,
 *   `module.exports.foo = ...`, or object-literal `module.exports` — each is a
 *   real local declaration the property name identifies, so it becomes a
 *   first-class exported symbol (and produces a derived `local` export entry
 *   through its `exported` flag downstream).
 * requirePaths: static `require("...")` specifiers — recorded as import paths
 *   like ESM sources. Computed/dynamic requires are ignored.
 */
interface ExtractedBindings {
  importBindings: ImportBinding[];
  exportBindings: ExportBinding[];
  extraSymbolAsts: SymbolAst[];
  requirePaths: string[];
}

function symbolAstFromValue(name: string, value: OxcNode, source: string): SymbolAst | null {
  const symbolType = value.type === "ClassExpression" ? "class" : "function";
  if (
    value.type !== "FunctionExpression" &&
    value.type !== "ArrowFunctionExpression" &&
    value.type !== "ClassExpression"
  ) {
    return null;
  }
  const startLine = source.slice(0, value.start).split("\n").length;
  const endLine = source.slice(0, value.end).split("\n").length;
  return {
    symbol: {
      name,
      symbolType,
      type: symbolType,
      exported: true,
      startLine,
      endLine,
    },
    node: value,
  };
}

/** Classify the left side of a CommonJS export assignment: Identifier
 *  `exports.name` and `module.exports.name` -> {kind:"member"} with the
 *  property name; bare `module.exports` -> {kind:"self"}; anything else
 *  (computed, different root) -> null. */
function commonjsExportTarget(
  left: OxcNode,
): { kind: "member"; name: string } | { kind: "self" } | null {
  if (left.type !== "MemberExpression" || left.computed === true) return null;
  const object = left.object as OxcNode | undefined;
  const property = left.property as OxcNode | undefined;
  if (object?.type === "Identifier" && object.name === "exports") {
    return property?.type === "Identifier" ? { kind: "member", name: property.name } : null;
  }
  if (object?.type === "Identifier" && object.name === "module") {
    return property?.type === "Identifier" && property.name === "exports" ? { kind: "self" } : null;
  }
  if (
    object?.type === "MemberExpression" &&
    object.computed !== true &&
    (object.object as OxcNode | undefined)?.type === "Identifier" &&
    (object.object as OxcNode).name === "module" &&
    (object.property as OxcNode | undefined)?.type === "Identifier" &&
    (object.property as OxcNode).name === "exports"
  ) {
    return property?.type === "Identifier" ? { kind: "member", name: property.name } : null;
  }
  return null;
}

function extractModuleBindings(
  body: OxcNode[],
  source: string,
  isTypeScript: boolean,
): ExtractedBindings {
  const importBindings: ImportBinding[] = [];
  const exportBindings: ExportBinding[] = [];
  const extraSymbolAsts: SymbolAst[] = [];
  const requirePaths: string[] = [];
  // Type-only state is per specifier: `import { type A, B }` marks A only.
  const typeOnly = (declKind: unknown, specKind: unknown): true | undefined =>
    isTypeScript && (declKind === "type" || specKind === "type") ? true : undefined;

  for (const node of body) {
    if (node.type === "ImportDeclaration") {
      const module = typeof node.source?.value === "string" ? node.source.value : null;
      if (!module) continue;
      for (const spec of (node.specifiers ?? []) as OxcNode[]) {
        const flag = typeOnly(node.importKind, spec.importKind);
        if (spec.type === "ImportDefaultSpecifier" && typeof spec.local?.name === "string") {
          importBindings.push({
            local: spec.local.name,
            module,
            imported: "default",
            ...(flag ? { typeOnly: true } : {}),
          });
        } else if (
          spec.type === "ImportNamespaceSpecifier" &&
          typeof spec.local?.name === "string"
        ) {
          importBindings.push({
            local: spec.local.name,
            module,
            imported: "*",
            ...(flag ? { typeOnly: true } : {}),
          });
        } else if (
          spec.type === "ImportSpecifier" &&
          typeof spec.local?.name === "string" &&
          typeof spec.imported?.name === "string"
        ) {
          importBindings.push({
            local: spec.local.name,
            module,
            imported: spec.imported.name,
            ...(flag ? { typeOnly: true } : {}),
          });
        }
      }
      continue;
    }

    if (node.type === "ExportNamedDeclaration" && !node.declaration) {
      const module = typeof node.source?.value === "string" ? node.source.value : null;
      for (const spec of (node.specifiers ?? []) as OxcNode[]) {
        if (
          spec.type !== "ExportSpecifier" ||
          typeof spec.exported?.name !== "string" ||
          typeof spec.local?.name !== "string"
        ) {
          continue;
        }
        const flag = typeOnly(node.exportKind, spec.exportKind);
        if (module) {
          exportBindings.push({
            name: spec.exported.name,
            kind: "reexport",
            module,
            imported: spec.local.name,
            ...(flag ? { typeOnly: true } : {}),
          });
        } else {
          exportBindings.push({
            name: spec.exported.name,
            kind: "local",
            local: spec.local.name,
            ...(flag ? { typeOnly: true } : {}),
          });
        }
      }
      continue;
    }

    if (node.type === "ExportDefaultDeclaration" && node.declaration) {
      const decl = node.declaration as OxcNode;
      const declName = getNodeId(decl);
      if (declName) {
        const flag =
          isTypeScript &&
          (decl.type === "TSInterfaceDeclaration" || decl.type === "TSTypeAliasDeclaration");
        exportBindings.push({
          name: "default",
          kind: "local",
          local: declName,
          ...(flag ? { typeOnly: true } : {}),
        });
      } else if (decl.type !== "Identifier") {
        // Anonymous declaration — extractSymbols synthesized a "default" symbol.
        exportBindings.push({ name: "default", kind: "local", local: "default" });
      }
      continue;
    }

    if (node.type === "ExportAllDeclaration" && typeof node.source?.value === "string") {
      // `export * as ns from` exports a namespace object, not top-level
      // re-exports — leave it unresolved rather than mis-expanding members.
      if (node.exported) continue;
      exportBindings.push({
        name: "*",
        kind: "star",
        module: node.source.value,
        ...(typeOnly(node.exportKind, undefined) ? { typeOnly: true } : {}),
      });
      continue;
    }

    // CommonJS require bindings: `const x = require("...")` and
    // `const { a, b: c } = require("...")`. Only string-literal specifiers at
    // top level are static; computed requires produce no bindings.
    if (node.type === "VariableDeclaration") {
      for (const decl of (node.declarations ?? []) as OxcNode[]) {
        const module = requireCallModule(decl.init as OxcNode | undefined);
        if (module === null) continue;
        requirePaths.push(module);
        const id = decl.id as OxcNode | undefined;
        if (id?.type === "Identifier" && typeof id.name === "string") {
          importBindings.push({ local: id.name, module, imported: "*" });
        } else if (id?.type === "ObjectPattern") {
          for (const prop of (id.properties ?? []) as OxcNode[]) {
            const key = prop.key as OxcNode | undefined;
            const value = prop.value as OxcNode | undefined;
            const keyName =
              key?.type === "Identifier"
                ? key.name
                : key?.type === "Literal" && typeof key.value === "string"
                  ? key.value
                  : null;
            if (prop.type === "Property" && keyName && value?.type === "Identifier") {
              importBindings.push({ local: value.name, module, imported: keyName });
            }
          }
        }
      }
      continue;
    }

    // CommonJS exports: `exports.foo = X`, `module.exports.foo = X`, and
    // `module.exports = {foo: X}`. A property resolves only when its value
    // maps to exactly one local declaration.
    if (node.type === "ExpressionStatement") {
      const expr = node.expression as OxcNode | undefined;
      // Bare `require("lit")` is a static dependency (no local binding).
      if (expr?.type === "CallExpression") {
        const callee = expr.callee as OxcNode | undefined;
        const firstArg = expr.arguments?.[0] as OxcNode | undefined;
        if (
          callee?.type === "Identifier" &&
          callee.name === "require" &&
          firstArg?.type === "Literal" &&
          typeof firstArg.value === "string"
        ) {
          requirePaths.push(firstArg.value);
        }
        continue;
      }
      if (expr?.type !== "AssignmentExpression" || expr.operator !== "=") continue;
      const left = expr.left as OxcNode | undefined;
      const right = expr.right as OxcNode | undefined;
      if (!left || !right) continue;
      const target = commonjsExportTarget(left);
      if (!target) continue;
      if (target.kind === "member") {
        const valueSymbol = symbolAstFromValue(target.name, right, source);
        if (valueSymbol) {
          extraSymbolAsts.push(valueSymbol);
        } else if (right.type === "Identifier" && typeof right.name === "string") {
          exportBindings.push({ name: target.name, kind: "local", local: right.name });
        }
      } else if (right.type === "ObjectExpression") {
        for (const prop of (right.properties ?? []) as OxcNode[]) {
          if (prop.type !== "Property" || prop.computed === true) continue;
          const key = prop.key as OxcNode | undefined;
          const value = prop.value as OxcNode | undefined;
          if (key?.type !== "Identifier" || !value) continue;
          const valueSymbol = symbolAstFromValue(key.name, value, source);
          if (valueSymbol) {
            extraSymbolAsts.push(valueSymbol);
          } else if (value.type === "Identifier" && typeof value.name === "string") {
            exportBindings.push({ name: key.name, kind: "local", local: value.name });
          }
        }
      }
      continue;
    }
  }

  return { importBindings, exportBindings, extraSymbolAsts, requirePaths };
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
    const bindings = extractModuleBindings(
      body,
      input.content,
      TS_ONLY_LANGUAGES.has(language ?? ""),
    );
    importPaths.push(...bindings.requirePaths);
    // Declarations exported directly (`export function f`) produce derived
    // `local` export entries from their `exported` flag; specifier re-exports,
    // default exports, and CommonJS identifier mappings are explicit entries.
    // A default-exported declaration only exports "default" — its own name is
    // not a named export.
    for (const ast of [...symbolAsts, ...bindings.extraSymbolAsts]) {
      if (ast.symbol.exported && !ast.defaultExport) {
        bindings.exportBindings.push({
          name: ast.symbol.name,
          kind: "local",
          local: ast.symbol.name,
        });
      }
    }
    // Discover nested callable declarations so calls inside them attribute to
    // the inner symbol, not the outer one. These nested callables are now
    // included in the public definedSymbols list so they appear as first-class
    // graph symbols (nodes + call edges).
    const nestedCallables = discoverNestedCallables(
      [...symbolAsts, ...bindings.extraSymbolAsts],
      input.content,
    );
    const allSymbolAsts = [...symbolAsts, ...bindings.extraSymbolAsts, ...nestedCallables];
    const allSymbols = allSymbolAsts.map((s) => s.symbol);
    const { callExpressions, calledIdentifiers, scopedRequireBindings, scopedRequirePaths } =
      extractCalls(allSymbolAsts);
    // Function-local `const x = require("...")` bindings carry the byte range
    // of their owning scope — call sites match by position, innermost wins.
    for (const binding of scopedRequireBindings) bindings.importBindings.push(binding);
    for (const specifier of scopedRequirePaths) {
      if (!importPaths.includes(specifier)) importPaths.push(specifier);
    }
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
      importBindings: bindings.importBindings,
      exportBindings: bindings.exportBindings,
    };
  }
}
