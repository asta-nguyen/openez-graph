import type { Node } from "web-tree-sitter";

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
  const parts = value.split(".").filter(Boolean);
  return parts[parts.length - 1] ?? value;
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
    for (const child of node.namedChildren) {
      if (child.type === "dotted_name") {
        if (child.startIndex === moduleStart && child.endIndex === moduleEnd) continue;
        if (modulePath) paths.push(`${modulePath}.${child.text}`);
      } else if (child.type === "aliased_import") {
        const nameNode = child.childForFieldName("name");
        if (nameNode && modulePath) {
          paths.push(`${modulePath}.${nameNode.text}`);
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
  const parts = value.split(".").filter(Boolean);
  return parts[parts.length - 1] ?? value;
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
  ],
  importRules: [{ nodeType: "import_declaration", extract: extractGoImports }],
  callRule: { nodeType: "call_expression", functionField: "function" },
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

function normalizeRustCallName(value: string): string {
  // Handle both :: and . separators
  const pathParts = value.split("::").filter(Boolean);
  const last = pathParts[pathParts.length - 1] ?? value;
  const dotParts = last.split(".");
  return dotParts[dotParts.length - 1] ?? last;
}

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
  if (!receiverNode || receiverNode.text !== "self") return null;
  for (let i = contextStack.length - 1; i >= 0; i--) {
    const frame = contextStack[i];
    if (frame.kind === "class" || frame.kind === "module") {
      return `${frame.name}::${normalized}`;
    }
  }
  return null;
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
