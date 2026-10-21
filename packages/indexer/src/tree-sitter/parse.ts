import type { Node } from "web-tree-sitter";
import type { TokenCounter } from "@openez-graph/core";

import {
  createSymbolChunks,
  makeFallbackChunks,
  type ExtractedSymbol,
  type IndexedCodeResult,
} from "../languages";
import { parseContent } from "./loader";

// ── Language config ──

export interface SymbolRule {
  /** tree-sitter node type, e.g. "function_definition" */
  nodeType: string;
  /** output symbolType: "function", "class", "struct", etc. */
  symbolType: string;
  /** field name containing the identifier node (usually "name") */
  nameField?: string;
  /** override name extraction for complex nodes (e.g. Rust impl_item) */
  extractName?: (node: Node) => string | null;
  /** override context name for nesting (defaults to symbol name) */
  extractContextName?: (node: Node, contextStack: ReadonlyArray<ContextFrame>) => string | null;
  /** push context stack without emitting a symbol or extracting calls */
  contextOnly?: boolean;
  /** context kind for this rule's frames; only "class" | "module" for Ruby */
  contextKind?: "class" | "module";
  /** whether this node establishes a parent context for nested symbols */
  establishesContext?: boolean;
  /** determine if symbol is exported; defaults to language-specific */
  isExported?: (name: string, node: Node) => boolean;
  /** receiver field for methods (Go) */
  receiverField?: string;
  /** transform receiver text (e.g. strip parens) */
  normalizeReceiver?: (text: string) => string;
  /** emit one symbol per identifier (Go const/var specs) */
  extractNames?: (node: Node) => string[];
  /** emit symbols only at package level (empty context stack) */
  topLevelOnly?: boolean;
  /** dynamic symbol type override — C++ function_definition resolves to
   *  "method" (qualified declarator or class context) vs "function" */
  symbolTypeFor?: (node: Node, contextStack: ReadonlyArray<ContextFrame>) => string;
}

/**
 * Context frame on the walker's context stack. `kind` is optional — only
 * Ruby class/module rules set it so singleton_class.extractContextName and
 * the qualifyCall hook can walk back for the nearest class/module frame.
 * Python/Go/Rust frames have kind: undefined.
 */
export interface ContextFrame {
  name: string;
  /** Byte offset where this context's node ends — used to pop contexts when
   *  the walker reaches a sibling that shares the end row (same-line
   *  declarations), where an end-row-only check cannot tell child from
   *  sibling. */
  endByte: number;
  kind?: "class" | "module";
  receiver?: { varName: string; typeName: string };
}

export interface ImportRule {
  nodeType: string;
  /** Extract import path strings from this node */
  extract: (node: Node) => string[];
}

export interface CallRule {
  nodeType: string;
  /** field containing the callable expression */
  functionField: string;
  /**
   * Optional override for callee extraction when the call node's callee is
   * not a single field (Java method_invocation: `name` field plus optional
   * `object`/`super` receiver). Takes precedence over functionField.
   */
  extractCall?: (callNode: Node) => string | null;
  /**
   * Optional second node type treated as a call only when its `typeField`
   * child has `requiredTypeKind` — Go generic instantiations surface as
   * `type_conversion_expression` with a `generic_type` type node.
   */
  typeConversion?: { nodeType: string; typeField: string; requiredTypeKind: string };
}

export interface LanguageConfig {
  /** tree-sitter language name: "python", "go", "rust" */
  language: string;
  symbolRules: SymbolRule[];
  importRules: ImportRule[];
  callRule: CallRule;
  /** identifiers to ignore as callees (keywords, builtins) */
  callIgnores: Set<string>;
  /** normalize a callee name (strip receiver, path, etc.) */
  normalizeCallName: (name: string) => string;
  /** node types that establish parent context for symbol nesting */
  contextNodeTypes: Set<string>;
  /** name field for context nodes (for building "Class::method" names) */
  contextNameField: string;
  /**
   * Optional hook to qualify a callee name based on the call node's receiver
   * and the active context stack. Returns the qualified callee, or null to
   * keep the normalized name unqualified. Used for Ruby self.foo →
   * TypeName::foo. Go receiver qualification stays in extractCallsInNode
   * via receiverInfo and is unaffected.
   */
  qualifyCall?: (
    callNode: Node,
    calleeName: string,
    normalized: string,
    contextStack: ReadonlyArray<ContextFrame>,
  ) => string | null;
  /**
   * When true, `callExpressions[].calleeName` keeps the qualified dotted
   * name (`pkg.func`, `self.m`) while `calledIdentifiers` records the last
   * segment; the call-ignore list is applied to the raw, normalized, and
   * last-segment forms. Python only — resolution consumes the qualifier.
   */
  keepQualifiedCallee?: boolean;
  /**
   * Optional post-pass that marks `call.shadowedLocal` for calls whose
   * last segment is bound as a local inside the caller's symbol range.
   * Runs once per file on the walker's output — Rust only.
   */
  markCallShadowing?: (
    content: string,
    symbols: ExtractedSymbol[],
    calls: Array<{ callerName: string; calleeName: string; shadowedLocal?: boolean }>,
  ) => void;
  /**
   * Optional source pre-pass applied only to the text handed to the
   * tree-sitter parser — chunking still uses the original content. C# uses it
   * to blank conditional-directive lines while preserving every byte offset.
   */
  preprocess?: (content: string) => string;
  /**
   * Node types whose symbol span extends to end-of-file instead of the
   * node's own end row — a C# `namespace Foo;` (file-scoped) covers the rest
   * of the file even though the grammar node ends at the semicolon.
   */
  eofSpanNodeTypes?: ReadonlySet<string>;
  /**
   * When true, any syntax error in the tree rejects the whole parse so the
   * caller falls back to generic chunks with no graph records. Used by the
   * `.h` C++ config only — other C++ extensions keep their partial trees.
   */
  errorFailsParse?: boolean;
}

// ── Extraction core ──

/** Extract receiver variable name from Go receiver text: `(f Foo)` → `f` */
function goReceiverName(text: string): string | null {
  const inner = text.replace(/^\(+|\)+$/g, "").trim();
  const parts = inner.split(/\s+/);
  return parts[0] ?? null;
}

/** Extract receiver type from Go receiver text: `(f Foo)` → `Foo`, `(b *Bar)` → `Bar` */
function goReceiverType(text: string): string | null {
  const inner = text.replace(/^\(+|\)+$/g, "").trim();
  const parts = inner.split(/\s+/);
  const typePart = parts[parts.length - 1];
  if (!typePart) return null;
  return typePart.replace(/^\*/, "").replace(/^\[\]/, "") || null;
}

function getNodeName(node: Node, field: string): string | null {
  const nameNode = node.childForFieldName(field);
  if (nameNode) return nameNode.text;
  // Some grammars use child by index
  const firstChild = node.namedChildren.find((c) => c.type === "identifier");
  return firstChild?.text ?? null;
}

/**
 * Last segment of a qualified callee: `pkg.func` → `func`,
 * `crate::util::run` → `run`, `x.run` → `run`. Used for calledIdentifiers
 * when `keepQualifiedCallee` keeps the full path in callExpressions.
 */
function lastPathSegment(value: string): string {
  return value.split(/[.:]/).filter(Boolean).pop() ?? value;
}

function isCallNode(node: Node, callRule: CallRule): boolean {
  if (node.type === callRule.nodeType) return true;
  const tc = callRule.typeConversion;
  return (
    tc !== undefined &&
    node.type === tc.nodeType &&
    node.childForFieldName(tc.typeField)?.type === tc.requiredTypeKind
  );
}

function extractCallName(node: Node, callRule: CallRule): string | null {
  if (callRule.extractCall) return callRule.extractCall(node);
  const tc = callRule.typeConversion;
  if (tc && node.type === tc.nodeType) {
    return node.childForFieldName(tc.typeField)?.text ?? null;
  }
  const funcNode = node.childForFieldName(callRule.functionField);
  if (!funcNode) return null;
  return funcNode.text;
}

function walkTree(
  root: Node,
  config: LanguageConfig,
  lines: string[],
): {
  symbols: ExtractedSymbol[];
  importPaths: string[];
  calledIdentifiers: Set<string>;
  callExpressions: Array<{ callerName: string; calleeName: string }>;
} {
  const symbols: ExtractedSymbol[] = [];
  const importPaths: string[] = [];
  const calledIdentifiers = new Set<string>();
  const callExpressions: Array<{ callerName: string; calleeName: string }> = [];

  // Stack of parent contexts for nested symbol naming (e.g. Class::method).
  // Carries optional receiver (varName, typeName) for Go methods so calls
  // through the receiver variable can be qualified as Type::method.
  const contextStack: ContextFrame[] = [];

  // Map node types to symbol rules for quick lookup
  const symbolRuleMap = new Map<string, SymbolRule>();
  for (const rule of config.symbolRules) {
    symbolRuleMap.set(rule.nodeType, rule);
  }

  // Map node types to import rules
  const importRuleMap = new Map<string, ImportRule>();
  for (const rule of config.importRules) {
    importRuleMap.set(rule.nodeType, rule);
  }

  // Recursive walk using a stack (depth-first, pre-order)
  // Each entry: { node, isContext }
  const stack: Node[] = [root];

  while (stack.length > 0) {
    const node = stack.pop()!;
    const startRow = node.startPosition.row + 1; // 1-based
    const endRow = config.eofSpanNodeTypes?.has(node.type)
      ? lines.length
      : node.endPosition.row + 1;

    // Pop expired contexts. A context ends where its node ends byte-wise:
    // a node starting at or after that byte is outside the context even when
    // it shares the context's end row (same-line sibling declarations).
    while (
      contextStack.length > 0 &&
      node.startIndex >= contextStack[contextStack.length - 1].endByte
    ) {
      contextStack.pop();
    }

    // Check for import
    const importRule = importRuleMap.get(node.type);
    if (importRule) {
      const paths = importRule.extract(node);
      importPaths.push(...paths);
    }

    // Check for Python decorated_definition — extract decorator call edges
    // linking the inner function/class to each decorator name.
    if (node.type === "decorated_definition") {
      // Find the inner definition (function_definition or class_definition)
      let innerName: string | null = null;
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (!child) continue;
        if (child.type === "function_definition" || child.type === "class_definition") {
          const nameNode = child.childForFieldName("name");
          if (nameNode) {
            const rawName = nameNode.text;
            const parentName =
              contextStack.length > 0 ? contextStack[contextStack.length - 1].name : null;
            innerName = parentName ? `${parentName}::${rawName}` : rawName;
          }
          break;
        }
      }

      // Extract decorator names and create call edges
      if (innerName) {
        for (let i = 0; i < node.namedChildCount; i++) {
          const child = node.namedChild(i);
          if (!child || child.type !== "decorator") continue;
          // Decorator contains an expression: identifier, attribute, or call
          const expr = child.namedChild(0);
          if (!expr) continue;
          let decName: string | null = null;
          if (expr.type === "call") {
            // @app.route("/api") → extract function name
            const funcNode = expr.childForFieldName("function");
            if (funcNode) {
              decName = config.normalizeCallName(funcNode.text);
            }
          } else {
            // @lru_cache or @app.route → normalize the expression text
            decName = config.normalizeCallName(expr.text);
          }
          const decIdentifier = decName
            ? config.keepQualifiedCallee
              ? lastPathSegment(decName)
              : decName
            : null;
          if (
            decName &&
            decIdentifier &&
            !config.callIgnores.has(decName) &&
            !config.callIgnores.has(decIdentifier) &&
            decName !== innerName
          ) {
            calledIdentifiers.add(decIdentifier);
            callExpressions.push({ callerName: innerName, calleeName: decName });
          }
        }
      }
    }

    // Check for symbol
    const symbolRule = symbolRuleMap.get(node.type);
    if (symbolRule) {
      if (symbolRule.contextOnly) {
        const contextName = symbolRule.extractContextName
          ? (symbolRule.extractContextName(node, contextStack) ?? null)
          : null;
        if (contextName) {
          contextStack.push({
            name: contextName,
            endByte: node.endIndex,
            kind: symbolRule.contextKind,
          });
        }
        // Skip symbol emission and call extraction — context-only.
      } else if (symbolRule.extractNames) {
        // Multi-name declarations (Go const/var specs). These are values,
        // not callables: emit symbols but never contexts or call edges.
        if (!symbolRule.topLevelOnly || contextStack.length === 0) {
          const parentName =
            contextStack.length > 0 ? contextStack[contextStack.length - 1].name : null;
          for (const specName of symbolRule.extractNames(node)) {
            if (!specName || specName === "_") continue;
            symbols.push({
              name: parentName ? `${parentName}::${specName}` : specName,
              symbolType: symbolRule.symbolType,
              type: symbolRule.symbolType,
              exported: symbolRule.isExported ? symbolRule.isExported(specName, node) : false,
              startLine: startRow,
              endLine: endRow,
            });
          }
        }
      } else {
        const name = symbolRule.extractName
          ? symbolRule.extractName(node)
          : getNodeName(node, symbolRule.nameField ?? "name");
        if (name) {
          const parentName =
            contextStack.length > 0 ? contextStack[contextStack.length - 1].name : null;
          const exported = symbolRule.isExported ? symbolRule.isExported(name, node) : false;

          let receiver: string | undefined;
          let receiverVar: string | null = null;
          let receiverType: string | null = null;
          if (symbolRule.receiverField) {
            const rawReceiver = node.childForFieldName(symbolRule.receiverField)?.text;
            if (rawReceiver) {
              receiver = symbolRule.normalizeReceiver
                ? symbolRule.normalizeReceiver(rawReceiver)
                : rawReceiver;
              receiverVar = goReceiverName(rawReceiver);
              receiverType = goReceiverType(rawReceiver);
            }
          }

          // Qualify method name with receiver type: Save → Foo::Save
          // This prevents same-named methods on different types from colliding.
          const fullName = receiverType
            ? `${receiverType}::${name}`
            : parentName
              ? `${parentName}::${name}`
              : name;

          const symType = symbolRule.symbolTypeFor?.(node, contextStack) ?? symbolRule.symbolType;
          symbols.push({
            name: fullName,
            symbolType: symType,
            type: symType,
            exported,
            startLine: startRow,
            endLine: endRow,
            ...(receiver ? { receiver } : {}),
          });

          // Extract calls within this symbol's body, skipping calls that are
          // inside nested symbols (those are extracted when processing the nested
          // symbol itself — avoids double-counting).
          const receiverInfo =
            receiverVar && receiverType
              ? { varName: receiverVar, typeName: receiverType }
              : undefined;
          // Java enum constants only scope a constant-specific class body —
          // a bodiless constant (`LOW, HIGH`) must not leak a frame into its
          // same-line siblings.
          const isContextNode =
            (symbolRule.establishesContext || config.contextNodeTypes.has(node.type)) &&
            !(
              config.language === "java" &&
              node.type === "enum_constant" &&
              !node.childForFieldName("body")
            );
          const contextName = isContextNode
            ? (symbolRule.extractContextName?.(node, contextStack) ?? fullName)
            : null;
          const callContext =
            contextName && symbolRule.contextKind
              ? [
                  ...contextStack,
                  { name: contextName, endByte: node.endIndex, kind: symbolRule.contextKind },
                ]
              : contextStack;
          extractCallsInNode(
            node,
            config,
            fullName,
            receiverInfo,
            calledIdentifiers,
            callExpressions,
            callContext,
          );

          if (isContextNode) {
            contextStack.push({
              name: contextName ?? fullName,
              endByte: node.endIndex,
              kind: symbolRule.contextKind,
              receiver: receiverInfo,
            });
          }
        }
      }
    } else if (isCallNode(node, config.callRule)) {
      // Top-level call not inside a symbol — still track it. Go calls
      // through the active method receiver qualify as Type::method, matching
      // the native walker's calledIdentifiers output.
      const calleeName = extractCallName(node, config.callRule);
      if (calleeName) {
        const normalized = config.normalizeCallName(calleeName);
        const trackedId = config.keepQualifiedCallee ? lastPathSegment(normalized) : normalized;
        if (
          normalized &&
          !config.callIgnores.has(calleeName) &&
          !config.callIgnores.has(normalized) &&
          !config.callIgnores.has(trackedId)
        ) {
          const receiver = contextStack[contextStack.length - 1]?.receiver;
          const tracked =
            receiver && calleeName.startsWith(`${receiver.varName}.`)
              ? `${receiver.typeName}::${normalized.split(".").pop()}`
              : normalized;
          calledIdentifiers.add(config.keepQualifiedCallee ? trackedId : tracked);
        }
      }
    }

    // Push children in reverse order for depth-first left-to-right
    const children = node.namedChildren;
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push(children[i]);
    }
  }

  return { symbols, importPaths, calledIdentifiers, callExpressions };
}

function extractCallsInNode(
  symbolNode: Node,
  config: LanguageConfig,
  callerName: string,
  receiverInfo: { varName: string; typeName: string } | undefined,
  calledIdentifiers: Set<string>,
  callExpressions: Array<{ callerName: string; calleeName: string }>,
  contextStack: ReadonlyArray<ContextFrame>,
): void {
  // Find nested symbol nodes so we can skip calls that belong to them.
  // Compare by position, not reference — web-tree-sitter returns new Node
  // wrapper objects on each descendantsOfType() call.
  const symbolRuleMap = new Map(config.symbolRules.map((rule) => [rule.nodeType, rule]));
  const nestedSymbols = symbolNode
    .descendantsOfType(config.symbolRules.map((rule) => rule.nodeType))
    .filter((node) => {
      if (node.startIndex === symbolNode.startIndex && node.endIndex === symbolNode.endIndex) {
        return false;
      }
      const rule = symbolRuleMap.get(node.type);
      if (!rule) return false;
      if (rule.contextOnly) return true;
      return Boolean(
        rule.extractName ? rule.extractName(node) : getNodeName(node, rule.nameField ?? "name"),
      );
    });

  const callNodes = [
    ...symbolNode.descendantsOfType(config.callRule.nodeType),
    ...(config.callRule.typeConversion
      ? symbolNode
          .descendantsOfType(config.callRule.typeConversion.nodeType)
          .filter(
            (node) =>
              node.childForFieldName(config.callRule.typeConversion!.typeField)?.type ===
              config.callRule.typeConversion!.requiredTypeKind,
          )
      : []),
  ];
  for (const callNode of callNodes) {
    // Skip calls inside nested symbols — they'll be extracted when processing
    // the nested symbol itself.
    const insideNested = nestedSymbols.some(
      (ns) => callNode.startIndex >= ns.startIndex && callNode.endIndex <= ns.endIndex,
    );
    if (insideNested) continue;

    const calleeName = extractCallName(callNode, config.callRule);
    if (!calleeName) continue;

    const normalized = config.normalizeCallName(calleeName);

    // Qualify calls through the receiver variable: f.Validate() → Foo::Validate
    // This matches the regex parser behavior and prevents call edges from
    // targeting the wrong same-named method on a different type.
    const qualifiedCallee =
      receiverInfo && calleeName.startsWith(`${receiverInfo.varName}.`)
        ? `${receiverInfo.typeName}::${normalized.split(".").pop()}`
        : normalized;

    const hookQualified = config.qualifyCall?.(callNode, calleeName, normalized, contextStack);
    const finalCallee = hookQualified ?? qualifiedCallee;
    const callIdentifier = config.keepQualifiedCallee ? lastPathSegment(finalCallee) : finalCallee;

    if (
      !normalized ||
      !finalCallee ||
      config.callIgnores.has(calleeName) ||
      config.callIgnores.has(normalized) ||
      (config.keepQualifiedCallee && config.callIgnores.has(callIdentifier)) ||
      finalCallee === callerName
    ) {
      continue;
    }
    calledIdentifiers.add(callIdentifier);
    callExpressions.push({ callerName, calleeName: finalCallee });
  }
}

// ── Public API ──

export async function parseWithTreeSitter(
  config: LanguageConfig,
  content: string,
  counter?: TokenCounter,
): Promise<IndexedCodeResult | null> {
  const tree = await parseContent(
    config.language,
    config.preprocess ? config.preprocess(content) : content,
  );
  if (!tree) return null;
  if (config.errorFailsParse && tree.rootNode.hasError) {
    tree.delete();
    return null;
  }

  try {
    const lines = content.split("\n");
    const { symbols, importPaths, calledIdentifiers, callExpressions } = walkTree(
      tree.rootNode,
      config,
      lines,
    );
    config.markCallShadowing?.(content, symbols, callExpressions);

    const chunks = createSymbolChunks(symbols, lines, config.language, counter);
    if (chunks.length === 0) {
      return {
        ...makeFallbackChunks(content, lines, counter),
        importPaths: [...new Set(importPaths)],
      };
    }

    return {
      chunks,
      importPaths: [...new Set(importPaths)],
      definedSymbols: symbols,
      calledIdentifiers: [...calledIdentifiers],
      callExpressions,
    };
  } finally {
    tree.delete();
  }
}
