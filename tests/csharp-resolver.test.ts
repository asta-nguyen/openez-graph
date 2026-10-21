import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  createCSharpResolver,
  type CSharpResolver,
  type CSharpResolverFileInput,
} from "../packages/indexer/src/csharp-resolver";
import { csharpConfig, parseWithTreeSitter } from "../packages/indexer/src/tree-sitter";
import { rmTempDir } from "./helpers/temp-cleanup";

/**
 * Unit coverage for the C# namespace/using resolver: project-root discovery
 * via *.csproj markers (never read), partial-type merging inside a root,
 * the simple-name lookup order (member types → enclosing namespaces →
 * usings), alias reservation, global using root scoping, using-static,
 * cross-root duplicate identities, overloads, #if/#else duplicates,
 * unknown receivers, and imports-edge rules.
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function makeWorkspace(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csharpres-"));
  cleanups.push(() => rmTempDir(root));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

async function resolverFor(root: string): Promise<CSharpResolver> {
  const inputs: CSharpResolverFileInput[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = dir === "." ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else inputs.push({ rel, abs: path.join(root, rel) } as never);
    }
  };
  walk(".");
  const files: CSharpResolverFileInput[] = [];
  for (const entry of inputs as unknown as Array<{ rel: string; abs: string }>) {
    if (!entry.rel.endsWith(".cs") && !entry.rel.endsWith(".csx")) continue;
    const parsed = await parseWithTreeSitter(csharpConfig, fs.readFileSync(entry.abs, "utf8"));
    files.push({
      filePath: entry.rel.split(path.sep).join("/"),
      symbols: parsed?.definedSymbols ?? [],
      importPaths: parsed?.importPaths ?? [],
    });
  }
  return createCSharpResolver(files, root);
}

const HELPER = `namespace Acme.Util
{
    public static class Helper
    {
        public static int Add(int a, int b) => a + b;
        public static int Sub(int a, int b) => a - b;
    }
}
`;

describe("csharp-resolver same-type and partial calls", () => {
  test("bare and this. calls resolve across partial parts", async () => {
    const root = makeWorkspace({
      "App.csproj": "<Project />",
      "a.cs": `namespace Acme.Core
{
    public partial class Widget
    {
        public void Run() { Step(); Extra(); }
        private void Step() { }
    }
}
`,
      "b.cs": `namespace Acme.Core
{
    public partial class Widget
    {
        public void Extra() { this.Step(); }
    }
}
`,
    });
    const r = await resolverFor(root);
    expect(r.resolveCall("a.cs", "Widget::Run", "Step")).toEqual({
      filePath: "a.cs",
      name: "Widget::Step",
    });
    expect(r.resolveCall("a.cs", "Widget::Run", "Extra")).toEqual({
      filePath: "b.cs",
      name: "Widget::Extra",
    });
    expect(r.resolveCall("b.cs", "Widget::Extra", "this.Step")).toEqual({
      filePath: "a.cs",
      name: "Widget::Step",
    });
  });

  test("overloads and #if/#else duplicates are ambiguous", async () => {
    const root = makeWorkspace({
      "App.csproj": "<Project />",
      "a.cs": `namespace Acme
{
    public class C
    {
        public void M(int x) { }
        public void M(string s) { }
#if DEBUG
        public void Dup() { }
#else
        public void Dup() { }
#endif
        public void Run() { M(1); Dup(); }
    }
}
`,
    });
    const r = await resolverFor(root);
    expect(r.resolveCall("a.cs", "C::Run", "M")).toBeNull();
    expect(r.resolveCall("a.cs", "C::Run", "Dup")).toBeNull();
  });
});

describe("csharp-resolver qualified calls and lookup order", () => {
  test("parent-namespace types resolve without a using", async () => {
    const root = makeWorkspace({
      "App.csproj": "<Project />",
      "a.cs": `namespace Acme
{
    public static class Helper { public static void Add() { } }
}
`,
      "b.cs": `namespace Acme.Inner
{
    public class C
    {
        public void Run() { Helper.Add(); }
    }
}
`,
    });
    const r = await resolverFor(root);
    expect(r.resolveCall("b.cs", "C::Run", "Helper.Add")).toEqual({
      filePath: "a.cs",
      name: "Helper::Add",
    });
  });

  test("nested member types walk the member chain", async () => {
    const root = makeWorkspace({
      "App.csproj": "<Project />",
      "a.cs": `namespace Acme
{
    public class Outer
    {
        public class Inner { public void M() { } }
        public void Run() { Inner.M(); Outer.Inner.M(); Acme.Outer.Inner.M(); }
    }
}
`,
    });
    const r = await resolverFor(root);
    const target = { filePath: "a.cs", name: "Outer::Inner::M" };
    expect(r.resolveCall("a.cs", "Outer::Run", "Inner.M")).toEqual(target);
    expect(r.resolveCall("a.cs", "Outer::Run", "Outer.Inner.M")).toEqual(target);
    expect(r.resolveCall("a.cs", "Outer::Run", "Acme.Outer.Inner.M")).toEqual(target);
    expect(r.resolveCall("a.cs", "Outer::Run", "global::Acme.Outer.Inner.M")).toEqual(target);
  });

  test("using binds a namespace for qualified names", async () => {
    const root = makeWorkspace({
      "App.csproj": "<Project />",
      "u.cs": HELPER,
      "c.cs": `using Acme.Util;
namespace Acme.Consumer
{
    public class C
    {
        public void Run() { Helper.Add(1, 2); }
    }
}
`,
    });
    const r = await resolverFor(root);
    expect(r.resolveCall("c.cs", "C::Run", "Helper.Add")).toEqual({
      filePath: "u.cs",
      name: "Helper::Add",
    });
    // Same-type qualified call without a using still resolves.
    expect(r.resolveCall("u.cs", "Helper::Add", "Helper.Sub")).toEqual({
      filePath: "u.cs",
      name: "Helper::Sub",
    });
  });
});

describe("csharp-resolver aliases and usings", () => {
  test("alias to a workspace type resolves; alias to external reserves", async () => {
    const root = makeWorkspace({
      "App.csproj": "<Project />",
      "u.cs": HELPER,
      "x.cs": `namespace Other.Space
{
    public static class Thing { public static void Make() { } }
}
`,
      "c.cs": `using Other.Space;
using H = Acme.Util.Helper;
using Thing = External.Elsewhere;
namespace Acme.Consumer
{
    public class C
    {
        public void Run() { H.Add(1, 2); Thing.Make(); }
    }
}
`,
      "d.cs": `using Other.Space;
namespace Acme.Consumer
{
    public class D
    {
        public void Run() { Thing.Make(); }
    }
}
`,
    });
    const r = await resolverFor(root);
    expect(r.resolveCall("c.cs", "C::Run", "H.Add")).toEqual({
      filePath: "u.cs",
      name: "Helper::Add",
    });
    // `Thing` is bound to an external type — the name is reserved and never
    // falls through to the workspace namesake that the ordinary using
    // Other.Space would otherwise supply at the same level.
    expect(r.resolveCall("c.cs", "C::Run", "Thing.Make")).toBeNull();
    // Without the alias, the same name resolves through Other.Space.
    expect(r.resolveCall("d.cs", "D::Run", "Thing.Make")).toEqual({
      filePath: "x.cs",
      name: "Thing::Make",
    });
  });

  test("using-static binds members uniquely", async () => {
    const root = makeWorkspace({
      "App.csproj": "<Project />",
      "u.cs": `namespace Acme.Util
{
    public static class Math2 { public static int Sq(int x) => x * x; }
    public static class Other { public static int Dup() => 1; }
}
`,
      "u2.cs": `namespace Acme.Util
{
    public static class Other2 { public static int Dup() => 2; }
}
`,
      "c.cs": `using static Acme.Util.Math2;
using static Acme.Util.Other;
using static Acme.Util.Other2;
namespace Acme.Consumer
{
    public class C
    {
        public void Run() { Sq(3); Dup(); }
    }
}
`,
    });
    const r = await resolverFor(root);
    expect(r.resolveCall("c.cs", "C::Run", "Sq")).toEqual({
      filePath: "u.cs",
      name: "Math2::Sq",
    });
    // Dup exists on two bound statics — ambiguous.
    expect(r.resolveCall("c.cs", "C::Run", "Dup")).toBeNull();
  });

  test("global using applies only inside the declaring project root", async () => {
    const root = makeWorkspace({
      "A/A.csproj": "<Project />",
      "A/globals.cs": "global using Acme.Util;\nnamespace Acme.A { }\n",
      "A/u.cs": HELPER,
      "A/c.cs": `namespace Acme.A
{
    public class C
    {
        public void Run() { Helper.Add(1, 2); }
    }
}
`,
      "B/B.csproj": "<Project />",
      "B/c.cs": `namespace Acme.B
{
    public class C
    {
        public void Run() { Helper.Add(1, 2); }
    }
}
`,
    });
    const r = await resolverFor(root);
    // A-root file sees the global using declared in A.
    expect(r.resolveCall("A/c.cs", "C::Run", "Helper.Add")).toEqual({
      filePath: "A/u.cs",
      name: "Helper::Add",
    });
    // B-root file does not.
    expect(r.resolveCall("B/c.cs", "C::Run", "Helper.Add")).toBeNull();
  });

  test("same type identity in two project roots is ambiguous", async () => {
    const root = makeWorkspace({
      "R1/R1.csproj": "<Project />",
      "R1/d.cs": `namespace Acme
{
    public class Dup { public void M() { } }
}
`,
      "R2/R2.csproj": "<Project />",
      "R2/d.cs": `namespace Acme
{
    public class Dup { public void M() { } }
}
`,
      "c.cs": `namespace Acme
{
    public class C
    {
        public void Run() { Dup.M(); }
    }
}
`,
    });
    const r = await resolverFor(root);
    expect(r.resolveCall("c.cs", "C::Run", "Dup.M")).toBeNull();
    // Inside R1 the same identity is unambiguous — it is R1's own type.
    expect(r.resolveCall("R1/d.cs", "Dup::M", "this.M")).toEqual({
      filePath: "R1/d.cs",
      name: "Dup::M",
    });
  });
});

describe("csharp-resolver negatives", () => {
  test("variable receivers, inherited members, externals produce no edge", async () => {
    const root = makeWorkspace({
      "App.csproj": "<Project />",
      "a.cs": `namespace Acme
{
    public class Base { public void Inherited() { } }
    public class Derived : Base
    {
        public void Run(Helper h)
        {
            h.Work();
            Inherited();
            External.Call();
        }
    }
    public class Helper { public void Work() { } }
}
`,
    });
    const r = await resolverFor(root);
    // `h` is not a type — `Helper` is, but the receiver is lowercase h and
    // receivers are never inferred.
    expect(r.resolveCall("a.cs", "Derived::Run", "h.Work")).toBeNull();
    // Inherited members are not resolved (design: no base-class lookup).
    expect(r.resolveCall("a.cs", "Derived::Run", "Inherited")).toBeNull();
    expect(r.resolveCall("a.cs", "Derived::Run", "External.Call")).toBeNull();
    // A property receiver is not a nested type — `Name.M` cannot resolve
    // through a property.
  });

  test("delegate-valued fields, properties, and delegate types are not call targets", async () => {
    const root = makeWorkspace({
      "App.csproj": "<Project />",
      "a.cs": `namespace Acme
{
    public class C
    {
        public System.Action Callback;
        public System.Action Handler { get; set; }
        public delegate void Nested();
        public void Real() { }
        public void Dup() { }
        public void Dup(int x) { }
        public void M() { Callback(); Handler(); Nested(); Real(); Dup(); }
    }
}
`,
    });
    const r = await resolverFor(root);
    // Fields, properties, and nested delegate declarations are members, never
    // call targets — `Callback()`/`Handler()`/`Nested()` produce no edge.
    expect(r.resolveCall("a.cs", "C::M", "Callback")).toBeNull();
    expect(r.resolveCall("a.cs", "C::M", "Handler")).toBeNull();
    expect(r.resolveCall("a.cs", "C::M", "Nested")).toBeNull();
    expect(r.resolveCall("a.cs", "C::M", "this.Callback")).toBeNull();
    // Real methods still resolve; overloads stay ambiguous.
    expect(r.resolveCall("a.cs", "C::M", "Real")).toEqual({
      filePath: "a.cs",
      name: "C::Real",
    });
    expect(r.resolveCall("a.cs", "C::M", "Dup")).toBeNull();
  });

  test("using-static never binds delegate-valued members", async () => {
    const root = makeWorkspace({
      "App.csproj": "<Project />",
      "u.cs": `namespace Acme.Util
{
    public static class Holder
    {
        public static System.Action Callback;
        public static System.Action Prop { get; set; }
        public static void Ping() { }
    }
}
`,
      "c.cs": `using static Acme.Util.Holder;
namespace Acme.Consumer
{
    public class C
    {
        public void Run() { Callback(); Prop(); Ping(); }
    }
}
`,
    });
    const r = await resolverFor(root);
    expect(r.resolveCall("c.cs", "C::Run", "Callback")).toBeNull();
    expect(r.resolveCall("c.cs", "C::Run", "Prop")).toBeNull();
    expect(r.resolveCall("c.cs", "C::Run", "Ping")).toEqual({
      filePath: "u.cs",
      name: "Holder::Ping",
    });
  });
});

describe("csharp-resolver imports edges", () => {
  test("usings emit an edge only for a single in-workspace file", async () => {
    const root = makeWorkspace({
      "App.csproj": "<Project />",
      "only.cs": `namespace Acme.Single { public class A { } }\n`,
      "m1.cs": `namespace Acme.Multi { public class B { } }\n`,
      "m2.cs": `namespace Acme.Multi { public class C { } }\n`,
      "part1.cs": `namespace Acme { public partial class P { public void A() { } } }\n`,
      "part2.cs": `namespace Acme { public partial class P { public void B() { } } }\n`,
      "c.cs": `using Acme.Single;
using Acme.Multi;
using T = Acme.P;
using static Acme.P;
using Acme.Missing;
namespace Acme.Consumer { public class C { } }
`,
    });
    const r = await resolverFor(root);
    // Namespace declared in exactly one file → edge.
    expect(r.resolveImport("c.cs", "using Acme.Single;")).toBe("only.cs");
    // Namespace spread over two files → no edge.
    expect(r.resolveImport("c.cs", "using Acme.Multi;")).toBeNull();
    // Alias/static targets resolving to a multi-file type → no edge.
    expect(r.resolveImport("c.cs", "using T = Acme.P;")).toBeNull();
    expect(r.resolveImport("c.cs", "using static Acme.P;")).toBeNull();
    // Undeclared namespace → ignored, no edge.
    expect(r.resolveImport("c.cs", "using Acme.Missing;")).toBeNull();
  });
});

describe("csharp-resolver same-line declarations", () => {
  test("same-line overloads never resolve", async () => {
    // Two C::M declarations share file, name, and start line — the resolver
    // must still count them as distinct occurrences and refuse the call.
    const root = makeWorkspace({
      "App.csproj": "<Project />",
      "c.cs": `class C { void M(int x) { } void M(string s) { } void Call() { M(1); this.M("s"); } }`,
    });
    const r = await resolverFor(root);
    expect(r.resolveCall("c.cs", "C::Call", "M")).toBeNull();
    expect(r.resolveCall("c.cs", "C::Call", "this.M")).toBeNull();
  });

  test("duplicate members from #if branches on adjacent lines stay ambiguous", async () => {
    const root = makeWorkspace({
      "App.csproj": "<Project />",
      "d.cs": `class D {
#if X
  void Dup() { }
#else
  void Dup() { }
#endif
  void Call() { Dup(); }
}`,
    });
    const r = await resolverFor(root);
    expect(r.resolveCall("d.cs", "D::Call", "Dup")).toBeNull();
  });

  test("same-line sibling namespaces keep same-named types distinct", async () => {
    // `namespace A { ... } namespace B { ... }` on one physical line emits
    // identical line ranges for both declarations — the Workers must stay
    // separate identities (A.Worker vs B.Worker), not merge into A.B.Worker.
    const root = makeWorkspace({
      "App.csproj": "<Project />",
      "t.cs": `namespace A { class Worker { public void RunA() { } public void Shared() { } } } namespace B { class Worker { public void RunB() { } public void Shared() { } } }`,
      "main.cs": `class Program { static void Main() { A.Worker.RunA(); B.Worker.RunB(); A.Worker.Shared(); B.Worker.Shared(); } }`,
    });
    const r = await resolverFor(root);
    // Namespace-qualified calls reach each sibling's own member.
    expect(r.resolveCall("main.cs", "Program::Main", "A.Worker.RunA")).toEqual({
      filePath: "t.cs",
      name: "Worker::RunA",
    });
    expect(r.resolveCall("main.cs", "Program::Main", "B.Worker.RunB")).toEqual({
      filePath: "t.cs",
      name: "Worker::RunB",
    });
    // Same-named members resolve per identity — A.Worker has RunA only.
    expect(r.resolveCall("main.cs", "Program::Main", "A.Worker.RunB")).toBeNull();
    expect(r.resolveCall("main.cs", "Program::Main", "B.Worker.RunA")).toBeNull();
    // Unique per identity: each Shared resolves (merged A.B.Worker would be
    // ambiguous and produce null).
    expect(r.resolveCall("main.cs", "Program::Main", "A.Worker.Shared")).toEqual({
      filePath: "t.cs",
      name: "Worker::Shared",
    });
    expect(r.resolveCall("main.cs", "Program::Main", "B.Worker.Shared")).toEqual({
      filePath: "t.cs",
      name: "Worker::Shared",
    });
    // The merged identity from the old line-range bug must not exist.
    expect(r.resolveCall("main.cs", "Program::Main", "A.B.Worker.Shared")).toBeNull();
  });

  test("paired case: same-line nested namespace after a prior member", async () => {
    // `namespace A { class X {} namespace B { class Y {} } }` — B IS nested
    // in A even though a member intervenes: parser-derived qualified names
    // (`A.B`) make the nesting exact rather than guessed. The same-line
    // siblings case above proves `A{W}B{W}` still lands `B` at top level.
    const root = makeWorkspace({
      "App.csproj": "<Project />",
      "t.cs": `namespace A { class X { } namespace B { class Y { public void M() { } } } }`,
      "main.cs": `class Program { static void Main() { A.B.Y.M(); } }`,
    });
    const r = await resolverFor(root);
    // The qualified path resolves through the nested namespace.
    expect(r.resolveCall("main.cs", "Program::Main", "A.B.Y.M")).toEqual({
      filePath: "t.cs",
      name: "Y::M",
    });
    // `B` is not a top-level namespace — an unqualified-B path finds no
    // target, and the top-level sibling reading `B.Y` must not appear.
    expect(r.resolveCall("main.cs", "Program::Main", "B.Y.M")).toBeNull();
    // An ordinary using sees the declared qualified namespace.
    expect(r.resolveImport("main.cs", "using A.B;")).toBe("t.cs");
    expect(r.resolveImport("main.cs", "using B;")).toBeNull();
  });

  test("same-line mixed-depth sibling: latest containing declaration wins", async () => {
    // `namespace A.B { class X {} } namespace B { class Y {} }` on one line —
    // `A.B` is deeper, but Y follows the later top-level `B` declaration and
    // belongs to `B`, not `A.B`. The parser-derived names already encode
    // nested-vs-sibling, so the latest containing decl must win.
    const root = makeWorkspace({
      "App.csproj": "<Project />",
      "t.cs": `namespace A.B { class X { } } namespace B { class Y { public void M() { } } }`,
      "main.cs": `class Program { static void Main() { B.Y.M(); A.B.Y.M(); } }`,
    });
    const r = await resolverFor(root);
    // Y lives in top-level `B` — the dotted `A.B` decl is a sibling, not a
    // parent.
    expect(r.resolveCall("main.cs", "Program::Main", "B.Y.M")).toEqual({
      filePath: "t.cs",
      name: "Y::M",
    });
    // Depth-preference would mis-assign Y to `A.B`; that path must resolve
    // to nothing.
    expect(r.resolveCall("main.cs", "Program::Main", "A.B.Y.M")).toBeNull();
    // An ordinary using sees `B` as declared (in t.cs).
    expect(r.resolveImport("main.cs", "using B;")).toBe("t.cs");
  });

  test("same-label overloaded callers fail closed — no wrong-source edge", async () => {
    // Two `T::M` overloads in one file call different unique targets. Both
    // share the label `T::M`, so the graph's (file,label) caller-node lookup
    // cannot tell which occurrence a call came from — emitting an edge could
    // attach it to the wrong node. The resolver must refuse instead.
    const root = makeWorkspace({
      "App.csproj": "<Project />",
      "h.cs": `namespace A { class Helper { public void RunA() { } } }\nnamespace B { class Helper { public void RunB() { } } }`,
      "t.cs": `class T { void M() { A.Helper.RunA(); } void M(int x) { B.Helper.RunB(); } }`,
      "main.cs": `class Program { static void Main() { A.Helper.RunA(); } }`,
    });
    const r = await resolverFor(root);
    // Calls from either T::M occurrence produce no resolution.
    expect(r.resolveCall("t.cs", "T::M", "A.Helper.RunA")).toBeNull();
    expect(r.resolveCall("t.cs", "T::M", "B.Helper.RunB")).toBeNull();
    expect(r.resolveCallOccurrence("t.cs", "T::M", "A.Helper.RunA")).toBeNull();
    // Unique callers are unaffected.
    expect(r.resolveCall("main.cs", "Program::Main", "A.Helper.RunA")).toEqual({
      filePath: "h.cs",
      name: "Helper::RunA",
    });
  });

  test("resolveCallOccurrence carries distinct indices for same-label members", async () => {
    // `Worker::Shared` exists once under `A` and once under `B` in one file —
    // the public result is identical, but the occurrence index must differ
    // so the graph maps each call to its own symbol node.
    const root = makeWorkspace({
      "App.csproj": "<Project />",
      "t.cs": `namespace A { class Worker { public void Shared() { } } }\nnamespace B { class Worker { public void Shared() { } } }`,
      "main.cs": `class Program { static void Main() { A.Worker.Shared(); B.Worker.Shared(); } }`,
    });
    const r = await resolverFor(root);
    const a = r.resolveCallOccurrence("main.cs", "Program::Main", "A.Worker.Shared");
    const b = r.resolveCallOccurrence("main.cs", "Program::Main", "B.Worker.Shared");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect({ filePath: a!.filePath, name: a!.name }).toEqual({
      filePath: "t.cs",
      name: "Worker::Shared",
    });
    expect({ filePath: b!.filePath, name: b!.name }).toEqual({
      filePath: "t.cs",
      name: "Worker::Shared",
    });
    expect(a!.index).not.toBe(b!.index);
    // The plain resolveCall shape is unchanged.
    expect(r.resolveCall("main.cs", "Program::Main", "A.Worker.Shared")).toEqual({
      filePath: "t.cs",
      name: "Worker::Shared",
    });
  });

  test("deeper same-line nesting chains qualify fully", async () => {
    const root = makeWorkspace({
      "App.csproj": "<Project />",
      "t.cs": `namespace A { namespace B { namespace C { class Y { public void M() { } } } } }`,
      "main.cs": `class Program { static void Main() { A.B.C.Y.M(); } }`,
    });
    const r = await resolverFor(root);
    expect(r.resolveCall("main.cs", "Program::Main", "A.B.C.Y.M")).toEqual({
      filePath: "t.cs",
      name: "Y::M",
    });
    expect(r.resolveCall("main.cs", "Program::Main", "B.C.Y.M")).toBeNull();
  });
});

describe("csharp-resolver namespace-scoped usings", () => {
  test("a block-namespace using binds calls inside its own block only", async () => {
    const root = makeWorkspace({
      "App.csproj": "<Project />",
      "u.cs": `namespace Acme.Util
{
    public static class Helper
    {
        public static int Add(int a, int b) => a + b;
    }
}
`,
      "c.cs": `namespace Acme.Consumer
{
    using Util;
    public class C
    {
        public void Run() { Helper.Add(1, 2); }
    }
}
namespace Acme.Other
{
    public class D
    {
        public void Go() { Helper.Add(1, 2); }
    }
}
`,
    });
    const r = await resolverFor(root);
    // `using Util` inside `namespace Acme.Consumer` resolves `Acme.Util` for
    // code in that block — `Helper.Add` binds through it.
    expect(r.resolveCall("c.cs", "C::Run", "Helper.Add")).toEqual({
      filePath: "u.cs",
      name: "Helper::Add",
    });
    // `Acme.Other` is a sibling declaration: the Acme.Consumer-block using
    // is not visible there even though `Acme` is a name prefix.
    expect(r.resolveCall("c.cs", "D::Go", "Helper.Add")).toBeNull();
  });

  test("a nested namespace using applies within its own subtree", async () => {
    const root = makeWorkspace({
      "App.csproj": "<Project />",
      "u.cs": `namespace A.B.Util
{
    public static class Helper
    {
        public static int Add(int a, int b) => a + b;
    }
}
`,
      "c.cs": `namespace A
{
    namespace B
    {
        using Util;
        public class C
        {
            public void Run() { Helper.Add(1, 2); }
        }
    }
    public class D
    {
        public void Go() { Helper.Add(1, 2); }
    }
}
`,
    });
    const r = await resolverFor(root);
    // `using Util` inside `namespace A.B` binds `A.B.Util`.
    expect(r.resolveCall("c.cs", "C::Run", "Helper.Add")).toEqual({
      filePath: "u.cs",
      name: "Helper::Add",
    });
    // `D` is in `A` but outside `A.B` — the using does not apply.
    expect(r.resolveCall("c.cs", "D::Go", "Helper.Add")).toBeNull();
  });

  test("a block-namespace alias resolves relative to its scope", async () => {
    const root = makeWorkspace({
      "App.csproj": "<Project />",
      "u.cs": `namespace Acme.Util
{
    public static class Helper
    {
        public static int Add(int a, int b) => a + b;
    }
}
`,
      "c.cs": `namespace Acme.Consumer
{
    using H = Util.Helper;
    public class C
    {
        public void Run() { H.Add(1, 2); }
    }
}
`,
    });
    const r = await resolverFor(root);
    // The alias target `Util.Helper` is resolved relative to `Acme.Consumer`:
    // `Acme.Consumer.Util.Helper` misses, `Acme.Util.Helper` hits.
    expect(r.resolveCall("c.cs", "C::Run", "H.Add")).toEqual({
      filePath: "u.cs",
      name: "Helper::Add",
    });
  });

  test("a block-namespace using-static binds static members in scope only", async () => {
    const root = makeWorkspace({
      "App.csproj": "<Project />",
      "u.cs": `namespace Acme.Util
{
    public static class Math2
    {
        public static int Sq(int x) => x * x;
    }
}
`,
      "c.cs": `namespace Acme.Consumer
{
    using static Acme.Util.Math2;
    public class C
    {
        public void Run() { Sq(3); }
    }
}
namespace Acme.Other
{
    public class D
    {
        public void Go() { Sq(3); }
    }
}
`,
    });
    const r = await resolverFor(root);
    expect(r.resolveCall("c.cs", "C::Run", "Sq")).toEqual({
      filePath: "u.cs",
      name: "Math2::Sq",
    });
    expect(r.resolveCall("c.cs", "D::Go", "Sq")).toBeNull();
  });

  test("using-static binds static methods but never instance methods", async () => {
    const root = makeWorkspace({
      "App.csproj": "<Project />",
      "u.cs": `namespace Acme.Util
{
    public static class St
    {
        public static int Twice(int x) => 2 * x;
        public int Inst(int x) => x;
    }
}
`,
      "c.cs": `using static Acme.Util.St;
namespace Acme.Consumer
{
    public class C
    {
        public void Run() { Twice(2); Inst(2); }
    }
}
`,
    });
    const r = await resolverFor(root);
    // The static member resolves; the same-named instance member must not.
    expect(r.resolveCall("c.cs", "C::Run", "Twice")).toEqual({
      filePath: "u.cs",
      name: "St::Twice",
    });
    expect(r.resolveCall("c.cs", "C::Run", "Inst")).toBeNull();
  });

  test("instance methods still resolve through the same-type member path", async () => {
    const root = makeWorkspace({
      "App.csproj": "<Project />",
      "c.cs": `namespace Acme
{
    public class C
    {
        public void Run() { Inst(); Stat(); }
        private void Inst() { }
        private static void Stat() { }
    }
}
`,
    });
    const r = await resolverFor(root);
    expect(r.resolveCall("c.cs", "C::Run", "Inst")).toEqual({
      filePath: "c.cs",
      name: "C::Inst",
    });
    expect(r.resolveCall("c.cs", "C::Run", "Stat")).toEqual({
      filePath: "c.cs",
      name: "C::Stat",
    });
    expect(r.resolveCall("c.cs", "C::Run", "this.Inst")).toEqual({
      filePath: "c.cs",
      name: "C::Inst",
    });
  });

  test("scoped usings emit imports edges owned by the declaring file", async () => {
    const root = makeWorkspace({
      "App.csproj": "<Project />",
      "u.cs": `namespace Acme.Util
{
    public static class Helper
    {
        public static int Add(int a, int b) => a + b;
    }
}
`,
      "c.cs": `namespace Acme.Consumer
{
    using Util;
    using H = Util.Helper;
    using static Acme.Util.Helper;
    public class C { }
}
`,
    });
    const r = await resolverFor(root);
    // Every scoped directive resolves relative to Acme.Consumer and maps to
    // the single file declaring its target. The `Acme.Consumer@1` scope key
    // names the enclosing declaration (`namespace` keyword at line 1).
    expect(r.resolveImport("c.cs", "Acme.Consumer@1\0using Util;")).toBe("u.cs");
    expect(r.resolveImport("c.cs", "Acme.Consumer@1\0using H = Util.Helper;")).toBe("u.cs");
    expect(r.resolveImport("c.cs", "Acme.Consumer@1\0using static Acme.Util.Helper;")).toBe("u.cs");
    // An undeclared scoped using still yields no edge.
    expect(r.resolveImport("c.cs", "Acme.Consumer@1\0using Missing;")).toBeNull();
  });
});
