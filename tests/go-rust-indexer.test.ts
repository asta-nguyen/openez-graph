import { describe, expect, it } from "bun:test";

import { parseGo, parseRust } from "../packages/indexer/src/languages";

describe("go indexing", () => {
  it("extracts grouped imports", () => {
    const result = parseGo(`
package main

import (
  "fmt"
  "os"
  "strings"
)

func main() {
  fmt.Println("hello")
}
`);
    expect(result.importPaths).toEqual(expect.arrayContaining(["fmt", "os", "strings"]));
  });

  it("extracts single import", () => {
    const result = parseGo(`
package main

import "net/http"

func handler() {}
`);
    expect(result.importPaths).toContain("net/http");
  });

  it("extracts aliased, blank, and dot imports", () => {
    const result = parseGo(`
package main
import api "example.com/api"
import _ "example.com/driver"
import . "example.com/helpers"
`);

    expect(result.importPaths).toEqual([
      "example.com/api",
      "example.com/driver",
      "example.com/helpers",
    ]);
  });

  it("extracts call expressions from function bodies", () => {
    const result = parseGo(`
package main

func process() {
  readFile("test")
  parseData(data)
  for i := 0; i < 10; i++ {
    handle(i)
  }
}

func readFile(path string) {}
func parseData(d []byte) {}
func handle(n int) {}
`);
    expect(result.calledIdentifiers).toEqual(
      expect.arrayContaining(["readFile", "parseData", "handle"]),
    );
    expect(result.calledIdentifiers).not.toContain("for");
    expect(result.callExpressions).toEqual(
      expect.arrayContaining([
        { callerName: "process", calleeName: "readFile" },
        { callerName: "process", calleeName: "parseData" },
        { callerName: "process", calleeName: "handle" },
      ]),
    );
  });

  it("extracts method receiver", () => {
    const result = parseGo(`
package main

type Server struct {
  addr string
}

func (s *Server) Start() {
  s.listen()
}

func (s *Server) listen() {}
`);
    const startSymbol = result.definedSymbols.find((s) => s.name === "Server::Start");
    expect(startSymbol).toBeDefined();
    expect(startSymbol?.receiver).toBe("s *Server");

    const listenSymbol = result.definedSymbols.find((s) => s.name === "Server::listen");
    expect(listenSymbol).toBeDefined();
    expect(listenSymbol?.receiver).toBe("s *Server");
    expect(result.callExpressions).toContainEqual({
      callerName: "Server::Start",
      calleeName: "Server::listen",
    });
  });

  it("ignores calls inside comments and strings", () => {
    const result = parseGo(`
package main
func real() {
  text := "fake_call()"
  // commented_call()
  /* block_call() */
  _ = text
}
`);

    expect(result.callExpressions).toEqual([]);
  });

  it("preserves package selectors and strips generic instantiation in call names", () => {
    const result = parseGo(`
package main

func main() {
  client.Do()
  net.Conn.Close()
  _ = Map[int](1)
  _ = pkg.F[int, string](1, "a")
}
`);
    expect(result.callExpressions).toEqual(
      expect.arrayContaining([
        { callerName: "main", calleeName: "client.Do" },
        { callerName: "main", calleeName: "net.Conn.Close" },
        { callerName: "main", calleeName: "Map" },
        { callerName: "main", calleeName: "pkg.F" },
      ]),
    );
  });

  it("extracts grouped and multi-name const/var at package level only", () => {
    const result = parseGo(`
package d

const (
	Alpha = 1
	Beta, Gamma = 2, 3
	_ = unused
)

var (
	sharedF = newF()
	sharedG, sharedH = g(), h()
)

var single, pair = f(), g()

func useG() {
	var inside = 1
	const alsoInside = 2
	_, _ = inside, alsoInside
}
`);
    const names = result.definedSymbols.map((s) => `${s.name}:${s.symbolType}`);
    expect(names).toEqual(
      expect.arrayContaining([
        "Alpha:const",
        "Beta:const",
        "Gamma:const",
        "sharedF:var",
        "sharedG:var",
        "sharedH:var",
        "single:var",
        "pair:var",
      ]),
    );
    expect(names).not.toContain("_:var");
    expect(names).not.toContain("inside:var");
    expect(names).not.toContain("alsoInside:const");
  });

  it("marks uppercase const/var names as exported", () => {
    const result = parseGo(`
package d

const Exported = 1
const unexported = 2
var ExportedVar = 3
var unexportedVar = 4
`);
    const byName = new Map(result.definedSymbols.map((s) => [s.name, s]));
    expect(byName.get("Exported")?.exported).toBe(true);
    expect(byName.get("unexported")?.exported).toBe(false);
    expect(byName.get("ExportedVar")?.exported).toBe(true);
    expect(byName.get("unexportedVar")?.exported).toBe(false);
  });

  it("extracts pointer and generic receivers", () => {
    const result = parseGo(`
package main

type Stack[T any] struct{ items []T }

func (s *Stack[T]) Push(item T) {}
func (s Stack[T]) Peek() T { return s.items[0] }
`);
    const names = result.definedSymbols.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(["Stack[T]::Push", "Stack[T]::Peek"]));
    const push = result.definedSymbols.find((s) => s.name === "Stack[T]::Push");
    expect(push?.receiver).toBe("s *Stack[T]");
  });

  it("includes searchText in chunk metadata", () => {
    const result = parseGo(`
func process_payment() {
  validate_order()
}
`);
    const chunk = result.chunks.find((c) => c.symbolName === "process_payment");
    expect(chunk).toBeDefined();
    expect(chunk?.metadata.searchText).toContain("process");
    expect(chunk?.metadata.searchText).toContain("payment");
    expect(chunk?.metadata.searchText).toContain("validate");
    expect(chunk?.metadata.searchText).toContain("order");
  });
});

describe("rust indexing", () => {
  it("extracts impl methods with type context", () => {
    const result = parseRust(`
pub struct Calculator {
  value: f64,
}

impl Calculator {
  pub fn add(&mut self, n: f64) -> f64 {
    self.value += n;
    self.value
  }

  fn reset(&mut self) {
    self.value = 0.0;
  }
}

fn main() {
  let mut calc = Calculator { value: 0.0 };
  calc.add(5.0);
}
`);
    const addSymbol = result.definedSymbols.find((s) => s.name === "Calculator::add");
    expect(addSymbol).toBeDefined();
    expect(addSymbol?.symbolType).toBe("function");

    const resetSymbol = result.definedSymbols.find((s) => s.name === "Calculator::reset");
    expect(resetSymbol).toBeDefined();

    const implSymbol = result.definedSymbols.find((s) => s.name === "impl Calculator");
    expect(implSymbol).toBeDefined();
    expect(implSymbol?.symbolType).toBe("impl");
  });

  it("extracts call expressions from function bodies", () => {
    const result = parseRust(`
fn process() {
  read_file("test")
  parse_data(data)
}

fn read_file(path: &str) {}
fn parse_data(d: &[u8]) {}
`);
    expect(result.calledIdentifiers).toEqual(expect.arrayContaining(["read_file", "parse_data"]));
    expect(result.callExpressions).toEqual(
      expect.arrayContaining([
        { callerName: "process", calleeName: "read_file" },
        { callerName: "process", calleeName: "parse_data" },
      ]),
    );
  });

  it("extracts impl trait for type", () => {
    const result = parseRust(`
pub trait Drawable {
  fn draw(&self);
}

pub struct Circle {
  radius: f64,
}

impl Drawable for Circle {
  fn draw(&self) {
    render(self.radius);
  }
}

fn render(r: f64) {}
`);
    const implSymbol = result.definedSymbols.find((s) => s.name === "impl Drawable for Circle");
    expect(implSymbol).toBeDefined();
    expect(implSymbol?.symbolType).toBe("impl");

    const drawSymbol = result.definedSymbols.find((s) => s.name === "Circle::draw");
    expect(drawSymbol).toBeDefined();
  });

  it("bounds trait declarations and extracts public uses and external modules", () => {
    const result = parseRust(`
pub use crate::thing::Thing;
mod child;
trait Drawable {
  fn draw(&self);
}
fn later() {}
`);

    expect(result.importPaths).toContain("crate::thing::Thing");
    expect(result.definedSymbols.find((s) => s.name === "child")?.endLine).toBe(3);
    const draw = result.definedSymbols.find((s) => s.name === "Drawable::draw");
    expect(draw?.endLine).toBe(5);
    expect(draw?.content).toBeUndefined();
  });

  it("ignores calls inside comments and strings without hiding lifetimes", () => {
    const result = parseRust(`
fn borrow<'a>(value: &'a str) -> &'a str {
  let text = "fake_call()";
  // commented_call()
  value
}
`);

    expect(result.definedSymbols.map((symbol) => symbol.name)).toContain("borrow");
    expect(result.callExpressions).toEqual([]);
  });

  it("includes searchText in chunk metadata", () => {
    const result = parseRust(`
fn process_payment() {
  validate_order();
}
`);
    const chunk = result.chunks.find((c) => c.symbolName === "process_payment");
    expect(chunk).toBeDefined();
    expect(chunk?.metadata.searchText).toContain("process");
    expect(chunk?.metadata.searchText).toContain("payment");
    expect(chunk?.metadata.searchText).toContain("validate");
    expect(chunk?.metadata.searchText).toContain("order");
  });
});
