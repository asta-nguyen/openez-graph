import { describe, expect, it } from "bun:test";

import { OxcParser } from "../packages/indexer/src/parsers/oxc-parser";

describe("OxcParser", () => {
  it("extracts TS declarations, calls, and import bindings", () => {
    const result = new OxcParser().parse(
      {
        relativePath: "example.ts",
        absolutePath: "/tmp/example.ts",
        content: [
          'import { fetchData as fetch } from "./api";',
          'import * as api from "./api";',
          "",
          "interface User { id: string }",
          "type UserId = string;",
          "enum Status { Ready }",
          "",
          "function caller() {",
          "  fetch();",
          "  api.save();",
          "}",
          "",
          "function helper() {}",
        ].join("\n"),
        targetTokens: 500,
        overlapTokens: 50,
      },
      "typescript",
      "code",
    );

    expect(result.definedSymbols.map((symbol) => symbol.name)).toEqual(
      expect.arrayContaining(["User", "UserId", "Status", "caller", "helper"]),
    );
    expect(result.definedSymbols.find((symbol) => symbol.name === "User")?.symbolType).toBe(
      "interface",
    );
    expect(result.definedSymbols.find((symbol) => symbol.name === "UserId")?.symbolType).toBe(
      "type",
    );
    expect(result.definedSymbols.find((symbol) => symbol.name === "Status")?.symbolType).toBe(
      "enum",
    );
    expect(result.callExpressions).toEqual(
      expect.arrayContaining([
        { callerName: "caller", calleeName: "fetch", start: expect.any(Number) },
        { callerName: "caller", calleeName: "api.save", start: expect.any(Number) },
      ]),
    );
    expect(result.calledIdentifiers).toEqual(expect.arrayContaining(["fetch", "api.save"]));
  });

  it("attributes nested-function calls to the inner symbol, not the outer one", () => {
    const result = new OxcParser().parse(
      {
        relativePath: "nested.ts",
        absolutePath: "/tmp/nested.ts",
        content: [
          "function outer() {",
          "  function inner() {",
          "    doThing();",
          "  }",
          "  inner();",
          "}",
        ].join("\n"),
        targetTokens: 500,
        overlapTokens: 50,
      },
      "typescript",
      "code",
    );

    // `doThing` belongs to `inner`, not `outer`.
    expect(result.callExpressions).toContainEqual({
      callerName: "outer.inner",
      calleeName: "doThing",
      start: expect.any(Number),
    });
    expect(result.callExpressions).toContainEqual({
      callerName: "outer",
      calleeName: "inner",
      start: expect.any(Number),
      // `inner` is a block-scoped function declaration inside `outer`.
      shadowedLocal: true,
    });
    // `doThing` must NOT be attributed to `outer`.
    expect(
      result.callExpressions.filter((c) => c.callerName === "outer" && c.calleeName === "doThing"),
    ).toHaveLength(0);
  });

  it("emits nested functions and class methods as graphable symbols", () => {
    const content = `
    function outer() { function inner() { helper(); } inner(); }
    class Service { run() { helper(); } }
    function helper() {}
  `;
    const result = new OxcParser().parse(
      {
        relativePath: "symbols.ts",
        absolutePath: "/tmp/symbols.ts",
        content,
        targetTokens: 500,
        overlapTokens: 50,
      },
      "typescript",
      "code",
    );

    expect(result.definedSymbols.map((symbol) => symbol.name)).toEqual(
      expect.arrayContaining(["outer", "outer.inner", "Service", "Service.run", "helper"]),
    );
    expect(result.callExpressions).toContainEqual({
      callerName: "outer.inner",
      calleeName: "helper",
      start: expect.any(Number),
    });
    expect(result.callExpressions).toContainEqual({
      callerName: "Service.run",
      calleeName: "helper",
      start: expect.any(Number),
    });
  });

  it("emits nested arrow functions as graphable symbols", () => {
    const content = `
    function outer() {
      const inner = () => { helper(); };
      inner();
    }
    function helper() {}
  `;
    const result = new OxcParser().parse(
      {
        relativePath: "arrow.ts",
        absolutePath: "/tmp/arrow.ts",
        content,
        targetTokens: 500,
        overlapTokens: 50,
      },
      "typescript",
      "code",
    );

    expect(result.definedSymbols.map((symbol) => symbol.name)).toEqual(
      expect.arrayContaining(["outer", "outer.inner", "helper"]),
    );
    expect(result.callExpressions).toContainEqual({
      callerName: "outer.inner",
      calleeName: "helper",
      start: expect.any(Number),
    });
  });

  it("does not duplicate overloaded or accessor class method names", () => {
    const result = new OxcParser().parse(
      {
        relativePath: "accessors.ts",
        absolutePath: "/tmp/accessors.ts",
        content: `class Box {
  get value() { return 1; }
  set value(next: number) {}
  value(next: number): void;
  value(next: number) {}
}`,
        targetTokens: 500,
        overlapTokens: 50,
      },
      "typescript",
      "code",
    );

    const names = result.definedSymbols.map((symbol) => symbol.name);
    expect(names.filter((name) => name === "Box.value")).toHaveLength(1);
    expect(names).toEqual(expect.arrayContaining(["Box.get.value", "Box.set.value"]));
    expect(new Set(names).size).toBe(names.length);
  });

  it("qualifies duplicate nested names to avoid graph collisions", () => {
    const content = `
    function outer() {
      function helper() { deep(); }
      helper();
    }
    function helper() {}
    function deep() {}
  `;
    const result = new OxcParser().parse(
      {
        relativePath: "dup.ts",
        absolutePath: "/tmp/dup.ts",
        content,
        targetTokens: 500,
        overlapTokens: 50,
      },
      "typescript",
      "code",
    );

    const names = result.definedSymbols.map((symbol) => symbol.name);
    // Top-level `helper` stays as `helper`; nested `helper` is qualified as `outer.helper`
    expect(names).toContain("helper");
    expect(names).toContain("outer.helper");
    expect(names).toContain("deep");
    // The call inside outer.helper is attributed to the nested symbol
    expect(result.callExpressions).toContainEqual({
      callerName: "outer.helper",
      calleeName: "deep",
      start: expect.any(Number),
    });
    // The call from outer() to helper() — at parser level this is still
    // `helper`, but graph resolution will prefer `outer.helper` over the
    // top-level `helper` because of lexical scope (verified in graph tests).
    expect(result.callExpressions).toContainEqual({
      callerName: "outer",
      calleeName: "helper",
      start: expect.any(Number),
      // `helper` is a block-scoped function declaration inside `outer`.
      shadowedLocal: true,
    });
  });

  it("attributes calls inside anonymous callbacks to the nearest named owner", () => {
    const result = new OxcParser().parse(
      {
        relativePath: "callback.ts",
        absolutePath: "/tmp/callback.ts",
        content: [
          "function outer(items: number[]) {",
          "  items.map(() => helper());",
          "}",
          "function helper() {}",
        ].join("\n"),
        targetTokens: 500,
        overlapTokens: 50,
      },
      "typescript",
      "code",
    );

    expect(result.callExpressions).toContainEqual({
      callerName: "outer",
      calleeName: "helper",
      start: expect.any(Number),
    });
  });

  it("normalizes this-method calls to the owning class", () => {
    const result = new OxcParser().parse(
      {
        relativePath: "service.ts",
        absolutePath: "/tmp/service.ts",
        content: "class Service { run() { this.save(); } save() {} }",
        targetTokens: 500,
        overlapTokens: 50,
      },
      "typescript",
      "code",
    );

    expect(result.callExpressions).toContainEqual({
      callerName: "Service.run",
      calleeName: "Service.save",
      start: expect.any(Number),
    });
  });

  it("gives accessors, static members, and static calls distinct graph names", () => {
    const result = new OxcParser().parse(
      {
        relativePath: "members.ts",
        absolutePath: "/tmp/members.ts",
        content: [
          "class Settings {",
          "  get value() { return 1; }",
          "  static get value() { return 2; }",
          "  set value(next: number) {}",
          "  static set value(next: number) {}",
          "  handler = () => {};",
          "  static handler = () => {};",
          "  run() {}",
          "  static run() { return Settings.helper(); }",
          "  static helper() {}",
          "}",
        ].join("\n"),
        targetTokens: 500,
        overlapTokens: 50,
      },
      "typescript",
      "code",
    );

    const names = result.definedSymbols.map((symbol) => symbol.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "Settings.get.value",
        "Settings.static.get.value",
        "Settings.set.value",
        "Settings.static.set.value",
        "Settings.handler",
        "Settings.static.handler",
        "Settings.run",
        "Settings.static.run",
        "Settings.static.helper",
      ]),
    );
    expect(new Set(names).size).toBe(names.length);
    expect(result.callExpressions).toContainEqual({
      callerName: "Settings.static.run",
      calleeName: "Settings.static.helper",
      start: expect.any(Number),
    });
  });

  it("does not rewrite a shadowing local binding as a class static call", () => {
    const result = new OxcParser().parse(
      {
        relativePath: "shadow.ts",
        absolutePath: "/tmp/shadow.ts",
        content: [
          "class Settings {",
          "  static save() {}",
          "  run() {",
          "    const Settings = getSettings();",
          "    Settings.save();",
          "  }",
          "}",
          "function getSettings() { return { save() {} }; }",
        ].join("\n"),
        targetTokens: 500,
        overlapTokens: 50,
      },
      "typescript",
      "code",
    );

    expect(result.callExpressions).toContainEqual({
      callerName: "Settings.run",
      calleeName: "Settings.save",
      start: expect.any(Number),
      shadowedLocal: true,
    });
    expect(result.callExpressions).not.toContainEqual({
      callerName: "Settings.run",
      calleeName: "Settings.static.save",
      start: expect.any(Number),
    });
  });

  it("does not rewrite this calls inside nested plain functions", () => {
    const result = new OxcParser().parse(
      {
        relativePath: "nested-this.ts",
        absolutePath: "/tmp/nested-this.ts",
        content: "function outer() { function inner() { this.save(); } }",
        targetTokens: 500,
        overlapTokens: 50,
      },
      "typescript",
      "code",
    );

    const inner = result.definedSymbols.find((symbol) => symbol.name === "outer.inner");
    expect(inner).toBeDefined();
    expect(result.callExpressions).toContainEqual({
      callerName: "outer.inner",
      calleeName: "this.save",
      start: expect.any(Number),
    });
    expect(result.callExpressions).not.toContainEqual({
      callerName: "outer.inner",
      calleeName: "outer.save",
      start: expect.any(Number),
    });
  });

  it("rewrites this calls inside arrow functions nested in class methods", () => {
    const result = new OxcParser().parse(
      {
        relativePath: "arrow-this.ts",
        absolutePath: "/tmp/arrow-this.ts",
        content: [
          "class Service {",
          "  save() {}",
          "  run() {",
          "    const callback = () => this.save();",
          "    callback();",
          "  }",
          "}",
        ].join("\n"),
        targetTokens: 500,
        overlapTokens: 50,
      },
      "typescript",
      "code",
    );

    expect(result.callExpressions).toContainEqual({
      callerName: "Service.run.callback",
      calleeName: "Service.save",
      start: expect.any(Number),
    });
  });

  it("does not rewrite arrows that capture a nested regular function this", () => {
    const result = new OxcParser().parse(
      {
        relativePath: "nested-arrow-this.ts",
        absolutePath: "/tmp/nested-arrow-this.ts",
        content: [
          "class Service {",
          "  save() {}",
          "  run() {",
          "    function inner() { const callback = () => this.save(); callback(); }",
          "  }",
          "}",
        ].join("\n"),
        targetTokens: 500,
        overlapTokens: 50,
      },
      "typescript",
      "code",
    );

    expect(result.callExpressions).toContainEqual({
      callerName: "Service.run.inner.callback",
      calleeName: "this.save",
      start: expect.any(Number),
    });
    expect(result.callExpressions).not.toContainEqual({
      callerName: "Service.run.inner.callback",
      calleeName: "Service.save",
      start: expect.any(Number),
    });
  });

  it("extracts ESM import bindings with local names and imported export names", () => {
    const result = new OxcParser().parse(
      {
        relativePath: "mod.mjs",
        absolutePath: "/tmp/mod.mjs",
        content: [
          'import defaultDep from "./dep.js";',
          'import { run, helper as renamed } from "./dep.js";',
          'import * as ns from "./ns.js";',
          'import "lodash";',
        ].join("\n"),
        targetTokens: 500,
        overlapTokens: 50,
      },
      "javascript",
      "code",
    );

    expect(result.importBindings).toEqual([
      { local: "defaultDep", module: "./dep.js", imported: "default" },
      { local: "run", module: "./dep.js", imported: "run" },
      { local: "renamed", module: "./dep.js", imported: "helper" },
      { local: "ns", module: "./ns.js", imported: "*" },
    ]);
    expect(result.importPaths).toEqual(expect.arrayContaining(["./dep.js", "./ns.js", "lodash"]));
  });

  it("extracts static CommonJS require bindings and ignores computed requires", () => {
    const result = new OxcParser().parse(
      {
        relativePath: "mod.cjs",
        absolutePath: "/tmp/mod.cjs",
        content: [
          'const mod = require("./mod.cjs");',
          'const { read, write: save } = require("./io.cjs");',
          "const dynamic = require(process.env.MOD);",
          "let late;",
          'late = require("./late.cjs");',
        ].join("\n"),
        targetTokens: 500,
        overlapTokens: 50,
      },
      "javascript",
      "code",
    );

    expect(result.importBindings).toEqual([
      { local: "mod", module: "./mod.cjs", imported: "*" },
      { local: "read", module: "./io.cjs", imported: "read" },
      { local: "save", module: "./io.cjs", imported: "write" },
    ]);
    // Declarator string-literal requires join importPaths; computed requires
    // and non-declarator require assignments are not static bindings.
    expect(result.importPaths).toEqual(expect.arrayContaining(["./mod.cjs", "./io.cjs"]));
    expect(result.importPaths).not.toContain("./late.cjs");
    expect(result.importBindings?.map((b) => b.local)).not.toContain("late");
  });

  it("extracts static CommonJS exports as symbols and local export entries", () => {
    const result = new OxcParser().parse(
      {
        relativePath: "mod.cjs",
        absolutePath: "/tmp/mod.cjs",
        content: [
          "function localFn() {}",
          "exports.nsFn = function () {};",
          "module.exports.prop = localFn;",
          "module.exports = { objFn: function () {}, named: localFn };",
          "exports.unresolvable = makeThing();",
        ].join("\n"),
        targetTokens: 500,
        overlapTokens: 50,
      },
      "javascript",
      "code",
    );

    const names = result.definedSymbols.map((symbol) => symbol.name);
    expect(names).toEqual(expect.arrayContaining(["localFn", "nsFn", "objFn"]));
    expect(result.definedSymbols.find((symbol) => symbol.name === "nsFn")?.exported).toBe(true);
    expect(result.exportBindings).toEqual(
      expect.arrayContaining([
        { name: "prop", kind: "local", local: "localFn" },
        { name: "named", kind: "local", local: "localFn" },
        { name: "nsFn", kind: "local", local: "nsFn" },
        { name: "objFn", kind: "local", local: "objFn" },
      ]),
    );
    // A property whose value is not one local declaration is unresolvable.
    expect(result.exportBindings?.map((e) => e.name)).not.toContain("unresolvable");
  });

  it("extracts ESM export specifiers, re-exports, and default exports", () => {
    const result = new OxcParser().parse(
      {
        relativePath: "barrel.js",
        absolutePath: "/tmp/barrel.js",
        content: [
          'export { a as ra } from "./a.js";',
          'export * from "./b.js";',
          "function internal() {}",
          "export { internal as helper };",
          "export function direct() {}",
          "export default function df() {}",
        ].join("\n"),
        targetTokens: 500,
        overlapTokens: 50,
      },
      "javascript",
      "code",
    );

    expect(result.exportBindings).toEqual(
      expect.arrayContaining([
        { name: "ra", kind: "reexport", module: "./a.js", imported: "a" },
        { name: "*", kind: "star", module: "./b.js" },
        { name: "helper", kind: "local", local: "internal" },
        { name: "direct", kind: "local", local: "direct" },
        { name: "default", kind: "local", local: "df" },
      ]),
    );
    // `export default function df` exports only "default" — `df` itself is
    // not a named export.
    expect(result.exportBindings?.map((e) => e.name)).not.toContain("df");
  });

  it("extracts TypeScript bindings with per-specifier typeOnly flags", () => {
    const result = new OxcParser().parse(
      {
        relativePath: "typed.ts",
        absolutePath: "/tmp/typed.ts",
        content: [
          'import type { Shape } from "./shapes";',
          'import { type OnlyT, realFn } from "./mixed";',
          'import * as ns from "./ns";',
          'export type { Shape } from "./shapes";',
          'export { type Iface, real } from "./x";',
          'export type * from "./types";',
          "export interface Iface { a: number }",
          "export function real() {}",
        ].join("\n"),
        targetTokens: 500,
        overlapTokens: 50,
      },
      "typescript",
      "code",
    );

    expect(result.importBindings).toEqual(
      expect.arrayContaining([
        { local: "Shape", module: "./shapes", imported: "Shape", typeOnly: true },
        { local: "OnlyT", module: "./mixed", imported: "OnlyT", typeOnly: true },
        { local: "realFn", module: "./mixed", imported: "realFn", typeOnly: undefined },
        { local: "ns", module: "./ns", imported: "*", typeOnly: undefined },
      ]),
    );
    expect(result.exportBindings).toEqual(
      expect.arrayContaining([
        {
          name: "Shape",
          kind: "reexport",
          module: "./shapes",
          imported: "Shape",
          typeOnly: true,
        },
        {
          name: "Iface",
          kind: "reexport",
          module: "./x",
          imported: "Iface",
          typeOnly: true,
        },
        { name: "real", kind: "reexport", module: "./x", imported: "real", typeOnly: undefined },
        { name: "*", kind: "star", module: "./types", typeOnly: true },
        { name: "Iface", kind: "local", local: "Iface", typeOnly: undefined },
        { name: "real", kind: "local", local: "real", typeOnly: undefined },
      ]),
    );
  });

  it("keeps JavaScript payloads free of typeOnly flags", () => {
    const result = new OxcParser().parse(
      {
        relativePath: "plain.js",
        absolutePath: "/tmp/plain.js",
        content: ['import { x } from "./m";', "export function f() {}"].join("\n"),
        targetTokens: 500,
        overlapTokens: 50,
      },
      "javascript",
      "code",
    );

    for (const binding of result.importBindings ?? []) {
      expect(binding).not.toHaveProperty("typeOnly");
    }
    for (const entry of result.exportBindings ?? []) {
      expect(entry).not.toHaveProperty("typeOnly");
    }
  });

  it("extracts function-local require bindings with their owning scope", () => {
    const result = new OxcParser().parse(
      {
        relativePath: "nested.js",
        absolutePath: "/tmp/nested.js",
        content: [
          "function handler() {",
          "  const { read } = require('./io');",
          "  const io = require('./io');",
          "  read();",
          "  io.write();",
          "}",
        ].join("\n"),
        targetTokens: 500,
        overlapTokens: 50,
      },
      "javascript",
      "code",
    );

    const bindings = result.importBindings ?? [];
    const read = bindings.find((b) => b.local === "read");
    const io = bindings.find((b) => b.local === "io");
    expect(read).toMatchObject({
      module: "./io",
      imported: "read",
      scopeStart: expect.any(Number),
      scopeEnd: expect.any(Number),
    });
    expect(io).toMatchObject({
      module: "./io",
      imported: "*",
      scopeStart: expect.any(Number),
      scopeEnd: expect.any(Number),
    });
    expect(result.importPaths).toContain("./io");
  });

  it("treats a shadowed require parameter as a local call, not a module binding", () => {
    const result = new OxcParser().parse(
      {
        relativePath: "shadowed-require.js",
        absolutePath: "/tmp/shadowed-require.js",
        content: [
          "function caller(require) {",
          '  const { run } = require("./dep");',
          "  run();",
          "}",
        ].join("\n"),
        targetTokens: 500,
        overlapTokens: 50,
      },
      "javascript",
      "code",
    );

    expect(result.importBindings?.some((binding) => binding.local === "run")).toBe(false);
    expect(result.importPaths).not.toContain("./dep");
    expect(result.callExpressions).toContainEqual({
      callerName: "caller",
      calleeName: "run",
      start: expect.any(Number),
      shadowedLocal: true,
    });
  });

  it("emits a stable `default` symbol for anonymous default exports", () => {
    const result = new OxcParser().parse(
      {
        relativePath: "anon.js",
        absolutePath: "/tmp/anon.js",
        content: ["export default function () {", "  return 1;", "}"].join("\n"),
        targetTokens: 500,
        overlapTokens: 50,
      },
      "javascript",
      "code",
    );

    expect(result.definedSymbols.map((s) => s.name)).toContain("default");
    expect(result.exportBindings).toContainEqual({
      name: "default",
      kind: "local",
      local: "default",
    });
  });

  it("emits a `default` symbol for anonymous default arrow exports", () => {
    const result = new OxcParser().parse(
      {
        relativePath: "anon.js",
        absolutePath: "/tmp/anon.js",
        content: "export default () => 2;",
        targetTokens: 500,
        overlapTokens: 50,
      },
      "javascript",
      "code",
    );

    const symbol = result.definedSymbols.find((s) => s.name === "default");
    expect(symbol?.symbolType).toBe("function");
    expect(result.exportBindings).toContainEqual({
      name: "default",
      kind: "local",
      local: "default",
    });
  });

  it("does not mark calls shadowed by declarations in sibling blocks", () => {
    const result = new OxcParser().parse(
      {
        relativePath: "scope.js",
        absolutePath: "/tmp/scope.js",
        content: ["export function caller() {", "  target();", "  { const target = 1; }", "}"].join(
          "\n",
        ),
        targetTokens: 500,
        overlapTokens: 50,
      },
      "javascript",
      "code",
    );

    expect(result.callExpressions).toContainEqual({
      callerName: "caller",
      calleeName: "target",
      start: expect.any(Number),
    });
  });

  it("marks calls shadowed by same-block declarations after the call (TDZ)", () => {
    const result = new OxcParser().parse(
      {
        relativePath: "scope.js",
        absolutePath: "/tmp/scope.js",
        content: ["export function caller() {", "  target();", "  const target = 1;", "}"].join(
          "\n",
        ),
        targetTokens: 500,
        overlapTokens: 50,
      },
      "javascript",
      "code",
    );

    expect(result.callExpressions).toContainEqual({
      callerName: "caller",
      calleeName: "target",
      start: expect.any(Number),
      shadowedLocal: true,
    });
  });

  it("finds calls inside object property values", () => {
    const result = new OxcParser().parse(
      {
        relativePath: "object.ts",
        absolutePath: "/tmp/object.ts",
        content: [
          "function configure() {",
          "  return { save: () => helper() };",
          "}",
          "function helper() {}",
        ].join("\n"),
        targetTokens: 500,
        overlapTokens: 50,
      },
      "typescript",
      "code",
    );

    expect(result.callExpressions).toContainEqual({
      callerName: "configure",
      calleeName: "helper",
      start: expect.any(Number),
    });
  });
});
