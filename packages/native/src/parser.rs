use napi_derive::napi;
use std::collections::HashSet;
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

struct SymbolRule {
  node_type: &'static str,
  symbol_type: &'static str,
  name_field: &'static str,
  establishes_context: bool,
  /// (name, node_text_first_20) -> is_exported
  is_exported: fn(&str, &str) -> bool,
  /// For Rust impl_item: custom name extraction
  extract_name: Option<fn(&Node, &[u8]) -> Option<String>>,
  /// For Rust impl_item: context name (type name, not full "impl X for Y")
  extract_context_name: Option<fn(&Node, &[u8]) -> Option<String>>,
  /// For Go method_declaration: receiver field
  receiver_field: Option<&'static str>,
  /// Normalize receiver text (strip parens for Go)
  normalize_receiver: Option<fn(&str) -> String>,
}

struct LanguageConfig {
  symbol_rules: Vec<SymbolRule>,
  import_node_types: Vec<&'static str>,
  call_node_type: &'static str,
  call_function_field: &'static str,
  call_ignores: HashSet<&'static str>,
  normalize_call_name: fn(&str) -> String,
  context_node_types: Vec<&'static str>,
}

// ── Exported checks ──

fn always_false(_name: &str, _text: &str) -> bool {
  false
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

fn rust_impl_context_name(node: &Node, source: &[u8]) -> Option<String> {
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

fn normalize_dot_call(value: &str) -> String {
  value
    .split('.')
    .filter(|s| !s.is_empty())
    .last()
    .unwrap_or(value)
    .to_string()
}

fn normalize_rust_call(value: &str) -> String {
  let last_path = value.split("::").filter(|s| !s.is_empty()).last().unwrap_or(value);
  last_path
    .split('.')
    .filter(|s| !s.is_empty())
    .last()
    .unwrap_or(last_path)
    .to_string()
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
      },
    ],
    import_node_types: vec!["import_statement", "import_from_statement"],
    call_node_type: "call",
    call_function_field: "function",
    call_ignores,
    normalize_call_name: normalize_dot_call,
    context_node_types: vec!["function_definition", "class_definition"],
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
      },
    ],
    import_node_types: vec!["import_declaration"],
    call_node_type: "call_expression",
    call_function_field: "function",
    call_ignores,
    normalize_call_name: normalize_dot_call,
    context_node_types: vec!["function_declaration", "method_declaration"],
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
      },
    ],
    import_node_types: vec!["use_declaration"],
    call_node_type: "call_expression",
    call_function_field: "function",
    call_ignores,
    normalize_call_name: normalize_rust_call,
    context_node_types: vec!["function_item", "trait_item", "impl_item"],
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

        for i in 0..node.named_child_count() {
          if let Some(child) = node.named_child(i) {
            if child.start_byte() == module_start && child.end_byte() == module_end {
              continue;
            }
            match child.kind() {
              "dotted_name" => {
                if !module_path.is_empty() {
                  paths.push(format!("{}.{}", module_path, text_of(&child, source)));
                }
              }
              "aliased_import" => {
                if let Some(name_node) = child.child_by_field_name("name") {
                  if !module_path.is_empty() {
                    paths.push(format!("{}.{}", module_path, text_of(&name_node, source)));
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
  // through the receiver variable can be qualified as Type::method.
  let mut context_stack: Vec<(String, usize, Option<(String, String)>)> = Vec::new();

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

    // Pop expired contexts
    while let Some((_, ctx_end, _)) = context_stack.last() {
      if start_row > *ctx_end {
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
              let parent_name = context_stack.last().map(|(n, _, _)| n.clone());
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
                if !dec.is_empty()
                  && !config.call_ignores.contains(dec.as_str())
                  && dec != *def_name
                {
                  called_identifiers.insert(dec.clone());
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

    // Check for symbol
    if let Some((_, rule)) = symbol_rule_map.iter().find(|(t, _)| *t == node_kind) {
      let name = if let Some(extract) = rule.extract_name {
        extract(&node, source)
      } else {
        get_node_name(&node, rule.name_field, source)
      };

      if let Some(name) = name {
        let parent_name = context_stack.last().map(|(n, _, _)| n.clone());

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

        symbols.push(NativeSymbol {
          name: full_name.clone(),
          symbol_type: rule.symbol_type.to_string(),
          exported,
          start_line: start_row as i32,
          end_line: end_row as i32,
          receiver,
        });

        // Push context if this node establishes one.
        // The context stack top is the innermost symbol — calls encountered
        // while this is on top belong to this symbol.
        let is_context = rule.establishes_context || context_type_set.contains(node_kind);
        if is_context {
          let context_name = if let Some(extract_ctx) = rule.extract_context_name {
            extract_ctx(&node, source).unwrap_or(full_name.clone())
          } else {
            full_name.clone()
          };
          // Carry receiver (var, type) so calls through the receiver variable
          // can be qualified as Type::method.
          let ctx_receiver = receiver_type
            .as_ref()
            .and_then(|rt| receiver_var.as_ref().map(|rv| (rv.clone(), rt.clone())));
          context_stack.push((context_name, end_row, ctx_receiver));
        }
      }
    } else if node_kind == config.call_node_type {
      // Call node — assign to current context (innermost symbol)
      if let Some(func_node) = node.child_by_field_name(config.call_function_field) {
        let callee_raw = text_of(&func_node, source);
        let normalized = (config.normalize_call_name)(&callee_raw);

        // Qualify calls through the receiver variable: f.Validate() → Foo::Validate
        // This matches the TS parser behavior and prevents call edges from
        // targeting the wrong same-named method on a different type.
        let qualified_callee = if let Some((_, _, Some((rv, rt)))) = context_stack.last() {
          if callee_raw.starts_with(&format!("{}.", rv)) {
            format!("{}::{}", rt, normalized)
          } else {
            normalized.clone()
          }
        } else {
          normalized.clone()
        };

        if !normalized.is_empty()
          && !config.call_ignores.contains(callee_raw.as_str())
          && !config.call_ignores.contains(normalized.as_str())
        {
          called_identifiers.insert(qualified_callee.clone());
          if let Some((caller, _, _)) = context_stack.last() {
            if qualified_callee != *caller {
              call_expressions.push(NativeCallExpression {
                caller_name: caller.clone(),
                callee_name: qualified_callee,
              });
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

  NativeParseResult {
    symbols,
    import_paths,
    called_identifiers: called_identifiers.into_iter().collect(),
    call_expressions,
  }
}

// ── Language detection from config ──

fn get_config(language: &str) -> Option<LanguageConfig> {
  match language {
    "python" => Some(python_config()),
    "go" => Some(go_config()),
    "rust" => Some(rust_config()),
    _ => None,
  }
}

fn get_language_fn(language: &str) -> Option<tree_sitter::Language> {
  match language {
    "python" => Some(tree_sitter_python::LANGUAGE.into()),
    "go" => Some(tree_sitter_go::LANGUAGE.into()),
    "rust" => Some(tree_sitter_rust::LANGUAGE.into()),
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
  let lang_fn = get_language_fn(&language)?;

  let tree = PARSER_CACHE.with(|cache| {
    let mut cache = cache.borrow_mut();
    let parser = cache.entry(language.clone()).or_insert_with(|| {
      let mut p = Parser::new();
      p.set_language(&lang_fn).ok();
      p
    });
    parser.parse(content.as_bytes(), None)
  })?;

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
      let lang_fn = match get_language_fn(&item.language) {
        Some(l) => l,
        None => return None,
      };

      // Each rayon thread gets its own parser via thread_local
      let tree = PARSER_CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        let parser = cache.entry(item.language.clone()).or_insert_with(|| {
          let mut p = Parser::new();
          p.set_language(&lang_fn).ok();
          p
        });
        parser.parse(item.content.as_bytes(), None)
      })?;

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
