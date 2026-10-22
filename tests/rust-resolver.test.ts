import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  createRustResolver,
  type RustResolver,
  type RustResolverFileInput,
} from "../packages/indexer/src/rust-resolver";
import { markRustCallShadowing, parseRust } from "../packages/indexer/src/languages";
import { rmTempDir } from "./helpers/temp-cleanup";

/**
 * Unit coverage for the Rust crate/module resolver: Cargo root discovery,
 * the module directory rules, both/neither candidates, use-tree expansion
 * (groups, self, as, globs, conflicts), every leading-segment form,
 * forwarding chains and cycles, Type/Self/self methods, split impls,
 * duplicate inline names, external crates, and the shadow marker.
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function makeWorkspace(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rustres-"));
  cleanups.push(() => rmTempDir(root));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

function resolverFor(root: string): RustResolver {
  const rustFiles: RustResolverFileInput[] = [];
  const allFiles: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = dir === "." ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else allFiles.push(rel);
    }
  };
  walk(".");
  for (const rel of allFiles) {
    if (!rel.endsWith(".rs")) continue;
    const parsed = parseRust(fs.readFileSync(path.join(root, rel), "utf8"));
    rustFiles.push({
      filePath: rel,
      symbols: parsed.definedSymbols,
      importPaths: parsed.importPaths,
    });
  }
  return createRustResolver(rustFiles, allFiles, root);
}

const APP = {
  "Cargo.toml": '[package]\nname = "app"\nversion = "0.1.0"\n',
  "src/lib.rs": "pub mod util;\npub mod helper;\nmod sub;\n\npub fn root_fn() {}\n",
  "src/util.rs": "pub fn run() {}\npub fn run2() {}\n",
  "src/helper.rs": "pub fn tool() {}\npub fn other() {}\n",
  "src/sub/mod.rs": "pub mod deep;\n\npub fn sub_fn() {}\n",
  "src/sub/deep.rs": "pub fn deep_fn() {}\n",
  "src/main.rs": "fn main() {}\nfn main_helper() {}\n",
};

describe("rust-resolver crate and module discovery", () => {
  test("lib.rs is the crate root; mod chains resolve crate/self/super", () => {
    const root = makeWorkspace({
      ...APP,
      "src/sub/deep.rs": `pub fn deep_fn() {
    crate::root_fn();
    crate::util::run();
    self::deep2();
    super::sub_fn();
    crate::sub::deep::deep2();
}
fn deep2() {}
`,
    });
    const r = resolverFor(root);
    const f = "src/sub/deep.rs";
    expect(r.resolveCall(f, "deep_fn", "crate::root_fn")).toEqual({
      filePath: "src/lib.rs",
      name: "root_fn",
    });
    expect(r.resolveCall(f, "deep_fn", "crate::util::run")).toEqual({
      filePath: "src/util.rs",
      name: "run",
    });
    expect(r.resolveCall(f, "deep_fn", "self::deep2")).toEqual({
      filePath: f,
      name: "deep2",
    });
    expect(r.resolveCall(f, "deep_fn", "super::sub_fn")).toEqual({
      filePath: "src/sub/mod.rs",
      name: "sub_fn",
    });
    expect(r.resolveCall(f, "deep_fn", "crate::sub::deep::deep2")).toEqual({
      filePath: f,
      name: "deep2",
    });
  });

  test("foo.rs owns foo/ for child module declarations", () => {
    const root = makeWorkspace({
      "Cargo.toml": '[package]\nname = "app"\n',
      "src/lib.rs": "mod outer;\n",
      "src/outer.rs": "mod inner;\n\npub fn outer_fn() {}\n",
      "src/outer/inner.rs": "pub fn inner_fn() {}\n",
    });
    const r = resolverFor(root);
    expect(r.resolveCall("src/outer.rs", "outer_fn", "crate::outer::inner::inner_fn")).toEqual({
      filePath: "src/outer/inner.rs",
      name: "inner_fn",
    });
  });

  test("mod with both x.rs and x/mod.rs resolves to nothing", () => {
    const root = makeWorkspace({
      "Cargo.toml": '[package]\nname = "app"\n',
      "src/lib.rs": "mod both;\n\npub fn go() {\n    both::f();\n}\n",
      "src/both.rs": "pub fn f() {}\n",
      "src/both/mod.rs": "pub fn f() {}\n",
    });
    const r = resolverFor(root);
    expect(r.resolveCall("src/lib.rs", "go", "both::f")).toBeNull();
    // The files still exist as standalone items; their internal calls resolve.
    expect(r.resolveCall("src/both.rs", "f", "x")).toBeNull();
  });

  test("mod with neither candidate resolves to nothing", () => {
    const root = makeWorkspace({
      "Cargo.toml": '[package]\nname = "app"\n',
      "src/lib.rs": "mod gone;\n\npub fn go() {\n    gone::f();\n}\n",
    });
    const r = resolverFor(root);
    expect(r.resolveCall("src/lib.rs", "go", "gone::f")).toBeNull();
  });

  test("files unreachable from a root lose module context; own items still resolve", () => {
    const root = makeWorkspace({
      "Cargo.toml": '[package]\nname = "app"\n',
      "src/lib.rs": "pub fn root_fn() {}\n",
      "src/orphan.rs":
        "pub fn helper() {}\npub fn f() {\n    helper();\n    crate::root_fn();\n}\n",
    });
    const r = resolverFor(root);
    expect(r.resolveCall("src/orphan.rs", "f", "helper")).toEqual({
      filePath: "src/orphan.rs",
      name: "helper",
    });
    expect(r.resolveCall("src/orphan.rs", "f", "crate::root_fn")).toBeNull();
    expect(r.resolveCall("src/orphan.rs", "f", "self::helper")).toBeNull();
  });

  test("binary roots see their own crate plus the library by package name", () => {
    const root = makeWorkspace({
      ...APP,
      "src/main.rs": `fn main() {
    app::util::run();
    crate::main_helper();
    app::sub::deep::deep_fn();
}
fn main_helper() {}
`,
      "src/bin/extra.rs": `fn main() {
    app::util::run();
    crate::bin_helper();
}
fn bin_helper() {}
`,
    });
    const r = resolverFor(root);
    expect(r.resolveCall("src/main.rs", "main", "app::util::run")).toEqual({
      filePath: "src/util.rs",
      name: "run",
    });
    expect(r.resolveCall("src/main.rs", "main", "crate::main_helper")).toEqual({
      filePath: "src/main.rs",
      name: "main_helper",
    });
    expect(r.resolveCall("src/main.rs", "main", "app::sub::deep::deep_fn")).toEqual({
      filePath: "src/sub/deep.rs",
      name: "deep_fn",
    });
    expect(r.resolveCall("src/bin/extra.rs", "main", "app::util::run")).toEqual({
      filePath: "src/util.rs",
      name: "run",
    });
    expect(r.resolveCall("src/bin/extra.rs", "main", "crate::bin_helper")).toEqual({
      filePath: "src/bin/extra.rs",
      name: "bin_helper",
    });
    // main.rs's crate root is itself, not lib.rs.
    expect(r.resolveCall("src/main.rs", "main", "crate::root_fn")).toBeNull();
  });

  test("sibling crates are external — names never cross crate boundaries", () => {
    const root = makeWorkspace({
      "a/Cargo.toml": '[package]\nname = "a"\n',
      "a/src/lib.rs": "pub mod m;\n",
      "a/src/m.rs": "pub fn shared() {}\n",
      "b/Cargo.toml": '[package]\nname = "b"\n',
      "b/src/lib.rs":
        "pub mod m;\n\npub fn go() {\n    crate::m::shared();\n    a::m::shared();\n}\n",
      "b/src/m.rs": "pub fn shared() {}\n",
    });
    const r = resolverFor(root);
    expect(r.resolveCall("b/src/lib.rs", "go", "crate::m::shared")).toEqual({
      filePath: "b/src/m.rs",
      name: "shared",
    });
    // `a::m::shared` — `a` is not b's package name, child, item or binding.
    expect(r.resolveCall("b/src/lib.rs", "go", "a::m::shared")).toBeNull();
  });

  test("dashes in [package] name become underscores for own-library paths", () => {
    const root = makeWorkspace({
      "Cargo.toml": '[package]\nname = "my-app"\n',
      "src/lib.rs": "pub mod util;\n",
      "src/util.rs": "pub fn run() {}\n",
      "src/main.rs": "fn main() {\n    my_app::util::run();\n}\n",
    });
    const r = resolverFor(root);
    expect(r.resolveCall("src/main.rs", "main", "my_app::util::run")).toEqual({
      filePath: "src/util.rs",
      name: "run",
    });
  });
});

describe("rust-resolver use bindings", () => {
  test("nested groups, self, as, and re-exported paths bind correctly", () => {
    const root = makeWorkspace({
      ...APP,
      "src/lib.rs": "pub mod util;\npub mod helper;\npub use crate::util::run as root_run;\n",
      "src/user.rs": `use crate::util::{self, run as go, run2};
use crate::helper::{self, other as o};
use crate::lib_missing::*;

pub fn f() {
    util::run2();
    go();
    run2();
    helper::tool();
    o();
    crate::root_run();
}
`,
      "src/lib2_marker.rs": "",
    });
    // lib.rs declares no `mod user` — attach it so module context exists.
    fs.writeFileSync(
      path.join(root, "src/lib.rs"),
      "pub mod util;\npub mod helper;\npub mod user;\npub use crate::util::run as root_run;\n",
    );
    const r = resolverFor(root);
    const f = "src/user.rs";
    expect(r.resolveCall(f, "f", "util::run2")).toEqual({ filePath: "src/util.rs", name: "run2" });
    expect(r.resolveCall(f, "f", "go")).toEqual({ filePath: "src/util.rs", name: "run" });
    expect(r.resolveCall(f, "f", "run2")).toEqual({ filePath: "src/util.rs", name: "run2" });
    expect(r.resolveCall(f, "f", "helper::tool")).toEqual({
      filePath: "src/helper.rs",
      name: "tool",
    });
    expect(r.resolveCall(f, "f", "o")).toEqual({ filePath: "src/helper.rs", name: "other" });
    // pub use forwarding through the crate root.
    expect(r.resolveCall(f, "f", "crate::root_run")).toEqual({
      filePath: "src/util.rs",
      name: "run",
    });
    // Glob-only names bind nothing.
    expect(r.resolveCall(f, "f", "lib_missing::x")).toBeNull();
  });

  test("one local name with two distinct paths is ambiguous", () => {
    const root = makeWorkspace({
      "Cargo.toml": '[package]\nname = "app"\n',
      "src/lib.rs": "pub mod util;\npub mod helper;\npub mod user;\n",
      "src/util.rs": "pub fn run() {}\n",
      "src/helper.rs": "pub fn run() {}\n",
      "src/user.rs": `use crate::util::run;
use crate::helper::run;

pub fn f() {
    run();
}
`,
    });
    const r = resolverFor(root);
    expect(r.resolveCall("src/user.rs", "f", "run")).toBeNull();
  });

  test("external crate paths (std, deps) never resolve", () => {
    const root = makeWorkspace({
      "Cargo.toml": '[package]\nname = "app"\n',
      "src/lib.rs": "pub mod user;\n",
      "src/user.rs": `use std::collections::HashMap;
use serde::Serialize;

pub fn f() {
    let _m = HashMap::new();
    std::collections::HashMap::new();
}
`,
    });
    const r = resolverFor(root);
    expect(r.resolveCall("src/user.rs", "f", "HashMap::new")).toBeNull();
    expect(r.resolveCall("src/user.rs", "f", "std::collections::HashMap::new")).toBeNull();
  });

  test("forwarding chains up to three hops; cycles drop", () => {
    const root = makeWorkspace({
      "Cargo.toml": '[package]\nname = "app"\n',
      "src/lib.rs": "pub mod a;\npub mod b;\npub mod c;\npub mod d;\npub mod user;\n",
      "src/a.rs": "pub use crate::b::it as it_a;\n",
      "src/b.rs": "pub use crate::c::it as it;\n",
      "src/c.rs": "pub use crate::d::it as it;\n",
      "src/d.rs": "pub fn it() {}\n",
      "src/user.rs": `pub fn f() {
    crate::a::it_a();
}
`,
      "src/cycle.rs": "pub use crate::cycle::spin as spin;\n",
    });
    fs.writeFileSync(
      path.join(root, "src/lib.rs"),
      "pub mod a;\npub mod b;\npub mod c;\npub mod d;\npub mod user;\npub mod cycle;\n",
    );
    const r = resolverFor(root);
    // a::it_a -> b::it -> c::it -> d::it — three forwards, allowed.
    expect(r.resolveCall("src/user.rs", "f", "crate::a::it_a")).toEqual({
      filePath: "src/d.rs",
      name: "it",
    });
    // cycle.rs re-exports its own binding — a forward loop.
    expect(r.resolveCall("src/user.rs", "f", "crate::cycle::spin")).toBeNull();
  });
});

describe("rust-resolver call forms", () => {
  test("bare name resolves to a unique same-file function only", () => {
    const root = makeWorkspace({
      "Cargo.toml": '[package]\nname = "app"\n',
      "src/lib.rs": "mod a;\nmod b;\n\npub fn top() {}\n",
      "src/a.rs": "pub fn dup() {}\npub fn f() {\n    dup();\n    top();\n}\n",
      "src/b.rs": "pub fn dup() {}\n",
    });
    const r = resolverFor(root);
    expect(r.resolveCall("src/a.rs", "f", "dup")).toEqual({ filePath: "src/a.rs", name: "dup" });
    // `top` lives only in lib.rs — bare names do not climb modules.
    expect(r.resolveCall("src/a.rs", "f", "top")).toBeNull();
  });

  test("duplicate inline module items stay ambiguous and drop", () => {
    const root = makeWorkspace({
      "Cargo.toml": '[package]\nname = "app"\n',
      "src/lib.rs": "mod dup;\n",
      "src/dup.rs": `mod a { pub fn same() {} }
mod b { pub fn same() {} }

pub fn caller() {
    same();
}
`,
    });
    const r = resolverFor(root);
    expect(r.resolveCall("src/dup.rs", "caller", "same")).toBeNull();
  });

  test("Type::function resolves only when the method is unique on the type", () => {
    const root = makeWorkspace({
      "Cargo.toml": '[package]\nname = "app"\n',
      "src/lib.rs": "mod shapes;\nmod caller;\n",
      "src/shapes.rs": `pub struct Circle;
impl Circle {
    pub fn new() -> Circle { Circle }
    pub fn draw(&self) {}
}
`,
      "src/caller.rs": `use crate::shapes::Circle;
pub fn f() {
    Circle::new();
    Circle::missing();
}
`,
    });
    const r = resolverFor(root);
    expect(r.resolveCall("src/caller.rs", "f", "Circle::new")).toEqual({
      filePath: "src/shapes.rs",
      name: "Circle::new",
    });
    expect(r.resolveCall("src/caller.rs", "f", "Circle::missing")).toBeNull();
  });

  test("self.method() resolves through the caller's type, including split impls", () => {
    const root = makeWorkspace({
      "Cargo.toml": '[package]\nname = "app"\n',
      "src/lib.rs": "mod shapes;\nmod ext;\n",
      "src/shapes.rs": `pub struct Circle;
impl Circle {
    pub fn draw(&self) {}
    pub fn area(&self) {
        self.draw();
        self.missing();
    }
}
`,
      "src/ext.rs": `use crate::shapes::Circle;
impl Circle {
    pub fn describe(&self) {
        self.draw();
    }
}
`,
    });
    const r = resolverFor(root);
    expect(r.resolveCall("src/shapes.rs", "Circle::area", "self.draw")).toEqual({
      filePath: "src/shapes.rs",
      name: "Circle::draw",
    });
    // Split impl: `self.draw` in ext.rs resolves through the type's file.
    expect(r.resolveCall("src/ext.rs", "Circle::describe", "self.draw")).toEqual({
      filePath: "src/shapes.rs",
      name: "Circle::draw",
    });
    expect(r.resolveCall("src/shapes.rs", "Circle::area", "self.missing")).toBeNull();
  });

  test("Self::function behaves like self.method()", () => {
    const root = makeWorkspace({
      "Cargo.toml": '[package]\nname = "app"\n',
      "src/lib.rs": "mod shapes;\n",
      "src/shapes.rs": `pub struct Circle;
impl Circle {
    pub fn new() -> Circle { Circle }
    pub fn again(&self) {
        Self::new();
    }
}
`,
    });
    const r = resolverFor(root);
    expect(r.resolveCall("src/shapes.rs", "Circle::again", "Self::new")).toEqual({
      filePath: "src/shapes.rs",
      name: "Circle::new",
    });
  });

  test("other receivers, tuple constructors, and ignored wrappers drop", () => {
    const root = makeWorkspace({
      "Cargo.toml": '[package]\nname = "app"\n',
      "src/lib.rs": "mod s;\n",
      "src/s.rs": `pub struct Pair(pub i32);
pub fn run() {}
pub fn f() {
    let x = Pair(1);
    x.run();
    let _s = Some(1);
    let _o = Ok(2);
}
`,
    });
    const r = resolverFor(root);
    expect(r.resolveCall("src/s.rs", "f", "x.run")).toBeNull();
    expect(r.resolveCall("src/s.rs", "f", "Pair")).toBeNull();
    expect(r.resolveCall("src/s.rs", "f", "Some")).toBeNull();
    expect(r.resolveCall("src/s.rs", "f", "Ok")).toBeNull();
  });

  test("shadowedLocal calls always drop", () => {
    const root = makeWorkspace({
      "Cargo.toml": '[package]\nname = "app"\n',
      "src/lib.rs": "mod s;\n",
      "src/s.rs": "pub fn run() {}\npub fn f() { let run = || (); run(); }\n",
    });
    const r = resolverFor(root);
    expect(r.resolveCall("src/s.rs", "f", "run", true)).toBeNull();
    expect(r.resolveCall("src/s.rs", "f", "run")).toEqual({
      filePath: "src/s.rs",
      name: "run",
    });
  });

  test("uppercase bindings shadow a same-named imported alias", () => {
    const content = `mod target;
use crate::target::run as Run;
use crate::target::run;
use crate::target::predicate;

pub fn caller(Run: fn()) {
    Run();
}

pub fn let_shadow() {
    let Run = || {};
    Run();
}

pub fn closure_shadow() {
    let invoke = |Run| Run();
}

pub fn for_shadow() {
    for Run in [|| {}] {
        Run();
    }
}

pub fn iflet_shadow() {
    if let Some(Run) = Some(|| {}) {
        Run();
    }
}

pub enum State { Run }
pub struct Record { Run: i32 }
pub type Run = fn();
pub enum ResultLike<T> { Ok(T) }

pub fn constructor_pattern_does_not_shadow(state: State) {
    if let State::Run = state {
        Run();
    }
}

pub fn field_pattern_does_not_shadow(record: Record) {
    if let Record { Run: value } = record {
        Run();
    }
}

pub struct LowerRecord { run: i32 }
pub mod constants { pub const run: i32 = 0; }

pub fn lowercase_field_pattern_does_not_shadow(record: LowerRecord) {
    match record {
        LowerRecord { run: value } => run(),
    }
}

pub fn qualified_pattern_path_does_not_shadow(value: i32) {
    match value {
        constants::run => run(),
        _ => (),
    }
}

pub fn generic_pattern_path_does_not_shadow(value: ResultLike<fn()>) {
    match value {
        ResultLike::<Run>::Ok(value) => Run(),
    }
}

pub fn match_shadow(value: Option<fn()>) {
    match value {
        Some(Run) => Run(),
        None => (),
    }
}

pub fn nested_match_shadow(value: Option<Result<fn(), ()>>) {
    match value {
        Some(Ok(Run)) => Run(),
        _ => (),
    }
}

pub fn bare_match_shadow(value: fn()) {
    match value {
        Run => Run(),
    }
}

pub fn block_scrutinee_match_shadow(value: Option<fn()>) {
    match { let _ = "=>"; value } {
        Some(Run) => Run(),
        None => (),
    }
}

pub fn match_guard_call(value: Option<fn()>) {
    match value {
        Some(Run)if predicate() => Run(),
        None => (),
    }
}

pub fn type_name_is_not_a_binding(value: Run) {
    Run();
}
`;
    const root = makeWorkspace({
      "Cargo.toml": '[package]\nname = "app"\n',
      "src/lib.rs": content,
      "src/target.rs": "pub fn run() {}\npub fn predicate() -> bool { true }\n",
    });
    const parsed = parseRust(content);
    const calls: Array<{ callerName: string; calleeName: string; shadowedLocal?: boolean }> =
      parsed.callExpressions.map(({ callerName, calleeName }) => ({ callerName, calleeName }));
    markRustCallShadowing(content, parsed.definedSymbols, calls);

    const call = calls.find(
      (candidate) => candidate.callerName === "caller" && candidate.calleeName === "Run",
    );
    expect(call?.calleeName).toBe("Run");
    expect(call?.shadowedLocal).toBe(true);
    const closureCall = calls.find(
      (candidate) => candidate.callerName === "closure_shadow" && candidate.calleeName === "Run",
    );
    expect(closureCall?.shadowedLocal).toBe(true);
    const typeCall = calls.find(
      (candidate) =>
        candidate.callerName === "type_name_is_not_a_binding" && candidate.calleeName === "Run",
    );
    expect(typeCall?.shadowedLocal).toBeUndefined();
    const constructorCall = calls.find(
      (candidate) =>
        candidate.callerName === "constructor_pattern_does_not_shadow" &&
        candidate.calleeName === "Run",
    );
    expect(constructorCall?.shadowedLocal).toBeUndefined();
    const fieldCall = calls.find(
      (candidate) =>
        candidate.callerName === "field_pattern_does_not_shadow" && candidate.calleeName === "Run",
    );
    expect(fieldCall?.shadowedLocal).toBeUndefined();
    const matchCall = calls.find(
      (candidate) => candidate.callerName === "match_shadow" && candidate.calleeName === "Run",
    );
    expect(matchCall?.shadowedLocal).toBe(true);
    const nestedMatchCall = calls.find(
      (candidate) =>
        candidate.callerName === "nested_match_shadow" && candidate.calleeName === "Run",
    );
    expect(nestedMatchCall?.shadowedLocal).toBe(true);
    const bareMatchCall = calls.find(
      (candidate) => candidate.callerName === "bare_match_shadow" && candidate.calleeName === "Run",
    );
    expect(bareMatchCall?.shadowedLocal).toBe(true);
    const blockScrutineeCall = calls.find(
      (candidate) =>
        candidate.callerName === "block_scrutinee_match_shadow" && candidate.calleeName === "Run",
    );
    expect(blockScrutineeCall?.shadowedLocal).toBe(true);
    const guardCall = calls.find(
      (candidate) =>
        candidate.callerName === "match_guard_call" && candidate.calleeName === "predicate",
    );
    expect(guardCall?.shadowedLocal).toBeUndefined();
    const lowercaseFieldCall = calls.find(
      (candidate) =>
        candidate.callerName === "lowercase_field_pattern_does_not_shadow" &&
        candidate.calleeName === "run",
    );
    expect(lowercaseFieldCall?.shadowedLocal).toBeUndefined();
    const qualifiedPathCall = calls.find(
      (candidate) =>
        candidate.callerName === "qualified_pattern_path_does_not_shadow" &&
        candidate.calleeName === "run",
    );
    expect(qualifiedPathCall?.shadowedLocal).toBeUndefined();
    const genericPathCall = calls.find(
      (candidate) =>
        candidate.callerName === "generic_pattern_path_does_not_shadow" &&
        candidate.calleeName === "Run",
    );
    expect(genericPathCall?.shadowedLocal).toBeUndefined();

    const r = resolverFor(root);
    expect(r.resolveCall("src/lib.rs", "caller", "Run")).toEqual({
      filePath: "src/target.rs",
      name: "run",
    });
    expect(r.resolveCall("src/lib.rs", "caller", "Run", call?.shadowedLocal)).toBeNull();
    expect(
      r.resolveCall("src/lib.rs", "closure_shadow", "Run", closureCall?.shadowedLocal),
    ).toBeNull();
    expect(
      r.resolveCall("src/lib.rs", "type_name_is_not_a_binding", "Run", typeCall?.shadowedLocal),
    ).toEqual({
      filePath: "src/target.rs",
      name: "run",
    });
    expect(
      r.resolveCall(
        "src/lib.rs",
        "constructor_pattern_does_not_shadow",
        "Run",
        constructorCall?.shadowedLocal,
      ),
    ).toEqual({
      filePath: "src/target.rs",
      name: "run",
    });
    expect(
      r.resolveCall(
        "src/lib.rs",
        "generic_pattern_path_does_not_shadow",
        "Run",
        genericPathCall?.shadowedLocal,
      ),
    ).toEqual({
      filePath: "src/target.rs",
      name: "run",
    });
    expect(
      r.resolveCall("src/lib.rs", "field_pattern_does_not_shadow", "Run", fieldCall?.shadowedLocal),
    ).toEqual({
      filePath: "src/target.rs",
      name: "run",
    });
    expect(r.resolveCall("src/lib.rs", "match_shadow", "Run", matchCall?.shadowedLocal)).toBeNull();
    expect(
      r.resolveCall("src/lib.rs", "nested_match_shadow", "Run", nestedMatchCall?.shadowedLocal),
    ).toBeNull();
    expect(
      r.resolveCall("src/lib.rs", "bare_match_shadow", "Run", bareMatchCall?.shadowedLocal),
    ).toBeNull();
    expect(
      r.resolveCall(
        "src/lib.rs",
        "block_scrutinee_match_shadow",
        "Run",
        blockScrutineeCall?.shadowedLocal,
      ),
    ).toBeNull();
    expect(
      r.resolveCall("src/lib.rs", "match_guard_call", "predicate", guardCall?.shadowedLocal),
    ).toEqual({
      filePath: "src/target.rs",
      name: "predicate",
    });
    expect(
      r.resolveCall(
        "src/lib.rs",
        "lowercase_field_pattern_does_not_shadow",
        "run",
        lowercaseFieldCall?.shadowedLocal,
      ),
    ).toEqual({
      filePath: "src/target.rs",
      name: "run",
    });
    expect(
      r.resolveCall(
        "src/lib.rs",
        "qualified_pattern_path_does_not_shadow",
        "run",
        qualifiedPathCall?.shadowedLocal,
      ),
    ).toEqual({
      filePath: "src/target.rs",
      name: "run",
    });
    expect(
      r.resolveCall(
        "src/lib.rs",
        "generic_pattern_path_does_not_shadow",
        "Run",
        genericPathCall?.shadowedLocal,
      ),
    ).toEqual({
      filePath: "src/target.rs",
      name: "run",
    });

    for (const callerName of ["let_shadow", "for_shadow", "iflet_shadow"]) {
      const localCall = calls.find(
        (candidate) => candidate.callerName === callerName && candidate.calleeName === "Run",
      );
      expect(localCall?.shadowedLocal, `${callerName} should mark Run as local`).toBe(true);
      expect(r.resolveCall("src/lib.rs", callerName, "Run", localCall?.shadowedLocal)).toBeNull();
    }
  });
});

describe("markRustCallShadowing", () => {
  test("let/closure/param/for/if-let/match bindings mark calls", () => {
    const content = `pub fn run() {}
pub fn compute(x: i32) -> i32 { x }

pub fn shadow_test() {
    let run = |v: i32| v;
    run(1);
    let compute = |v: i32| v * 2;
    compute(2);
}

pub fn param_shadow(run: i32) {
    run();
}

pub fn closure_param() {
    let f = |run: i32| run;
    run();
}

pub fn for_shadow() {
    for run in 0..3 {
        run();
    }
}

pub fn iflet_shadow(o: Option<i32>) {
    if let helper = o {
        helper();
    }
}

pub fn match_shadow_call() {
    let o = Some(1);
    match o {
        helper => println!("x"),
        _ => (),
    }
    helper();
}
`;
    const parsed = parseRust(content);
    const calls: Array<{ callerName: string; calleeName: string; shadowedLocal?: boolean }> = [
      { callerName: "shadow_test", calleeName: "run" },
      { callerName: "shadow_test", calleeName: "compute" },
      { callerName: "param_shadow", calleeName: "run" },
      { callerName: "closure_param", calleeName: "run" },
      { callerName: "for_shadow", calleeName: "run" },
      { callerName: "iflet_shadow", calleeName: "helper" },
      { callerName: "match_shadow_call", calleeName: "helper" },
    ];
    markRustCallShadowing(content, parsed.definedSymbols, calls);
    for (const call of calls) {
      expect(call.shadowedLocal, `${call.callerName} -> ${call.calleeName}`).toBe(true);
    }
  });

  test("unshadowed calls stay unmarked", () => {
    const content = `pub fn run() {}
pub fn f() {
    run();
    let other = run();
}

pub struct Worker;
impl Worker {
    pub fn run(&self) {}
    pub fn call(&self) {
        let run = 0;
        self.run();
    }
}
`;
    const parsed = parseRust(content);
    const calls: Array<{ callerName: string; calleeName: string; shadowedLocal?: boolean }> = [
      { callerName: "f", calleeName: "run" },
      { callerName: "f", calleeName: "crate::x::run" },
      { callerName: "Worker::call", calleeName: "self.run" },
    ];
    markRustCallShadowing(content, parsed.definedSymbols, calls);
    expect(calls[0].shadowedLocal).toBeUndefined();
    expect(calls[1].shadowedLocal).toBeUndefined();
    expect(calls[2].shadowedLocal).toBeUndefined();

    const root = makeWorkspace({
      "Cargo.toml": '[package]\nname = "app"\n',
      "src/lib.rs": content,
    });
    expect(
      resolverFor(root).resolveCall(
        "src/lib.rs",
        "Worker::call",
        "self.run",
        calls[2].shadowedLocal,
      ),
    ).toEqual({
      filePath: "src/lib.rs",
      name: "Worker::run",
    });
  });
});
