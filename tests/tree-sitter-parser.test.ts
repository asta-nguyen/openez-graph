import { describe, expect, it } from "bun:test";

import {
  goConfig,
  javaConfig,
  parseWithTreeSitter,
  pythonConfig,
  rubyConfig,
  rustConfig,
} from "../packages/indexer/src/tree-sitter";
import { TreeSitterParser } from "../packages/indexer/src/parsers";
import { fastTokenCounter } from "../packages/core/src/tokenizer";

// ── Python ──

describe("tree-sitter python parser", () => {
  it("extracts functions and classes with correct line ranges", async () => {
    const result = await parseWithTreeSitter(
      pythonConfig,
      [
        "import os",
        "from typing import List",
        "",
        "def hello(name: str) -> str:",
        '    return f"Hello, {name}"',
        "",
        "class Greeter:",
        "    def __init__(self, prefix: str):",
        "        self.prefix = prefix",
        "",
        "    def greet(self, name: str) -> str:",
        '        return hello(f"{self.prefix} {name}")',
        "",
        "def main():",
        '    g = Greeter("Dr.")',
        '    print(g.greet("Watson"))',
        "",
      ].join("\n"),
    );

    expect(result).not.toBeNull();
    const symbols = result!.definedSymbols.map((s) => s.name);
    expect(symbols).toEqual(["hello", "Greeter", "Greeter::__init__", "Greeter::greet", "main"]);

    const greeter = result!.definedSymbols.find((s) => s.name === "Greeter");
    expect(greeter?.symbolType).toBe("class");
    expect(greeter?.startLine).toBe(7);
    expect(greeter?.exported).toBe(true);

    const init = result!.definedSymbols.find((s) => s.name === "Greeter::__init__");
    expect(init?.symbolType).toBe("function");
    expect(init?.exported).toBe(false); // starts with _
  });

  it("extracts imports correctly", async () => {
    const result = await parseWithTreeSitter(
      pythonConfig,
      [
        "import os",
        "import sys as system",
        "from typing import List, Dict",
        "from .utils import helper",
        "",
        "def main():",
        "    pass",
      ].join("\n"),
    );

    expect(result!.importPaths).toEqual(
      expect.arrayContaining([
        "os",
        "sys",
        "typing",
        "typing.List",
        "typing.Dict",
        ".utils",
        ".utils.helper",
      ]),
    );
  });

  it("extracts call expressions without double-counting nested symbols", async () => {
    const result = await parseWithTreeSitter(
      pythonConfig,
      [
        "def helper():",
        "    return 42",
        "",
        "def caller():",
        "    return helper()",
        "",
        "class MyClass:",
        "    def method(self):",
        "        return helper()",
        "",
        "def main():",
        "    c = MyClass()",
        "    c.method()",
      ].join("\n"),
    );

    // caller calls helper
    expect(result!.callExpressions).toContainEqual({
      callerName: "caller",
      calleeName: "helper",
    });

    // method calls helper (not MyClass)
    expect(result!.callExpressions).toContainEqual({
      callerName: "MyClass::method",
      calleeName: "helper",
    });

    // main calls MyClass and method
    expect(result!.callExpressions).toContainEqual({
      callerName: "main",
      calleeName: "MyClass",
    });
    expect(result!.callExpressions).toContainEqual({
      callerName: "main",
      calleeName: "method",
    });

    // MyClass (class context) should NOT have its own call edges
    const classCalls = result!.callExpressions.filter((c) => c.callerName === "MyClass");
    expect(classCalls).toHaveLength(0);
  });

  it("handles syntax errors gracefully", async () => {
    const result = await parseWithTreeSitter(pythonConfig, "def broken(:\n    pass\n");

    // Should not throw; may return partial results or fallback chunks
    expect(result).not.toBeNull();
  });

  it("creates chunks for each symbol", async () => {
    const result = await parseWithTreeSitter(
      pythonConfig,
      ["def foo():", "    return 1", "", "def bar():", "    return 2"].join("\n"),
    );

    expect(result!.chunks.length).toBe(2);
    expect(result!.chunks[0].symbolName).toBe("foo");
    expect(result!.chunks[1].symbolName).toBe("bar");
  });

  it("uses the supplied fast counter for successful WASM parses", async () => {
    const source = [
      "def deliberately_long_function_name_with_many_words(argument_one, argument_two):",
      "    return argument_one + argument_two",
    ].join("\n");
    const result = await parseWithTreeSitter(pythonConfig, source, fastTokenCounter);

    expect(result).not.toBeNull();
    expect(result!.chunks[0]?.tokenCount).toBe(fastTokenCounter.count(result!.chunks[0]!.content));
  });
});

// ── Go ──

describe("tree-sitter go parser", () => {
  it("extracts functions, methods, and types", async () => {
    const result = await parseWithTreeSitter(
      goConfig,
      [
        "package main",
        "",
        'import "fmt"',
        "",
        "type Greeter struct {",
        "    prefix string",
        "}",
        "",
        "func greet(name string) string {",
        '    return fmt.Sprintf("Hello, %s", name)',
        "}",
        "",
        "func (g *Greeter) Greet(name string) string {",
        '    return greet(g.prefix + " " + name)',
        "}",
        "",
        "func main() {",
        '    g := &Greeter{prefix: "Dr."}',
        '    fmt.Println(g.Greet("Watson"))',
        "}",
      ].join("\n"),
    );

    expect(result).not.toBeNull();
    const symbols = result!.definedSymbols.map((s) => s.name);
    expect(symbols).toEqual(expect.arrayContaining(["greet", "Greeter", "Greeter::Greet", "main"]));

    const greeterType = result!.definedSymbols.find((s) => s.name === "Greeter");
    expect(greeterType?.symbolType).toBe("type");
    expect(greeterType?.exported).toBe(true);

    const greetMethod = result!.definedSymbols.find((s) => s.name === "Greeter::Greet");
    expect(greetMethod?.receiver).toBe("g *Greeter");
    expect(greetMethod?.exported).toBe(true);

    const greetFunc = result!.definedSymbols.find((s) => s.name === "greet");
    expect(greetFunc?.exported).toBe(false); // lowercase
  });

  it("extracts grouped and single imports", async () => {
    const result = await parseWithTreeSitter(
      goConfig,
      [
        "package main",
        "",
        "import (",
        '    "fmt"',
        '    "os"',
        '    "strings"',
        ")",
        "",
        "func main() {}",
      ].join("\n"),
    );

    expect(result!.importPaths).toEqual(expect.arrayContaining(["fmt", "os", "strings"]));
  });

  it("extracts call expressions", async () => {
    const result = await parseWithTreeSitter(
      goConfig,
      [
        "package main",
        "",
        "func process() {",
        '    readFile("test")',
        "    parseData(data)",
        "}",
        "",
        "func readFile(path string) {}",
        "func parseData(d []byte) {}",
      ].join("\n"),
    );

    expect(result!.callExpressions).toContainEqual({
      callerName: "process",
      calleeName: "readFile",
    });
    expect(result!.callExpressions).toContainEqual({
      callerName: "process",
      calleeName: "parseData",
    });
  });
});

// ── Rust ──

describe("tree-sitter rust parser", () => {
  it("extracts functions, structs, impls with correct nesting", async () => {
    const result = await parseWithTreeSitter(
      rustConfig,
      [
        "use std::collections::HashMap;",
        "",
        "pub fn greet(name: &str) -> String {",
        '    format!("Hello, {}", name)',
        "}",
        "",
        "pub struct Greeter {",
        "    prefix: String,",
        "}",
        "",
        "impl Greeter {",
        "    pub fn new(prefix: &str) -> Self {",
        "        Greeter { prefix: prefix.to_string() }",
        "    }",
        "",
        "    pub fn greet(&self, name: &str) -> String {",
        '        greet(&format!("{} {}", self.prefix, name))',
        "    }",
        "}",
      ].join("\n"),
    );

    expect(result).not.toBeNull();
    const symbols = result!.definedSymbols.map((s) => s.name);
    expect(symbols).toEqual(
      expect.arrayContaining([
        "greet",
        "Greeter",
        "impl Greeter",
        "Greeter::new",
        "Greeter::greet",
      ]),
    );

    const implSymbol = result!.definedSymbols.find((s) => s.name === "impl Greeter");
    expect(implSymbol?.symbolType).toBe("impl");

    const newMethod = result!.definedSymbols.find((s) => s.name === "Greeter::new");
    expect(newMethod?.symbolType).toBe("function");
    expect(newMethod?.exported).toBe(true);
  });

  it("extracts use declarations as imports", async () => {
    const result = await parseWithTreeSitter(
      rustConfig,
      ["use std::io::Read;", "use std::collections::{HashMap, BTreeMap};", "", "fn main() {}"].join(
        "\n",
      ),
    );

    expect(result!.importPaths).toEqual(
      expect.arrayContaining(["std::io::Read", "std::collections::{HashMap, BTreeMap}"]),
    );
  });

  it("extracts call expressions without impl-level double-counting", async () => {
    const result = await parseWithTreeSitter(
      rustConfig,
      [
        "pub fn helper() -> i32 { 42 }",
        "",
        "pub struct Foo;",
        "",
        "impl Foo {",
        "    pub fn bar(&self) -> i32 {",
        "        helper()",
        "    }",
        "}",
        "",
        "fn main() {",
        "    let f = Foo;",
        "    f.bar();",
        "}",
      ].join("\n"),
    );

    // bar calls helper
    expect(result!.callExpressions).toContainEqual({
      callerName: "Foo::bar",
      calleeName: "helper",
    });

    // main calls bar
    expect(result!.callExpressions).toContainEqual({
      callerName: "main",
      calleeName: "bar",
    });

    // impl Foo should NOT have its own call edges
    const implCalls = result!.callExpressions.filter((c) => c.callerName === "impl Foo");
    expect(implCalls).toHaveLength(0);
  });

  it("handles trait implementations", async () => {
    const result = await parseWithTreeSitter(
      rustConfig,
      [
        "pub trait Drawable {",
        "    fn draw(&self);",
        "}",
        "",
        "pub struct Circle {",
        "    radius: f64,",
        "}",
        "",
        "impl Drawable for Circle {",
        "    fn draw(&self) {",
        "        render(self.radius);",
        "    }",
        "}",
        "",
        "fn render(r: f64) {}",
      ].join("\n"),
    );

    const implSymbol = result!.definedSymbols.find((s) => s.name === "impl Drawable for Circle");
    expect(implSymbol).toBeDefined();
    expect(implSymbol?.symbolType).toBe("impl");

    // draw should be nested under the impl context
    const drawSymbol = result!.definedSymbols.find((s) => s.name === "Circle::draw");
    expect(drawSymbol).toBeDefined();
  });
});

// ── Ruby ──

describe("tree-sitter ruby parser", () => {
  it("extracts class, module, method, and singleton_method", async () => {
    const result = await parseWithTreeSitter(
      rubyConfig,
      [
        "module MyApp",
        "  class User",
        "    def greet(name)",
        '      puts "Hello"',
        "    end",
        "",
        "    def self.admin?",
        "      true",
        "    end",
        "  end",
        "end",
      ].join("\n"),
    );

    expect(result).not.toBeNull();
    const names = result!.definedSymbols.map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining(["MyApp", "MyApp::User", "MyApp::User::greet", "MyApp::User::admin?"]),
    );
  });

  it("class << self is context-only — no pseudo-symbol, methods nest under parent class", async () => {
    const result = await parseWithTreeSitter(
      rubyConfig,
      [
        "class User",
        "  def instance_method",
        "  end",
        "",
        "  class << self",
        "    def bulk_create",
        "    end",
        "  end",
        "end",
      ].join("\n"),
    );

    expect(result).not.toBeNull();
    const names = result!.definedSymbols.map((s) => s.name);
    // No <Class::User> pseudo-symbol
    expect(names).not.toContain("<Class::User>");
    expect(names).not.toContain("User::<Class::User>");
    // bulk_create nests under User, not under a pseudo class
    expect(names).toContain("User::bulk_create");
    expect(names).toContain("User::instance_method");
  });

  it("class << self nested in method walks back to class frame", async () => {
    const result = await parseWithTreeSitter(
      rubyConfig,
      [
        "class User",
        "  def setup",
        "    class << self",
        "      def dynamic_method",
        "      end",
        "    end",
        "  end",
        "end",
      ].join("\n"),
    );

    expect(result).not.toBeNull();
    const names = result!.definedSymbols.map((s) => s.name);
    // dynamic_method should nest under User, not under User::setup
    expect(names).toContain("User::dynamic_method");
    expect(names).not.toContain("User::setup::dynamic_method");
  });

  it("self.foo call qualification produces User::foo → User::bar edge", async () => {
    const result = await parseWithTreeSitter(
      rubyConfig,
      ["class User", "  def foo", "    self.bar", "  end", "", "  def bar", "  end", "end"].join(
        "\n",
      ),
    );

    expect(result).not.toBeNull();
    const edge = result!.callExpressions.find(
      (e) => e.callerName === "User::foo" && e.calleeName === "User::bar",
    );
    expect(edge).toBeDefined();
  });

  it("keeps calls in ordinary assignments attributed to the enclosing method", async () => {
    const result = await parseWithTreeSitter(
      rubyConfig,
      ["class User", "  def save(input)", "    result = parse(input)", "  end", "end"].join("\n"),
    );

    expect(result!.callExpressions).toContainEqual({
      callerName: "User::save",
      calleeName: "parse",
    });
  });

  it("qualifies self calls directly in a class body", async () => {
    const result = await parseWithTreeSitter(
      rubyConfig,
      ["class User", "  self.configure", "end"].join("\n"),
    );

    expect(result!.callExpressions).toContainEqual({
      callerName: "User",
      calleeName: "User::configure",
    });
  });

  it("extracts require_relative imports only", async () => {
    const result = await parseWithTreeSitter(
      rubyConfig,
      [
        'require "rails"',
        'require_relative "./user"',
        'load "helper.rb"',
        'autoload :Cache, "cache"',
        "",
        "class App",
        "end",
      ].join("\n"),
    );

    expect(result).not.toBeNull();
    expect(result!.importPaths).toEqual(["./user"]);
    expect(result!.importPaths).not.toContain("rails");
    expect(result!.importPaths).not.toContain("helper.rb");
    expect(result!.importPaths).not.toContain("cache");
  });

  it("extracts named lambda assignment", async () => {
    const result = await parseWithTreeSitter(
      rubyConfig,
      [
        "class Handler",
        "  handler = lambda { |x| x + 1 }",
        "  proc_var = proc { |x| x * 2 }",
        "end",
      ].join("\n"),
    );

    expect(result).not.toBeNull();
    const names = result!.definedSymbols.map((s) => s.name);
    expect(names).toContain("Handler::handler");
    expect(names).toContain("Handler::proc_var");
  });

  it("keeps calls inside named lambda assignments", async () => {
    const result = await parseWithTreeSitter(
      rubyConfig,
      ["class Handler", "  handler = lambda { custom_call() }", "end"].join("\n"),
    );

    expect(result!.callExpressions).toContainEqual({
      callerName: "Handler::handler",
      calleeName: "custom_call",
    });
  });
});

// ── Java ──

describe("tree-sitter java parser", () => {
  const fixture = [
    "package com.acme.service;",
    "",
    "import java.util.List;",
    "import com.acme.model.User;",
    "import static com.acme.util.Names.normalize;",
    "import com.acme.wildcard.*;",
    "",
    "public class UserService {",
    "  private final UserRepository repository;",
    "  protected int version, retries;",
    "",
    "  public UserService(UserRepository repository) {",
    "    this.repository = repository;",
    "  }",
    "",
    "  public User find(String id) {",
    '    // normalize("comment") must not become a call.',
    '    String sample = "orElseThrow()";',
    "    return repository.findById(normalize(id)).orElseThrow();",
    "  }",
    "",
    "  private void hidden() {}",
    "",
    "  public void save(String value) {}",
    "  public void save(int value) {}",
    "}",
    "",
    "interface Factory {",
    "  int MAX = 1;",
    "  User create();",
    "}",
    "",
    "enum Status { READY }",
    "",
    "record UserDto(String id) {",
    "  UserDto { }",
    "}",
    "",
    "@interface Audited {",
    "  String value();",
    "}",
  ].join("\n");

  it("extracts symbols, imports, calls, and chunks", async () => {
    const result = await parseWithTreeSitter(javaConfig, fixture);

    expect(result).not.toBeNull();
    expect(result!.chunks.length).toBeGreaterThan(0);
    expect(result!.importPaths).toEqual(
      expect.arrayContaining([
        "java.util.List",
        "com.acme.model.User",
        "static com.acme.util.Names.normalize",
        "com.acme.wildcard.*",
      ]),
    );

    const symbols = result!.definedSymbols;
    const expectedSymbols = [
      ["UserService", "class", true],
      ["UserService::repository", "field", false],
      ["UserService::version", "field", true],
      ["UserService::retries", "field", true],
      ["UserService::<constructor>", "constructor", true],
      ["UserService::find", "method", true],
      ["UserService::hidden", "method", false],
      ["Factory", "interface", false],
      ["Factory::MAX", "field", false],
      ["Factory::create", "method", false],
      ["Status", "enum", false],
      ["UserDto", "record", false],
      ["UserDto::<constructor>", "constructor", false],
      ["Audited", "annotation", false],
    ] as const;

    for (const [name, type, exported] of expectedSymbols) {
      expect(symbols).toContainEqual(expect.objectContaining({ name, symbolType: type, exported }));
    }
    expect(symbols.filter((symbol) => symbol.name === "UserService::save")).toHaveLength(2);
    expect(symbols.map((symbol) => symbol.name)).not.toContain("UserService::sample");
    expect(
      symbols
        .filter((symbol) => symbol.name === "UserService::save")
        .every((symbol) => symbol.symbolType === "method" && symbol.exported),
    ).toBe(true);

    const find = symbols.find((symbol) => symbol.name === "UserService::find");
    expect(find).toMatchObject({
      symbolType: "method",
      startLine: 16,
      endLine: 20,
    });
    expect(
      result!.chunks.find((chunk) => chunk.symbolName === "UserService::find")?.metadata,
    ).toMatchObject({
      language: "java",
      symbolName: "UserService::find",
      symbolType: "method",
    });

    expect(result!.callExpressions).toEqual(
      expect.arrayContaining([
        { callerName: "UserService::find", calleeName: "findById" },
        { callerName: "UserService::find", calleeName: "normalize" },
        { callerName: "UserService::find", calleeName: "orElseThrow" },
      ]),
    );
    expect(result!.callExpressions).not.toContainEqual({
      callerName: "UserService::find",
      calleeName: "comment",
    });
    expect(result!.callExpressions).not.toContainEqual({
      callerName: "UserService::find",
      calleeName: "sample",
    });
  });

  it("handles malformed Java without throwing", async () => {
    const result = await parseWithTreeSitter(
      javaConfig,
      "public class Broken { public void run( {",
    );

    expect(result).not.toBeNull();
    expect(result!.definedSymbols.length + result!.chunks.length).toBeGreaterThan(0);
  });
});

// ── Fallback behavior ──

describe("tree-sitter fallback", () => {
  it("keeps unknown-language fallback output empty", async () => {
    const result = await new TreeSitterParser().parse(
      {
        relativePath: "unknown.example",
        absolutePath: "/tmp/unknown.example",
        content: "class Broken {}\n",
        targetTokens: 500,
        overlapTokens: 50,
      },
      "nonexistent",
      "code",
    );

    expect(result.parser).toBe("regex");
    expect(result.chunks).toEqual([]);
    expect(result.definedSymbols).toEqual([]);
    expect(result.importPaths).toEqual([]);
    expect(result.callExpressions).toEqual([]);
  });

  it("returns null for unavailable grammar (non-existent language)", async () => {
    // Use a config with a language that doesn't have a grammar installed
    const result = await parseWithTreeSitter(
      { ...pythonConfig, language: "nonexistent" },
      "def foo(): pass\n",
    );
    expect(result).toBeNull();
  });
});
