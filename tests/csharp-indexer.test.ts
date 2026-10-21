import { describe, expect, spyOn, test } from "bun:test";

import { parseDocument } from "../packages/indexer/src/parsers";
import { inferDocumentKind, blankCSharpDirectives } from "../packages/indexer/src/languages";
import * as treeSitter from "../packages/indexer/src/tree-sitter";
import { csharpConfig, parseWithTreeSitter } from "../packages/indexer/src/tree-sitter";

/**
 * C# WASM-side extraction: namespaces (file-scoped, block, nested, dotted),
 * every declared type kind, fields/properties/methods/constructors/
 * destructors/delegates/nested types with `Owner::member` names, full
 * using-directive text, conditional-directive blanking with original
 * offsets, qualified call forms, CRLF, and the generic text fallback when
 * the grammar is unavailable.
 */

const PARSE = (src: string) => parseWithTreeSitter(csharpConfig, src);

describe("csharp discovery", () => {
  test(".cs and .csx map to language csharp", () => {
    expect(inferDocumentKind("src/Widget.cs")).toEqual({
      kind: "code",
      language: "csharp",
      extension: ".cs",
    });
    expect(inferDocumentKind("build/script.csx")).toEqual({
      kind: "code",
      language: "csharp",
      extension: ".csx",
    });
  });

  test("parseDocument routes .cs through the tree-sitter parser", async () => {
    const result = await parseDocument({
      relativePath: "a.cs",
      absolutePath: "/tmp/a.cs",
      content: "namespace N { public class C { public void M() { } } }",
      targetTokens: 512,
      overlapTokens: 64,
    });
    expect(result.parser).toBe("tree-sitter");
    expect(result.language).toBe("csharp");
    expect(result.definedSymbols?.map((s) => s.name)).toEqual(
      expect.arrayContaining(["N", "C", "C::M"]),
    );
  });
});

describe("csharp symbols", () => {
  test("file-scoped namespace spans to end of file", async () => {
    const result = await PARSE(
      "namespace Acme.Core;\n\npublic class Widget\n{\n    public void Run() { }\n}\n",
    );
    const ns = result?.definedSymbols?.find((s) => s.symbolType === "namespace");
    expect(ns?.name).toBe("Acme.Core");
    expect(ns?.startLine).toBe(1);
    // content.split("\n").length — trailing newline counts (native parity).
    expect(ns?.endLine).toBe(7);
  });

  test("block, nested, and dotted namespaces emit symbols with ranges", async () => {
    const result = await PARSE(
      "namespace A.B\n{\n    namespace C\n    {\n        class Inner { }\n    }\n}\nnamespace Top { class T { } }\n",
    );
    const names = result?.definedSymbols?.map((s) => s.name) ?? [];
    // Nested declarations emit fully qualified names: `namespace C` inside
    // `namespace A.B` is `A.B.C`.
    expect(names).toEqual(expect.arrayContaining(["A.B", "A.B.C", "Inner", "Top", "T"]));
    const ab = result?.definedSymbols?.find((s) => s.name === "A.B");
    const c = result?.definedSymbols?.find(
      (s) => s.name === "A.B.C" && s.symbolType === "namespace",
    );
    expect(ab?.startLine).toBe(1);
    expect(ab?.endLine).toBe(7);
    expect(c?.startLine).toBe(3);
  });

  test("all type kinds and member kinds with Owner::member names", async () => {
    const result = await PARSE(
      `namespace N
{
    public class K { }
    public struct S { }
    public interface I { }
    public record R(int X);
    public enum E { One, Two }
    public delegate void D(int x);
    public class Outer
    {
        private int _a, _b;
        public string Name { get; set; }
        public Outer() { }
        ~Outer() { }
        public void M() { }
        public class Nested { public void P() { } }
    }
}
`,
    );
    const byName = new Map(result!.definedSymbols!.map((s) => [s.name, s]));
    for (const [name, type] of [
      ["K", "class"],
      ["S", "struct"],
      ["I", "interface"],
      ["R", "record"],
      ["E", "enum"],
      ["D", "delegate"],
      ["Outer", "class"],
      ["Outer::_a", "field"],
      ["Outer::_b", "field"],
      ["Outer::Name", "property"],
      ["Outer::M", "method"],
      ["Outer::Nested", "class"],
      ["Outer::Nested::P", "method"],
    ] as const) {
      expect(byName.get(name)?.symbolType, name).toBe(type);
    }
    // Constructor and destructor share the declared name `Outer` — both are
    // emitted as `Outer::Outer` members.
    expect(
      result!.definedSymbols!.filter((s) => s.symbolType === "constructor").map((s) => s.name),
    ).toContain("Outer::Outer");
    expect(
      result!.definedSymbols!.filter((s) => s.symbolType === "destructor").map((s) => s.name),
    ).toContain("Outer::Outer");
    // Multi-declarator field produced two field symbols.
    expect(byName.get("E::One")?.symbolType).toBe("field");
    expect(byName.get("E::Two")?.symbolType).toBe("field");
  });

  test("nested namespace symbols carry fully qualified names", async () => {
    const res = await PARSE(`namespace A { class X { } namespace B { class Y { } } }`);
    const names = res.definedSymbols!.map((s) => s.name);
    // Same-line nesting is exact: B's emitted name is `A.B` (parser-derived
    // ancestor walk), not `B` — and same-line siblings stay top-level.
    expect(names).toEqual(["A", "X", "A.B", "Y"]);
    const sib = await PARSE(`namespace A { class W { } } namespace B { class W { } }`);
    expect(sib.definedSymbols!.map((s) => s.name)).toEqual(["A", "W", "B", "W"]);
  });

  test("exported reflects the public modifier token, not attribute text", async () => {
    const res = await PARSE(
      `[Doc("public API")] class Internal { void M() { } }\n` +
        `[Doc("public")] public class P { public void Run() { } void Hide() { } }\n`,
    );
    const byName = new Map(res.definedSymbols!.map((s) => [s.name, s.exported]));
    // "public" inside an attribute argument must not fake accessibility.
    expect(byName.get("Internal")).toBe(false);
    expect(byName.get("Internal::M")).toBe(false);
    // An actually public annotated declaration stays exported.
    expect(byName.get("P")).toBe(true);
    expect(byName.get("P::Run")).toBe(true);
    expect(byName.get("P::Hide")).toBe(false);
  });

  test("static methods emit the internal static_method type", async () => {
    const result = await PARSE(
      "namespace N { public class C { public static int Sq(int x) => x * x; public int Inst(int x) => x; } }\n",
    );
    const byName = new Map(result!.definedSymbols!.map((s) => [s.name, s]));
    // Internal symbolType distinction so `using static` never binds an
    // instance member; graph/public shapes are unchanged.
    expect(byName.get("C::Sq")?.symbolType).toBe("static_method");
    expect(byName.get("C::Inst")?.symbolType).toBe("method");
  });

  test("local declarators are never field symbols", async () => {
    const result = await PARSE(
      "namespace N { public class C { public void M() { var local = 1; using var r = Open(); int x = 2, y = 3; } } }\n",
    );
    const names = result?.definedSymbols?.map((s) => s.name) ?? [];
    expect(names).not.toContain("C::local");
    expect(names).not.toContain("C::r");
    expect(names).not.toContain("C::x");
    expect(names).not.toContain("C::y");
  });
});

describe("csharp usings", () => {
  test("ordinary/alias/global/static directives carry full text", async () => {
    const result = await PARSE(
      `using Alpha.Util;
global using Beta.Common;
using H = Alpha.Util.Helper;
using static Alpha.Util.Math2;
global using G = Other.Thing;
global using static Other.Statics;
namespace N { class C { } }
`,
    );
    expect(result?.importPaths).toEqual([
      "using Alpha.Util;",
      "global using Beta.Common;",
      "using H = Alpha.Util.Helper;",
      "using static Alpha.Util.Math2;",
      "global using G = Other.Thing;",
      "global using static Other.Statics;",
    ]);
  });

  test("usings inside a block namespace carry their enclosing scope", async () => {
    const result = await PARSE(
      "using Top;\nnamespace N\n{\n    using Inner;\n    using H = Inner.Helper;\n    using static Inner.St;\n    class C { }\n}\n",
    );
    // importPaths stays string[] — a namespace-scoped directive is encoded
    // `<qualified-name>@<decl-line>\0<verbatim directive>` so the resolver can
    // apply it inside exactly the namespace block that declared it.
    expect(result?.importPaths).toEqual([
      "using Top;",
      "N@2\0using Inner;",
      "N@2\0using H = Inner.Helper;",
      "N@2\0using static Inner.St;",
    ]);
  });

  test("nested namespace usings carry the fully qualified scope", async () => {
    const result = await PARSE(
      "namespace A\n{\n    namespace B\n    {\n        using X;\n        class C { }\n    }\n}\n",
    );
    expect(result?.importPaths).toEqual(["A.B@3\0using X;"]);
  });

  test("usings after a file-scoped namespace are scoped to it", async () => {
    const result = await PARSE("namespace Acme;\nusing Util;\nclass C { }\n");
    expect(result?.importPaths).toEqual(["Acme@1\0using Util;"]);
  });

  test("same-named sibling blocks disambiguate scope keys by ordinal", async () => {
    // Two `namespace N` blocks on one line share the `N@1` scope key, so
    // the second declaration's directives carry a `#<ordinal>` suffix —
    // the resolver computes the same ordinal from symbol emission order.
    const result = await PARSE(
      "namespace N { using X; class C { } } namespace N { using Y; class D { } }\n",
    );
    expect(result?.importPaths).toEqual(["N@1\0using X;", "N@1#1\0using Y;"]);
  });

  test("usings before a file-scoped namespace stay compilation-unit level", async () => {
    const result = await PARSE("using Top;\nnamespace Acme;\nclass C { }\n");
    expect(result?.importPaths).toEqual(["using Top;"]);
  });

  test("a using inside a non-namespace declaration list is dropped", async () => {
    // Malformed recovery: `class C { using A; ... }` puts the directive in
    // a class body, not a namespace body — the using is invalid C# and both
    // parsers drop it instead of treating it as compilation-unit text.
    const result = await PARSE("class C { using A; public void Go() { } }\n");
    expect(result?.importPaths).toEqual([]);
  });

  test("legitimate compilation-unit and namespace usings survive a dropped one", async () => {
    const result = await PARSE(
      "using B;\nclass C { using A; public void Go() { } }\nnamespace N { using D; class E { } }\n",
    );
    expect(result?.importPaths).toEqual(["using B;", "N@3\0using D;"]);
  });
});

describe("csharp symbol scopes", () => {
  test("symbols carry the enclosing namespace declaration as receiver scope key", async () => {
    const result = await PARSE(
      "namespace A { using U; namespace B { public class C { public void M() { } } } }\n",
    );
    const recv = (name: string) => result?.definedSymbols?.find((s) => s.name === name)?.receiver;
    // A namespace declaration's receiver is its *enclosing* declaration's
    // scope key — the same `name@line[#ord]` encoding usings carry.
    expect(recv("A")).toBeUndefined();
    expect(recv("A.B")).toBe("A@1");
    expect(recv("C")).toBe("A.B@1");
    expect(recv("C::M")).toBe("A.B@1");
  });

  test("file-scoped members carry the file-scoped declaration's scope", async () => {
    const result = await PARSE("namespace Acme; public class C { public void M() { } }\n");
    const recv = (name: string) => result?.definedSymbols?.find((s) => s.name === name)?.receiver;
    expect(recv("Acme")).toBeUndefined();
    expect(recv("C")).toBe("Acme@1");
    expect(recv("C::M")).toBe("Acme@1");
  });

  test("same-named sibling declarations produce distinct receiver keys", async () => {
    const result = await PARSE("namespace N { class C { } } namespace N { class D { } }\n");
    const recv = (name: string) => result?.definedSymbols?.find((s) => s.name === name)?.receiver;
    expect(recv("C")).toBe("N@1");
    expect(recv("D")).toBe("N@1#1");
  });
});

describe("csharp conditional directives", () => {
  test("blankCSharpDirectives blanks only #if-family directive lines", () => {
    const src = "int a;\n#if DEBUG\nint b;\n#else\nint c;\n#endif\n#region R\nint d;\n";
    const blanked = blankCSharpDirectives(src);
    expect(blanked.length).toBe(src.length);
    expect(blanked).toContain("int a;");
    expect(blanked).toContain("int b;");
    expect(blanked).toContain("int c;");
    expect(blanked).toContain("#region R");
    expect(blanked).not.toContain("#if");
    expect(blanked).not.toContain("#else");
    expect(blanked).not.toContain("#endif");
  });

  test("both #if/#else bodies are indexed with original line numbers", async () => {
    const src = `namespace N
{
    class C
    {
#if DEBUG
        void Target() { }
#else
        void Target() { }
#endif
        void Other() { }
    }
}
`;
    const result = await PARSE(src);
    const targets = result!.definedSymbols!.filter((s) => s.name === "C::Target");
    expect(targets).toHaveLength(2);
    expect(targets.map((t) => t.startLine).sort()).toEqual([6, 8]);
    const other = result!.definedSymbols!.find((s) => s.name === "C::Other");
    expect(other?.startLine).toBe(10);
  });
});

describe("csharp calls", () => {
  test("bare, this, type-qualified, and alias-qualified calls keep dotted paths", async () => {
    const result = await PARSE(
      `namespace N
{
    class C
    {
        void Run()
        {
            Step();
            this.Step();
            Helper.Add(1, 2);
            Alpha.Util.Helper.Add(1, 2);
            Alias.Make();
            Gen<int>.Build();
            Generic<Dict<string, int>>(1);
        }
        void Step() { }
    }
}
`,
    );
    const callees = result!.callExpressions!.map((c) => c.calleeName);
    expect(callees).toEqual(
      expect.arrayContaining([
        "Step",
        "this.Step",
        "Helper.Add",
        "Alpha.Util.Helper.Add",
        "Alias.Make",
        "Gen.Build",
        "Generic",
      ]),
    );
    expect(result!.callExpressions!.every((c) => c.callerName === "C::Run")).toBe(true);
  });

  test("conditional access and expression receivers produce no call", async () => {
    const result = await PARSE(
      "namespace N { class C { void Run() { obj?.Maybe(); (expr).M(); Foo().Bar(); } } }\n",
    );
    const callees = result?.callExpressions?.map((c) => c.calleeName) ?? [];
    // `obj?.M` and `(expr).M` callees are dropped; `Foo()` inside
    // `Foo().Bar()` is a genuine invocation (never resolvable as a member
    // of C — the resolver drops it).
    expect(callees).toEqual(["Foo"]);
  });

  test("object creation is not a call", async () => {
    const result = await PARSE(
      "namespace N { class C { void Run() { var w = new Widget(); var x = new Widget(arg); } } }\n",
    );
    const callees = result?.callExpressions?.map((c) => c.calleeName) ?? [];
    expect(callees).toEqual([]);
  });

  test("keywords and control statements are never calls", async () => {
    const result = await PARSE(
      `namespace N { class C { void Run() { if (x) { } foreach (var i in xs) { } while (y) { } using (var r = z) { } lock (o) { } return; } } }\n`,
    );
    const callees = result?.callExpressions?.map((c) => c.calleeName) ?? [];
    expect(callees).toEqual([]);
  });
});

describe("csharp offsets", () => {
  test("CRLF produces the same symbols and ranges as LF", async () => {
    const lf = "namespace N\n{\n    class C\n    {\n        void M() { Helper.Go(); }\n    }\n}\n";
    const crlf = lf.replace(/\n/g, "\r\n");
    const a = await PARSE(lf);
    const b = await PARSE(crlf);
    expect(b?.definedSymbols).toEqual(a?.definedSymbols);
    expect(b?.callExpressions).toEqual(a?.callExpressions);
    expect(b?.importPaths).toEqual(a?.importPaths);
    expect(b?.calledIdentifiers).toEqual(a?.calledIdentifiers);
  });
});

describe("csharp fallback", () => {
  test("grammar-unavailable yields generic chunks, no symbols, no throw", async () => {
    // Force the WASM path to fail — TreeSitterParser must degrade to generic
    // text chunks for .cs with no symbols/imports/calls and must not throw.
    const spy = spyOn(treeSitter, "parseWithTreeSitter").mockResolvedValue(null);
    try {
      const content = "namespace N { class C { void M() { Helper.Go(); } } }";
      const result = await parseDocument({
        relativePath: "a.cs",
        absolutePath: "/tmp/a.cs",
        content,
        targetTokens: 512,
        overlapTokens: 64,
      });
      expect(result.parser).toBe("fallback");
      expect(result.definedSymbols ?? []).toEqual([]);
      expect(result.callExpressions ?? []).toEqual([]);
      expect(result.importPaths ?? []).toEqual([]);
      expect(result.chunks.length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("bogus grammar resolves to null without throwing", async () => {
    const missing = await parseWithTreeSitter({ ...csharpConfig, language: "csharp-missing" }, "x");
    expect(missing).toBeNull();
  });
});
