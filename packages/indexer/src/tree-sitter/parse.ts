import type { Node } from "web-tree-sitter";

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
  nameField: string;
  /** override name extraction for complex nodes (e.g. Rust impl_item) */
  extractName?: (node: Node) => string | null;
  /** override context name for nesting (defaults to symbol name) */
  extractContextName?: (node: Node) => string | null;
  /** whether this node establishes a parent context for nested symbols */
  establishesContext?: boolean;
  /** determine if symbol is exported; defaults to language-specific */
  isExported?: (name: string, node: Node) => boolean;
  /** receiver field for methods (Go) */
  receiverField?: string;
  /** transform receiver text (e.g. strip parens) */
  normalizeReceiver?: (text: string) => string;
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

function isCallNode(node: Node, callRule: CallRule): boolean {
  return node.type === callRule.nodeType;
}

function extractCallName(node: Node, callRule: CallRule): string | null {
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
  const contextStack: Array<{
    name: string;
    endRow: number;
    receiver?: { varName: string; typeName: string };
  }> = [];

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
    const endRow = node.endPosition.row + 1;

    // Pop expired contexts
    while (contextStack.length > 0 && startRow > contextStack[contextStack.length - 1].endRow) {
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
          if (decName && !config.callIgnores.has(decName) && decName !== innerName) {
            calledIdentifiers.add(decName);
            callExpressions.push({ callerName: innerName, calleeName: decName });
          }
        }
      }
    }

    // Check for symbol
    const symbolRule = symbolRuleMap.get(node.type);
    if (symbolRule) {
      const name = symbolRule.extractName
        ? symbolRule.extractName(node)
        : getNodeName(node, symbolRule.nameField);
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

        symbols.push({
          name: fullName,
          symbolType: symbolRule.symbolType,
          type: symbolRule.symbolType,
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
        extractCallsInNode(
          node,
          config,
          fullName,
          receiverInfo,
          calledIdentifiers,
          callExpressions,
        );

        const isContextNode =
          symbolRule.establishesContext || config.contextNodeTypes.has(node.type);
        if (isContextNode) {
          // Use extractContextName if provided (e.g. Rust impl uses type name
          // for nesting, not the full "impl Trait for Type" symbol name)
          const contextName = symbolRule.extractContextName
            ? (symbolRule.extractContextName(node) ?? fullName)
            : fullName;
          contextStack.push({ name: contextName, endRow, receiver: receiverInfo });
        }
      }
    } else if (isCallNode(node, config.callRule)) {
      // Top-level call not inside a symbol — still track it
      const calleeName = extractCallName(node, config.callRule);
      if (calleeName) {
        const normalized = config.normalizeCallName(calleeName);
        if (
          normalized &&
          !config.callIgnores.has(calleeName) &&
          !config.callIgnores.has(normalized)
        ) {
          calledIdentifiers.add(normalized);
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
): void {
  // Find nested symbol nodes so we can skip calls that belong to them.
  // Compare by position, not reference — web-tree-sitter returns new Node
  // wrapper objects on each descendantsOfType() call.
  const nestedSymbolTypes = config.symbolRules.map((r) => r.nodeType);
  const nestedSymbols = symbolNode
    .descendantsOfType(nestedSymbolTypes)
    .filter((n) => !(n.startIndex === symbolNode.startIndex && n.endIndex === symbolNode.endIndex));

  const callNodes = symbolNode.descendantsOfType(config.callRule.nodeType);
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
        ? `${receiverInfo.typeName}::${normalized}`
        : normalized;

    if (
      !normalized ||
      config.callIgnores.has(calleeName) ||
      config.callIgnores.has(normalized) ||
      qualifiedCallee === callerName
    ) {
      continue;
    }
    calledIdentifiers.add(qualifiedCallee);
    callExpressions.push({ callerName, calleeName: qualifiedCallee });
  }
}

// ── Public API ──

export async function parseWithTreeSitter(
  config: LanguageConfig,
  content: string,
): Promise<IndexedCodeResult | null> {
  const tree = await parseContent(config.language, content);
  if (!tree) return null;

  try {
    const lines = content.split("\n");
    const { symbols, importPaths, calledIdentifiers, callExpressions } = walkTree(
      tree.rootNode,
      config,
      lines,
    );

    const chunks = createSymbolChunks(symbols, lines, config.language);
    if (chunks.length === 0) {
      return {
        ...makeFallbackChunks(content, lines),
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
