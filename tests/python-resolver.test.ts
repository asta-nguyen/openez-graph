import { describe, expect, it } from "bun:test";

import { parsePython } from "../packages/indexer/src/languages";
import {
  createPythonModuleResolver,
  createPythonResolver,
  extractPythonBindings,
  markPythonCallShadowing,
} from "../packages/indexer/src/python-resolver";

/**
 * Unit coverage for the Python binding extractor, shadow marker, module
 * resolver, and call resolver — the pieces that back `calls` edge
 * resolution in buildGraphGeneration. Graph-level behavior is covered by
 * tests/python-edge-accuracy.test.ts.
 */

interface CallSpec {
  callerName: string;
  calleeName: string;
  shadowedLocal?: boolean;
}

function makeResolver(files: Record<string, string>) {
  const names = Object.keys(files);
  const symbols = new Map(names.map((f) => [f, parsePython(files[f]).definedSymbols ?? []]));
  const bindings = new Map(names.map((f) => [f, extractPythonBindings(files[f], symbols.get(f))]));
  const calls = new Map<string, CallSpec[]>(
    names.map((f) => [f, parsePython(files[f]).callExpressions ?? []] as [string, CallSpec[]]),
  );
  for (const f of names) {
    markPythonCallShadowing(files[f], symbols.get(f) ?? [], calls.get(f)!);
  }
  const resolver = createPythonResolver({
    pythonFiles: names,
    symbolsFor: (f) => symbols.get(f),
    bindingsFor: (f) => bindings.get(f),
  });
  const resolve = (file: string, call: CallSpec) =>
    resolver.resolveCall({ filePath: file, ...call });
  return { resolver, bindings, calls, resolve };
}

describe("extractPythonBindings", () => {
  it("reads every binding form", () => {
    const source = `
import os
import a.b.c
import d.e as de
from pkg import item
from pkg.sub import one as uno, two
from . import sibling
from ..pkg import up
from x import *
`;
    const bindings = extractPythonBindings(source);
    expect(bindings).toEqual(
      expect.arrayContaining([
        { local: "os", module: "os", imported: "*" },
        { local: "a", module: "a.b.c", imported: "*" },
        { local: "de", module: "d.e", imported: "*" },
        { local: "item", module: "pkg", imported: "item" },
        { local: "uno", module: "pkg.sub", imported: "one" },
        { local: "two", module: "pkg.sub", imported: "two" },
        { local: "sibling", module: ".", imported: "sibling" },
        { local: "up", module: "..pkg", imported: "up" },
        // Star imports carry an empty `local` marker binding.
        { local: "", module: "x", imported: "*" },
      ]),
    );
  });

  it("reads parenthesized and backslash-continued imports", () => {
    const source = `
from pkg import (
    alpha,
    beta as b,
    gamma,
)
from other import one, \\
    two
`;
    const bindings = extractPythonBindings(source);
    expect(bindings).toEqual(
      expect.arrayContaining([
        { local: "alpha", module: "pkg", imported: "alpha" },
        { local: "b", module: "pkg", imported: "beta" },
        { local: "gamma", module: "pkg", imported: "gamma" },
        { local: "one", module: "other", imported: "one" },
        { local: "two", module: "other", imported: "two" },
      ]),
    );
  });

  it("ignores import-looking text inside strings and comments", () => {
    const source = `
# from ghost import thing
text = """
from ghost import other
"""
s = "import phantom"
import real
`;
    const bindings = extractPythonBindings(source);
    expect(bindings).toEqual([{ local: "real", module: "real", imported: "*" }]);
  });

  it("scopes function-local imports and marks them as scoped", () => {
    const source = `import real_a

def f():
    import real_b as real_a
    real_a.go()

def g():
    real_a.go()
`;
    const syms = parsePython(source).definedSymbols ?? [];
    const bindings = extractPythonBindings(source, syms);
    const scoped = bindings.find((b) => b.module === "real_b");
    expect(scoped?.scopeStart).toBeDefined();
    expect(scoped?.scopeEnd).toBeDefined();
    const moduleLevel = bindings.find((b) => b.module === "real_a");
    expect(moduleLevel?.scopeStart).toBeUndefined();
  });
});

describe("createPythonModuleResolver", () => {
  const files = [
    "src/app/__init__.py",
    "src/app/models.py",
    "src/tests/test_models.py",
    "pkg/__init__.py",
    "pkg/logging.py",
    "pkg/user.py",
    "top.py",
    "both.py",
    "both/__init__.py",
  ];
  const { resolveModule } = createPythonModuleResolver(files);

  it("resolves relative levels against the importing package", () => {
    expect(resolveModule("src/app/models.py", ".")).toBe("src/app/__init__.py");
    expect(resolveModule("src/app/models.py", ".sibling")).toBeNull();
    expect(resolveModule("pkg/user.py", ".logging")).toBe("pkg/logging.py");
    expect(resolveModule("src/tests/test_models.py", "..app.models")).toBe("src/app/models.py");
  });

  it("uses nearest non-package ancestor source roots plus workspace root", () => {
    // src/tests is a non-package dir → src/ is a source root → app.models.
    expect(resolveModule("src/tests/test_models.py", "app.models")).toBe("src/app/models.py");
    // workspace root works for top-level modules.
    expect(resolveModule("pkg/user.py", "top")).toBe("top.py");
  });

  it("does not capture package-local modules for outside importers", () => {
    // `logging` inside the pkg package is only reachable as pkg.logging.
    // Bare `import logging` resolves against source roots only — a sibling
    // inside the same package is NOT visible to absolute imports.
    expect(resolveModule("top.py", "logging")).toBeNull();
    expect(resolveModule("pkg/user.py", "logging")).toBeNull();
    expect(resolveModule("pkg/user.py", ".logging")).toBe("pkg/logging.py");
  });

  it("treats a root holding both a.py and a/__init__.py as ambiguous", () => {
    expect(resolveModule("top.py", "both")).toBeNull();
  });
});

describe("createPythonResolver — bare calls", () => {
  it("walks enclosing function scopes, skips class scopes, then module scope", () => {
    const { resolve } = makeResolver({
      "main.py": `
def outer():
    def inner():
        return helper()
    return inner()

class K:
    x = helper()

def helper():
    pass
`,
    });
    // inner's call sees enclosing function scope then module → helper
    expect(resolve("main.py", { callerName: "outer::inner", calleeName: "helper" })).toEqual({
      filePath: "main.py",
      symbolName: "helper",
    });
    // class-body call: class scope skipped → module-scope helper
    expect(resolve("main.py", { callerName: "K", calleeName: "helper" })).toEqual({
      filePath: "main.py",
      symbolName: "helper",
    });
  });

  it("drops bare calls that resolve to zero or multiple symbols", () => {
    const { resolve } = makeResolver({
      "main.py": `
def dup():
    pass

def dup():
    pass

def caller():
    dup()
    missing()
`,
    });
    expect(resolve("main.py", { callerName: "caller", calleeName: "dup" })).toBeNull();
    expect(resolve("main.py", { callerName: "caller", calleeName: "missing" })).toBeNull();
  });
});

describe("createPythonResolver — shadowing", () => {
  it("drops calls shadowed by params, assignments, loops, with/except, walrus", () => {
    const files = {
      "helpers.py": `def f():\n    pass\n`,
      "main.py": `from helpers import f

def run(param_target):
    f = lambda: None
    f()
    for loop_t in []:
        loop_t()
    with open_ctx() as ctx:
        ctx()
    if (walrus_t := 1):
        walrus_t()
    param_target()
    try:
        pass
    except E as exc_t:
        exc_t()
`,
    };
    const { resolve, calls } = makeResolver(files);
    const marked = calls
      .get("main.py")!
      .filter((c) => c.shadowedLocal)
      .map((c) => c.calleeName);
    expect(marked).toEqual(
      expect.arrayContaining(["f", "loop_t", "ctx", "walrus_t", "param_target", "exc_t"]),
    );
    expect(
      resolve("main.py", { callerName: "run", calleeName: "f", shadowedLocal: true }),
    ).toBeNull();
  });

  it("function-scoped imports shadow for calls inside that function only", () => {
    const files = {
      "a.py": `def go():\n    pass\n`,
      "b.py": `def go():\n    pass\n`,
      "main.py": `import a

def f():
    import b as a
    a.go()

def g():
    a.go()
`,
    };
    const { resolve } = makeResolver(files);
    // Both bindings of `a` exist → conflict drops both call sites.
    expect(resolve("main.py", { callerName: "f", calleeName: "a.go" })).toBeNull();
    expect(resolve("main.py", { callerName: "g", calleeName: "a.go" })).toBeNull();
  });

  it("self/cls calls are exempt from shadow marks", () => {
    const files = {
      "main.py": `class K:
    def m(self):
        pass
    def run(self):
        self = get_k()
        self.m()
        cls.build()
`,
    };
    const { calls } = makeResolver(files);
    const selfCall = calls.get("main.py")!.find((c) => c.calleeName === "self.m");
    expect(selfCall?.shadowedLocal).toBeUndefined();
  });
});

describe("createPythonResolver — dotted and receiver calls", () => {
  const files = {
    "helpers.py": `def project_view():
    pass

class X:
    def as_view():
        pass
`,
    "pkg/__init__.py": `from .mod import thing
`,
    "pkg/mod.py": `def thing():
    pass
`,
    "cycle_a.py": `from cycle_b import b_thing
`,
    "cycle_b.py": `from cycle_a import a_thing
`,
    "main.py": `from helpers import project_view, X
from pkg import thing

def run():
    project_view()
    X()
    X.as_view()
    thing()
    helpers.missing()
`,
  };

  it("resolves imported names, Class(), Class.method(), and re-exports", () => {
    const { resolve } = makeResolver(files);
    expect(resolve("main.py", { callerName: "run", calleeName: "project_view" })).toEqual({
      filePath: "helpers.py",
      symbolName: "project_view",
    });
    expect(resolve("main.py", { callerName: "run", calleeName: "X" })).toEqual({
      filePath: "helpers.py",
      symbolName: "X",
    });
    expect(resolve("main.py", { callerName: "run", calleeName: "X.as_view" })).toEqual({
      filePath: "helpers.py",
      symbolName: "X::as_view",
    });
    expect(resolve("main.py", { callerName: "run", calleeName: "thing" })).toEqual({
      filePath: "pkg/mod.py",
      symbolName: "thing",
    });
  });

  it("drops unbound dotted calls", () => {
    const { resolve } = makeResolver(files);
    // `helpers` is not imported in main.py — the root cannot bind.
    expect(resolve("main.py", { callerName: "run", calleeName: "helpers.missing" })).toBeNull();
  });

  it("re-export cycles terminate and produce no edge", () => {
    const { resolve } = makeResolver(files);
    // a_thing re-exported through a cycle never resolves to a real symbol.
    const withCycle = makeResolver({
      "cycle_a.py": files["cycle_a.py"],
      "cycle_b.py": files["cycle_b.py"],
      "user.py": `from cycle_a import a_thing\n\ndef u():\n    a_thing()\n`,
    });
    expect(withCycle.resolve("user.py", { callerName: "u", calleeName: "a_thing" })).toBeNull();
  });

  it("self.m() and cls.m() resolve only on the enclosing class", () => {
    const { resolve } = makeResolver({
      "main.py": `class K:
    def m(self):
        pass
    def caller(self):
        self.m()
        cls.m()
        self.other_thing()

def outside():
    self.m()
`,
    });
    expect(resolve("main.py", { callerName: "K::caller", calleeName: "self.m" })).toEqual({
      filePath: "main.py",
      symbolName: "K::m",
    });
    expect(resolve("main.py", { callerName: "K::caller", calleeName: "cls.m" })).toEqual({
      filePath: "main.py",
      symbolName: "K::m",
    });
    expect(
      resolve("main.py", { callerName: "K::caller", calleeName: "self.other_thing" }),
    ).toBeNull();
    // self outside a class method resolves nothing.
    expect(resolve("main.py", { callerName: "outside", calleeName: "self.m" })).toBeNull();
  });

  it("star imports never expand to call targets", () => {
    const { resolve } = makeResolver({
      "mod.py": `def go():
    pass
`,
      "main.py": `from mod import *

def run():
    go()
`,
    });
    expect(resolve("main.py", { callerName: "run", calleeName: "go" })).toBeNull();
  });
});
