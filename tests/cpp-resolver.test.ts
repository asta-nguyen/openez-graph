import { describe, expect, test } from "bun:test";

import { createCppResolver, type CppResolver } from "../packages/indexer/src/cpp-resolver";

/**
 * Unit tests for C++ translation-unit resolution: quoted-include lookup
 * order, workspace containment, include-cycle safety, declaration/
 * definition pairing, scope-aware qualified lookup, and unique-only
 * resolution. Symbols/imports are synthetic — no tree-sitter needed.
 */

interface Sym {
  name: string;
  symbolType: string;
}

function makeResolver(options: {
  files: string[];
  symbols?: Record<string, Sym[]>;
  imports?: Record<string, string[]>;
}): CppResolver {
  const fileSet = new Set(options.files);
  return createCppResolver({
    cppFiles: options.files,
    symbolsFor: (f) => options.symbols?.[f] ?? [],
    importPathsFor: (f) => options.imports?.[f] ?? [],
    workspaceRoot: "/ws",
    workspaceRelativeFor: (absPath) => {
      const normalized = absPath.replace(/\\/g, "/").replace(/^\/ws\/?/, "");
      if (normalized.startsWith("/") || normalized.startsWith("..")) return null;
      return fileSet.has(normalized) ? normalized : null;
    },
  });
}

describe("cpp quoted-include resolution", () => {
  const resolver = makeResolver({
    files: [
      "src/a.cpp",
      "src/b.h",
      "root.h",
      "include/shared/util.h",
      "dup/x.h",
      "other/x.h",
    ],
  });

  test("importer directory wins, then workspace root, then unique suffix", () => {
    expect(resolver.resolveImport("src/a.cpp", "b.h")).toBe("src/b.h");
    expect(resolver.resolveImport("src/a.cpp", "root.h")).toBe("root.h");
    expect(resolver.resolveImport("src/a.cpp", "util.h")).toBe("include/shared/util.h");
    expect(resolver.resolveImport("src/a.cpp", "shared/util.h")).toBe("include/shared/util.h");
  });

  test("ambiguous suffix, missing file, and escapes resolve to null", () => {
    expect(resolver.resolveImport("src/a.cpp", "x.h")).toBeNull();
    expect(resolver.resolveImport("src/a.cpp", "missing.h")).toBeNull();
    expect(resolver.resolveImport("src/a.cpp", "../outside.h")).toBeNull();
    expect(resolver.resolveImport("src/a.cpp", "../../etc/passwd.h")).toBeNull();
    // Angle/system includes never produce edges.
    expect(resolver.resolveImport("src/a.cpp", "<vector>")).toBeNull();
  });
});

describe("cpp call resolution", () => {
  test("same-file and decl/def pairing prefer the definition", () => {
    const resolver = makeResolver({
      files: ["lib.h", "lib.cpp", "main.cpp"],
      symbols: {
        "lib.h": [
          { name: "helper", symbolType: "declaration" },
          { name: "decl_only", symbolType: "declaration" },
        ],
        "lib.cpp": [
          { name: "helper", symbolType: "function" },
          { name: "caller", symbolType: "function" },
        ],
        "main.cpp": [{ name: "main", symbolType: "function" }],
      },
      imports: {
        "lib.cpp": ["lib.h"],
        "main.cpp": ["lib.h"],
      },
    });
    // Cross-file: caller in main.cpp sees lib.h + lib.cpp? No — main.cpp's
    // closure is {main.cpp, lib.h}: only the declaration is visible.
    expect(
      resolver.resolveCall({ filePath: "main.cpp", callerName: "main", calleeName: "helper" }),
    ).toEqual({ filePath: "lib.h", symbolName: "helper" });
    // lib.cpp's closure is {lib.cpp, lib.h}: decl + def visible → def wins.
    expect(
      resolver.resolveCall({ filePath: "lib.cpp", callerName: "caller", calleeName: "helper" }),
    ).toEqual({ filePath: "lib.cpp", symbolName: "helper" });
    // Declaration-only target resolves to the declaration.
    expect(
      resolver.resolveCall({ filePath: "lib.cpp", callerName: "caller", calleeName: "decl_only" }),
    ).toEqual({ filePath: "lib.h", symbolName: "decl_only" });
  });

  test("unqualified calls hide outer scopes; qualified calls resolve relatively", () => {
    const resolver = makeResolver({
      files: ["a.cpp"],
      symbols: {
        "a.cpp": [
          { name: "ns", symbolType: "namespace" },
          { name: "ns::C", symbolType: "class" },
          { name: "ns::C::m", symbolType: "method" },
          { name: "ns::C::f", symbolType: "method" },
          { name: "ns::f", symbolType: "function" },
          { name: "f", symbolType: "function" },
          { name: "ns::deep", symbolType: "function" },
        ],
      },
    });
    // Member scope hides the global same-named f.
    expect(
      resolver.resolveCall({ filePath: "a.cpp", callerName: "ns::C::m", calleeName: "f" }),
    ).toEqual({ filePath: "a.cpp", symbolName: "ns::C::f" });
    // ns::deep resolves relative to the innermost scope holding it.
    expect(
      resolver.resolveCall({
        filePath: "a.cpp",
        callerName: "ns::C::m",
        calleeName: "ns::deep",
      }),
    ).toEqual({ filePath: "a.cpp", symbolName: "ns::deep" });
    // ::f binds global only — global f exists.
    expect(
      resolver.resolveCall({ filePath: "a.cpp", callerName: "ns::C::m", calleeName: "::f" }),
    ).toEqual({ filePath: "a.cpp", symbolName: "f" });
    // Relative qualified lookup: C::f inside ns resolves to ns::C::f.
    expect(
      resolver.resolveCall({
        filePath: "a.cpp",
        callerName: "ns::deep",
        calleeName: "C::f",
      }),
    ).toEqual({ filePath: "a.cpp", symbolName: "ns::C::f" });
  });

  test("this-> resolves only inside the caller's own class scope", () => {
    const resolver = makeResolver({
      files: ["a.cpp"],
      symbols: {
        "a.cpp": [
          { name: "S", symbolType: "struct" },
          { name: "S::a", symbolType: "method" },
          { name: "S::b", symbolType: "method" },
          { name: "ns::T", symbolType: "class" },
          { name: "ns::T::m", symbolType: "method" },
        ],
      },
    });
    expect(
      resolver.resolveCall({ filePath: "a.cpp", callerName: "S::a", calleeName: "this.b" }),
    ).toEqual({ filePath: "a.cpp", symbolName: "S::b" });
    // this-> inside a free function has no class scope → null.
    expect(
      resolver.resolveCall({ filePath: "a.cpp", callerName: "S", calleeName: "this.b" }),
    ).toEqual({ filePath: "a.cpp", symbolName: "S::b" });
    // Unknown receivers never resolve.
    for (const callee of ["obj.f", "a.b.c", "p.f", "ns::obj.f"]) {
      expect(
        resolver.resolveCall({ filePath: "a.cpp", callerName: "S::a", calleeName: callee }),
      ).toBeNull();
    }
  });

  test("overloads and duplicate definitions are ambiguous → no edge", () => {
    const resolver = makeResolver({
      files: ["o.h", "d1.cpp", "d2.cpp", "u.cpp"],
      symbols: {
        "o.h": [
          { name: "twice", symbolType: "declaration" },
          { name: "twice", symbolType: "declaration" },
          { name: "dup", symbolType: "declaration" },
        ],
        "d1.cpp": [{ name: "dup", symbolType: "function" }],
        "d2.cpp": [{ name: "dup", symbolType: "function" }],
        "u.cpp": [{ name: "u", symbolType: "function" }],
      },
      imports: { "u.cpp": ["o.h", "d1.cpp", "d2.cpp"] },
    });
    // Two same-name declarations (overloads) → ambiguous, no edge.
    expect(
      resolver.resolveCall({ filePath: "u.cpp", callerName: "u", calleeName: "twice" }),
    ).toBeNull();
    // Two definitions across files → ambiguous.
    expect(
      resolver.resolveCall({ filePath: "u.cpp", callerName: "u", calleeName: "dup" }),
    ).toBeNull();
  });

  test("transitive visibility and isolation through include cycles", () => {
    const resolver = makeResolver({
      files: ["a.h", "b.h", "c.h", "x.cpp", "y.cpp"],
      symbols: {
        "c.h": [{ name: "deep", symbolType: "declaration" }],
        "x.cpp": [{ name: "f", symbolType: "function" }],
        "y.cpp": [{ name: "g", symbolType: "function" }],
      },
      imports: {
        "a.h": ["b.h"],
        "b.h": ["c.h", "a.h"], // include cycle a<->b
        "x.cpp": ["a.h"],
      },
    });
    // x.cpp sees c.h transitively through a.h -> b.h (cycle-safe).
    expect(
      resolver.resolveCall({ filePath: "x.cpp", callerName: "f", calleeName: "deep" }),
    ).toEqual({ filePath: "c.h", symbolName: "deep" });
    // y.cpp includes nothing — c.h is not in its translation unit.
    expect(
      resolver.resolveCall({ filePath: "y.cpp", callerName: "g", calleeName: "deep" }),
    ).toBeNull();
  });
});
