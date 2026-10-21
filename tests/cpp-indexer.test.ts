import fs from "node:fs";
import module from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  closeAllWorkspaceDbs,
  closeRegistryDb,
  createRegistryRepository,
  createWorkspaceRepository,
} from "../packages/db/src/sqlite";
import { inferDocumentKind } from "../packages/indexer/src/languages";
import { ensureGraphReady } from "../packages/indexer/src/graph-service";
import { indexWorkspace } from "../packages/indexer/src/index-workspace";
import { TreeSitterParser } from "../packages/indexer/src/parsers/tree-sitter-parser";
import { cppConfig, cppHeaderConfig, parseWithTreeSitter } from "../packages/indexer/src/tree-sitter";

let registryRoot: string;
let workspaceRoot: string;

beforeEach(() => {
  registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-cpp-registry-"));
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-cpp-workspace-"));
  process.env.AI_MEMORY_REGISTRY_DB_PATH = path.join(registryRoot, "registry.sqlite");
  process.env.EMBEDDING_PROVIDER = "none";
  closeRegistryDb();
  closeAllWorkspaceDbs();
});

afterEach(() => {
  closeAllWorkspaceDbs();
  closeRegistryDb();
  fs.rmSync(registryRoot, { recursive: true, force: true });
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.AI_MEMORY_REGISTRY_DB_PATH;
  delete process.env.EMBEDDING_PROVIDER;
});

describe("C++ document classification", () => {
  test("C++ extensions map to cpp; lowercase .c stays unindexed", () => {
    for (const ext of [".cpp", ".cc", ".cxx", ".c++", ".hpp", ".hh", ".hxx", ".h++", ".h"]) {
      const info = inferDocumentKind(`x${ext}`);
      expect(info.kind, ext).toBe("code");
      expect(info.language, ext).toBe("cpp");
    }
    const upper = inferDocumentKind("x.C");
    expect(upper.kind).toBe("code");
    expect(upper.language).toBe("cpp");

    const lower = inferDocumentKind("x.c");
    expect(lower.kind).not.toBe("code");
    expect(lower.language).not.toBe("cpp");
  });
});

const CPP_SOURCE = `#include "util.h"
#include <vector>

namespace app {

class Worker {
public:
  void run();
  int status();
};

int helper(int v) { return v + 1; }

void Worker::run() {
  status();
  this->run();
  helper(2);
}

}  // namespace app

int free_function() { return app::helper(3); }
`;

describe("C++ tree-sitter extraction", () => {
  test("symbols, imports, and calls are extracted with qualification", async () => {
    const result = await parseWithTreeSitter(cppConfig, CPP_SOURCE);
    expect(result).not.toBeNull();
    const symbols = new Map(result!.definedSymbols!.map((s) => [s.name, s.symbolType]));

    expect(symbols.get("app")).toBe("namespace");
    expect(symbols.get("app::Worker")).toBe("class");
    expect(symbols.get("app::helper")).toBe("function");
    // In-class prototype and out-of-line definition pair by qualified name.
    expect(symbols.get("app::Worker::run")).toBeDefined();
    expect(symbols.get("app::Worker::status")).toBeDefined();
    expect(symbols.get("free_function")).toBe("function");

    // Quoted include recorded; angle/system include ignored.
    expect(result!.importPaths).toEqual(["util.h"]);

    const calls = result!.callExpressions!.map((c) => `${c.callerName}->${c.calleeName}`);
    expect(calls).toContain("app::Worker::run->status");
    expect(calls).toContain("app::Worker::run->this.run");
    expect(calls).toContain("app::Worker::run->helper");
    expect(calls).toContain("free_function->app::helper");
  });

  test("line ranges are correct 1-based source locations", async () => {
    const result = await parseWithTreeSitter(cppConfig, CPP_SOURCE);
    const helper = result!.definedSymbols!.find((s) => s.name === "app::helper");
    expect(helper?.startLine).toBe(12);
    expect(helper?.endLine).toBe(12);
    const klass = result!.definedSymbols!.find((s) => s.name === "app::Worker");
    expect(klass?.startLine).toBe(6);
    expect(klass?.endLine).toBe(10);
  });

  test(".h with a syntax error yields no symbols via header config", async () => {
    const broken = "struct Broken { void f( ; };\n";
    const header = await parseWithTreeSitter(cppHeaderConfig, broken);
    expect(header).toBeNull();
    // The non-header C++ config keeps partial trees for the same content.
    const partial = await parseWithTreeSitter(cppConfig, broken);
    expect(partial).not.toBeNull();
  });

  test("a .cpp with a syntax error still keeps its partial tree", async () => {
    const source = "int ok() { return 1; }\nstruct Broken { void f( ; };\nint after() { return 2; }\n";
    const result = await parseWithTreeSitter(cppConfig, source);
    expect(result).not.toBeNull();
    const names = result!.definedSymbols!.map((s) => s.name);
    expect(names).toContain("ok");
  });

  test("same-line sibling declarations do not leak context", async () => {
    // Regression: end-row-only context expiry kept `a` live when sibling `b`
    // started on the same row `a` ended, producing `n::a::b`.
    const source =
      "namespace n { void a() { f(); } void b() { g(); } }\n" +
      "struct S { int x() { return h(); } int y() { return h(); } };\n" +
      "int f() { return 0; }\nint g() { return 0; }\nint h() { return 0; }\n";
    const result = await parseWithTreeSitter(cppConfig, source);
    expect(result).not.toBeNull();
    const names = result!.definedSymbols!.map((s) => s.name);
    expect(names).toContain("n::a");
    expect(names).toContain("n::b");
    expect(names).not.toContain("n::a::b");
    expect(names).toContain("S::x");
    expect(names).toContain("S::y");
    expect(names).not.toContain("S::x::y");

    const calls = result!.callExpressions!.map((c) => `${c.callerName}->${c.calleeName}`);
    expect(calls).toContain("n::a->f");
    expect(calls).toContain("n::b->g");
    expect(calls).not.toContain("n::a::b->g");
    expect(calls).toContain("S::x->h");
    expect(calls).toContain("S::y->h");
  });

  test("operator<< and operator< stay distinct; calls keep exact callee", async () => {
    // Regression: stripCppTemplateArgs kept only the first `<` after
    // `operator`, truncating `operator<<` to `operator<` and colliding with
    // real `operator<` declarations.
    const source =
      "struct A {\n" +
      "  int operator<<(int);\n" +
      "  bool operator<(const A&);\n" +
      "};\n" +
      "int A::operator<<(int x) { return x; }\n" +
      "bool A::operator<(const A& o) { return true; }\n" +
      "int g() { return A::operator<<(1); }\n" +
      "bool h(A& a, A& b) { return A::operator<(a, b); }\n" +
      "int t() { return tpl<int>(0); }\n";
    const result = await parseWithTreeSitter(cppConfig, source);
    expect(result).not.toBeNull();
    const names = result!.definedSymbols!.map((s) => s.name);
    expect(names).toContain("A::operator<<");
    expect(names).toContain("A::operator<");
    expect(names).not.toContain("A::operator");

    const calls = result!.callExpressions!.map((c) => `${c.callerName}->${c.calleeName}`);
    expect(calls).toContain("g->A::operator<<");
    expect(calls).toContain("h->A::operator<");
    // Template arguments on ordinary names still strip.
    expect(calls).toContain("t->tpl");
    expect(calls).not.toContain("t->tpl<int>");
  });

  test(".h parse failure degrades to generic chunks, never throws", async () => {
    const parser = new TreeSitterParser();
    const doc = await parser.parse(
      {
        relativePath: "bad.h",
        absolutePath: "/tmp/bad.h",
        content: "struct Broken { void f( ; };\n",
      } as never,
      "cpp",
      "code",
    );
    expect(doc.definedSymbols ?? []).toHaveLength(0);
    expect(doc.callExpressions ?? []).toHaveLength(0);
    expect(doc.chunks.length).toBeGreaterThan(0);
  });
});

describe("C++ indexing end-to-end", () => {
  test("C++ files index, .C discovered, .c not scanned, error .h chunks only", async () => {
    fs.writeFileSync(path.join(workspaceRoot, "lib.h"), "#pragma once\nint helper();\n");
    fs.writeFileSync(
      path.join(workspaceRoot, "lib.cpp"),
      '#include "lib.h"\nint helper() { return 7; }\n',
    );
    fs.writeFileSync(
      path.join(workspaceRoot, "upper.C"),
      '#include "lib.h"\nint upper_fn() { return helper(); }\n',
    );
    fs.writeFileSync(path.join(workspaceRoot, "lower.c"), "int c_fn() { return 3; }\n");
    fs.writeFileSync(path.join(workspaceRoot, "bad.h"), "struct Broken { void f( ; };\n");

    const workspace = await createRegistryRepository().ensureWorkspace({
      rootPath: workspaceRoot,
    });
    await indexWorkspace({ workspaceId: workspace.id });
    await ensureGraphReady(workspace.id);
    const repo = createWorkspaceRepository(workspaceRoot);

    const libDoc = await repo.getDocumentByPath("lib.cpp");
    expect(libDoc?.language).toBe("cpp");
    const upperDoc = await repo.getDocumentByPath("upper.C");
    expect(upperDoc?.language).toBe("cpp");
    const headerDoc = await repo.getDocumentByPath("lib.h");
    expect(headerDoc?.language).toBe("cpp");
    // lowercase .c is not even scanned.
    expect(await repo.getDocumentByPath("lower.c")).toBeNull();

    // .h with syntax errors: generic text chunks exist, zero graph records.
    const badDoc = await repo.getDocumentByPath("bad.h");
    expect(badDoc).not.toBeNull();
    const badChunks = await repo.getChunksByDocument(badDoc!.id);
    expect(badChunks.length).toBeGreaterThan(0);
    const badNodes = await repo.queryRaw(
      "SELECT count(*) AS c FROM graph_nodes WHERE json_extract(metadata, '$.filePath') = 'bad.h'",
    );
    expect(Number(badNodes[0]?.c ?? 0)).toBe(0);

    // Real graph records exist for the healthy files.
    const symNodes = await repo.queryRaw(
      "SELECT label FROM graph_nodes WHERE type = 'symbol' ORDER BY label",
    );
    const labels = symNodes.map((r) => r.label as string);
    expect(labels).toContain("helper");
    expect(labels).toContain("upper_fn");
  });
});

describe("C++ grammar-unavailable fallback", () => {
  test("missing WASM grammar degrades to generic chunks without throwing", async () => {
    const req = module.createRequire(import.meta.url);
    let wasmPath: string;
    try {
      wasmPath = req.resolve("tree-sitter-cpp/tree-sitter-cpp.wasm");
    } catch {
      // Grammar not installed — the fallback path is the only path anyway.
      const parser = new TreeSitterParser();
      const doc = await parser.parse(
        {
          relativePath: "a.cpp",
          absolutePath: "/tmp/a.cpp",
          content: "int f() { return 1; }",
        } as never,
        "cpp",
        "code",
      );
      expect(doc.chunks.length).toBeGreaterThan(0);
      return;
    }
    const backup = `${wasmPath}.bak`;
    fs.renameSync(wasmPath, backup);
    try {
      const parser = new TreeSitterParser();
      const doc = await parser.parse(
        {
          relativePath: "a.cpp",
          absolutePath: "/tmp/a.cpp",
          content: "int f() { return 1; }",
        } as never,
        "cpp",
        "code",
      );
      expect(doc.definedSymbols ?? []).toHaveLength(0);
      expect(doc.chunks.length).toBeGreaterThan(0);
    } finally {
      fs.renameSync(backup, wasmPath);
    }
  });
});
