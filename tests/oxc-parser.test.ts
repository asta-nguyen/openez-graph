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
        { callerName: "caller", calleeName: "fetch" },
        { callerName: "caller", calleeName: "api.save" },
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
    });
    expect(result.callExpressions).toContainEqual({
      callerName: "outer",
      calleeName: "inner",
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
    });
    expect(result.callExpressions).toContainEqual({
      callerName: "Service.run",
      calleeName: "helper",
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
    });
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
    });
    // The call from outer() to helper() — at parser level this is still
    // `helper`, but graph resolution will prefer `outer.helper` over the
    // top-level `helper` because of lexical scope (verified in graph tests).
    expect(result.callExpressions).toContainEqual({
      callerName: "outer",
      calleeName: "helper",
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
    });
  });
});
