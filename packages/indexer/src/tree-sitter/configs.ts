import type { Node } from "web-tree-sitter";

import {
  blankCSharpDirectives,
  markRustCallShadowing,
  normalizeRustCallName,
} from "../languages";
import type { ContextFrame, LanguageConfig, ImportRule } from "./parse";

// ── Python ──

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
  "type",
  "abs",
  "min",
  "max",
  "sum",
  "sorted",
  "enumerate",
  "zip",
  "map",
  "filter",
  "open",
  "input",
  "format",
  "getattr",
  "setattr",
  "hasattr",
  "delattr",
  "property",
  "staticmethod",
  "classmethod",
  "abstractmethod",
]);

function normalizePythonCallName(value: string): string {
  // Python keeps the qualified dotted callee (`pkg.func`, `self.m`) —
  // keepQualifiedCallee records the last segment as the called identifier.
  return value;
}

function extractPythonImports(node: Node): string[] {
  const paths: string[] = [];

  if (node.type === "import_statement") {
    // import foo, bar.baz as b
    for (const child of node.namedChildren) {
      if (child.type === "dotted_name") {
        paths.push(child.text);
      } else if (child.type === "aliased_import") {
        const nameNode = child.childForFieldName("name");
        if (nameNode) paths.push(nameNode.text);
      }
    }
  } else if (node.type === "import_from_statement") {
    // from .foo.bar import baz, qux
    const moduleNode = node.childForFieldName("module_name");
    const modulePath = moduleNode?.text ?? "";
    if (modulePath) paths.push(modulePath);

    // Track imported names for graph edges. Skip the module_name child
    // by comparing position (web-tree-sitter returns new wrapper objects).
    const moduleStart = moduleNode?.startIndex ?? -1;
    const moduleEnd = moduleNode?.endIndex ?? -1;
    // Relative imports: modulePath already ends in dots (`from . import x`
    // gives `.`) — joining with another dot would corrupt the level count.
    const join = (name: string) =>
      modulePath.endsWith(".") ? `${modulePath}${name}` : `${modulePath}.${name}`;
    for (const child of node.namedChildren) {
      if (child.type === "dotted_name") {
        if (child.startIndex === moduleStart && child.endIndex === moduleEnd) continue;
        if (modulePath) paths.push(join(child.text));
      } else if (child.type === "aliased_import") {
        const nameNode = child.childForFieldName("name");
        if (nameNode && modulePath) {
          paths.push(join(nameNode.text));
        }
      } else if (child.type === "wildcard_import") {
        // from foo import * — just track the module
      }
    }
  }

  return paths;
}

export const pythonConfig: LanguageConfig = {
  language: "python",
  symbolRules: [
    {
      nodeType: "function_definition",
      symbolType: "function",
      nameField: "name",
      establishesContext: true,
      isExported: (name) => !name.startsWith("_"),
    },
    {
      nodeType: "class_definition",
      symbolType: "class",
      nameField: "name",
      establishesContext: true,
      isExported: (name) => !name.startsWith("_"),
    },
  ],
  importRules: [
    { nodeType: "import_statement", extract: extractPythonImports },
    { nodeType: "import_from_statement", extract: extractPythonImports },
  ],
  callRule: { nodeType: "call", functionField: "function" },
  callIgnores: PYTHON_CALL_IGNORES,
  normalizeCallName: normalizePythonCallName,
  keepQualifiedCallee: true,
  contextNodeTypes: new Set(["function_definition", "class_definition"]),
  contextNameField: "name",
};

// ── Go ──

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
  "min",
  "max",
  "clear",
  "string",
  "int",
  "int8",
  "int16",
  "int32",
  "int64",
  "uint",
  "float32",
  "float64",
  "bool",
  "byte",
  "rune",
  "error",
]);

function normalizeGoCallName(value: string): string {
  // Strip generic instantiation (`pkg.F[T]` → `pkg.F`); keep the selector so
  // graph resolution can map the qualifier to an import binding.
  return value.split("[")[0] ?? value;
}

function extractGoImports(node: Node): string[] {
  const paths: string[] = [];
  if (node.type === "import_declaration") {
    // import_declaration > import_spec_list > import_spec (path field)
    // Or single: import_declaration > import_spec
    const specs = node.descendantsOfType("import_spec");
    for (const spec of specs) {
      const pathNode = spec.childForFieldName("path");
      if (pathNode) {
        const text = pathNode.text.replace(/^"|"$/g, "");
        if (text) paths.push(text);
      }
    }
    // Handle single import without import_spec (e.g. import "fmt")
    if (specs.length === 0) {
      const literals = node.descendantsOfType("interpreted_string_literal");
      for (const lit of literals) {
        const text = lit.text.replace(/^"|"$/g, "");
        if (text) paths.push(text);
      }
    }
  }
  return paths;
}

/** All identifiers declared by a const/var spec. `identifier_list` is a
 *  hidden grammar rule, so `name` maps to flat identifier children. */
function goSpecNames(node: Node): string[] {
  return node
    .childrenForFieldName("name")
    .filter((child) => child.type === "identifier")
    .map((child) => child.text)
    .filter((text) => text !== "_");
}

export const goConfig: LanguageConfig = {
  language: "go",
  symbolRules: [
    {
      nodeType: "function_declaration",
      symbolType: "function",
      nameField: "name",
      establishesContext: true,
      isExported: (name) => name[0] >= "A" && name[0] <= "Z",
    },
    {
      nodeType: "method_declaration",
      symbolType: "function",
      nameField: "name",
      receiverField: "receiver",
      normalizeReceiver: (text) => text.replace(/^\(+|\)+$/g, "").trim(),
      establishesContext: true,
      isExported: (name) => name[0] >= "A" && name[0] <= "Z",
    },
    {
      nodeType: "type_spec",
      symbolType: "type",
      nameField: "name",
      isExported: (name) => name[0] >= "A" && name[0] <= "Z",
    },
    {
      nodeType: "const_spec",
      symbolType: "const",
      extractNames: goSpecNames,
      topLevelOnly: true,
      isExported: (name) => name[0] >= "A" && name[0] <= "Z",
    },
    {
      nodeType: "var_spec",
      symbolType: "var",
      extractNames: goSpecNames,
      topLevelOnly: true,
      isExported: (name) => name[0] >= "A" && name[0] <= "Z",
    },
  ],
  importRules: [{ nodeType: "import_declaration", extract: extractGoImports }],
  callRule: {
    nodeType: "call_expression",
    functionField: "function",
    // Bare generic instantiation (`Map[int](x)`) parses as
    // type_conversion_expression, not call_expression.
    typeConversion: {
      nodeType: "type_conversion_expression",
      typeField: "type",
      requiredTypeKind: "generic_type",
    },
  },
  callIgnores: GO_CALL_IGNORES,
  normalizeCallName: normalizeGoCallName,
  contextNodeTypes: new Set(["function_declaration", "method_declaration"]),
  contextNameField: "name",
};

// ── Rust ──

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

function extractRustImports(node: Node): string[] {
  const paths: string[] = [];
  if (node.type === "use_declaration") {
    // The argument field contains the use tree
    const argNode = node.childForFieldName("argument");
    const target = argNode ?? node;
    // Extract the full path text, strip trailing semicolons
    const text = target.text.replace(/;$/, "").trim();
    if (text) paths.push(text);
  }
  return paths;
}

export const rustConfig: LanguageConfig = {
  language: "rust",
  symbolRules: [
    {
      nodeType: "function_item",
      symbolType: "function",
      nameField: "name",
      establishesContext: true,
      isExported: (_name, node) => {
        // Check if any ancestor is an impl/trait block, or if pub keyword present
        // tree-sitter doesn't expose modifiers directly; check text for pub prefix
        const text = node.text.slice(0, 20);
        return text.includes("pub ");
      },
    },
    {
      nodeType: "struct_item",
      symbolType: "struct",
      nameField: "name",
      isExported: (_name, node) => node.text.slice(0, 20).includes("pub "),
    },
    {
      nodeType: "enum_item",
      symbolType: "enum",
      nameField: "name",
      isExported: (_name, node) => node.text.slice(0, 20).includes("pub "),
    },
    {
      nodeType: "trait_item",
      symbolType: "trait",
      nameField: "name",
      establishesContext: true,
      isExported: (_name, node) => node.text.slice(0, 20).includes("pub "),
    },
    {
      nodeType: "impl_item",
      symbolType: "impl",
      nameField: "type",
      extractName: (node) => {
        const traitNode = node.childForFieldName("trait");
        const typeNode = node.childForFieldName("type");
        const typeName = typeNode?.text ?? "";
        if (traitNode) {
          return `impl ${traitNode.text} for ${typeName}`;
        }
        return typeName ? `impl ${typeName}` : null;
      },
      extractContextName: (node, _contextStack) => {
        // Use the type name for nesting (Circle::draw, not impl Circle::draw)
        return node.childForFieldName("type")?.text ?? null;
      },
      establishesContext: true,
      isExported: () => false,
    },
    {
      nodeType: "type_item",
      symbolType: "type",
      nameField: "name",
      isExported: (_name, node) => node.text.slice(0, 20).includes("pub "),
    },
    {
      nodeType: "const_item",
      symbolType: "const",
      nameField: "name",
      isExported: (_name, node) => node.text.slice(0, 20).includes("pub "),
    },
    {
      nodeType: "static_item",
      symbolType: "const",
      nameField: "name",
      isExported: (_name, node) => node.text.slice(0, 20).includes("pub "),
    },
    {
      nodeType: "mod_item",
      symbolType: "module",
      nameField: "name",
      isExported: (_name, node) => node.text.slice(0, 20).includes("pub "),
    },
  ],
  importRules: [{ nodeType: "use_declaration", extract: extractRustImports }],
  callRule: { nodeType: "call_expression", functionField: "function" },
  callIgnores: RUST_CALL_IGNORES,
  normalizeCallName: normalizeRustCallName,
  keepQualifiedCallee: true,
  markCallShadowing: markRustCallShadowing,
  contextNodeTypes: new Set(["function_item", "trait_item", "impl_item"]),
  contextNameField: "name",
};

// ── Ruby ──

const RUBY_CALL_IGNORES = new Set([
  "if",
  "unless",
  "while",
  "until",
  "for",
  "return",
  "yield",
  "break",
  "next",
  "redo",
  "retry",
  "puts",
  "pp",
  "p",
  "print",
  "raise",
  "require",
  "require_relative",
  "load",
  "autoload",
  "attr_accessor",
  "attr_reader",
  "attr_writer",
  "include",
  "extend",
  "define_method",
  "lambda",
  "proc",
  "send",
  "public_send",
  "method_missing",
  "eval",
  "const_get",
  "respond_to",
  "respond_to?",
  "super",
  "self",
  "nil",
  "true",
  "false",
  "new",
  "Array",
  "Hash",
  "String",
  "Integer",
  "Float",
  "Symbol",
]);

function normalizeRubyCallName(value: string): string {
  const parts = value.split(/[.::]/).filter(Boolean);
  return parts[parts.length - 1] ?? value;
}

function extractRubyImports(node: Node): string[] {
  const paths: string[] = [];
  // Only require_relative calls produce import edges.
  // require (gem), load, autoload do not resolve to local files.
  if (node.type === "call") {
    const methodNode = node.childForFieldName("method");
    if (methodNode && methodNode.text === "require_relative") {
      const argsNode = node.childForFieldName("arguments");
      if (argsNode) {
        const stringNode = argsNode.namedChildren.find(
          (c) => c.type === "string" || c.type === "argument_list",
        );
        const target =
          stringNode?.type === "string"
            ? stringNode
            : stringNode?.namedChildren.find((c) => c.type === "string");
        if (target) {
          const text = target.text.replace(/^['"]|['"]$/g, "");
          if (text) paths.push(text);
        }
      }
    }
  }
  return paths;
}

function rubyQualifyCall(
  callNode: Node,
  _calleeName: string,
  normalized: string,
  contextStack: ReadonlyArray<ContextFrame>,
): string | null {
  const receiverNode = callNode.childForFieldName("receiver");
  if (!receiverNode) return null;
  const receiverText = receiverNode.text;
  if (receiverText === "self") {
    for (let i = contextStack.length - 1; i >= 0; i--) {
      const frame = contextStack[i];
      if (frame.kind === "class" || frame.kind === "module") {
        return `${frame.name}::${normalized}`;
      }
    }
    return null;
  }
  // Constant receivers keep the scope-qualified target name:
  // Invoice.build → Invoice::build, Billing::Invoice.build → Billing::Invoice::build.
  if (receiverNode.type === "constant" || receiverNode.type === "scope_resolution") {
    return `${receiverText}::${normalized}`;
  }
  // Ordinary receivers (locals, ivars, expressions, &.) never resolve to a
  // method statically — return "" to suppress the call entirely.
  return "";
}

export const rubyConfig: LanguageConfig = {
  language: "ruby",
  symbolRules: [
    {
      nodeType: "class",
      symbolType: "class",
      nameField: "name",
      establishesContext: true,
      contextKind: "class",
      isExported: (name) => name[0] >= "A" && name[0] <= "Z",
    },
    {
      nodeType: "module",
      symbolType: "module",
      nameField: "name",
      establishesContext: true,
      contextKind: "module",
      isExported: (name) => name[0] >= "A" && name[0] <= "Z",
    },
    {
      nodeType: "method",
      symbolType: "function",
      nameField: "name",
      establishesContext: true,
      isExported: () => false,
    },
    {
      nodeType: "singleton_method",
      symbolType: "function",
      nameField: "name",
      establishesContext: true,
      isExported: () => false,
    },
    {
      nodeType: "singleton_class",
      symbolType: "class",
      contextOnly: true,
      extractContextName: (_node, contextStack) => {
        for (let i = contextStack.length - 1; i >= 0; i--) {
          const frame = contextStack[i];
          if (frame.kind === "class" || frame.kind === "module") {
            return frame.name;
          }
        }
        return null;
      },
      isExported: () => false,
    },
    {
      nodeType: "assignment",
      symbolType: "lambda",
      extractName: (node) => {
        const rightNode = node.childForFieldName("right");
        if (!rightNode) return null;
        // lambda { } or lambda do |x| end
        if (rightNode.type === "lambda") {
          const leftNode = node.childForFieldName("left");
          return leftNode?.text ?? null;
        }
        // proc { } or Proc.new { } or lambda { } via call
        if (rightNode.type === "call") {
          const methodNode = rightNode.childForFieldName("method");
          const methodName = methodNode?.text;
          if (methodName === "proc" || methodName === "lambda") {
            const leftNode = node.childForFieldName("left");
            return leftNode?.text ?? null;
          }
          // Proc.new — check receiver is "Proc" and method is "new"
          const receiverNode = rightNode.childForFieldName("receiver");
          if (receiverNode?.text === "Proc" && methodName === "new") {
            const leftNode = node.childForFieldName("left");
            return leftNode?.text ?? null;
          }
        }
        return null;
      },
      isExported: () => false,
    },
  ],
  importRules: [{ nodeType: "call", extract: extractRubyImports }],
  callRule: { nodeType: "call", functionField: "method" },
  callIgnores: RUBY_CALL_IGNORES,
  normalizeCallName: normalizeRubyCallName,
  contextNodeTypes: new Set(["class", "module", "method", "singleton_method"]),
  contextNameField: "name",
  qualifyCall: rubyQualifyCall,
};

// ── C++ ──

const CPP_CALL_IGNORES = new Set([
  "if",
  "for",
  "while",
  "switch",
  "return",
  "sizeof",
  "alignof",
  "decltype",
  "typeid",
  "noexcept",
  "static_cast",
  "dynamic_cast",
  "reinterpret_cast",
  "const_cast",
  "new",
  "delete",
  "throw",
  "static_assert",
  "catch",
  "int",
  "char",
  "short",
  "long",
  "float",
  "double",
  "bool",
  "void",
  "unsigned",
  "signed",
  "const",
  "volatile",
  "auto",
  "size_t",
  "nullptr",
  "true",
  "false",
  "this",
]);

/** Strip `<...>` template argument lists, depth-aware. A `<` that begins
 *  an operator-name token (`operator<`, `operator<<`, `operator<=`,
 *  `operator<=>`, `operator<<=`, …) is kept together with the rest of the
 *  operator symbol run — only `<` that cannot be part of an operator name
 *  opens a template-argument group. */
function stripCppTemplateArgs(text: string): string {
  const OP_SYMS = "+-*/%^&|~!=<>,";
  let depth = 0;
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (depth > 0) {
      if (ch === "<") depth++;
      else if (ch === ">") depth--;
      continue;
    }
    if (ch === "<") {
      const before = out[out.length - "operator".length - 1];
      const operatorTail =
        out.endsWith("operator") && (before === undefined || !/[\w]/.test(before));
      if (operatorTail) {
        out += ch;
        while (i + 1 < text.length && OP_SYMS.includes(text[i + 1])) {
          out += text[++i];
        }
        continue;
      }
      depth++;
      continue;
    }
    out += ch;
  }
  return out;
}

/** Descend a declaration/function_definition `declarator` chain to its
 *  function_declarator. Pointer and reference layers unwrap; anything else
 *  (init_declarator, parenthesized function pointers, plain variables)
 *  yields null so non-function declarations emit no symbol. */
function cppFunctionDeclarator(node: Node): Node | null {
  let cur: Node | null | undefined = node.childForFieldName("declarator");
  while (cur) {
    if (cur.type === "function_declarator") return cur;
    if (cur.type === "pointer_declarator" || cur.type === "reference_declarator") {
      cur = cur.childForFieldName("declarator");
      continue;
    }
    return null;
  }
  return null;
}

/** Name text of a function_declarator's declarator field — identifier,
 *  field_identifier, qualified_identifier, destructor_name, operator_name,
 *  or template_function (its `name` field) — with whitespace and template
 *  arguments stripped (`a::b::f`, `~A`, `operator==`, `id<int>` → `id`). */
function cppFunctionName(node: Node): string | null {
  const declarator = cppFunctionDeclarator(node);
  const nameNode = declarator?.childForFieldName("declarator");
  if (!declarator || !nameNode) return null;
  const raw =
    nameNode.type === "template_function"
      ? (nameNode.childForFieldName("name")?.text ?? nameNode.text)
      : nameNode.text;
  const stripped = stripCppTemplateArgs(raw.replace(/\s+/g, ""));
  return stripped || null;
}

/** class/struct/union/enum specifier name — only when the specifier has a
 *  `body`, so elaborated type uses (`class Foo *p`) and forward
 *  declarations emit no symbol. */
function cppTypeName(node: Node): string | null {
  if (!node.childForFieldName("body")) return null;
  return node.childForFieldName("name")?.text ?? null;
}

/** namespace_definition name — anonymous namespaces emit no symbol and no
 *  context (their members keep the enclosing scope). `namespace a::b`
 *  qualified names keep all segments. */
function cppNamespaceName(node: Node): string | null {
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return null;
  return nameNode.text.replace(/\s+/g, "") || null;
}

/** function_definition → "method" when the declarator is qualified
 *  (`A::m`) or it sits directly inside a class/struct/union context;
 *  otherwise "function". */
function cppFunctionType(
  node: Node,
  contextStack: ReadonlyArray<ContextFrame>,
): string {
  const declarator = cppFunctionDeclarator(node);
  const nameNode = declarator?.childForFieldName("declarator");
  if (nameNode?.type === "qualified_identifier") return "method";
  const top = contextStack[contextStack.length - 1];
  return top?.kind === "class" ? "method" : "function";
}

/** Quoted `#include "..."` paths only — angle/system includes
 *  (system_lib_string) and macro-computed paths produce no import path. */
function extractCppImports(node: Node): string[] {
  const paths: string[] = [];
  if (node.type !== "preproc_include") return paths;
  const pathNode = node.childForFieldName("path");
  if (pathNode?.type === "string_literal") {
    paths.push(pathNode.text.replace(/^"|"$/g, ""));
  }
  return paths;
}

/**
 * Normalize a call-expression function child to its callee name: strip
 * whitespace and template args, convert `->` to `.`, then keep only simple
 * identifier paths (`f`, `a::b::f`, `::f`, `obj.f`, `this.f`, `~A`,
 * `A::operator==`). Anything else (`(*fp)`, `arr[i].f`, casts already
 * covered by callIgnores) returns "" and is dropped.
 */
function normalizeCppCallName(value: string): string {
  const stripped = stripCppTemplateArgs(value.replace(/\s+/g, ""));
  const text = stripped.replace(/->/g, ".");
  if (!text) return "";
  const scopeParts = text.split("::");
  const leadingGlobal = scopeParts[0] === "";
  const parts = leadingGlobal ? scopeParts.slice(1) : scopeParts;
  if (parts.length === 0) return "";
  for (const part of parts) {
    for (const seg of part.split(".")) {
      if (seg === "") return "";
      if (seg.startsWith("operator") && seg.length > 8) continue;
      if (!/^[\w~]+$/.test(seg)) return "";
    }
  }
  return text;
}

export const cppConfig: LanguageConfig = {
  language: "cpp",
  symbolRules: [
    {
      nodeType: "namespace_definition",
      symbolType: "namespace",
      nameField: "name",
      extractName: cppNamespaceName,
      establishesContext: true,
      contextKind: "module",
      isExported: () => true,
    },
    {
      nodeType: "class_specifier",
      symbolType: "class",
      nameField: "name",
      extractName: cppTypeName,
      establishesContext: true,
      contextKind: "class",
      isExported: () => true,
    },
    {
      nodeType: "struct_specifier",
      symbolType: "struct",
      nameField: "name",
      extractName: cppTypeName,
      establishesContext: true,
      contextKind: "class",
      isExported: () => true,
    },
    {
      nodeType: "union_specifier",
      symbolType: "union",
      nameField: "name",
      extractName: cppTypeName,
      establishesContext: true,
      contextKind: "class",
      isExported: () => true,
    },
    {
      nodeType: "enum_specifier",
      symbolType: "enum",
      nameField: "name",
      extractName: cppTypeName,
      establishesContext: true,
      isExported: () => true,
    },
    {
      nodeType: "alias_declaration",
      symbolType: "type",
      nameField: "name",
      isExported: () => true,
    },
    {
      nodeType: "type_definition",
      symbolType: "type",
      nameField: "declarator",
      isExported: () => true,
    },
    {
      nodeType: "function_definition",
      symbolType: "function",
      nameField: "name",
      extractName: cppFunctionName,
      symbolTypeFor: cppFunctionType,
      establishesContext: true,
      isExported: () => true,
    },
    {
      nodeType: "declaration",
      symbolType: "declaration",
      nameField: "name",
      extractName: cppFunctionName,
      isExported: () => true,
    },
    {
      nodeType: "field_declaration",
      symbolType: "declaration",
      nameField: "name",
      extractName: cppFunctionName,
      isExported: () => true,
    },
  ],
  importRules: [{ nodeType: "preproc_include", extract: extractCppImports }],
  callRule: { nodeType: "call_expression", functionField: "function" },
  callIgnores: CPP_CALL_IGNORES,
  normalizeCallName: normalizeCppCallName,
  keepQualifiedCallee: true,
  contextNodeTypes: new Set([
    "namespace_definition",
    "class_specifier",
    "struct_specifier",
    "union_specifier",
    "enum_specifier",
    "function_definition",
  ]),
  contextNameField: "name",
};

/**
 * `.h` files are shared between C and C++ and get parsed without a
 * compilation context; any syntax error rejects the whole parse so the
 * document falls back to generic text chunks with no graph records — the
 * same contract the native `cpp-header` config enforces.
 */
export const cppHeaderConfig: LanguageConfig = { ...cppConfig, errorFailsParse: true };
// ── C# ──

const CSHARP_CALL_IGNORES = new Set([
  "if",
  "for",
  "foreach",
  "while",
  "switch",
  "catch",
  "using",
  "lock",
  "fixed",
  "return",
  "throw",
  "goto",
  "checked",
  "unchecked",
  "sizeof",
  "typeof",
  "nameof",
  "default",
  "new",
  "delegate",
  "stackalloc",
]);

function csharpExported(_name: string, node: Node): boolean {
  // Accessibility is carried by `modifier` child nodes, so an attribute
  // argument containing the word "public" cannot fake the modifier.
  // Mirrors csharp_exported in parser.rs.
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === "modifier" && child.text === "public") return true;
  }
  return false;
}

/** Fully qualified namespace name — walking ancestor namespace declarations
 *  through node.parent gives the true nesting (`A.B` for `namespace B`
 *  inside `namespace A`, `B` for a same-line sibling), which line ranges
 *  alone cannot recover. Mirrors csharp_ns_name in parser.rs. */
function csharpNamespaceName(node: Node): string | null {
  const name = node.childForFieldName("name")?.text;
  if (!name) return null;
  const parts = [name];
  let p = node.parent;
  while (p) {
    if (
      p.type === "namespace_declaration" ||
      p.type === "file_scoped_namespace_declaration"
    ) {
      const pn = p.childForFieldName("name")?.text;
      if (pn) parts.unshift(pn);
    }
    p = p.parent;
  }
  return parts.join(".");
}

/**
 * Field names come from `variable_declarator` nodes (multi-declarator fields
 * like `int a, b;` emit one symbol each), but only when the declarator sits
 * inside `field_declaration` — local `var`/`using` declarators inside methods
 * share the same node type and are never member symbols.
 */
function csharpFieldDeclaratorName(node: Node): string | null {
  const parent = node.parent;
  if (!parent || parent.type !== "variable_declaration") return null;
  if (parent.parent?.type !== "field_declaration") return null;
  return node.childForFieldName("name")?.text ?? null;
}

/**
 * `using` directives are carried verbatim — the resolver parses
 * global/alias/static modifiers out of the full text. Directives nested
 * inside a `declaration_list` (a block-scoped `namespace` body) are dropped:
 * importPaths carry no positions, so the resolver cannot tell them apart
 * from compilation-unit usings — carrying them would bind names in files
 * where the using does not apply.
 */
function extractCSharpImports(node: Node): string[] {
  if (node.parent?.type === "declaration_list") return [];
  return [node.text];
}

/**
 * Keep the qualified dotted callee (`Ns.Type.M`, `this.M`, `Alias.M`) so the
 * resolver can follow the C# lookup order — keepQualifiedCallee records the
 * last segment as the called identifier. Generic type arguments are stripped
 * (`M<T>` → `M`, `X.M<Dict<K,V>>` → `X.M`). Returns "" when the callee is not
 * a plain identifier path: `x?.M`, `(expr).M`, `Foo().M` never resolve.
 */
function normalizeCSharpCallName(value: string): string {
  const stripped = value.replace(/\s+/g, "");
  let out = "";
  let depth = 0;
  for (const ch of stripped) {
    if (ch === "<") depth += 1;
    else if (ch === ">") depth = Math.max(0, depth - 1);
    else if (depth === 0) out += ch;
  }
  const globalPrefix = out.startsWith("global::") ? "global::" : "";
  const dotted = out.slice(globalPrefix.length);
  const valid =
    dotted.length > 0 && dotted.split(".").every((seg) => /^[A-Za-z_]\w*$/.test(seg));
  return valid ? `${globalPrefix}${dotted}` : "";
}

export const csharpConfig: LanguageConfig = {
  language: "csharp",
  symbolRules: [
    {
      nodeType: "file_scoped_namespace_declaration",
      symbolType: "namespace",
      extractName: csharpNamespaceName,
      isExported: csharpExported,
    },
    {
      nodeType: "namespace_declaration",
      symbolType: "namespace",
      extractName: csharpNamespaceName,
      isExported: csharpExported,
    },
    {
      nodeType: "class_declaration",
      symbolType: "class",
      nameField: "name",
      establishesContext: true,
      isExported: csharpExported,
    },
    {
      nodeType: "struct_declaration",
      symbolType: "struct",
      nameField: "name",
      establishesContext: true,
      isExported: csharpExported,
    },
    {
      nodeType: "interface_declaration",
      symbolType: "interface",
      nameField: "name",
      establishesContext: true,
      isExported: csharpExported,
    },
    {
      nodeType: "record_declaration",
      symbolType: "record",
      nameField: "name",
      establishesContext: true,
      isExported: csharpExported,
    },
    {
      nodeType: "enum_declaration",
      symbolType: "enum",
      nameField: "name",
      establishesContext: true,
      isExported: csharpExported,
    },
    {
      nodeType: "delegate_declaration",
      symbolType: "delegate",
      nameField: "name",
      isExported: csharpExported,
    },
    {
      nodeType: "method_declaration",
      symbolType: "method",
      nameField: "name",
      establishesContext: true,
      isExported: csharpExported,
    },
    {
      nodeType: "constructor_declaration",
      symbolType: "constructor",
      nameField: "name",
      establishesContext: true,
      isExported: csharpExported,
    },
    {
      nodeType: "destructor_declaration",
      symbolType: "destructor",
      nameField: "name",
      establishesContext: true,
      isExported: csharpExported,
    },
    {
      nodeType: "property_declaration",
      symbolType: "property",
      nameField: "name",
      isExported: csharpExported,
    },
    {
      nodeType: "variable_declarator",
      symbolType: "field",
      extractName: csharpFieldDeclaratorName,
      isExported: csharpExported,
    },
    {
      nodeType: "enum_member_declaration",
      symbolType: "field",
      nameField: "name",
      isExported: csharpExported,
    },
  ],
  importRules: [{ nodeType: "using_directive", extract: extractCSharpImports }],
  callRule: { nodeType: "invocation_expression", functionField: "function" },
  callIgnores: CSHARP_CALL_IGNORES,
  normalizeCallName: normalizeCSharpCallName,
  keepQualifiedCallee: true,
  contextNodeTypes: new Set([
    "class_declaration",
    "struct_declaration",
    "interface_declaration",
    "record_declaration",
    "enum_declaration",
    "method_declaration",
    "constructor_declaration",
    "destructor_declaration",
  ]),
  contextNameField: "name",
  preprocess: blankCSharpDirectives,
  eofSpanNodeTypes: new Set(["file_scoped_namespace_declaration"]),
};
