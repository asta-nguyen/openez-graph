import path from "node:path";

import { describe, expect, it } from "vitest";

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

    expect(result.importPaths).toEqual(expect.arrayContaining([
      "src.models",
      "src.models.EnvelopePromptHistory",
      "src.models.helper",
      ".local",
      ".local.tool",
      ".sibling",
      "src.services.runner",
      "os"
    ]));

    expect(result.calledIdentifiers).toEqual(expect.arrayContaining(["helper", "run"]));
    expect(result.calledIdentifiers).not.toContain("len");
    expect(result.callExpressions).toEqual(expect.arrayContaining([
      { callerName: "load_history", calleeName: "helper" },
      { callerName: "load_history", calleeName: "run" }
    ]));
  });

  it("resolves python absolute and relative module imports", () => {
    const root = path.resolve("/workspace");
    const resolver = createWorkspaceFileResolver(root, [
      {
        relativePath: "src/app.py",
        absolutePath: path.join(root, "src/app.py")
      },
      {
        relativePath: "src/models/envelope_prompt_history.py",
        absolutePath: path.join(root, "src/models/envelope_prompt_history.py")
      },
      {
        relativePath: "src/local/tool.py",
        absolutePath: path.join(root, "src/local/tool.py")
      },
      {
        relativePath: "src/sibling.py",
        absolutePath: path.join(root, "src/sibling.py")
      },
      {
        relativePath: "src/services/runner/__init__.py",
        absolutePath: path.join(root, "src/services/runner/__init__.py")
      }
    ]);

    expect(resolver.resolveImport("src/app.py", "src.models.envelope_prompt_history", "python"))
      .toBe("src/models/envelope_prompt_history.py");
    expect(resolver.resolveImport("src/app.py", ".local.tool", "python"))
      .toBe("src/local/tool.py");
    expect(resolver.resolveImport("src/app.py", ".sibling", "python"))
      .toBe("src/sibling.py");
    expect(resolver.resolveImport("src/app.py", "src.services.runner", "python"))
      .toBe("src/services/runner/__init__.py");
    expect(resolver.resolveImport("src/app.py", "src.models.envelope_prompt_history", "typescript"))
      .toBeNull();
  });
});
