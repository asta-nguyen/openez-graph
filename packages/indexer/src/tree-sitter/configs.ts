import type { Node } from "web-tree-sitter";

import { markRustCallShadowing, normalizeRustCallName } from "../languages";
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

// ── Java ──

const JAVA_CALL_IGNORES = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "throw",
  "new",
  "super",
  "this",
  "assert",
  "synchronized",
  "try",
  "do",
  "else",
  "case",
  "instanceof",
  "null",
  "true",
  "false",
  "void",
  "break",
  "continue",
  "default",
  "finally",
  "package",
  "import",
]);

const JAVA_QUALIFIED_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;

/** Body node types that delimit a type-like scope. The innermost enclosing
 *  body determines whether a call sits inside an anonymous class. */
const JAVA_BODY_TYPES = new Set([
  "class_body",
  "interface_body",
  "enum_body",
  "enum_body_declarations",
  "annotation_type_body",
]);

function normalizeJavaCallName(value: string): string {
  // `x.super.m()`, casts, chained `new`/`()` receivers and other non-qualified
  // receiver text collapse to the empty callee and are dropped.
  const v = value.replace(/\s+/g, "");
  return JAVA_QUALIFIED_NAME_RE.test(v) ? v : "";
}

function extractJavaImports(node: Node): string[] {
  // `import static app.Util.format;` → "static app.Util.format";
  // `import app.Util;` → "app.Util"; `import app.*;` → "app.*"
  const spec = node.text
    .replace(/^import\s+/, "")
    .replace(/;+\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return spec ? [spec] : [];
}

/** `obj.m()` → `obj.m`; `this.m()` → `this.m`; `super.m()` → `super.m`;
 *  `x.super.m()` → `x.super.m`; `m()` → `m`; `Outer.Inner.m()` → `Outer.Inner.m`. */
function extractJavaCall(callNode: Node): string | null {
  const nameNode = callNode.childForFieldName("name");
  if (!nameNode) return null;
  const obj = callNode.childForFieldName("object");
  let receiver = obj?.text;
  for (const child of callNode.children) {
    if (child.type === "super" && child.id !== obj?.id) {
      receiver = receiver ? `${receiver}.super` : "super";
    }
  }
  return receiver ? `${receiver}.${nameNode.text}` : nameNode.text;
}

/** `int x, y;` → ["x", "y"]; each declarator name is a field symbol. */
function javaFieldNames(node: Node): string[] {
  const names: string[] = [];
  for (const child of node.namedChildren) {
    if (child.type !== "variable_declarator") continue;
    const nameNode = child.childForFieldName("name");
    if (nameNode) names.push(nameNode.text);
  }
  return names;
}

function javaExported(node: Node): boolean {
  // Only the actual `public` modifier token counts — annotation contents such
  // as `@Doc("public API")` must not mark a declaration exported.
  return node.namedChildren.some(
    (c) => c.type === "modifiers" && c.children.some((m) => m.type === "public"),
  );
}

/**
 * Anonymous-class suppression: a bare or `this.` callee inside a class body
 * owned by `object_creation_expression` or `enum_constant` (constant-specific
 * class bodies are anonymous subclasses) may be supplied by the supertype, so
 * no edge is emitted. Type-qualified calls are unaffected.
 */
function javaQualifyCall(
  callNode: Node,
  _calleeName: string,
  normalized: string,
  _contextStack: ReadonlyArray<ContextFrame>,
): string | null {
  if (!normalized) return null;
  if (!normalized.startsWith("this.") && normalized.includes(".")) return null;
  let parent = callNode.parent;
  while (parent) {
    if (JAVA_BODY_TYPES.has(parent.type)) {
      const owner = parent.parent;
      if (
        parent.type === "class_body" &&
        owner &&
        (owner.type === "object_creation_expression" || owner.type === "enum_constant")
      ) {
        return "";
      }
      break;
    }
    parent = parent.parent;
  }
  return null;
}

export const javaConfig: LanguageConfig = {
  language: "java",
  symbolRules: [
    {
      nodeType: "package_declaration",
      symbolType: "package",
      extractName: (node) =>
        node.namedChildren.find((c) => c.type === "scoped_identifier" || c.type === "identifier")
          ?.text ?? null,
      isExported: () => true,
    },
    {
      nodeType: "class_declaration",
      symbolType: "class",
      nameField: "name",
      establishesContext: true,
      isExported: (_name, node) => javaExported(node),
    },
    {
      nodeType: "interface_declaration",
      symbolType: "interface",
      nameField: "name",
      establishesContext: true,
      isExported: (_name, node) => javaExported(node),
    },
    {
      nodeType: "enum_declaration",
      symbolType: "enum",
      nameField: "name",
      establishesContext: true,
      isExported: (_name, node) => javaExported(node),
    },
    {
      nodeType: "record_declaration",
      symbolType: "record",
      nameField: "name",
      establishesContext: true,
      isExported: (_name, node) => javaExported(node),
    },
    {
      nodeType: "enum_constant",
      symbolType: "const",
      nameField: "name",
      establishesContext: true,
      isExported: () => true,
    },
    {
      nodeType: "method_declaration",
      symbolType: "function",
      nameField: "name",
      establishesContext: true,
      isExported: (_name, node) => javaExported(node),
    },
    {
      nodeType: "constructor_declaration",
      symbolType: "constructor",
      nameField: "name",
      establishesContext: true,
      isExported: (_name, node) => javaExported(node),
    },
    {
      nodeType: "compact_constructor_declaration",
      symbolType: "constructor",
      nameField: "name",
      establishesContext: true,
      isExported: (_name, node) => javaExported(node),
    },
    {
      nodeType: "field_declaration",
      symbolType: "field",
      extractNames: javaFieldNames,
      isExported: (_name, node) => javaExported(node),
    },
    {
      nodeType: "constant_declaration",
      symbolType: "field",
      extractNames: javaFieldNames,
      isExported: (_name, node) => javaExported(node),
    },
    {
      nodeType: "object_creation_expression",
      symbolType: "anonymous",
      contextOnly: true,
      extractContextName: (node, contextStack) =>
        node.namedChildren.some((c) => c.type === "class_body")
          ? `${contextStack[contextStack.length - 1]?.name ?? ""}::<anonymous>`.replace(/^::/, "")
          : null,
    },
  ],
  importRules: [{ nodeType: "import_declaration", extract: extractJavaImports }],
  callRule: {
    nodeType: "method_invocation",
    functionField: "name",
    extractCall: extractJavaCall,
  },
  callIgnores: JAVA_CALL_IGNORES,
  normalizeCallName: normalizeJavaCallName,
  contextNodeTypes: new Set([
    "class_declaration",
    "interface_declaration",
    "enum_declaration",
    "record_declaration",
    "enum_constant",
    "method_declaration",
    "constructor_declaration",
    "compact_constructor_declaration",
  ]),
  contextNameField: "name",
  keepQualifiedCallee: true,
  qualifyCall: javaQualifyCall,
};
