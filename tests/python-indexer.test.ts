import path from "node:path";

import { describe, expect, it } from "bun:test";

import { createWorkspaceFileResolver } from "../packages/indexer/src/index-workspace";
import { parsePython } from "../packages/indexer/src/languages";

describe("python indexing", () => {
  it("extracts import candidates and per-symbol calls", () => {
    const result = parsePython(`
from src.models import EnvelopePromptHistory, helper as renamed
from .local import tool
from . import sibling
import src.services.runner as runner, os

def load_history():
    helper()
    runner.run()
    len([])

def helper():
    return 1
`);

    expect(result.importPaths).toEqual(
      expect.arrayContaining([
        "src.models",
        "src.models.EnvelopePromptHistory",
        "src.models.helper",
        ".local",
        ".local.tool",
        ".sibling",
        "src.services.runner",
        "os",
      ]),
    );

    expect(result.calledIdentifiers).toEqual(expect.arrayContaining(["helper", "run"]));
    expect(result.calledIdentifiers).not.toContain("len");
    expect(result.callExpressions).toEqual(
      expect.arrayContaining([
        { callerName: "load_history", calleeName: "helper" },
        { callerName: "load_history", calleeName: "run" },
      ]),
    );
  });

  it("tracks decorators and extracts calls from decorator lines", () => {
    const result = parsePython(`
@app.route("/api")
@auth.required
def create_user():
    db.save()
    return 1

@dataclass
class User:
    name: str
`);

    const createSymbol = result.definedSymbols.find((s) => s.name === "create_user");
    expect(createSymbol).toBeDefined();
    expect(createSymbol?.decorators).toEqual(["app.route", "auth.required"]);
    expect(createSymbol?.startLine).toBe(2);

    const userSymbol = result.definedSymbols.find((s) => s.name === "User");
    expect(userSymbol).toBeDefined();
    expect(userSymbol?.decorators).toEqual(["dataclass"]);

    expect(result.calledIdentifiers).toEqual(
      expect.arrayContaining(["route", "required", "save", "dataclass"]),
    );
    expect(result.callExpressions).toEqual(
      expect.arrayContaining([
        { callerName: "create_user", calleeName: "route" },
        { callerName: "create_user", calleeName: "required" },
        { callerName: "create_user", calleeName: "save" },
        { callerName: "User", calleeName: "dataclass" },
      ]),
    );
  });

  it("ignores symbols and calls inside comments and strings", () => {
    const result = parsePython(`
'''
def fake():
    ghost()
'''
def real():
    text = "fake_call()"
    # commented_call()
`);

    expect(result.definedSymbols.map((symbol) => symbol.name)).toEqual(["real"]);
    expect(result.callExpressions).toEqual([]);
  });

  it("includes searchText in chunk metadata for FTS matching", () => {
    const result = parsePython(`
def load_history():
    helper()
    runner.run()
`);

    const chunk = result.chunks.find((c) => c.symbolName === "load_history");
    expect(chunk).toBeDefined();
    expect(chunk?.metadata.searchText).toBeDefined();
    expect(chunk?.metadata.searchText).toContain("load");
    expect(chunk?.metadata.searchText).toContain("history");
    expect(chunk?.metadata.searchText).toContain("helper");
    expect(chunk?.metadata.searchText).toContain("runner");
  });

  it("splits snake_case identifiers in searchText", () => {
    const result = parsePython(`
def process_payment_history():
    pass
`);

    const chunk = result.chunks.find((c) => c.symbolName === "process_payment_history");
    expect(chunk?.metadata.searchText).toContain("process");
    expect(chunk?.metadata.searchText).toContain("payment");
    expect(chunk?.metadata.searchText).toContain("history");
  });

  it("resolves python absolute and relative module imports", () => {
    const root = path.resolve("/workspace");
    const resolver = createWorkspaceFileResolver(root, [
      {
        relativePath: "src/app.py",
        absolutePath: path.join(root, "src/app.py"),
      },
      {
        relativePath: "src/models/envelope_prompt_history.py",
        absolutePath: path.join(root, "src/models/envelope_prompt_history.py"),
      },
      {
        relativePath: "src/local/tool.py",
        absolutePath: path.join(root, "src/local/tool.py"),
      },
      {
        relativePath: "src/sibling.py",
        absolutePath: path.join(root, "src/sibling.py"),
      },
      {
        relativePath: "src/services/runner/__init__.py",
        absolutePath: path.join(root, "src/services/runner/__init__.py"),
      },
    ]);

    expect(
      resolver.resolveImport("src/app.py", "src.models.envelope_prompt_history", "python"),
    ).toBe("src/models/envelope_prompt_history.py");
    expect(resolver.resolveImport("src/app.py", ".local.tool", "python")).toBe("src/local/tool.py");
    expect(resolver.resolveImport("src/app.py", ".sibling", "python")).toBe("src/sibling.py");
    expect(resolver.resolveImport("src/app.py", "src.services.runner", "python")).toBe(
      "src/services/runner/__init__.py",
    );
    expect(
      resolver.resolveImport("src/app.py", "src.models.envelope_prompt_history", "typescript"),
    ).toBeNull();
  });
});
