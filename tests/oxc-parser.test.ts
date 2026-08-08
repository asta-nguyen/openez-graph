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
      callerName: "inner",
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
});
