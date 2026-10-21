use napi_derive::napi;
use std::collections::{HashMap, HashSet};
use tree_sitter::{Node, Parser};

// ── NAPI output types ──

#[napi(object)]
pub struct NativeSymbol {
  pub name: String,
  pub symbol_type: String,
  pub exported: bool,
  pub start_line: i32,
  pub end_line: i32,
  pub receiver: Option<String>,
}

#[napi(object)]
pub struct NativeCallExpression {
  pub caller_name: String,
  pub callee_name: String,
}

#[napi(object)]
pub struct NativeParseResult {
  pub symbols: Vec<NativeSymbol>,
  pub import_paths: Vec<String>,
  pub called_identifiers: Vec<String>,
  pub call_expressions: Vec<NativeCallExpression>,
}

#[napi(object)]
pub struct NativeChunk {
  pub content: String,
  pub start_line: i32,
  pub end_line: i32,
}

#[napi(object)]
pub struct NativeParseAndChunkResult {
  pub symbols: Vec<NativeSymbol>,
  pub import_paths: Vec<String>,
  pub called_identifiers: Vec<String>,
  pub call_expressions: Vec<NativeCallExpression>,
  pub chunks: Vec<NativeChunk>,
}

// ── Language config (ported from configs.ts) ──

#[derive(Clone, Copy, PartialEq, Eq)]
enum ContextKind {
  Class,
  Module,
}

/// One frame of the walker's context stack. `kind` is set only for Ruby
/// class/module contexts so `class << self` and `self.foo` hooks can walk
/// back to the nearest namespace frame.
#[derive(Clone)]
struct ContextFrame {
  name: String,
  /// Byte offset where the context node ends. Context expiry compares on
  /// byte position (not row) so same-line sibling declarations don't leak
  /// the previous sibling's scope.
  end_byte: usize,
  kind: Option<ContextKind>,
  /// Go method receiver (var_name, type_name) for Type::method qualification.
  receiver: Option<(String, String)>,
}

struct SymbolRule {
  node_type: &'static str,
  symbol_type: &'static str,
  name_field: &'static str,
  establishes_context: bool,
  /// (name, node_text_first_20) -> is_exported
  is_exported: fn(&str, &str) -> bool,
  /// For Rust impl_item / Ruby assignment: custom name extraction
  extract_name: Option<fn(&Node, &[u8]) -> Option<String>>,
  /// For Rust impl_item: context name (type name, not full "impl X for Y");
  /// for Ruby singleton_class: nearest class/module frame name.
  extract_context_name: Option<fn(&Node, &[u8], &[ContextFrame]) -> Option<String>>,
  /// For Go method_declaration: receiver field
  receiver_field: Option<&'static str>,
  /// Normalize receiver text (strip parens for Go)
  normalize_receiver: Option<fn(&str) -> String>,
  /// Push a context frame without emitting a symbol or extracting calls
  /// (Ruby `class << self` singleton context).
  context_only: bool,
  /// Context kind carried by frames this rule pushes (Ruby class/module).
  context_kind: Option<ContextKind>,
  /// Dynamic symbol type — C++ function_definition resolves to "method"
  /// (qualified declarator or class context) vs "function".
  symbol_type_fn: Option<fn(&Node, &[u8], &[ContextFrame]) -> &'static str>,
}

struct LanguageConfig {
  symbol_rules: Vec<SymbolRule>,
  import_node_types: Vec<&'static str>,
  call_node_type: &'static str,
  call_function_field: &'static str,
  call_ignores: HashSet<&'static str>,
  normalize_call_name: fn(&str) -> String,
  context_node_types: Vec<&'static str>,
  /// WASM parity mode: callExpressions are attributed to the symbol node
  /// whose subtree contains the call (skipping nested symbol ranges),
  /// matching extractCallsInNode in parse.ts. When false, calls encountered
  /// during DFS attribute to the innermost context frame.
  per_symbol_calls: bool,
  /// (call_node, source, raw callee, normalized callee, context stack) ->
  /// qualified callee name override (Ruby self.foo -> C::foo).
  qualify_call: Option<fn(&Node, &[u8], &str, &str, &[ContextFrame]) -> Option<String>>,
  /// When true, call_expressions keep the qualified callee name
  /// (`pkg.func`, `self.m`) while called_identifiers record the last
  /// segment; ignores apply to the raw and last-segment forms. Python only.
  keep_qualified_calls: bool,
  /// `.h` C++ headers only: any syntax error rejects the whole parse so the
  /// document falls back to generic chunks with no graph records.
  error_fails_parse: bool,
}

// ── Exported checks ──

fn always_false(_name: &str, _text: &str) -> bool {
  false
}

fn always_true(_name: &str, _text: &str) -> bool {
  true
}

fn python_exported(name: &str, _text: &str) -> bool {
  !name.starts_with('_')
}

fn go_exported(name: &str, _text: &str) -> bool {
  name
    .chars()
    .next()
    .map(|c| c.is_ascii_uppercase())
    .unwrap_or(false)
}

fn rust_pub_check(_name: &str, text: &str) -> bool {
  text.starts_with("pub ")
}

// ── Rust impl_item name extraction ──

fn rust_impl_name(node: &Node, source: &[u8]) -> Option<String> {
  let type_node = node.child_by_field_name("type")?;
  let type_name = text_of(&type_node, source);
  if let Some(trait_node) = node.child_by_field_name("trait") {
    let trait_name = text_of(&trait_node, source);
    return Some(format!("impl {} for {}", trait_name, type_name));
  }
  Some(format!("impl {}", type_name))
}

fn rust_impl_context_name(
  node: &Node,
  source: &[u8],
  _stack: &[ContextFrame],
) -> Option<String> {
  node.child_by_field_name("type").map(|n| text_of(&n, source))
}

// ── Go receiver normalization ──

fn go_normalize_receiver(text: &str) -> String {
  text
    .trim_matches(|c| c == '(' || c == ')')
    .trim()
    .to_string()
}

/// Extract the receiver variable name from Go receiver text.
/// `(f Foo)` → `f`, `(b *Bar)` → `b`
fn go_receiver_name(text: &str) -> Option<String> {
  let inner = text.trim_matches(|c| c == '(' || c == ')').trim();
  let parts: Vec<&str> = inner.split_whitespace().collect();
  parts.first().map(|s| s.to_string())
}

/// Extract the receiver type name from Go receiver text.
/// `(f Foo)` → `Foo`, `(b *Bar)` → `Bar`, `(s []byte)` → `byte`
fn go_receiver_type(text: &str) -> Option<String> {
  let inner = text.trim_matches(|c| c == '(' || c == ')').trim();
  let parts: Vec<&str> = inner.split_whitespace().collect();
  let type_part = parts.last()?;
  // Strip pointer marker: *Bar → Bar
  let cleaned = type_part.trim_start_matches('*');
  // Strip slice/brackets: []byte → byte
  let cleaned = cleaned.trim_start_matches("[]");
  if cleaned.is_empty() {
    None
  } else {
    Some(cleaned.to_string())
  }
}

// ── Call name normalization ──

/// Python keeps the qualified dotted callee (`pkg.func`, `self.m`) —
/// keep_qualified_calls records the last segment as the called identifier.
fn python_normalize_call(value: &str) -> String {
  value.to_string()
}

/// Go call names keep their package selector (`pkg.Func`) for graph-level
/// import resolution; only generic instantiation `[T]` is stripped.
fn go_normalize_call(value: &str) -> String {
  value.split('[').next().unwrap_or(value).to_string()
}

/// Last `::`/`.`-separated segment of a normalized Rust call path.
/// `crate::util::run` → `run`, `x.run` → `run`.
fn last_rust_call_segment(value: &str) -> &str {
  value
    .rsplit(|c| c == ':' || c == '.')
    .find(|s| !s.is_empty())
    .unwrap_or(value)
}

/// Preserve the qualified Rust call path (`crate::util::run`, `x.run`,
/// `Self::new`) with whitespace removed and turbofish arguments stripped
/// (`parse::<u8>` → `parse`). Returns "" when the callee is not a plain
/// identifier path (`iter().map`, `[1].iter`) — those never resolve.
/// keep_qualified_calls records the last segment as the called identifier.
fn normalize_rust_call(value: &str) -> String {
  let stripped: String = value.chars().filter(|c| !c.is_whitespace()).collect();
  let bytes = stripped.as_bytes();
  let mut result = String::with_capacity(bytes.len());
  let mut depth: i32 = 0;
  let mut i = 0;
  while i < bytes.len() {
    if depth == 0
      && i + 2 < bytes.len()
      && bytes[i] == b':'
      && bytes[i + 1] == b':'
      && bytes[i + 2] == b'<'
    {
      depth = 1;
      i += 3;
      continue;
    }
    if depth > 0 {
      match bytes[i] {
        b'<' => depth += 1,
        b'>' => depth -= 1,
        _ => {}
      }
      i += 1;
      continue;
    }
    result.push(bytes[i] as char);
    i += 1;
  }
  // Valid callees are identifier paths joined by :: or . (\w+(::\w+)*(\.\w+)*).
  let valid = !result.is_empty()
    && result
      .split("::")
      .flat_map(|p| p.split('.'))
      .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'));
  if valid { result } else { String::new() }
}

// ── Config builders ──

fn python_config() -> LanguageConfig {
  let mut call_ignores = HashSet::new();
  for s in [
    "if", "for", "while", "with", "return", "yield", "print", "len", "range", "str", "int",
    "float", "list", "dict", "set", "tuple", "bool", "isinstance", "issubclass", "super",
    "self", "cls", "type", "abs", "min", "max", "sum", "sorted", "enumerate", "zip", "map",
    "filter", "open", "input", "format", "getattr", "setattr", "hasattr", "delattr",
    "property", "staticmethod", "classmethod", "abstractmethod",
  ] {
    call_ignores.insert(s);
  }

  LanguageConfig {
    symbol_rules: vec![
      SymbolRule {
        node_type: "function_definition",
        symbol_type: "function",
        name_field: "name",
        establishes_context: true,
        is_exported: python_exported,
        extract_name: None,
        extract_context_name: None,
        receiver_field: None,
        normalize_receiver: None,
        context_only: false,
        context_kind: None,
        symbol_type_fn: None,
      },
      SymbolRule {
        node_type: "class_definition",
        symbol_type: "class",
        name_field: "name",
        establishes_context: true,
        is_exported: python_exported,
        extract_name: None,
        extract_context_name: None,
        receiver_field: None,
        normalize_receiver: None,
        context_only: false,
        context_kind: None,
        symbol_type_fn: None,
      },
    ],
    import_node_types: vec!["import_statement", "import_from_statement"],
    call_node_type: "call",
    call_function_field: "function",
    call_ignores,
    normalize_call_name: python_normalize_call,
    context_node_types: vec!["function_definition", "class_definition"],
    per_symbol_calls: false,
    qualify_call: None,
    keep_qualified_calls: true,
    error_fails_parse: false,
  }
}

fn go_config() -> LanguageConfig {
  let mut call_ignores = HashSet::new();
  for s in [
    "if", "for", "switch", "select", "case", "go", "defer", "return", "make", "len", "cap",
    "append", "copy", "delete", "panic", "recover", "new", "print", "println", "close",
    "complex", "real", "imag", "min", "max", "clear", "string", "int", "int8", "int16",
    "int32", "int64", "uint", "float32", "float64", "bool", "byte", "rune", "error",
  ] {
    call_ignores.insert(s);
  }

  LanguageConfig {
    symbol_rules: vec![
      SymbolRule {
        node_type: "function_declaration",
        symbol_type: "function",
        name_field: "name",
        establishes_context: true,
        is_exported: go_exported,
        extract_name: None,
        extract_context_name: None,
        receiver_field: None,
        normalize_receiver: None,
        context_only: false,
        context_kind: None,
        symbol_type_fn: None,
      },
      SymbolRule {
        node_type: "method_declaration",
        symbol_type: "function",
        name_field: "name",
        establishes_context: true,
        is_exported: go_exported,
        extract_name: None,
        extract_context_name: None,
        receiver_field: Some("receiver"),
        normalize_receiver: Some(go_normalize_receiver),
        context_only: false,
        context_kind: None,
        symbol_type_fn: None,
      },
      SymbolRule {
        node_type: "type_spec",
        symbol_type: "type",
        name_field: "name",
        establishes_context: false,
        is_exported: go_exported,
        extract_name: None,
        extract_context_name: None,
        receiver_field: None,
        normalize_receiver: None,
        context_only: false,
        context_kind: None,
        symbol_type_fn: None,
      },
    ],
    import_node_types: vec!["import_declaration"],
    call_node_type: "call_expression",
    call_function_field: "function",
    call_ignores,
    normalize_call_name: go_normalize_call,
    context_node_types: vec!["function_declaration", "method_declaration"],
    per_symbol_calls: false,
    qualify_call: None,
    keep_qualified_calls: false,
    error_fails_parse: false,
  }
}

fn rust_config() -> LanguageConfig {
  let mut call_ignores = HashSet::new();
  for s in [
    "if", "while", "for", "loop", "match", "return", "let", "as", "in", "println", "print",
    "eprintln", "eprint", "format", "vec", "Box", "Some", "None", "Ok", "Err", "String",
    "str", "Vec", "Option", "Result", "self", "Self", "true", "false",
  ] {
    call_ignores.insert(s);
  }

  LanguageConfig {
    symbol_rules: vec![
      SymbolRule {
        node_type: "function_item",
        symbol_type: "function",
        name_field: "name",
        establishes_context: true,
        is_exported: rust_pub_check,
        extract_name: None,
        extract_context_name: None,
        receiver_field: None,
        normalize_receiver: None,
        context_only: false,
        context_kind: None,
        symbol_type_fn: None,
      },
      SymbolRule {
        node_type: "struct_item",
        symbol_type: "struct",
        name_field: "name",
        establishes_context: false,
        is_exported: rust_pub_check,
        extract_name: None,
        extract_context_name: None,
        receiver_field: None,
        normalize_receiver: None,
        context_only: false,
        context_kind: None,
        symbol_type_fn: None,
      },
      SymbolRule {
        node_type: "enum_item",
        symbol_type: "enum",
        name_field: "name",
        establishes_context: false,
        is_exported: rust_pub_check,
        extract_name: None,
        extract_context_name: None,
        receiver_field: None,
        normalize_receiver: None,
        context_only: false,
        context_kind: None,
        symbol_type_fn: None,
      },
      SymbolRule {
        node_type: "trait_item",
        symbol_type: "trait",
        name_field: "name",
        establishes_context: true,
        is_exported: rust_pub_check,
        extract_name: None,
        extract_context_name: None,
        receiver_field: None,
        normalize_receiver: None,
        context_only: false,
        context_kind: None,
        symbol_type_fn: None,
      },
      SymbolRule {
        node_type: "impl_item",
        symbol_type: "impl",
        name_field: "type",
        establishes_context: true,
        is_exported: always_false,
        extract_name: Some(rust_impl_name),
        extract_context_name: Some(rust_impl_context_name),
        receiver_field: None,
        normalize_receiver: None,
        context_only: false,
        context_kind: None,
        symbol_type_fn: None,
      },
      SymbolRule {
        node_type: "type_item",
        symbol_type: "type",
        name_field: "name",
        establishes_context: false,
        is_exported: rust_pub_check,
        extract_name: None,
        extract_context_name: None,
        receiver_field: None,
        normalize_receiver: None,
        context_only: false,
        context_kind: None,
        symbol_type_fn: None,
      },
      SymbolRule {
        node_type: "const_item",
        symbol_type: "const",
        name_field: "name",
        establishes_context: false,
        is_exported: rust_pub_check,
        extract_name: None,
        extract_context_name: None,
        receiver_field: None,
        normalize_receiver: None,
        context_only: false,
        context_kind: None,
        symbol_type_fn: None,
      },
      SymbolRule {
        node_type: "static_item",
        symbol_type: "const",
        name_field: "name",
        establishes_context: false,
        is_exported: rust_pub_check,
        extract_name: None,
        extract_context_name: None,
        receiver_field: None,
        normalize_receiver: None,
        context_only: false,
        context_kind: None,
        symbol_type_fn: None,
      },
      SymbolRule {
        node_type: "mod_item",
        symbol_type: "module",
        name_field: "name",
        establishes_context: false,
        is_exported: rust_pub_check,
        extract_name: None,
        extract_context_name: None,
        receiver_field: None,
        normalize_receiver: None,
        context_only: false,
        context_kind: None,
        symbol_type_fn: None,
      },
    ],
    import_node_types: vec!["use_declaration"],
    call_node_type: "call_expression",
    call_function_field: "function",
    call_ignores,
    normalize_call_name: normalize_rust_call,
    context_node_types: vec!["function_item", "trait_item", "impl_item"],
    per_symbol_calls: false,
    qualify_call: None,
    keep_qualified_calls: true,
    error_fails_parse: false,
  }
}

// ── Ruby config (ported from rubyConfig in configs.ts) ──

fn ruby_exported(name: &str, _text: &str) -> bool {
  name
    .chars()
    .next()
    .map(|c| c.is_ascii_uppercase())
    .unwrap_or(false)
}

/// JS: value.split(/[.::]/).filter(Boolean).pop() ?? value — the regex char
/// class splits on every '.' or ':' character.
fn normalize_ruby_call(value: &str) -> String {
  value
    .split(|c| c == '.' || c == ':')
    .filter(|s| !s.is_empty())
    .last()
    .unwrap_or(value)
    .to_string()
}

/// `x = lambda {}` / `x = proc {}` / `x = Proc.new {}` → the left-hand name.
fn ruby_assignment_name(node: &Node, source: &[u8]) -> Option<String> {
  let right = node.child_by_field_name("right")?;
  let left_name = || {
    node
      .child_by_field_name("left")
      .map(|n| text_of(&n, source))
  };
  match right.kind() {
    "lambda" => left_name(),
    "call" => {
      let method = right
        .child_by_field_name("method")
        .map(|m| text_of(&m, source));
      if matches!(method.as_deref(), Some("proc") | Some("lambda")) {
        return left_name();
      }
      let receiver = right
        .child_by_field_name("receiver")
        .map(|r| text_of(&r, source));
      if receiver.as_deref() == Some("Proc") && method.as_deref() == Some("new") {
        return left_name();
      }
      None
    }
    _ => None,
  }
}

/// `class << self` — context name is the nearest enclosing class/module frame.
fn ruby_singleton_context_name(
  _node: &Node,
  _source: &[u8],
  stack: &[ContextFrame],
) -> Option<String> {
  for frame in stack.iter().rev() {
    if matches!(frame.kind, Some(ContextKind::Class) | Some(ContextKind::Module)) {
      return Some(frame.name.clone());
    }
  }
  None
}

/// `self.foo` inside a class/module context → `ClassName::foo`.
/// Constant receivers keep the scope-qualified name: `Invoice.build` →
/// `Invoice::build`, `Billing::Invoice.build` → `Billing::Invoice::build`.
/// Ordinary receivers (locals, ivars, expressions, `&.`) can never resolve —
/// returns `""` so the caller suppresses the call entirely.
fn ruby_qualify_call(
  call_node: &Node,
  source: &[u8],
  _callee_raw: &str,
  normalized: &str,
  stack: &[ContextFrame],
) -> Option<String> {
  let receiver = call_node.child_by_field_name("receiver")?;
  if text_of(&receiver, source) == "self" {
    for frame in stack.iter().rev() {
      if matches!(frame.kind, Some(ContextKind::Class) | Some(ContextKind::Module)) {
        return Some(format!("{}::{}", frame.name, normalized));
      }
    }
    return None;
  }
  if receiver.kind() == "constant" || receiver.kind() == "scope_resolution" {
    return Some(format!("{}::{}", text_of(&receiver, source), normalized));
  }
  Some(String::new())
}

fn ruby_config() -> LanguageConfig {
  let call_ignores: HashSet<&str> = [
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
  ]
  .iter()
  .copied()
  .collect();

  LanguageConfig {
    symbol_rules: vec![
      SymbolRule {
        node_type: "class",
        symbol_type: "class",
        name_field: "name",
        establishes_context: true,
        is_exported: ruby_exported,
        extract_name: None,
        extract_context_name: None,
        receiver_field: None,
        normalize_receiver: None,
        context_only: false,
        context_kind: Some(ContextKind::Class),
        symbol_type_fn: None,
      },
      SymbolRule {
        node_type: "module",
        symbol_type: "module",
        name_field: "name",
        establishes_context: true,
        is_exported: ruby_exported,
        extract_name: None,
        extract_context_name: None,
        receiver_field: None,
        normalize_receiver: None,
        context_only: false,
        context_kind: Some(ContextKind::Module),
        symbol_type_fn: None,
      },
      SymbolRule {
        node_type: "method",
        symbol_type: "function",
        name_field: "name",
        establishes_context: true,
        is_exported: always_false,
        extract_name: None,
        extract_context_name: None,
        receiver_field: None,
        normalize_receiver: None,
        context_only: false,
        context_kind: None,
        symbol_type_fn: None,
      },
      SymbolRule {
        node_type: "singleton_method",
        symbol_type: "function",
        name_field: "name",
        establishes_context: true,
        is_exported: always_false,
        extract_name: None,
        extract_context_name: None,
        receiver_field: None,
        normalize_receiver: None,
        context_only: false,
        context_kind: None,
        symbol_type_fn: None,
      },
      SymbolRule {
        node_type: "singleton_class",
        symbol_type: "class",
        name_field: "name",
        establishes_context: false,
        is_exported: always_false,
        extract_name: None,
        extract_context_name: Some(ruby_singleton_context_name),
        receiver_field: None,
        normalize_receiver: None,
        context_only: true,
        context_kind: None,
        symbol_type_fn: None,
      },
      SymbolRule {
        node_type: "assignment",
        symbol_type: "lambda",
        name_field: "name",
        establishes_context: false,
        is_exported: always_false,
        extract_name: Some(ruby_assignment_name),
        extract_context_name: None,
        receiver_field: None,
        normalize_receiver: None,
        context_only: false,
        context_kind: None,
        symbol_type_fn: None,
      },
    ],
    import_node_types: vec!["call"],
    call_node_type: "call",
    call_function_field: "method",
    call_ignores,
    normalize_call_name: normalize_ruby_call,
    context_node_types: vec!["class", "module", "method", "singleton_method"],
    per_symbol_calls: true,
    qualify_call: Some(ruby_qualify_call),
    keep_qualified_calls: false,
    error_fails_parse: false,
  }
}


// ── C++ config (ported from cppConfig in configs.ts) ──

/// Strip `<...>` template argument lists, depth-aware. A `<` that begins
/// an operator-name token (`operator<`, `operator<<`, `operator<=`,
/// `operator<=>`, `operator<<=`, …) is kept together with the rest of the
/// operator symbol run — only `<` that cannot be part of an operator name
/// opens a template-argument group.
fn strip_cpp_template_args(text: &str) -> String {
  const OP_SYMS: &[u8] = b"+-*/%^&|~!=<>,";
  let bytes = text.as_bytes();
  let mut out = String::with_capacity(bytes.len());
  let mut depth: i32 = 0;
  let mut i = 0;
  while i < bytes.len() {
    let b = bytes[i];
    if depth > 0 {
      if b == b'<' {
        depth += 1;
      } else if b == b'>' {
        depth -= 1;
      }
      i += 1;
      continue;
    }
    if b == b'<' {
      let operator_tail = out.ends_with("operator")
        && (out.len() == "operator".len()
          || !matches!(out.as_bytes()[out.len() - "operator".len() - 1],
              c if c.is_ascii_alphanumeric() || c == b'_'));
      if operator_tail {
        out.push(b as char);
        i += 1;
        while i < bytes.len() && OP_SYMS.contains(&bytes[i]) {
          out.push(bytes[i] as char);
          i += 1;
        }
        continue;
      }
      depth += 1;
      i += 1;
      continue;
    }
    out.push(b as char);
    i += 1;
  }
  out
}

/// Descend a declarator chain to its function_declarator. Pointer and
/// reference layers unwrap; anything else yields None so non-function
/// declarations emit no symbol.
fn cpp_function_declarator<'a>(node: &Node<'a>) -> Option<Node<'a>> {
  let mut cur = node.child_by_field_name("declarator");
  while let Some(c) = cur {
    match c.kind() {
      "function_declarator" => return Some(c),
      "pointer_declarator" | "reference_declarator" => {
        cur = c.child_by_field_name("declarator");
      }
      _ => return None,
    }
  }
  None
}

/// Name text of a function_declarator's declarator field — identifier,
/// field_identifier, qualified_identifier, destructor_name, operator_name,
/// or template_function — with whitespace and template args stripped.
fn cpp_function_name(node: &Node, source: &[u8]) -> Option<String> {
  let declarator = cpp_function_declarator(node)?;
  let name_node = declarator.child_by_field_name("declarator")?;
  let raw = if name_node.kind() == "template_function" {
    name_node
      .child_by_field_name("name")
      .map(|n| text_of(&n, source))
      .unwrap_or_else(|| text_of(&name_node, source))
  } else {
    text_of(&name_node, source)
  };
  let no_ws: String = raw.chars().filter(|c| !c.is_whitespace()).collect();
  let stripped = strip_cpp_template_args(&no_ws);
  if stripped.is_empty() {
    None
  } else {
    Some(stripped)
  }
}

/// class/struct/union/enum specifier name — only when a `body` exists, so
/// elaborated type uses (`class Foo *p`) and forward declarations emit no
/// symbol.
fn cpp_type_name(node: &Node, source: &[u8]) -> Option<String> {
  node.child_by_field_name("body")?;
  node
    .child_by_field_name("name")
    .map(|n| text_of(&n, source))
}

/// namespace_definition name — anonymous namespaces emit no symbol/context;
/// `namespace a::b` qualified names keep all segments.
fn cpp_namespace_name(node: &Node, source: &[u8]) -> Option<String> {
  let name_node = node.child_by_field_name("name")?;
  let cleaned: String = text_of(&name_node, source)
    .chars()
    .filter(|c| !c.is_whitespace())
    .collect();
  if cleaned.is_empty() {
    None
  } else {
    Some(cleaned)
  }
}

/// function_definition -> "method" when the declarator is qualified (`A::m`)
/// or it sits directly inside a class/struct/union context; else "function".
fn cpp_function_type(node: &Node, _source: &[u8], stack: &[ContextFrame]) -> &'static str {
  let qualified = cpp_function_declarator(node)
    .and_then(|d| d.child_by_field_name("declarator"))
    .map(|n| n.kind() == "qualified_identifier")
    .unwrap_or(false);
  if qualified {
    return "method";
  }
  match stack.last().and_then(|f| f.kind) {
    Some(ContextKind::Class) => "method",
    _ => "function",
  }
}

/// Normalize a call-expression function child: strip whitespace and
/// template args, convert `->` to `.`, keep only simple identifier paths
/// (`f`, `a::b::f`, `::f`, `obj.f`, `this.f`, `~A`, `A::operator==`).
/// Anything else returns "" and is dropped.
fn normalize_cpp_call(value: &str) -> String {
  let no_ws: String = value.chars().filter(|c| !c.is_whitespace()).collect();
  let stripped = strip_cpp_template_args(&no_ws);
  let text = stripped.replace("->", ".");
  if text.is_empty() {
    return String::new();
  }
  let scope_parts: Vec<&str> = text.split("::").collect();
  let leading_global = scope_parts.first() == Some(&"");
  let parts: &[&str] = if leading_global {
    &scope_parts[1..]
  } else {
    &scope_parts[..]
  };
  if parts.is_empty() {
    return String::new();
  }
  for part in parts {
    for seg in part.split('.') {
      if seg.is_empty() {
        return String::new();
      }
      if seg.starts_with("operator") && seg.len() > 8 {
        continue;
      }
      if !seg
        .chars()
        .all(|c| c == '_' || c == '~' || c.is_alphanumeric())
      {
        return String::new();
      }
    }
  }
  text
}

fn cpp_symbol_rules() -> Vec<SymbolRule> {
  vec![
    SymbolRule {
      node_type: "namespace_definition",
      symbol_type: "namespace",
      name_field: "name",
      establishes_context: true,
      is_exported: always_true,
      extract_name: Some(cpp_namespace_name),
      extract_context_name: None,
      receiver_field: None,
      normalize_receiver: None,
      context_only: false,
      context_kind: Some(ContextKind::Module),
      symbol_type_fn: None,
    },
    SymbolRule {
      node_type: "class_specifier",
      symbol_type: "class",
      name_field: "name",
      establishes_context: true,
      is_exported: always_true,
      extract_name: Some(cpp_type_name),
      extract_context_name: None,
      receiver_field: None,
      normalize_receiver: None,
      context_only: false,
      context_kind: Some(ContextKind::Class),
      symbol_type_fn: None,
    },
    SymbolRule {
      node_type: "struct_specifier",
      symbol_type: "struct",
      name_field: "name",
      establishes_context: true,
      is_exported: always_true,
      extract_name: Some(cpp_type_name),
      extract_context_name: None,
      receiver_field: None,
      normalize_receiver: None,
      context_only: false,
      context_kind: Some(ContextKind::Class),
      symbol_type_fn: None,
    },
    SymbolRule {
      node_type: "union_specifier",
      symbol_type: "union",
      name_field: "name",
      establishes_context: true,
      is_exported: always_true,
      extract_name: Some(cpp_type_name),
      extract_context_name: None,
      receiver_field: None,
      normalize_receiver: None,
      context_only: false,
      context_kind: Some(ContextKind::Class),
      symbol_type_fn: None,
    },
    SymbolRule {
      node_type: "enum_specifier",
      symbol_type: "enum",
      name_field: "name",
      establishes_context: true,
      is_exported: always_true,
      extract_name: Some(cpp_type_name),
      extract_context_name: None,
      receiver_field: None,
      normalize_receiver: None,
      context_only: false,
      context_kind: None,
      symbol_type_fn: None,
    },
    SymbolRule {
      node_type: "alias_declaration",
      symbol_type: "type",
      name_field: "name",
      establishes_context: false,
      is_exported: always_true,
      extract_name: None,
      extract_context_name: None,
      receiver_field: None,
      normalize_receiver: None,
      context_only: false,
      context_kind: None,
      symbol_type_fn: None,
    },
    SymbolRule {
      node_type: "type_definition",
      symbol_type: "type",
      name_field: "declarator",
      establishes_context: false,
      is_exported: always_true,
      extract_name: None,
      extract_context_name: None,
      receiver_field: None,
      normalize_receiver: None,
      context_only: false,
      context_kind: None,
      symbol_type_fn: None,
    },
    SymbolRule {
      node_type: "function_definition",
      symbol_type: "function",
      name_field: "name",
      establishes_context: true,
      is_exported: always_true,
      extract_name: Some(cpp_function_name),
      extract_context_name: None,
      receiver_field: None,
      normalize_receiver: None,
      context_only: false,
      context_kind: None,
      symbol_type_fn: Some(cpp_function_type),
    },
    SymbolRule {
      node_type: "declaration",
      symbol_type: "declaration",
      name_field: "name",
      establishes_context: false,
      is_exported: always_true,
      extract_name: Some(cpp_function_name),
      extract_context_name: None,
      receiver_field: None,
      normalize_receiver: None,
      context_only: false,
      context_kind: None,
      symbol_type_fn: None,
    },
    SymbolRule {
      node_type: "field_declaration",
      symbol_type: "declaration",
      name_field: "name",
      establishes_context: false,
      is_exported: always_true,
      extract_name: Some(cpp_function_name),
      extract_context_name: None,
      receiver_field: None,
      normalize_receiver: None,
      context_only: false,
      context_kind: None,
      symbol_type_fn: None,
    },
  ]
}

fn cpp_config(error_fails_parse: bool) -> LanguageConfig {
  let mut call_ignores = HashSet::new();
  for s in [
    "if", "for", "while", "switch", "return", "sizeof", "alignof", "decltype", "typeid",
    "noexcept", "static_cast", "dynamic_cast", "reinterpret_cast", "const_cast", "new",
    "delete", "throw", "static_assert", "catch", "int", "char", "short", "long", "float",
    "double", "bool", "void", "unsigned", "signed", "const", "volatile", "auto", "size_t",
    "nullptr", "true", "false", "this",
  ] {
    call_ignores.insert(s);
  }

  LanguageConfig {
    symbol_rules: cpp_symbol_rules(),
    import_node_types: vec!["preproc_include"],
    call_node_type: "call_expression",
    call_function_field: "function",
    call_ignores,
    normalize_call_name: normalize_cpp_call,
    context_node_types: vec![
      "namespace_definition",
      "class_specifier",
      "struct_specifier",
      "union_specifier",
      "enum_specifier",
      "function_definition",
    ],
    per_symbol_calls: true,
    qualify_call: None,
    keep_qualified_calls: true,
    error_fails_parse,
  }
}

// ── Helpers ──

fn get_node_name(node: &Node, field: &str, source: &[u8]) -> Option<String> {
  if let Some(name_node) = node.child_by_field_name(field) {
    return Some(text_of(&name_node, source));
  }
  // Fallback: first named child of type "identifier"
  for i in 0..node.named_child_count() {
    if let Some(child) = node.named_child(i) {
      if child.kind() == "identifier" {
        return Some(text_of(&child, source));
      }
    }
  }
  None
}

fn text_of(node: &Node, source: &[u8]) -> String {
  let start = node.start_byte();
  let end = node.end_byte();
  String::from_utf8_lossy(&source[start..end]).to_string()
}

fn text_first_n(node: &Node, source: &[u8], n: usize) -> String {
  let start = node.start_byte();
  let end = (node.end_byte()).min(start + n);
  String::from_utf8_lossy(&source[start..end]).to_string()
}

// ── Import extraction ──

fn extract_imports(node: &Node, source: &[u8], language: &str) -> Vec<String> {
  let mut paths = Vec::new();

  match language {
    "python" => {
      if node.kind() == "import_statement" {
        let cursor = node.walk();
        for i in 0..node.named_child_count() {
          if let Some(child) = node.named_child(i) {
            match child.kind() {
              "dotted_name" => paths.push(text_of(&child, source)),
              "aliased_import" => {
                if let Some(name_node) = child.child_by_field_name("name") {
                  paths.push(text_of(&name_node, source));
                }
              }
              _ => {}
            }
          }
        }
        let _ = cursor;
      } else if node.kind() == "import_from_statement" {
        let module_path = node
          .child_by_field_name("module_name")
          .map(|n| text_of(&n, source))
          .unwrap_or_default();
        if !module_path.is_empty() {
          paths.push(module_path.clone());
        }

        let module_start = node
          .child_by_field_name("module_name")
          .map(|n| n.start_byte())
          .unwrap_or(0);
        let module_end = node
          .child_by_field_name("module_name")
          .map(|n| n.end_byte())
          .unwrap_or(0);

        // Relative imports: module_path already ends in dots (`from . import x`
        // gives `.`) — joining with another dot would corrupt the level count.
        let join = |name: &str| {
          if module_path.ends_with('.') {
            format!("{}{}", module_path, name)
          } else {
            format!("{}.{}", module_path, name)
          }
        };
        for i in 0..node.named_child_count() {
          if let Some(child) = node.named_child(i) {
            if child.start_byte() == module_start && child.end_byte() == module_end {
              continue;
            }
            match child.kind() {
              "dotted_name" => {
                if !module_path.is_empty() {
                  paths.push(join(&text_of(&child, source)));
                }
              }
              "aliased_import" => {
                if let Some(name_node) = child.child_by_field_name("name") {
                  if !module_path.is_empty() {
                    paths.push(join(&text_of(&name_node, source)));
                  }
                }
              }
              _ => {}
            }
          }
        }
      }
    }
    "go" => {
      // import_declaration > import_spec_list > import_spec (path field)
      // Or single: import "fmt"
      let mut found_specs = false;

      // Walk all descendants
      let mut stack = vec![*node];
      while let Some(n) = stack.pop() {
        if n.kind() == "import_spec" {
          found_specs = true;
          if let Some(path_node) = n.child_by_field_name("path") {
            let text = text_of(&path_node, source);
            let cleaned = text.trim_matches('"');
            if !cleaned.is_empty() {
              paths.push(cleaned.to_string());
            }
          }
        }
        // Push children
        for i in (0..n.child_count()).rev() {
          if let Some(child) = n.child(i) {
            stack.push(child);
          }
        }
      }

      if !found_specs {
        // Handle single import without import_spec (e.g. import "fmt")
        let mut stack2 = vec![*node];
        while let Some(n) = stack2.pop() {
          if n.kind() == "interpreted_string_literal" {
            let text = text_of(&n, source);
            let cleaned = text.trim_matches('"');
            if !cleaned.is_empty() {
              paths.push(cleaned.to_string());
            }
          }
          for i in (0..n.child_count()).rev() {
            if let Some(child) = n.child(i) {
              stack2.push(child);
            }
          }
        }
      }
    }
    "rust" => {
      // use_declaration — argument field contains the use tree
      let target = node.child_by_field_name("argument").unwrap_or(*node);
      let text = text_of(&target, source);
      let cleaned = text.trim_end_matches(';').trim();
      if !cleaned.is_empty() {
        paths.push(cleaned.to_string());
      }
    }
    "cpp" | "cpp-header" => {
      // Quoted `#include "..."` paths only — system_lib_string and macro
      // paths produce no import edge (extractCppImports).
      if node.kind() == "preproc_include" {
        if let Some(path_node) = node.child_by_field_name("path") {
          if path_node.kind() == "string_literal" {
            let text = text_of(&path_node, source);
            let cleaned = text.trim_matches('"');
            if !cleaned.is_empty() {
              paths.push(cleaned.to_string());
            }
          }
        }
      }
    }
    "ruby" => {
      // Only require_relative produces import edges — require (gem), load,
      // and autoload do not resolve to local files (extractRubyImports).
      if node.kind() == "call" {
        let is_require_relative = node
          .child_by_field_name("method")
          .map(|m| text_of(&m, source) == "require_relative")
          .unwrap_or(false);
        if is_require_relative {
          if let Some(args) = node.child_by_field_name("arguments") {
            let mut string_node: Option<Node> = None;
            for i in 0..args.named_child_count() {
              if let Some(c) = args.named_child(i) {
                if c.kind() == "string" || c.kind() == "argument_list" {
                  string_node = Some(c);
                  break;
                }
              }
            }
            let target = string_node.and_then(|sn| {
              if sn.kind() == "string" {
                Some(sn)
              } else {
                (0..sn.named_child_count()).find_map(|i| {
                  sn.named_child(i).filter(|c| c.kind() == "string")
                })
              }
            });
            if let Some(t) = target {
              // JS: text.replace(/^['"]|['"]$/g, "") — strip at most one
              // leading and one trailing quote character.
              let text = text_of(&t, source);
              let bytes = text.as_bytes();
              let start =
                if !bytes.is_empty() && (bytes[0] == b'\'' || bytes[0] == b'"') {
                  1
                } else {
                  0
                };
              let end = if bytes.len() > start
                && (bytes[bytes.len() - 1] == b'\'' || bytes[bytes.len() - 1] == b'"')
              {
                bytes.len() - 1
              } else {
                bytes.len()
              };
              let stripped = &text[start..end];
              if !stripped.is_empty() {
                paths.push(stripped.to_string());
              }
            }
          }
        }
      }
    }
    _ => {}
  }

  paths
}

// ── Main walk ──

fn walk_tree(
  root: Node,
  config: &LanguageConfig,
  source: &[u8],
  language: &str,
) -> NativeParseResult {
  let mut symbols: Vec<NativeSymbol> = Vec::new();
  let mut import_paths: Vec<String> = Vec::new();
  let mut called_identifiers: HashSet<String> = HashSet::new();
  let mut call_expressions: Vec<NativeCallExpression> = Vec::new();

  // Context stack for nested symbol naming.
  // Carries optional receiver (var_name, type_name) for Go methods so calls
  // through the receiver variable can be qualified as Type::method, plus an
  // optional ContextKind for Ruby class/module frames.
  let mut context_stack: Vec<ContextFrame> = Vec::new();

  // Build lookup maps
  let symbol_rule_map: Vec<(&str, &SymbolRule)> = config
    .symbol_rules
    .iter()
    .map(|r| (r.node_type, r))
    .collect();
  let import_type_set: HashSet<&str> = config.import_node_types.iter().copied().collect();
  let context_type_set: HashSet<&str> = config.context_node_types.iter().copied().collect();

  // DFS with explicit stack
  let mut stack: Vec<Node> = vec![root];

  while let Some(node) = stack.pop() {
    let start_row = node.start_position().row + 1; // 1-based
    let end_row = node.end_position().row + 1;

    // Pop expired contexts — byte-position comparison so siblings that
    // start on the same row the previous context ended on still pop it.
    let start_byte = node.start_byte();
    while let Some(frame) = context_stack.last() {
      if start_byte >= frame.end_byte {
        context_stack.pop();
      } else {
        break;
      }
    }

    let node_kind = node.kind();

    // Check for import
    if import_type_set.contains(node_kind) {
      let paths = extract_imports(&node, source, language);
      import_paths.extend(paths);
    }

    // Check for Python decorated_definition — extract decorator call edges
    // linking the inner function/class to each decorator name.
    if node_kind == "decorated_definition" {
      // Find the inner definition (function_definition or class_definition)
      let mut inner_name: Option<String> = None;
      for i in 0..node.named_child_count() {
        if let Some(child) = node.named_child(i) {
          let child_kind = child.kind();
          if child_kind == "function_definition" || child_kind == "class_definition" {
            if let Some(name_node) = child.child_by_field_name("name") {
              let raw_name = text_of(&name_node, source);
              let parent_name = context_stack.last().map(|f| f.name.clone());
              inner_name = Some(
                parent_name
                  .map(|p| format!("{}::{}", p, raw_name))
                  .unwrap_or(raw_name),
              );
            }
            break;
          }
        }
      }

      // Extract decorator names and create call edges
      if let Some(ref def_name) = inner_name {
        for i in 0..node.named_child_count() {
          if let Some(child) = node.named_child(i) {
            if child.kind() != "decorator" {
              continue;
            }
            // Decorator contains an expression: identifier, attribute, or call
            if let Some(expr) = child.named_child(0) {
              let dec_name = match expr.kind() {
                "call" => {
                  // @app.route("/api") → extract function name
                  if let Some(func_node) = expr.child_by_field_name("function") {
                    let raw = text_of(&func_node, source);
                    let normalized = (config.normalize_call_name)(&raw);
                    Some(normalized)
                  } else {
                    None
                  }
                }
                _ => {
                  // @lru_cache or @app.route → normalize the expression text
                  let raw = text_of(&expr, source);
                  let normalized = (config.normalize_call_name)(&raw);
                  Some(normalized)
                }
              };
              if let Some(dec) = dec_name {
                let dec_id = if config.keep_qualified_calls {
                  last_rust_call_segment(&dec).to_string()
                } else {
                  dec.clone()
                };
                if !dec.is_empty()
                  && !config.call_ignores.contains(dec.as_str())
                  && !config.call_ignores.contains(dec_id.as_str())
                  && dec != *def_name
                {
                  called_identifiers.insert(dec_id);
                  call_expressions.push(NativeCallExpression {
                    caller_name: def_name.clone(),
                    callee_name: dec,
                  });
                }
              }
            }
          }
        }
      }
    }

    // Go const/var specs: each identifier in the spec's identifier_list is a
    // package-level symbol. Specs inside a function body (non-empty context
    // stack) and the blank identifier are not graph symbols.
    if language == "go" && (node_kind == "const_spec" || node_kind == "var_spec") {
      if context_stack.is_empty() {
        // `name` maps to every identifier in the (hidden) identifier_list.
        let mut cursor = node.walk();
        for ident in node.children_by_field_name("name", &mut cursor) {
          if ident.kind() != "identifier" {
            continue;
          }
          let name = text_of(&ident, source);
          if name == "_" {
            continue;
          }
          let sym_type = if node_kind == "const_spec" { "const" } else { "var" };
          symbols.push(NativeSymbol {
            exported: go_exported(&name, ""),
            name,
            symbol_type: sym_type.to_string(),
            start_line: start_row as i32,
            end_line: end_row as i32,
            receiver: None,
          });
        }
      }
    } else if let Some((_, rule)) = symbol_rule_map.iter().find(|(t, _)| *t == node_kind) {
      if rule.context_only {
        // Context-only rules (Ruby `class << self`) push a plain context
        // frame when extractContextName resolves — no symbol, no calls.
        if let Some(extract_ctx) = rule.extract_context_name {
          if let Some(context_name) = extract_ctx(&node, source, &context_stack) {
            context_stack.push(ContextFrame {
              name: context_name,
              end_byte: node.end_byte(),
              kind: rule.context_kind,
              receiver: None,
            });
          }
        }
      } else {
        let name = if let Some(extract) = rule.extract_name {
          extract(&node, source)
        } else {
          get_node_name(&node, rule.name_field, source)
        };

        if let Some(name) = name {
          let parent_name = context_stack.last().map(|f| f.name.clone());

        // Extract receiver info for Go methods
        let receiver_raw = rule.receiver_field.and_then(|field| {
          node.child_by_field_name(field).map(|r| text_of(&r, source))
        });
        let receiver_type = receiver_raw.as_deref().and_then(go_receiver_type);
        let receiver_var = receiver_raw.as_deref().and_then(go_receiver_name);

        // Qualify method name with receiver type: Save → Foo::Save
        // This prevents same-named methods on different types from colliding.
        let full_name = if let Some(ref rt) = receiver_type {
          format!("{}::{}", rt, name)
        } else {
          parent_name
            .map(|p| format!("{}::{}", p, name))
            .unwrap_or_else(|| name.clone())
        };

        let node_text_20 = text_first_n(&node, source, 20);
        let exported = (rule.is_exported)(&name, &node_text_20);

        let receiver = receiver_raw.as_deref().map(|raw| {
          if let Some(normalize) = rule.normalize_receiver {
            normalize(raw)
          } else {
            raw.to_string()
          }
        });

        let sym_type = rule
          .symbol_type_fn
          .map(|f| f(&node, source, &context_stack))
          .unwrap_or(rule.symbol_type);
        symbols.push(NativeSymbol {
          name: full_name.clone(),
          symbol_type: sym_type.to_string(),
          exported,
          start_line: start_row as i32,
          end_line: end_row as i32,
          receiver,
        });

          // Push context if this node establishes one.
          // The context stack top is the innermost symbol — calls encountered
          // while this is on top belong to this symbol.
          let is_context = rule.establishes_context || context_type_set.contains(node_kind);
          let context_name: Option<String> = if is_context {
            Some(
              rule
                .extract_context_name
                .and_then(|extract_ctx| extract_ctx(&node, source, &context_stack))
                .unwrap_or_else(|| full_name.clone()),
            )
          } else {
            None
          };

          // WASM extractCallsInNode parity for configs that opt in (Ruby):
          // attribute the call descendants of this symbol's subtree to it,
          // skipping nested symbol ranges. Go/Python/Rust keep DFS-frame
          // attribution in the call branch below.
          if config.per_symbol_calls {
            let call_context: Vec<ContextFrame> =
              if context_name.is_some() && rule.context_kind.is_some() {
                let mut v = context_stack.clone();
                v.push(ContextFrame {
                  name: context_name.clone().unwrap(),
                  end_byte: node.end_byte(),
                  kind: rule.context_kind,
                  receiver: None,
                });
                v
              } else {
                context_stack.clone()
              };
            extract_calls_in_node(
              &node,
              config,
              &full_name,
              &mut called_identifiers,
              &mut call_expressions,
              &call_context,
              source,
            );
          }

          if is_context {
            // Carry receiver (var, type) so calls through the receiver variable
            // can be qualified as Type::method.
            let ctx_receiver = receiver_type
              .as_ref()
              .and_then(|rt| receiver_var.as_ref().map(|rv| (rv.clone(), rt.clone())));
            context_stack.push(ContextFrame {
              name: context_name.unwrap_or_else(|| full_name.clone()),
              end_byte: node.end_byte(),
              kind: rule.context_kind,
              receiver: ctx_receiver,
            });
          }
        }
      }
    } else if node_kind == config.call_node_type
      || (language == "go" && node_kind == "type_conversion_expression")
    {
      // Call node — assign to current context (innermost symbol). A Go
      // type_conversion_expression only counts as a call when its type is a
      // generic instantiation (Map[int](x) → callee Map); real conversions
      // like int(x) keep producing no call.
      let func_node = if node_kind == "type_conversion_expression" {
        node
          .child_by_field_name("type")
          .filter(|t| t.kind() == "generic_type")
      } else {
        node.child_by_field_name(config.call_function_field)
      };
      if let Some(func_node) = func_node {
        let callee_raw = text_of(&func_node, source);
        let normalized = (config.normalize_call_name)(&callee_raw);

        // Qualify calls through the receiver variable: f.Validate() → Foo::Validate
        // This matches the TS parser behavior and prevents call edges from
        // targeting the wrong same-named method on a different type.
        let qualified_callee = if let Some((rv, rt)) =
          context_stack.last().and_then(|f| f.receiver.as_ref())
        {
          if callee_raw.starts_with(&format!("{}.", rv)) {
            // Method name is the last selector segment: n.next.Traverse()
            // on receiver n *Node qualifies as Node::Traverse.
            let method = normalized.rsplit('.').next().unwrap_or(&normalized);
            format!("{}::{}", rt, method)
          } else {
            normalized.clone()
          }
        } else {
          normalized.clone()
        };

        // Last path segment of the normalized callee; splits on '.' and ':'
        // so Rust `crate::util::run` records `run` as the called identifier.
        let last_segment = || last_rust_call_segment(&normalized);
        if !normalized.is_empty()
          && !config.call_ignores.contains(callee_raw.as_str())
          && !config.call_ignores.contains(normalized.as_str())
          && (!config.keep_qualified_calls || !config.call_ignores.contains(last_segment()))
        {
          // Qualified callees (Python pkg.func/self.m) keep the qualifier in
          // call_expressions; called_identifiers record the last segment only.
          called_identifiers.insert(if config.keep_qualified_calls {
            last_segment().to_string()
          } else {
            qualified_callee.clone()
          });
          // per_symbol_calls configs (Ruby) attribute edges in
          // extract_calls_in_node — this DFS branch tracks identifiers only,
          // matching parse.ts's walkTree.
          if !config.per_symbol_calls {
            if let Some(caller) = context_stack.last().map(|f| f.name.clone()) {
              if qualified_callee != caller {
                call_expressions.push(NativeCallExpression {
                  caller_name: caller,
                  callee_name: qualified_callee,
                });
              }
            }
          }
        }
      }
    }

    // Push children in reverse order for DFS left-to-right
    let child_count = node.named_child_count();
    for i in (0..child_count).rev() {
      if let Some(child) = node.named_child(i) {
        stack.push(child);
      }
    }
  }

  // WASM parse.ts wraps importPaths in `new Set` — dedupe here the same way
  // (first-occurrence order preserved) so native/WASM agree on repeats.
  let mut seen_imports: HashSet<String> = HashSet::new();
  import_paths.retain(|p| seen_imports.insert(p.clone()));

  NativeParseResult {
    symbols,
    import_paths,
    called_identifiers: called_identifiers.into_iter().collect(),
    call_expressions,
  }
}

/// Pre-order (document-order) descendants of `node` whose kind is in `kinds`,
/// mirroring web-tree-sitter's descendantsOfType for named node kinds.
fn collect_descendants<'a>(node: &Node<'a>, kinds: &HashSet<&str>) -> Vec<Node<'a>> {
  let mut out = Vec::new();
  let mut stack: Vec<Node<'a>> = Vec::new();
  for i in (0..node.named_child_count()).rev() {
    if let Some(c) = node.named_child(i) {
      stack.push(c);
    }
  }
  while let Some(n) = stack.pop() {
    if kinds.contains(n.kind()) {
      out.push(n);
    }
    for i in (0..n.named_child_count()).rev() {
      if let Some(c) = n.named_child(i) {
        stack.push(c);
      }
    }
  }
  out
}

/// Port of extractCallsInNode in parse.ts: attribute every call descendant of
/// `symbol_node` to `caller_name`, skipping calls inside nested symbol ranges
/// (contextOnly nodes always count as boundaries; other rules count when they
/// produce a symbol name). Used only by per_symbol_calls configs — Ruby —
/// where Go receiverInfo / keepQualifiedCallee have no equivalents.
fn extract_calls_in_node(
  symbol_node: &Node,
  config: &LanguageConfig,
  caller_name: &str,
  called_identifiers: &mut HashSet<String>,
  call_expressions: &mut Vec<NativeCallExpression>,
  context_stack: &[ContextFrame],
  source: &[u8],
) {
  let rule_kinds: HashSet<&str> = config.symbol_rules.iter().map(|r| r.node_type).collect();
  let rule_map: HashMap<&str, &SymbolRule> =
    config.symbol_rules.iter().map(|r| (r.node_type, r)).collect();

  let nested_ranges: Vec<(usize, usize)> = collect_descendants(symbol_node, &rule_kinds)
    .into_iter()
    .filter(|n| {
      if n.start_byte() == symbol_node.start_byte() && n.end_byte() == symbol_node.end_byte() {
        return false;
      }
      let rule = match rule_map.get(n.kind()) {
        Some(r) => *r,
        None => return false,
      };
      if rule.context_only {
        return true;
      }
      match rule.extract_name {
        Some(extract) => extract(n, source).is_some(),
        None => get_node_name(n, rule.name_field, source).is_some(),
      }
    })
    .map(|n| (n.start_byte(), n.end_byte()))
    .collect();

  let call_kinds: HashSet<&str> = [config.call_node_type].into_iter().collect();
  for call_node in collect_descendants(symbol_node, &call_kinds) {
    let inside_nested = nested_ranges
      .iter()
      .any(|(s, e)| call_node.start_byte() >= *s && call_node.end_byte() <= *e);
    if inside_nested {
      continue;
    }
    let func_node = match call_node.child_by_field_name(config.call_function_field) {
      Some(f) => f,
      None => continue,
    };
    let callee_raw = text_of(&func_node, source);
    let normalized = (config.normalize_call_name)(&callee_raw);
    let final_callee = config
      .qualify_call
      .and_then(|f| f(&call_node, source, &callee_raw, &normalized, context_stack))
      .unwrap_or_else(|| normalized.clone());

    if normalized.is_empty()
      || final_callee.is_empty()
      || config.call_ignores.contains(callee_raw.as_str())
      || config.call_ignores.contains(normalized.as_str())
      || final_callee == caller_name
    {
      continue;
    }
    // keepQualifiedCallee parity with parse.ts extractCallsInNode: record
    // the last path segment as the called identifier for C++ (Ruby keeps
    // the full name via keep_qualified_calls = false).
    called_identifiers.insert(if config.keep_qualified_calls {
      last_rust_call_segment(&final_callee).to_string()
    } else {
      final_callee.clone()
    });
    call_expressions.push(NativeCallExpression {
      caller_name: caller_name.to_string(),
      callee_name: final_callee,
    });
  }
}

// ── Language detection from config ──

fn get_config(language: &str) -> Option<LanguageConfig> {
  match language {
    "python" => Some(python_config()),
    "go" => Some(go_config()),
    "rust" => Some(rust_config()),
    "ruby" => Some(ruby_config()),
    "cpp" => Some(cpp_config(false)),
    // `.h` strict header mode: any syntax error rejects the parse so the
    // file falls back to generic chunks with no graph records.
    "cpp-header" => Some(cpp_config(true)),
    _ => None,
  }
}

fn get_language_fn(language: &str) -> Option<tree_sitter::Language> {
  match language {
    "python" => Some(tree_sitter_python::LANGUAGE.into()),
    "go" => Some(tree_sitter_go::LANGUAGE.into()),
    "rust" => Some(tree_sitter_rust::LANGUAGE.into()),
    "ruby" => Some(tree_sitter_ruby::LANGUAGE.into()),
    "cpp" | "cpp-header" => Some(tree_sitter_cpp::LANGUAGE.into()),
    _ => None,
  }
}

// ── Parser cache (thread-local) ──

use std::cell::RefCell;
use rayon::prelude::*;

thread_local! {
  static PARSER_CACHE: RefCell<std::collections::HashMap<String, Parser>> = RefCell::new(std::collections::HashMap::new());
}

#[napi(object)]
pub struct ParseBatchItem {
  pub language: String,
  pub content: String,
}

// ── Public NAPI functions ──

#[napi]
pub fn parse_code_native(language: String, content: String) -> Option<NativeParseResult> {
  let config = get_config(&language)?;
  let lang = get_language_fn(&language)?;

  let tree = PARSER_CACHE.with(|cache| {
    let mut cache = cache.borrow_mut();
    let parser = cache.entry(language.clone()).or_insert_with(|| {
      let mut p = Parser::new();
      p.set_language(&lang).ok();
      p
    });
    parser.parse(content.as_bytes(), None)
  })?;

  if config.error_fails_parse && tree.root_node().has_error() {
    return None;
  }

  let source = content.as_bytes();
  let result = walk_tree(tree.root_node(), &config, source, &language);

  if result.symbols.is_empty() && result.import_paths.is_empty() {
    return None;
  }

  Some(result)
}

/// Batch parse — parses all files in parallel using rayon.
/// Returns results in the same order as input. null entries = parse failed/empty.
#[napi]
pub fn parse_code_batch(items: Vec<ParseBatchItem>) -> Vec<Option<NativeParseResult>> {
  items
    .par_iter()
    .map(|item| {
      let config = match get_config(&item.language) {
        Some(c) => c,
        None => return None,
      };
      let lang = match get_language_fn(&item.language) {
        Some(l) => l,
        None => return None,
      };

      // Each rayon thread gets its own parser via thread_local
      let tree = PARSER_CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        let parser = cache.entry(item.language.clone()).or_insert_with(|| {
          let mut p = Parser::new();
          p.set_language(&lang).ok();
          p
        });
        parser.parse(item.content.as_bytes(), None)
      })?;

      if config.error_fails_parse && tree.root_node().has_error() {
        return None;
      }

      let source = item.content.as_bytes();
      let result = walk_tree(tree.root_node(), &config, source, &item.language);

      if result.symbols.is_empty() && result.import_paths.is_empty() {
        return None;
      }

      Some(result)
    })
    .collect()
}

/// Batch parse + chunk — parses all files in parallel and creates 80-line chunks.
/// Returns results in the same order as input. null entries = parse failed/empty.
/// During indexing, only chunks are needed — symbols/calls are extracted lazily during graph build.
#[napi]
pub fn parse_and_chunk_batch(items: Vec<ParseBatchItem>) -> Vec<Option<NativeParseAndChunkResult>> {
  items
    .par_iter()
    .map(|item| {
      // Build 80-line chunks — no AST parse needed for indexing
      let lines: Vec<&str> = item.content.split('\n').collect();
      let mut chunks: Vec<NativeChunk> = Vec::new();
      let mut ci = 0;
      while ci < lines.len() {
        let end = std::cmp::min(ci + 80, lines.len());
        let slice = lines[ci..end].join("\n");
        let trimmed = slice.trim();
        if !trimmed.is_empty() {
          chunks.push(NativeChunk {
            content: trimmed.to_string(),
            start_line: (ci + 1) as i32,
            end_line: end as i32,
          });
        }
        ci += 80;
      }

      if chunks.is_empty() {
        return None;
      }

      Some(NativeParseAndChunkResult {
        symbols: Vec::new(),
        import_paths: Vec::new(),
        called_identifiers: Vec::new(),
        call_expressions: Vec::new(),
        chunks,
      })
    })
    .collect()
}
