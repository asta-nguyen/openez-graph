use oxc_allocator::Allocator;
use oxc_ast::ast::*;
use oxc_parser::Parser;
use oxc_span::{SourceType, Span};

use crate::parser::{NativeCallExpression, NativeParseResult, NativeSymbol};

struct LineIndex {
  newlines: Vec<usize>,
}

impl LineIndex {
  fn new(source: &str) -> Self {
    let mut newlines = Vec::new();
    for (i, b) in source.bytes().enumerate() {
      if b == b'\n' {
        newlines.push(i);
      }
    }
    Self { newlines }
  }

  fn offset_to_line(&self, offset: usize) -> i32 {
    match self.newlines.binary_search(&offset) {
      Ok(line_idx) => (line_idx + 1) as i32,
      Err(line_idx) => (line_idx + 1) as i32,
    }
  }

  fn span_to_lines(&self, span: Span) -> (i32, i32) {
    let start = self.offset_to_line(span.start as usize);
    let end = self.offset_to_line(span.end as usize);
    (start, end.max(start))
  }
}

pub fn parse_ts_js(content: &str, language: &str) -> Option<NativeParseResult> {
  let allocator = Allocator::default();
  let source_type = match language {
    "tsx" => SourceType::tsx(),
    "typescript" => SourceType::ts(),
    "jsx" => SourceType::jsx(),
    _ => SourceType::mjs(),
  };

  let parser = Parser::new(&allocator, content, source_type);
  let parsed = parser.parse();

  let line_index = LineIndex::new(content);

  let mut symbols = Vec::new();
  let mut import_paths = Vec::new();
  let mut called_identifiers = Vec::new();
  let mut call_expressions = Vec::new();

  for stmt in &parsed.program.body {
    extract_statement(
      stmt,
      &line_index,
      false,
      None,
      &mut symbols,
      &mut import_paths,
      &mut called_identifiers,
      &mut call_expressions,
    );
  }

  if symbols.is_empty() && import_paths.is_empty() && called_identifiers.is_empty() {
    return None;
  }

  Some(NativeParseResult {
    symbols,
    import_paths,
    called_identifiers,
    call_expressions,
  })
}

fn extract_statement<'a>(
  stmt: &Statement<'a>,
  lines: &LineIndex,
  is_exported: bool,
  current_caller: Option<&str>,
  symbols: &mut Vec<NativeSymbol>,
  import_paths: &mut Vec<String>,
  called_identifiers: &mut Vec<String>,
  call_expressions: &mut Vec<NativeCallExpression>,
) {
  match stmt {
    Statement::ImportDeclaration(import_decl) => {
      let path = import_decl.source.value.as_str().to_string();
      if !path.is_empty() {
        import_paths.push(path);
      }
    }
    Statement::ExportDefaultDeclaration(export_decl) => {
      match &export_decl.declaration {
        ExportDefaultDeclarationKind::FunctionDeclaration(func) => {
          extract_function(
            func,
            lines,
            true,
            current_caller,
            symbols,
            called_identifiers,
            call_expressions,
          );
        }
        ExportDefaultDeclarationKind::ClassDeclaration(class_decl) => {
          extract_class(
            class_decl,
            lines,
            true,
            symbols,
            called_identifiers,
            call_expressions,
          );
        }
        _ => {}
      }
    }
    Statement::FunctionDeclaration(func) => {
      extract_function(
        func,
        lines,
        is_exported,
        current_caller,
        symbols,
        called_identifiers,
        call_expressions,
      );
    }
    Statement::ClassDeclaration(class_decl) => {
      extract_class(
        class_decl,
        lines,
        is_exported,
        symbols,
        called_identifiers,
        call_expressions,
      );
    }
    Statement::VariableDeclaration(var_decl) => {
      extract_variable_declaration(
        var_decl,
        lines,
        is_exported,
        current_caller,
        symbols,
        called_identifiers,
        call_expressions,
      );
    }
    Statement::TSTypeAliasDeclaration(t) => {
      let (start_line, end_line) = lines.span_to_lines(t.span);
      symbols.push(NativeSymbol {
        name: t.id.name.as_str().to_string(),
        symbol_type: "type_alias".to_string(),
        exported: is_exported,
        start_line,
        end_line,
        receiver: None,
      });
    }
    Statement::TSInterfaceDeclaration(i) => {
      let (start_line, end_line) = lines.span_to_lines(i.span);
      symbols.push(NativeSymbol {
        name: i.id.name.as_str().to_string(),
        symbol_type: "interface".to_string(),
        exported: is_exported,
        start_line,
        end_line,
        receiver: None,
      });
    }
    Statement::TSEnumDeclaration(e) => {
      let (start_line, end_line) = lines.span_to_lines(e.span);
      symbols.push(NativeSymbol {
        name: e.id.name.as_str().to_string(),
        symbol_type: "enum".to_string(),
        exported: is_exported,
        start_line,
        end_line,
        receiver: None,
      });
    }
    _ => {
      extract_calls_from_statement(stmt, current_caller, called_identifiers, call_expressions);
    }
  }
}

fn extract_function<'a>(
  func: &Function<'a>,
  lines: &LineIndex,
  is_exported: bool,
  _current_caller: Option<&str>,
  symbols: &mut Vec<NativeSymbol>,
  called_identifiers: &mut Vec<String>,
  call_expressions: &mut Vec<NativeCallExpression>,
) {
  let name = func
    .id
    .as_ref()
    .map(|id| id.name.as_str().to_string())
    .unwrap_or_else(|| "default".to_string());

  let (start_line, end_line) = lines.span_to_lines(func.span);
  symbols.push(NativeSymbol {
    name: name.clone(),
    symbol_type: "function".to_string(),
    exported: is_exported,
    start_line,
    end_line,
    receiver: None,
  });

  if let Some(ref body) = func.body {
    for stmt in &body.statements {
      extract_calls_from_statement(stmt, Some(&name), called_identifiers, call_expressions);
    }
  }
}

fn extract_class<'a>(
  class_decl: &Class<'a>,
  lines: &LineIndex,
  is_exported: bool,
  symbols: &mut Vec<NativeSymbol>,
  called_identifiers: &mut Vec<String>,
  call_expressions: &mut Vec<NativeCallExpression>,
) {
  let class_name = class_decl
    .id
    .as_ref()
    .map(|id| id.name.as_str().to_string())
    .unwrap_or_else(|| "AnonymousClass".to_string());

  let (start_line, end_line) = lines.span_to_lines(class_decl.span);
  symbols.push(NativeSymbol {
    name: class_name.clone(),
    symbol_type: "class".to_string(),
    exported: is_exported,
    start_line,
    end_line,
    receiver: None,
  });

  for element in &class_decl.body.body {
    match element {
      ClassElement::MethodDefinition(method) => {
        let method_name = match &method.key {
          PropertyKey::StaticIdentifier(id) => id.name.as_str().to_string(),
          PropertyKey::Identifier(id) => id.name.as_str().to_string(),
          _ => continue,
        };
        let (m_start, m_end) = lines.span_to_lines(method.span);
        symbols.push(NativeSymbol {
          name: method_name.clone(),
          symbol_type: "method".to_string(),
          exported: is_exported,
          start_line: m_start,
          end_line: m_end,
          receiver: Some(class_name.clone()),
        });
        if let Some(ref body) = method.value.body {
          let caller = format!("{}.{}", class_name, method_name);
          for stmt in &body.statements {
            extract_calls_from_statement(stmt, Some(&caller), called_identifiers, call_expressions);
          }
        }
      }
      _ => {}
    }
  }
}

fn extract_variable_declaration<'a>(
  var_decl: &VariableDeclaration<'a>,
  lines: &LineIndex,
  is_exported: bool,
  current_caller: Option<&str>,
  symbols: &mut Vec<NativeSymbol>,
  called_identifiers: &mut Vec<String>,
  call_expressions: &mut Vec<NativeCallExpression>,
) {
  for decl in &var_decl.declarations {
    if let Some(id) = decl.id.get_binding_identifier() {
      let name = id.name.as_str().to_string();
      if let Some(ref init) = decl.init {
        match init {
          Expression::ArrowFunctionExpression(arrow) => {
            let (start_line, end_line) = lines.span_to_lines(decl.span);
            symbols.push(NativeSymbol {
              name: name.clone(),
              symbol_type: "function".to_string(),
              exported: is_exported,
              start_line,
              end_line,
              receiver: None,
            });
            let _ = arrow.body.is_empty();
          }
          Expression::FunctionExpression(func) => {
            let (start_line, end_line) = lines.span_to_lines(decl.span);
            symbols.push(NativeSymbol {
              name: name.clone(),
              symbol_type: "function".to_string(),
              exported: is_exported,
              start_line,
              end_line,
              receiver: None,
            });
            if let Some(ref body) = func.body {
              for stmt in &body.statements {
                extract_calls_from_statement(stmt, Some(&name), called_identifiers, call_expressions);
              }
            }
          }
          _ => {
            extract_calls_from_expression(init, current_caller, called_identifiers, call_expressions);
          }
        }
      }
    }
  }
}

fn extract_calls_from_statement<'a>(
  stmt: &Statement<'a>,
  current_caller: Option<&str>,
  called_identifiers: &mut Vec<String>,
  call_expressions: &mut Vec<NativeCallExpression>,
) {
  match stmt {
    Statement::ExpressionStatement(expr_stmt) => {
      extract_calls_from_expression(&expr_stmt.expression, current_caller, called_identifiers, call_expressions);
    }
    Statement::BlockStatement(block) => {
      for s in &block.body {
        extract_calls_from_statement(s, current_caller, called_identifiers, call_expressions);
      }
    }
    Statement::ReturnStatement(ret) => {
      if let Some(ref arg) = ret.argument {
        extract_calls_from_expression(arg, current_caller, called_identifiers, call_expressions);
      }
    }
    Statement::IfStatement(if_stmt) => {
      extract_calls_from_expression(&if_stmt.test, current_caller, called_identifiers, call_expressions);
      extract_calls_from_statement(&if_stmt.consequent, current_caller, called_identifiers, call_expressions);
      if let Some(ref alt) = if_stmt.alternate {
        extract_calls_from_statement(alt, current_caller, called_identifiers, call_expressions);
      }
    }
    _ => {}
  }
}

fn extract_calls_from_expression<'a>(
  expr: &Expression<'a>,
  current_caller: Option<&str>,
  called_identifiers: &mut Vec<String>,
  call_expressions: &mut Vec<NativeCallExpression>,
) {
  match expr {
    Expression::CallExpression(call) => {
      let callee_name = match &call.callee {
        Expression::Identifier(id) => Some(id.name.as_str().to_string()),
        Expression::StaticMemberExpression(member) => Some(member.property.name.as_str().to_string()),
        _ => None,
      };

      if let Some(callee) = callee_name {
        if !called_identifiers.contains(&callee) {
          called_identifiers.push(callee.clone());
        }
        if let Some(caller) = current_caller {
          call_expressions.push(NativeCallExpression {
            caller_name: caller.to_string(),
            callee_name: callee,
          });
        }
      }

      for arg in &call.arguments {
        if let Argument::SpreadElement(spread) = arg {
          extract_calls_from_expression(&spread.argument, current_caller, called_identifiers, call_expressions);
        } else if let Some(expr) = arg.as_expression() {
          extract_calls_from_expression(expr, current_caller, called_identifiers, call_expressions);
        }
      }
    }
    Expression::AwaitExpression(aw) => {
      extract_calls_from_expression(&aw.argument, current_caller, called_identifiers, call_expressions);
    }
    _ => {}
  }
}
