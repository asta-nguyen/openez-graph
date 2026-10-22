import { describe, expect, test } from "bun:test";

import {
  createRubyImportResolver,
  createRubyResolver,
} from "../packages/indexer/src/ruby-resolver";

/**
 * Unit coverage for the scope-aware Ruby resolver — the fixture-level
 * end-to-end cases live in tests/ruby-edge-accuracy.test.ts.
 */

function resolverFor(symbols: Array<{ filePath: string; name: string; symbolType?: string }>) {
  return createRubyResolver({
    symbols: symbols.map((s) => ({ symbolType: "function", ...s })),
  });
}

describe("ruby-resolver", () => {
  test("bare calls resolve to the caller's own class/module first", () => {
    const resolver = resolverFor([
      { filePath: "a.rb", name: "Billing::Invoice::total" },
      { filePath: "a.rb", name: "Billing::Invoice::tax" },
      { filePath: "a.rb", name: "tax" },
    ]);
    expect(
      resolver.resolveCall({
        callerName: "Billing::Invoice::total",
        calleeName: "tax",
        filePath: "a.rb",
      }),
    ).toEqual({ filePath: "a.rb", symbolName: "Billing::Invoice::tax" });
  });

  test("bare calls fall back to a unique top-level method only", () => {
    const resolver = resolverFor([
      { filePath: "a.rb", name: "C::run" },
      { filePath: "a.rb", name: "emit" },
    ]);
    expect(
      resolver.resolveCall({
        callerName: "C::run",
        calleeName: "emit",
        filePath: "a.rb",
      }),
    ).toEqual({ filePath: "a.rb", symbolName: "emit" });
    // No candidate anywhere → null.
    expect(
      resolver.resolveCall({
        callerName: "C::run",
        calleeName: "missing",
        filePath: "a.rb",
      }),
    ).toBeNull();
  });

  test("bare calls do not walk enclosing namespaces", () => {
    const resolver = resolverFor([
      { filePath: "a.rb", name: "Outer::Inner::m" },
      { filePath: "a.rb", name: "Outer::helper" },
    ]);
    // `helper` is defined on `Outer`, one level above the caller's own
    // class `Outer::Inner` — the resolver must not climb to it.
    expect(
      resolver.resolveCall({
        callerName: "Outer::Inner::m",
        calleeName: "helper",
        filePath: "a.rb",
      }),
    ).toBeNull();
  });

  test("reopened classes resolve across files; duplicate labels are ambiguous", () => {
    const resolver = resolverFor([
      { filePath: "x.rb", name: "Rep::Report::generate" },
      { filePath: "x.rb", name: "Rep::Report::stamp" },
      { filePath: "x.rb", name: "Rep::Report::clean" },
      { filePath: "y.rb", name: "Rep::Report::clean" },
      { filePath: "y.rb", name: "Rep::Report::helper_b" },
    ]);
    // Only defined in y.rb → unique cross-file hit.
    expect(
      resolver.resolveCall({
        callerName: "Rep::Report::generate",
        calleeName: "helper_b",
        filePath: "x.rb",
      }),
    ).toEqual({ filePath: "y.rb", symbolName: "Rep::Report::helper_b" });
    // Defined in both files → ambiguous → no edge.
    expect(
      resolver.resolveCall({
        callerName: "Rep::Report::generate",
        calleeName: "clean",
        filePath: "x.rb",
      }),
    ).toBeNull();
    // Unique in the caller's own file.
    expect(
      resolver.resolveCall({
        callerName: "Rep::Report::generate",
        calleeName: "stamp",
        filePath: "x.rb",
      }),
    ).toEqual({ filePath: "x.rb", symbolName: "Rep::Report::stamp" });
  });

  test("qualified callees walk lexical scopes innermost-first", () => {
    const resolver = resolverFor([
      { filePath: "a.rb", name: "Billing", symbolType: "module" },
      { filePath: "a.rb", name: "Billing::Invoice", symbolType: "class" },
      { filePath: "a.rb", name: "Billing::Helper", symbolType: "module" },
      { filePath: "a.rb", name: "Billing::Invoice::total" },
      { filePath: "a.rb", name: "Billing::Invoice::build" },
      { filePath: "a.rb", name: "Billing::Helper::run" },
      { filePath: "a.rb", name: "Billing::Invoice::tax" },
    ]);
    const caller = { callerName: "Billing::Invoice::total", filePath: "a.rb" };
    // `Invoice::build` resolves via the `Billing` scope.
    expect(resolver.resolveCall({ ...caller, calleeName: "Invoice::build" })).toEqual({
      filePath: "a.rb",
      symbolName: "Billing::Invoice::build",
    });
    // `Helper::run` resolves via the `Billing` scope.
    expect(resolver.resolveCall({ ...caller, calleeName: "Helper::run" })).toEqual({
      filePath: "a.rb",
      symbolName: "Billing::Helper::run",
    });
    // Fully-qualified `Billing::Invoice::tax` (self.foo output) hits directly.
    expect(resolver.resolveCall({ ...caller, calleeName: "Billing::Invoice::tax" })).toEqual({
      filePath: "a.rb",
      symbolName: "Billing::Invoice::tax",
    });
    // `Child::build` where only `Parent::build` exists — no ancestor walk.
    expect(resolver.resolveCall({ ...caller, calleeName: "Child::build" })).toBeNull();
  });

  test("same-file duplicate labels collapse to one candidate", () => {
    // `def audit` and `class << self; def audit` share the label — the
    // (file, name) pair is still unique, so the call resolves.
    const resolver = resolverFor([
      { filePath: "a.rb", name: "Billing::Invoice::total" },
      { filePath: "a.rb", name: "Billing::Invoice::audit" },
      { filePath: "a.rb", name: "Billing::Invoice::audit" },
    ]);
    expect(
      resolver.resolveCall({
        callerName: "Billing::Invoice::total",
        calleeName: "audit",
        filePath: "a.rb",
      }),
    ).toEqual({ filePath: "a.rb", symbolName: "Billing::Invoice::audit" });
  });

  test("class/module-body callers use their own label as scope", () => {
    const resolver = resolverFor([
      { filePath: "a.rb", name: "Widget", symbolType: "class" },
      { filePath: "a.rb", name: "Widget::helper" },
      { filePath: "a.rb", name: "Mod", symbolType: "module" },
      { filePath: "a.rb", name: "Mod::helper" },
      { filePath: "a.rb", name: "Outer", symbolType: "class" },
      { filePath: "a.rb", name: "helper" },
    ]);
    // `helper()` in `class Widget` body → Widget::helper.
    expect(
      resolver.resolveCall({ callerName: "Widget", calleeName: "helper", filePath: "a.rb" }),
    ).toEqual({ filePath: "a.rb", symbolName: "Widget::helper" });
    // `helper()` in `module Mod` body → Mod::helper.
    expect(
      resolver.resolveCall({ callerName: "Mod", calleeName: "helper", filePath: "a.rb" }),
    ).toEqual({ filePath: "a.rb", symbolName: "Mod::helper" });
    // `helper()` in `class Outer` body, Outer::helper absent → top-level.
    expect(
      resolver.resolveCall({ callerName: "Outer", calleeName: "helper", filePath: "a.rb" }),
    ).toEqual({ filePath: "a.rb", symbolName: "helper" });
  });

  test("class-body callers never walk enclosing namespaces", () => {
    const resolver = resolverFor([
      { filePath: "a.rb", name: "A::B", symbolType: "class" },
      { filePath: "a.rb", name: "A::helper" },
    ]);
    // `helper()` in `class A::B` body must not climb to A::helper.
    expect(
      resolver.resolveCall({ callerName: "A::B", calleeName: "helper", filePath: "a.rb" }),
    ).toBeNull();
  });

  test("qualified callees resolve the constant segment lexically", () => {
    const resolver = resolverFor([
      { filePath: "a.rb", name: "A::B::m" },
      { filePath: "a.rb", name: "A::B::C", symbolType: "class" },
      { filePath: "a.rb", name: "C::foo" },
      { filePath: "a.rb", name: "A::B::C::m" },
    ]);
    // Inner A::B::C exists → the call binds there, never to top-level C::foo.
    expect(
      resolver.resolveCall({ callerName: "A::B::m", calleeName: "C::m", filePath: "a.rb" }),
    ).toEqual({ filePath: "a.rb", symbolName: "A::B::C::m" });
    // Inner A::B::C exists but defines no foo → no edge to top-level C::foo.
    expect(
      resolver.resolveCall({ callerName: "A::B::m", calleeName: "C::foo", filePath: "a.rb" }),
    ).toBeNull();
  });

  test("leading :: callees resolve at top level", () => {
    const resolver = resolverFor([
      { filePath: "a.rb", name: "A::B::m" },
      { filePath: "a.rb", name: "A::B::Top", symbolType: "class" },
      { filePath: "a.rb", name: "A::B::Top::ping" },
      { filePath: "a.rb", name: "Top", symbolType: "class" },
      { filePath: "a.rb", name: "Top::ping" },
    ]);
    // `::Top` is absolute — resolves top-level even though A::B::Top exists.
    expect(
      resolver.resolveCall({ callerName: "A::B::m", calleeName: "::Top::ping", filePath: "a.rb" }),
    ).toEqual({ filePath: "a.rb", symbolName: "Top::ping" });
  });

  test("bare calls never bind to non-method symbols", () => {
    const resolver = resolverFor([
      { filePath: "a.rb", name: "C::run" },
      { filePath: "a.rb", name: "helper", symbolType: "lambda" },
    ]);
    expect(
      resolver.resolveCall({ callerName: "C::run", calleeName: "helper", filePath: "a.rb" }),
    ).toBeNull();
  });

  test("require_relative resolves only .rb targets", () => {
    const known = new Set(["util.rb", "util.md", "other.rb", "sub/helper.rb"]);
    const importResolver = createRubyImportResolver({
      workspaceRoot: "/ws",
      workspaceRelativeFor: (abs) => {
        const rel = abs.replace(/^\/ws\//, "").replaceAll("\\", "/");
        return known.has(rel) ? rel : null;
      },
    });
    expect(importResolver.resolveImport("main.rb", "./util")).toBe("util.rb");
    expect(importResolver.resolveImport("main.rb", "./other.rb")).toBe("other.rb");
    expect(importResolver.resolveImport("main.rb", "./sub/helper")).toBe("sub/helper.rb");
    // A .md with the same stem never captures the edge — as-written or appended.
    expect(importResolver.resolveImport("main.rb", "util.md")).toBeNull();
    expect(importResolver.resolveImport("main.rb", "./missing")).toBeNull();
  });
});
