import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { blankGoTrivia, createGoResolver } from "../packages/indexer/src/go-resolver";
import { rmTempDir } from "./helpers/temp-cleanup";

/**
 * Unit coverage for the Go module/package resolver: go.mod discovery and
 * matching, import-header parsing (comments, raw strings, grouped imports,
 * CRLF), declared-package binding, and function-granular local names.
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function makeWorkspace(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gores-"));
  cleanups.push(() => rmTempDir(root));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

function resolverFor(root: string): ReturnType<typeof createGoResolver> {
  const goFiles: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = dir === "." ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith(".go")) goFiles.push(rel);
    }
  };
  walk(".");
  return createGoResolver({ workspaceRoot: root, goFiles });
}

describe("go-resolver module matching", () => {
  test("nested module wins by longest prefix; own module wins a same-path tie", () => {
    const root = makeWorkspace({
      "go.mod": "module example.com/root\n\ngo 1.22\n",
      "inner/go.mod": "module example.com/inner\n",
      "inner/p/p.go": "package p\n",
      "a/a.go": "package a\n",
      "dup1/go.mod": "module example.com/dup\n",
      "dup1/q/q.go": "package q\n",
      "dup2/go.mod": "module example.com/dup\n",
      "dup2/q/q.go": "package q\n",
      "testdata/fake/go.mod": "module example.com/fake\n",
      "testdata/fake/f.go": "package fake\n",
      "vendor/fake/f.go": "package fake\n",
      ".hidden/fake/f.go": "package fake\n",
      "_hidden/fake/f.go": "package fake\n",
      "bad/go.mod": "module (\n",
      "bad/bad.go": "package bad\n",
      "bad/target/target.go": "package target\n",
    });
    const r = resolverFor(root);
    // Nested module owns example.com/inner/p.
    expect(r.packageForImport("a/a.go", "example.com/inner/p")).toEqual({
      dir: "inner/p",
      packageName: "p",
    });
    // A path that only shares a prefix with the module path is unresolved.
    expect(r.packageForImport("a/a.go", "example.com/rootx")).toBeNull();
    // Same-path modules: the importing file's own module wins.
    expect(r.packageForImport("dup1/x/x.go", "example.com/dup/q")).toEqual({
      dir: "dup1/q",
      packageName: "q",
    });
    // Equal module paths without an importing-module winner are ambiguous.
    expect(r.packageForImport("a/a.go", "example.com/dup/q")).toBeNull();
    // A go.mod under testdata never answers for the module it imitates.
    expect(r.packageForImport("a/a.go", "example.com/fake")).toBeNull();
    // Ignored directories never become import targets, even inside the root module.
    for (const suffix of ["testdata/fake", "vendor/fake", ".hidden/fake", "_hidden/fake"]) {
      expect(r.packageForImport("a/a.go", `example.com/root/${suffix}`)).toBeNull();
    }
    // A malformed nested module still blocks parent-module import resolution.
    expect(r.packageForImport("bad/bad.go", "example.com/root/bad/target")).toBeNull();
    expect(r.packageFiles("bad", "bad", true)).toEqual(["bad/bad.go"]);
    // External paths bind nothing.
    expect(r.packageForImport("a/a.go", "github.com/x/y")).toBeNull();
  });

  test("quoted and commented module directives parse", () => {
    const root = makeWorkspace({
      "go.mod": 'module "example.com/quoted" // trailing comment\n\ngo 1.22\n',
      "a/a.go": "package a\n",
    });
    const r = resolverFor(root);
    expect(r.packageForImport("a/a.go", "example.com/quoted/a")).toEqual({
      dir: "a",
      packageName: "a",
    });
  });

  test("a directory with two non-test package names resolves to nothing", () => {
    const root = makeWorkspace({
      "go.mod": "module example.com/m\n",
      "mix/a.go": "package mix\n",
      "mix/gen.go": "//go:build ignore\n\npackage main\n",
      "user/u.go": "package user\n",
    });
    const r = resolverFor(root);
    expect(r.packageForImport("user/u.go", "example.com/m/mix")).toBeNull();
  });

  test("root module packages provide import targets and same-package files", () => {
    const root = makeWorkspace({
      "go.mod": "module example.com/root\n",
      "root.go": "package root\nfunc A() { B() }\nfunc B() {}\n",
      "sub/sub.go": "package sub\n",
    });
    const r = resolverFor(root);
    const ctx = r.contextForFile("root.go");
    expect(ctx?.packageDir).toBe("");
    expect(r.packageFiles(ctx!.packageDir, "root", true)).toEqual(["root.go"]);
    expect(r.packageForImport("sub/sub.go", "example.com/root")).toEqual({
      dir: "",
      packageName: "root",
    });
  });
});

describe("go-resolver import binding", () => {
  const files = {
    "go.mod": "module example.com/impmod\n",
    "client/v3/v3.go": "package clientv3\n",
    "imp/a.go": `package imp\n\nimport (\n\tv3 "example.com/impmod/client/v3"\n\t"github.com/x/pb/v3"\n)\n`,
    "imp/b.go": `package imp\n\nimport (\n\t"github.com/x/pb/v3"\n\tv3 "example.com/impmod/client/v3"\n)\n`,
    "imp/c.go": `package imp\n\nimport "example.com/impmod/client/v3"\n`,
    "imp/d.go": `package imp\n\nimport (\n\t// "fake.io/notanimport"\n\t"example.com/impmod/client/v3" // trailing "fake.io/x"\n\t_ "example.com/impmod/client/v3"\n\t. "example.com/impmod/client/v3"\n)\n\nvar doc = \`import "fake.io/raw"\`\n`,
  };

  test("explicit alias wins over an external unaliased namesake in both orders", () => {
    const root = makeWorkspace(files);
    const r = resolverFor(root);
    const target = { dir: "client/v3", packageName: "clientv3" };
    expect(r.contextForFile("imp/a.go")?.imports.get("v3")).toEqual(target);
    expect(r.contextForFile("imp/b.go")?.imports.get("v3")).toEqual(target);
  });

  test("unaliased workspace import binds the declared package name", () => {
    const root = makeWorkspace(files);
    const r = resolverFor(root);
    const ctx = r.contextForFile("imp/c.go");
    expect(ctx?.imports.get("clientv3")).toEqual({ dir: "client/v3", packageName: "clientv3" });
    // The directory name v3 is not bound.
    expect(ctx?.imports.has("v3")).toBe(false);
  });

  test("comments, raw strings, blank and dot imports bind nothing", () => {
    const root = makeWorkspace(files);
    const r = resolverFor(root);
    const ctx = r.contextForFile("imp/d.go");
    expect(ctx?.imports.get("clientv3")).toEqual({ dir: "client/v3", packageName: "clientv3" });
    expect(ctx?.imports.has("fake")).toBe(false);
    expect(ctx?.imports.has("doc")).toBe(false);
    // _ and . do not double-bind clientv3.
    expect(ctx?.ambiguousNames.has("clientv3")).toBe(false);
  });

  test("CRLF source parses the same bindings", () => {
    const root = makeWorkspace({
      "go.mod": "module example.com/impmod\r\n",
      "client/v3/v3.go": "package clientv3\r\n",
      "imp/c.go": 'package imp\r\n\r\nimport "example.com/impmod/client/v3"\r\n',
    });
    const r = resolverFor(root);
    expect(r.contextForFile("imp/c.go")?.imports.get("clientv3")).toEqual({
      dir: "client/v3",
      packageName: "clientv3",
    });
  });
});

describe("go-resolver local names and packages", () => {
  test("receivers, params, results, := and var names are function-local", () => {
    const root = makeWorkspace({
      "go.mod": "module example.com/m\n",
      "f/f.go": `package f

func (s *Server) Handle(ctx *Context, k string) (out int, err error) {
	store := newStore()
	var buf, tmp = read(k)
	const max = 10
	for i, v := range items {
		_, _ = i, v
	}
	if n := len(k); n > 0 {
	}
	_, _, _, _ = store, buf, tmp, max
	return out, err
}
`,
    });
    const r = resolverFor(root);
    const locals = r.contextForFile("f/f.go")?.localNamesByCaller.get("Server::Handle");
    for (const name of [
      "s",
      "ctx",
      "k",
      "out",
      "err",
      "store",
      "buf",
      "tmp",
      "max",
      "i",
      "v",
      "n",
    ]) {
      expect(locals?.has(name), `local ${name} missing`).toBe(true);
    }
  });

  test("grouped and function-literal parameters shadow package imports", () => {
    const root = makeWorkspace({
      "go.mod": "module example.com/m\n",
      "f/f.go": `package f

func Grouped(pkg, other *Client) {}

func Outer() {
	work := func(inner, sibling *Client) {
		inner.Do()
		sibling.Do()
	}
	_ = work
}
`,
    });
    const r = resolverFor(root);
    const ctx = r.contextForFile("f/f.go");
    for (const name of ["pkg", "other"]) {
      expect(ctx?.localNamesByCaller.get("Grouped")?.has(name)).toBe(true);
    }
    for (const name of ["inner", "sibling"]) {
      expect(ctx?.localNamesByCaller.get("Outer")?.has(name)).toBe(true);
    }
  });

  test("generic and pointer receivers key callers like the parser does", () => {
    const root = makeWorkspace({
      "go.mod": "module example.com/m\n",
      "g/g.go": `package g

func (s *Stack[T]) Push(v T) {
	items := collect(v)
	_ = items
}
`,
    });
    const r = resolverFor(root);
    const ctx = r.contextForFile("g/g.go");
    expect(ctx?.localNamesByCaller.has("Stack[T]::Push")).toBe(true);
  });

  test("repeated init functions union their locals", () => {
    const root = makeWorkspace({
      "go.mod": "module example.com/m\n",
      "i/i.go": `package i

func init() {
	alpha := 1
	_ = alpha
}

func init() {
	beta := 2
	_ = beta
}
`,
    });
    const r = resolverFor(root);
    const locals = r.contextForFile("i/i.go")?.localNamesByCaller.get("init");
    expect(locals?.has("alpha")).toBe(true);
    expect(locals?.has("beta")).toBe(true);
  });

  test("foo_test is its own package; _test.go files are not import targets", () => {
    const root = makeWorkspace({
      "go.mod": "module example.com/m\n",
      "foo/foo.go": "package foo\n",
      "foo/foo_test.go": "package foo_test\n",
    });
    const r = resolverFor(root);
    // The external test package's context resolves inside foo_test.
    const ctx = r.contextForFile("foo/foo_test.go");
    expect(ctx?.packageName).toBe("foo_test");
    expect(r.packageFiles("foo", "foo_test", true)).toEqual(["foo/foo_test.go"]);
    // Import targets exclude _test.go.
    expect(r.packageFiles("foo", "foo", false)).toEqual(["foo/foo.go"]);
    // An import of foo binds the non-test package only.
    expect(r.packageForImport("foo/foo_test.go", "example.com/m/foo")).toEqual({
      dir: "foo",
      packageName: "foo",
    });
  });

  test("import-like text inside comments and strings produces no specs", () => {
    const root = makeWorkspace({
      "go.mod": "module example.com/m\n",
      "x/x.go": `package x

// import "fake.io/comment"
/* import "fake.io/block" */
import "example.com/m/real"

var doc = "import \\"fake.io/string\\""
var raw = \`import "fake.io/raw"\`
`,
      "real/real.go": "package real\n",
    });
    const r = resolverFor(root);
    const ctx = r.contextForFile("x/x.go");
    expect(ctx?.imports.get("real")).toEqual({ dir: "real", packageName: "real" });
    for (const name of ctx?.imports.keys() ?? []) {
      expect(name).not.toContain("fake");
    }
  });
});

describe("blankGoTrivia", () => {
  test("comments and string contents are blanked, offsets preserved", () => {
    const src = 'a // x\nb /* y\nz */ c "str" `raw`';
    const out = blankGoTrivia(src);
    expect(out.length).toBe(src.length);
    expect(out).toContain("a ");
    expect(out).toContain("b ");
    expect(out).toContain(" c");
    expect(out).not.toContain("str");
    expect(out).not.toContain("raw");
    expect(out).not.toContain(" x");
  });
});
