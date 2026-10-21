import { describe, expect, test } from "bun:test";

import { createJavaResolver, type JavaResolverFile } from "../packages/indexer/src/java-resolver";

/** Build a file entry: package name → package symbol, plus member symbols. */
function file(
  filePath: string,
  packageName: string,
  symbols: Array<[string, string]>,
  importPaths: string[] = [],
): JavaResolverFile {
  return {
    filePath,
    symbols: [
      ...(packageName ? [{ name: packageName, symbolType: "package" }] : []),
      ...symbols.map(([name, symbolType]) => ({ name, symbolType })),
    ],
    importPaths,
  };
}

const CALL = { function: "function", class: "class", field: "field" };

describe("java-resolver bare and this calls", () => {
  const files = [
    file("src/a/Outer.java", "a", [
      ["Outer", CALL.class],
      ["Outer::caller", CALL.function],
      ["Outer::helper", CALL.function],
      ["Outer::Inner", CALL.class],
      ["Outer::Inner::deep", CALL.function],
    ]),
  ];
  const resolver = createJavaResolver(files);
  const at = (callerName: string, calleeName: string) =>
    resolver.resolveCall({ filePath: "src/a/Outer.java", callerName, calleeName });

  test("bare call resolves to the unique innermost-type method", () => {
    expect(at("Outer::caller", "helper")).toEqual({
      filePath: "src/a/Outer.java",
      symbolName: "Outer::helper",
    });
  });

  test("this call resolves the same way", () => {
    expect(at("Outer::caller", "this.helper")).toEqual({
      filePath: "src/a/Outer.java",
      symbolName: "Outer::helper",
    });
  });

  test("a nested type's bare call resolves inside itself, not outward", () => {
    expect(at("Outer::Inner::deep", "helper")).toBeNull();
    expect(at("Outer::Inner::deep", "deep")).toEqual({
      filePath: "src/a/Outer.java",
      symbolName: "Outer::Inner::deep",
    });
  });

  test("calls attributed to the type itself resolve in that type", () => {
    expect(at("Outer", "helper")).toEqual({
      filePath: "src/a/Outer.java",
      symbolName: "Outer::helper",
    });
  });

  test("unknown names produce no edge", () => {
    expect(at("Outer::caller", "missing")).toBeNull();
    expect(at("Outer::caller", "this.missing")).toBeNull();
  });
});

describe("java-resolver overload and member blocking", () => {
  const files = [
    file("src/a/Over.java", "a", [
      ["Over", CALL.class],
      ["Over::target", CALL.function],
      ["Over::go", CALL.function],
      ["Over::field", CALL.field],
    ]),
    file("src/a/Over2.java", "a", [
      ["Over", CALL.class], // duplicate type name across files? same file only matters per-file
    ]),
    file(
      "src/a/Static.java",
      "a",
      [
        ["Statics", CALL.class],
        ["Statics::go", CALL.function],
      ],
      ["static a.Over.target"],
    ),
  ];
  const resolver = createJavaResolver(files);

  test("overloaded same-name methods never resolve", () => {
    const files2 = [
      file("src/a/O.java", "a", [
        ["O", CALL.class],
        ["O::t", CALL.function],
        ["O::t2", CALL.function],
      ]),
    ];
    // two methods named t can't be distinguished by symbol label — a file with
    // both `O::t` entries counts 2 → ambiguous
    const r = createJavaResolver([
      file("src/a/O.java", "a", [
        ["O", CALL.class],
        ["O::t", CALL.function],
        ["O::t", CALL.function],
        ["O::go", CALL.function],
      ]),
    ]);
    expect(
      r.resolveCall({ filePath: "src/a/O.java", callerName: "O::go", calleeName: "t" }),
    ).toBeNull();
  });

  test("a member declaration in the enclosing type blocks a static import", () => {
    const r = createJavaResolver([
      file(
        "src/a/B.java",
        "a",
        [
          ["B", CALL.class],
          ["B::format", CALL.function],
          ["B::go", CALL.function],
        ],
        ["static x.Util.format"],
      ),
      file("src/x/Util.java", "x", [
        ["Util", CALL.class],
        ["Util::format", CALL.function],
      ]),
    ]);
    expect(
      r.resolveCall({ filePath: "src/a/B.java", callerName: "B::go", calleeName: "format" }),
    ).toEqual({ filePath: "src/a/B.java", symbolName: "B::format" });
  });

  test("an outer-type member blocks a static import for nested callers", () => {
    const r = createJavaResolver([
      file(
        "src/a/B.java",
        "a",
        [
          ["B", CALL.class],
          ["B::format", CALL.function],
          ["B::Inner", CALL.class],
          ["B::Inner::go", CALL.function],
        ],
        ["static x.Util.format"],
      ),
      file("src/x/Util.java", "x", [
        ["Util", CALL.class],
        ["Util::format", CALL.function],
      ]),
    ]);
    expect(
      r.resolveCall({ filePath: "src/a/B.java", callerName: "B::Inner::go", calleeName: "format" }),
    ).toBeNull();
  });

  test("a single static import resolves a bare call", () => {
    const r = createJavaResolver([
      file(
        "src/a/S.java",
        "a",
        [
          ["S", CALL.class],
          ["S::go", CALL.function],
        ],
        ["static x.Util.format"],
      ),
      file("src/x/Util.java", "x", [
        ["Util", CALL.class],
        ["Util::format", "static_function"],
      ]),
    ]);
    expect(
      r.resolveCall({ filePath: "src/a/S.java", callerName: "S::go", calleeName: "format" }),
    ).toEqual({ filePath: "src/x/Util.java", symbolName: "Util::format" });
  });

  test("a static import never resolves an instance method", () => {
    const r = createJavaResolver([
      file(
        "src/a/S.java",
        "a",
        [
          ["S", CALL.class],
          ["S::go", CALL.function],
        ],
        ["static x.Util.inst"],
      ),
      file("src/x/Util.java", "x", [
        ["Util", CALL.class],
        ["Util::inst", CALL.function],
      ]),
    ]);
    expect(
      r.resolveCall({ filePath: "src/a/S.java", callerName: "S::go", calleeName: "inst" }),
    ).toBeNull();
  });

  test("a static import binds the static overload, not the instance one", () => {
    const r = createJavaResolver([
      file(
        "src/a/S.java",
        "a",
        [
          ["S", CALL.class],
          ["S::go", CALL.function],
        ],
        ["static x.Util.fmt"],
      ),
      file("src/x/Util.java", "x", [
        ["Util", CALL.class],
        ["Util::fmt", "static_function"],
        ["Util::fmt", CALL.function],
      ]),
    ]);
    expect(
      r.resolveCall({ filePath: "src/a/S.java", callerName: "S::go", calleeName: "fmt" }),
    ).toEqual({ filePath: "src/x/Util.java", symbolName: "Util::fmt" });
  });

  test("two static overloads under one static import stay ambiguous", () => {
    const r = createJavaResolver([
      file(
        "src/a/S.java",
        "a",
        [
          ["S", CALL.class],
          ["S::go", CALL.function],
        ],
        ["static x.Util.fmt"],
      ),
      file("src/x/Util.java", "x", [
        ["Util", CALL.class],
        ["Util::fmt", "static_function"],
        ["Util::fmt", "static_function"],
      ]),
    ]);
    expect(
      r.resolveCall({ filePath: "src/a/S.java", callerName: "S::go", calleeName: "fmt" }),
    ).toBeNull();
  });

  test("same-type lookup still resolves both instance and static methods", () => {
    const r = createJavaResolver([
      file("src/a/S.java", "a", [
        ["S", CALL.class],
        ["S::go", CALL.function],
        ["S::inst", CALL.function],
        ["S::stat", "static_function"],
      ]),
    ]);
    const at = (calleeName: string) =>
      r.resolveCall({ filePath: "src/a/S.java", callerName: "S::go", calleeName });
    expect(at("inst")).toEqual({ filePath: "src/a/S.java", symbolName: "S::inst" });
    expect(at("stat")).toEqual({ filePath: "src/a/S.java", symbolName: "S::stat" });
    expect(at("this.stat")).toEqual({ filePath: "src/a/S.java", symbolName: "S::stat" });
  });

  test("external static imports produce no edge", () => {
    const r = createJavaResolver([
      file(
        "src/a/S.java",
        "a",
        [
          ["S", CALL.class],
          ["S::go", CALL.function],
        ],
        ["static java.lang.Math.max"],
      ),
    ]);
    expect(
      r.resolveCall({ filePath: "src/a/S.java", callerName: "S::go", calleeName: "max" }),
    ).toBeNull();
  });
});

describe("java-resolver type-qualified calls", () => {
  const base: JavaResolverFile[] = [
    file("src/app/Util.java", "app", [
      ["Util", CALL.class],
      ["Util::format", CALL.function],
    ]),
    file("src/app/Outer.java", "app", [
      ["Outer", CALL.class],
      ["Outer::Inner", CALL.class],
      ["Outer::Inner::act", CALL.function],
      ["Outer::caller", CALL.function],
    ]),
  ];

  test("simple qualifier resolves via explicit single-type import", () => {
    const r = createJavaResolver([
      ...base,
      file(
        "src/shop/S.java",
        "shop",
        [
          ["S", CALL.class],
          ["S::go", CALL.function],
        ],
        ["app.Util"],
      ),
    ]);
    expect(
      r.resolveCall({
        filePath: "src/shop/S.java",
        callerName: "S::go",
        calleeName: "Util.format",
      }),
    ).toEqual({ filePath: "src/app/Util.java", symbolName: "Util::format" });
  });

  test("simple qualifier resolves via same-package type", () => {
    const r = createJavaResolver([
      ...base,
      file("src/app/S.java", "app", [
        ["S", CALL.class],
        ["S::go", CALL.function],
      ]),
    ]);
    expect(
      r.resolveCall({ filePath: "src/app/S.java", callerName: "S::go", calleeName: "Util.format" }),
    ).toEqual({ filePath: "src/app/Util.java", symbolName: "Util::format" });
  });

  test("simple qualifier resolves a member type of the enclosing type", () => {
    const r = createJavaResolver(base);
    expect(
      r.resolveCall({
        filePath: "src/app/Outer.java",
        callerName: "Outer::caller",
        calleeName: "Inner.act",
      }),
    ).toEqual({ filePath: "src/app/Outer.java", symbolName: "Outer::Inner::act" });
  });

  test("file's own top-level type beats single-type import", () => {
    const r = createJavaResolver([
      ...base,
      file(
        "src/app/S.java",
        "app",
        [
          ["S", CALL.class],
          ["S::go", CALL.function],
          ["Util", CALL.class],
          ["Util::format", CALL.function],
        ],
        ["app.Util"],
      ),
    ]);
    expect(
      r.resolveCall({ filePath: "src/app/S.java", callerName: "S::go", calleeName: "Util.format" }),
    ).toEqual({ filePath: "src/app/S.java", symbolName: "Util::format" });
  });

  test("external single-type import reserves the name — no same-package fallthrough", () => {
    const r = createJavaResolver([
      file("src/shop/Util.java", "shop", [
        ["Util", CALL.class],
        ["Util::format", CALL.function],
      ]),
      file(
        "src/shop/S.java",
        "shop",
        [
          ["S", CALL.class],
          ["S::go", CALL.function],
        ],
        ["java.util.Util"],
      ),
    ]);
    expect(
      r.resolveCall({
        filePath: "src/shop/S.java",
        callerName: "S::go",
        calleeName: "Util.format",
      }),
    ).toBeNull();
  });

  test("wildcard imports do not authorize a call edge", () => {
    const r = createJavaResolver([
      ...base,
      file(
        "src/shop/S.java",
        "shop",
        [
          ["S", CALL.class],
          ["S::go", CALL.function],
        ],
        ["app.*"],
      ),
    ]);
    expect(
      r.resolveCall({
        filePath: "src/shop/S.java",
        callerName: "S::go",
        calleeName: "Util.format",
      }),
    ).toBeNull();
  });

  test("dotted receivers must equal the package-qualified type name", () => {
    const r = createJavaResolver(base);
    // Outer.Inner.act is not package-qualified — no edge
    expect(
      r.resolveCall({
        filePath: "src/app/Outer.java",
        callerName: "Outer::caller",
        calleeName: "Outer.Inner.act",
      }),
    ).toBeNull();
    expect(
      r.resolveCall({
        filePath: "src/app/Outer.java",
        callerName: "Outer::caller",
        calleeName: "app.Outer.Inner.act",
      }),
    ).toEqual({ filePath: "src/app/Outer.java", symbolName: "Outer::Inner::act" });
  });

  test("ambiguous same-package types drop the call", () => {
    const r = createJavaResolver([
      file("src/dup/a/Shared.java", "dup", [
        ["Shared", CALL.class],
        ["Shared::m", CALL.function],
      ]),
      file("src/dup/b/Shared.java", "dup", [
        ["Shared", CALL.class],
        ["Shared::m", CALL.function],
      ]),
      file("src/dup/Caller.java", "dup", [
        ["Caller", CALL.class],
        ["Caller::go", CALL.function],
      ]),
    ]);
    expect(
      r.resolveCall({
        filePath: "src/dup/Caller.java",
        callerName: "Caller::go",
        calleeName: "Shared.m",
      }),
    ).toBeNull();
  });

  test("inherited members never resolve", () => {
    const r = createJavaResolver([
      file("src/a/Base.java", "a", [
        ["Base", CALL.class],
        ["Base::m", CALL.function],
      ]),
      file("src/a/Sub.java", "a", [
        ["Sub", CALL.class],
        ["Sub::go", CALL.function],
      ]),
    ]);
    // Sub extends Base conceptually, but m is not declared on Sub → no edge
    expect(
      r.resolveCall({ filePath: "src/a/Sub.java", callerName: "Sub::go", calleeName: "m" }),
    ).toBeNull();
    expect(
      r.resolveCall({ filePath: "src/a/Sub.java", callerName: "Sub::go", calleeName: "this.m" }),
    ).toBeNull();
  });
});

describe("java-resolver import edges", () => {
  const files: JavaResolverFile[] = [
    file("src/app/Util.java", "app", [
      ["Util", CALL.class],
      ["Util::format", CALL.function],
    ]),
    file("src/app/Outer.java", "app", [
      ["Outer", CALL.class],
      ["Outer::Inner", CALL.class],
    ]),
    file(
      "src/shop/S.java",
      "shop",
      [["S", CALL.class]],
      [
        "app.Util",
        "app.Outer.Inner",
        "static app.Util.format",
        "app.*",
        "java.util.List",
        "static java.lang.Math.*",
      ],
    ),
  ];
  const r = createJavaResolver(files);

  test("explicit single-type imports map to the declaring file", () => {
    expect(r.resolveImport("src/shop/S.java", "app.Util")).toBe("src/app/Util.java");
  });

  test("nested-type imports resolve to the nested type's file", () => {
    expect(r.resolveImport("src/shop/S.java", "app.Outer.Inner")).toBe("src/app/Outer.java");
  });

  test("explicit static imports resolve to the member's file", () => {
    expect(r.resolveImport("src/shop/S.java", "static app.Util.format")).toBe("src/app/Util.java");
  });

  test("wildcard and external imports produce no edge", () => {
    expect(r.resolveImport("src/shop/S.java", "app.*")).toBeNull();
    expect(r.resolveImport("src/shop/S.java", "java.util.List")).toBeNull();
    expect(r.resolveImport("src/shop/S.java", "static java.lang.Math.*")).toBeNull();
  });
});

describe("java-resolver conflicting imports", () => {
  const utilA = file("src/app/Util.java", "app", [
    ["Util", CALL.class],
    ["Util::format", CALL.function],
  ]);
  const utilB = file("src/other/Util.java", "other", [
    ["Util", CALL.class],
    ["Util::format", CALL.function],
  ]);
  const callerWith = (importPaths: string[]) =>
    file(
      "src/shop/S.java",
      "shop",
      [
        ["S", CALL.class],
        ["S::go", CALL.function],
      ],
      importPaths,
    );

  test("conflicting single-type imports resolve to null in either order", () => {
    for (const importPaths of [
      ["app.Util", "other.Util"],
      ["other.Util", "app.Util"],
    ]) {
      const r = createJavaResolver([utilA, utilB, callerWith(importPaths)]);
      expect(
        r.resolveCall({
          filePath: "src/shop/S.java",
          callerName: "S::go",
          calleeName: "Util.format",
        }),
      ).toBeNull();
    }
  });

  test("conflicting single-type imports never fall back to same-package types", () => {
    const r = createJavaResolver([
      utilA,
      file("src/shop/Util.java", "shop", [
        ["Util", CALL.class],
        ["Util::format", CALL.function],
      ]),
      callerWith(["app.Util", "other.Util"]),
    ]);
    expect(
      r.resolveCall({
        filePath: "src/shop/S.java",
        callerName: "S::go",
        calleeName: "Util.format",
      }),
    ).toBeNull();
  });

  test("one external plus one workspace import of the same name is a conflict", () => {
    const r = createJavaResolver([utilA, callerWith(["app.Util", "java.util.Util"])]);
    expect(
      r.resolveCall({
        filePath: "src/shop/S.java",
        callerName: "S::go",
        calleeName: "Util.format",
      }),
    ).toBeNull();
  });

  test("duplicate identical single-type imports still resolve", () => {
    const r = createJavaResolver([utilA, callerWith(["app.Util", "app.Util"])]);
    expect(
      r.resolveCall({
        filePath: "src/shop/S.java",
        callerName: "S::go",
        calleeName: "Util.format",
      }),
    ).toEqual({ filePath: "src/app/Util.java", symbolName: "Util::format" });
  });

  test("conflicting static imports resolve to null in either order", () => {
    for (const importPaths of [
      ["static app.Util.format", "static other.Util.format"],
      ["static other.Util.format", "static app.Util.format"],
    ]) {
      const r = createJavaResolver([utilA, utilB, callerWith(importPaths)]);
      expect(
        r.resolveCall({ filePath: "src/shop/S.java", callerName: "S::go", calleeName: "format" }),
      ).toBeNull();
    }
  });

  test("conflicting static imports of distinct member names resolve independently", () => {
    const withTwo = file("src/app/Util.java", "app", [
      ["Util", CALL.class],
      ["Util::format", CALL.function],
      ["Util::parse", "static_function"],
    ]);
    const r = createJavaResolver([
      withTwo,
      utilB,
      callerWith(["static app.Util.format", "static other.Util.format", "static app.Util.parse"]),
    ]);
    expect(
      r.resolveCall({ filePath: "src/shop/S.java", callerName: "S::go", calleeName: "format" }),
    ).toBeNull();
    expect(
      r.resolveCall({ filePath: "src/shop/S.java", callerName: "S::go", calleeName: "parse" }),
    ).toEqual({ filePath: "src/app/Util.java", symbolName: "Util::parse" });
  });

  test("duplicate identical static imports still resolve", () => {
    const staticUtilA = file("src/app/Util.java", "app", [
      ["Util", CALL.class],
      ["Util::format", "static_function"],
    ]);
    const r = createJavaResolver([
      staticUtilA,
      callerWith(["static app.Util.format", "static app.Util.format"]),
    ]);
    expect(
      r.resolveCall({ filePath: "src/shop/S.java", callerName: "S::go", calleeName: "format" }),
    ).toEqual({ filePath: "src/app/Util.java", symbolName: "Util::format" });
  });

  test("import edges still map each explicit specifier to its own file", () => {
    const r = createJavaResolver([utilA, utilB, callerWith(["app.Util", "other.Util"])]);
    expect(r.resolveImport("src/shop/S.java", "app.Util")).toBe("src/app/Util.java");
    expect(r.resolveImport("src/shop/S.java", "other.Util")).toBe("src/other/Util.java");
  });
});
