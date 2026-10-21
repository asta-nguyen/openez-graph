import { describe, expect, test } from "bun:test";

import { parseDocument } from "../packages/indexer/src/parsers";
import { TreeSitterParser } from "../packages/indexer/src/parsers/tree-sitter-parser";
import { javaConfig, parseWithTreeSitter } from "../packages/indexer/src/tree-sitter";
import { codeExtensions } from "../packages/indexer/src/languages";

async function parseJava(content: string) {
  const result = await parseWithTreeSitter(javaConfig, content);
  expect(result).not.toBeNull();
  return result!;
}

const BASIC = `package app.demo;

import app.util.Util;
import static app.util.Util.format;
import app.util.*;
import static java.lang.Math.*;

public class Outer {
    private int count;
    String name;

    public Outer() {
        this.count = 0;
    }

    public void caller() {
        helper();
        this.local();
        Util.format();
        format();
    }

    void helper() {
    }

    void local() {
    }

    static class Inner {
        void deep() {
        }
    }
}
`;

describe("java language registration", () => {
  test(".java maps to the java language key", () => {
    expect(codeExtensions.get(".java")).toBe("java");
  });

  test("the parser registry routes .java through tree-sitter", async () => {
    const parser = new TreeSitterParser();
    expect(parser.canParse("src/A.java", "java", "code")).toBe(true);
    const parsed = await parser.parse(
      {
        relativePath: "src/A.java",
        absolutePath: "/tmp/A.java",
        content: BASIC,
      },
      "java",
      "code",
    );
    expect(parsed.parser).toBe("tree-sitter");
    expect(parsed.definedSymbols.map((s) => s.name)).toContain("Outer::caller");
  });
});

describe("java symbols", () => {
  test("package declaration emits exactly one package symbol", async () => {
    const { definedSymbols } = await parseJava(BASIC);
    const packages = definedSymbols.filter((s) => s.symbolType === "package");
    expect(packages).toHaveLength(1);
    expect(packages[0].name).toBe("app.demo");
    expect(packages[0].exported).toBe(true);
  });

  test("classes, fields, methods and constructors use Owner::member names", async () => {
    const { definedSymbols } = await parseJava(BASIC);
    const names = definedSymbols.map((s) => s.name);
    for (const expected of [
      "Outer",
      "Outer::count",
      "Outer::name",
      "Outer::Outer",
      "Outer::caller",
      "Outer::helper",
      "Outer::local",
      "Outer::Inner",
      "Outer::Inner::deep",
    ]) {
      expect(names).toContain(expected);
    }
    const types = Object.fromEntries(definedSymbols.map((s) => [s.name, s.symbolType]));
    expect(types["Outer"]).toBe("class");
    expect(types["Outer::Inner"]).toBe("class");
    expect(types["Outer::count"]).toBe("field");
    expect(types["Outer::Outer"]).toBe("constructor");
    expect(types["Outer::caller"]).toBe("function");
  });

  test("interfaces, enums, records and compact constructors are symbols", async () => {
    const { definedSymbols } = await parseJava(`package a;
interface Greeter { void hi(); }
enum Level { LOW, HIGH; void tick() {} }
record Point(int x) {
    Point { normalize(); }
    void normalize() {}
}
`);
    const types = Object.fromEntries(definedSymbols.map((s) => [s.name, s.symbolType]));
    expect(types["Greeter"]).toBe("interface");
    expect(types["Greeter::hi"]).toBe("function");
    expect(types["Level"]).toBe("enum");
    expect(types["Level::LOW"]).toBe("const");
    expect(types["Level::HIGH"]).toBe("const");
    expect(types["Level::tick"]).toBe("function");
    expect(types["Point"]).toBe("record");
    expect(types["Point::Point"]).toBe("constructor");
    expect(types["Point::normalize"]).toBe("function");
  });

  test("local classes nest under their method", async () => {
    const { definedSymbols } = await parseJava(`class A {
    void m() {
        class Local {
            void inside() {
            }
        }
    }
}
`);
    const names = definedSymbols.map((s) => s.name);
    expect(names).toContain("A::m::Local");
    expect(names).toContain("A::m::Local::inside");
  });

  test("static methods emit the internal static_function type", async () => {
    const { definedSymbols } = await parseJava(`package a;
public class Util {
    public static void format() {
    }
    public void inst() {
    }
}
`);
    const types = Object.fromEntries(definedSymbols.map((s) => [s.name, s.symbolType]));
    // Internal symbolType distinction so `import static` never binds an
    // instance member; ordinary member lookup keeps counting both kinds.
    expect(types["Util::format"]).toBe("static_function");
    expect(types["Util::inst"]).toBe("function");
  });

  test("public modifier marks exported symbols", async () => {
    const { definedSymbols } = await parseJava(BASIC);
    const exported = Object.fromEntries(definedSymbols.map((s) => [s.name, s.exported]));
    expect(exported["Outer"]).toBe(true);
    expect(exported["Outer::caller"]).toBe(true);
    expect(exported["Outer::count"]).toBe(false);
    expect(exported["Outer::name"]).toBe(false);
  });

  test("annotation text containing 'public' does not mark a symbol exported", async () => {
    const { definedSymbols } = await parseJava(`package a;

@Doc("public API")
class Hidden {
    @Doc("public method")
    void m() {
    }
}

@Doc("internal")
public class Shown {
    @Doc("public field")
    public void run() {
    }
}
`);
    const exported = Object.fromEntries(definedSymbols.map((s) => [s.name, s.exported]));
    expect(exported["Hidden"]).toBe(false);
    expect(exported["Hidden::m"]).toBe(false);
    expect(exported["Shown"]).toBe(true);
    expect(exported["Shown::run"]).toBe(true);
  });
});

describe("java imports", () => {
  test("normal, static and wildcard imports persist as raw specifiers", async () => {
    const { importPaths } = await parseJava(BASIC);
    expect(importPaths).toEqual(
      expect.arrayContaining([
        "app.util.Util",
        "static app.util.Util.format",
        "app.util.*",
        "static java.lang.Math.*",
      ]),
    );
  });
});

describe("java calls", () => {
  test("bare, this-qualified and type-qualified calls keep their receivers", async () => {
    const { callExpressions } = await parseJava(BASIC);
    const pairs = callExpressions.map((c) => `${c.callerName}->${c.calleeName}`);
    expect(pairs).toContain("Outer::caller->helper");
    expect(pairs).toContain("Outer::caller->this.local");
    expect(pairs).toContain("Outer::caller->Util.format");
    expect(pairs).toContain("Outer::caller->format");
  });

  test("method references and constructors emit no call", async () => {
    const { callExpressions, calledIdentifiers } = await parseJava(`class A {
    void m() {
        Runnable r = A::go;
        B b = new B();
        super.sup();
    }
    void go() {
    }
}
`);
    const callees = callExpressions.map((c) => c.calleeName);
    expect(callees).not.toContain("go");
    expect(callees).not.toContain("A::go");
    expect(callees).not.toContain("B");
    // super.sup is recorded as a qualified callee that the resolver drops
    expect(callees).toContain("super.sup");
    expect(calledIdentifiers).toContain("sup");
  });

  test("calls inside anonymous classes suppress bare/this but keep qualified", async () => {
    const { callExpressions, definedSymbols } = await parseJava(`class A {
    void m() {
        Runnable r = new Runnable() {
            public void run() {
                helper();
                this.other();
                app.Util.format();
            }
        };
    }
}
`);
    const names = definedSymbols.map((s) => s.name);
    expect(names).toContain("A::m::<anonymous>::run");
    const callees = callExpressions.map((c) => `${c.callerName}->${c.calleeName}`);
    expect(callees).toContain("A::m::<anonymous>::run->app.Util.format");
    expect(callees).not.toContain("A::m::<anonymous>::run->helper");
    expect(callees).not.toContain("A::m::<anonymous>::run->this.other");
  });

  test("enum-constant class bodies suppress bare calls like anonymous classes", async () => {
    const { callExpressions } = await parseJava(`enum E {
    A {
        void run() {
            helper();
            Type.m();
        }
    };
    void helper() {
    }
}
`);
    const callees = callExpressions.map((c) => `${c.callerName}->${c.calleeName}`);
    expect(callees).toContain("E::A::run->Type.m");
    expect(callees).not.toContain("E::A::run->helper");
  });

  test("LF and CRLF produce identical output", async () => {
    const lf = await parseJava(BASIC);
    const crlf = await parseJava(BASIC.replace(/\n/g, "\r\n"));
    const norm = (r: typeof lf) =>
      JSON.stringify({
        symbols: r.definedSymbols,
        imports: r.importPaths,
        ids: [...r.calledIdentifiers].sort(),
        calls: r.callExpressions,
      });
    expect(norm(crlf)).toBe(norm(lf));
  });

  test("malformed source still extracts a partial tree without throwing", async () => {
    const result = await parseWithTreeSitter(javaConfig, `class A { void m( { }`);
    expect(result).not.toBeNull();
  });
});

describe("java parser fallback", () => {
  test("unrecognized .java parse still returns chunks through the registry", async () => {
    const parsed = await parseDocument({
      relativePath: "src/A.java",
      absolutePath: "/tmp/A.java",
      content: "plain text with no java structure at all\n\n\n",
    });
    expect(parsed.chunks.length).toBeGreaterThan(0);
    expect(parsed.definedSymbols).toEqual([]);
    expect(parsed.callExpressions).toEqual([]);
  });
});
