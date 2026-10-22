# Rust indexing accuracy

Issue: #39

## Goal

Resolve Rust call edges through crate module paths and use aliases so same-named functions in unrelated modules do not link to the wrong graph node.

## Current evidence

- Rust call normalization removes both module separators and receiver separators in the native, WASM, and regex parsers, reducing `crate::util::run()`, `helper::tool()`, `Circle::new()`, `Self::new()`, `go()` (an alias), and `x.run()` to `run`, `tool`, `new`, `new`, `go`, `run`. Observed by running the WASM parser on a sample file.
- Import parsing stores the raw use-tree text (`super::helper::{self, tool, other as o}`) as one `importPaths` entry. The text contains the aliases, but nothing parses groups, `self`, `as`, or globs into local names, and no Rust path resolves to a file, so Rust has no file-level imports edges.
- Items inside an inline `mod util { pub fn run() {} }` are labeled by their bare name (`run`); only `fn`, `trait`, and `impl` establish a naming context. Two inline modules in one file, or a `mod tests` helper beside a top-level function, can share a label, and the graph keys symbols by file and label.
- Graph construction uses a global symbol-name map that keeps the first matching name. Its same-file lookup splits nested scopes on `.`, while Rust labels use `::` (`Circle::draw`).
- Method calls through any receiver are cut to the method name, so `x.run()` on an unrelated value links to whatever `run` the map finds first.
- The regex fallback records no call expressions and omits methods of trait impls (`Circle::area` in the sample).
- Existing tests cover parser extraction for impls, traits, modules, and use declarations, and the parity suite has one Rust fixture with no pins, but there are no exact Rust graph edges.
- The generic graph builder keeps at most 30 symbols and 20 calls per file, and the native path slices parse results to 20 calls at two sites.

## Scope

- Keep call paths and receiver text in Rust call names across the native, WASM, and regex parsers; resolve explicit use aliases and use trees in TypeScript from the existing `importPaths` text.
- Derive module identity from Cargo crate roots and ordinary `mod` declarations; resolve `crate::`, `self::`, `super::`, child-module paths, and explicit use aliases within one Cargo package, including the package's own library crate by name.
- Resolve `Type::function`, `Self::function`, and `self.method()` to a method of the same type when exactly one exists. Drop every other method call.
- Emit call edges only for unique in-crate targets. Drop external crate, glob-import, unresolved, shadowed, and ambiguous targets.
- Keep existing Rust symbol extraction for functions, impl blocks, traits, and modules, correcting only regressions exposed by the ground-truth fixture.
- Remove the 30-symbol and 20-call graph caps for Rust only, including both native parse-result slices.
- Keep SQLite schema, graph/API shapes, and optional native behavior unchanged.

Cargo workspaces spanning multiple crates, proc-macro expansion, macro-generated symbols, trait dispatch, `#[path]` attributes, and receiver type inference are out of scope.

## Behavior

**Crates.** A crate is a directory that holds a `Cargo.toml`. Its roots are `src/lib.rs`, `src/main.rs`, each `src/bin/*.rs`, and each `src/bin/*/main.rs` present in the workspace file list. Custom `[lib]` and `[[bin]]` paths, build scripts, tests, examples, and benches are not roots. A file belongs to the crate of its nearest ancestor `Cargo.toml`. The package name (`[package] name`, dashes replaced by underscores) names the package's library crate: a binary root may reach its own library through `use <package>::…`. Any other crate name, including workspace siblings and dependencies, is external.

**Modules.** A root file is its crate's root module. For a module item `mod x;` in file F, the child file is `x.rs` or `x/mod.rs` inside F's module directory: a root, `mod.rs`, `lib.rs`, or `main.rs` owns its own directory, and `foo.rs` owns `foo/`. If both candidates exist, or neither does, the child resolves to nothing. A `mod x { … }` with no child file is inline: its items keep their unqualified labels and belong to the file. A file unreachable from a root has no module path and only same-file resolution.

**Use bindings.** Each `importPaths` entry is expanded in TypeScript: nested `{…}` groups are flattened, `self` binds the parent name, `as` renames, and a glob (`*`) binds nothing. Every `use` in the file counts for the whole file, including those inside function bodies. If one local name has more than one distinct path in a file, calls through it are dropped.

**Paths.** The leading segment of a callee resolves as `crate`, `self`, a run of `super`, a name bound by a use, a child module of the current module (edition 2018 uniform paths), or the package's own library name. Anything else is external and drops the call. The remaining module segments are walked through the module tree, and the last segment is a function in the final module. A module that lacks the item but has a use binding of that name forwards to the bound path, up to three hops with a cycle guard. Visibility is not evaluated because the code compiles.

**Calls.**

- A bare call `f()` resolves to a function of the current module, otherwise to a use binding of `f`. There is no walk to enclosing modules, no prelude, and no glob expansion.
- `Type::function()` resolves `Type` as an item of the current module or a use-bound name, then looks up the label `Type::function` in the file that defines `Type`.
- `Self::function()` and `self.method()` use the caller's impl type `T` from the caller label (`T::caller`): the label `T::name` must exist exactly once in the caller's file, or else in the file that defines `T`.
- A method call on any other receiver, a chained call, a trait-qualified path (`<T as Trait>::f`), a tuple-struct constructor, and an enum variant produce no edge.
- Targets are functions and methods.

**Local shadowing.** A call is marked `shadowedLocal` and dropped when its bare callee, or the first segment of its path, is bound in the calling function: as a parameter, a `let` pattern, a closure parameter, a `for` pattern, or an `if let`, `while let`, or match-arm pattern. The scan is conservative and function-granular, covering every identifier in those pattern regions of the whole body, so it may drop a valid edge but never turns a local value into a project call. The marker is computed at parse time from the source and the symbol line ranges and persisted on the call record in the existing `calls` JSON.

**Call names.** `calleeName` keeps the callee text with whitespace removed and turbofish generic arguments (`::<u8>`) stripped: `crate::util::run`, `Self::new`, `x.run`. `calledIdentifiers` keeps the last segment. The native result shape is unchanged.

**Graph limits.** Rust symbols and calls are not truncated by the generic graph limits; non-Rust languages retain their current limits. The cap decision and the call-resolver choice are separate per-language decisions, following the per-language branch the Go work landed: lifting the cap for Rust must not route Rust calls through the OXC module-binding resolver, the same-file lexical lookup, or the global first-match map.

**Versions.** Import and call metadata may extend the internal parser result and existing parsed-document JSON payload; no SQL migration is needed. Native and fallback parser-version tags are bumped, incrementing from the value left by whichever indexing plan landed before this one (the Python and Ruby plans share the tags). Because the tags are shared, unchanged Go and Python parse rows may also be refreshed. A parser-version mismatch is checked during graph construction, while a completed graph can short-circuit after a no-op incremental index. Run `openez reindex <path>` after this change to rebuild old parsed rows and graph artifacts; a no-op `openez index <path>` is not sufficient.

## CodeGraph reference

I inspected [colbymchenry/codegraph at commit `204315274e7902c713ba3ad61e8df511aa634b10`](https://github.com/colbymchenry/codegraph/tree/204315274e7902c713ba3ad61e8df511aa634b10). Its [Rust extractor](https://github.com/colbymchenry/codegraph/blob/204315274e7902c713ba3ad61e8df511aa634b10/src/extraction/languages/rust.ts) and [foreign-impl fixture](https://github.com/colbymchenry/codegraph/blob/204315274e7902c713ba3ad61e8df511aa634b10/__tests__/rust-foreign-impl-calls.test.ts) show how trait scope and concrete argument types affect method targets.

Further fixtures and resolver code read at the same commit and adopted:

- Module and use resolution in [`import-resolver.ts`](https://github.com/colbymchenry/codegraph/blob/204315274e7902c713ba3ad61e8df511aa634b10/src/resolution/import-resolver.ts): `resolveRustModuleFile` maps `crate`, `self`, and `super` segments to `<seg>.rs` or `<seg>/mod.rs`, with a module directory rule for `mod.rs`, `lib.rs`, `main.rs`, and `foo.rs`; `collectRustUseBindings` flattens nested groups and `as` aliases and skips globs.
- [Self-owner scope](https://github.com/colbymchenry/codegraph/blob/204315274e7902c713ba3ad61e8df511aa634b10/__tests__/rust-self-owner.test.ts): `self.reset()` must not borrow a method from a same-named type in another module; a unique owner whose impl is split across files keeps its edge; indistinguishable inline-module owners are declined.
- [Call shapes](https://github.com/colbymchenry/codegraph/blob/204315274e7902c713ba3ad61e8df511aa634b10/__tests__/rust-go-call-shape.test.ts): a bare call never reaches a method, and chained standard-library names (`map`, `unwrap`) are not project methods.
- [Prelude scope](https://github.com/colbymchenry/codegraph/blob/204315274e7902c713ba3ad61e8df511aa634b10/__tests__/rust-prelude-scope.test.ts) and [type scope](https://github.com/colbymchenry/codegraph/blob/204315274e7902c713ba3ad61e8df511aa634b10/__tests__/rust-type-scope.test.ts): `Some`, `Ok`, and a name bound by a `use` of an outside crate are not project items.

Deliberate differences. CodeGraph falls back from a self-relative path to a crate-relative one for 2015-edition code, takes a name-based best match for unknown receivers, tracks item visibility, and maps workspace member crate names through `cargo-workspace.ts`; this plan does none of these. It adopts language-specific module and use fixtures with explicit no-edge assertions, but not type-aware trait dispatch, Cargo workspace evaluation, or CodeGraph's native kernel. OpenEZ keeps its existing optional native, WASM, and regex paths.

## Edge cases

- Two inline modules in one file that declare the same function name make that label ambiguous in the file; a path or bare call to it produces no edge.
- A glob import (`use super::*;`, common in `mod tests`) leaves its names unresolved; calls that depend on it produce no edge.
- A use of an external crate (`use std::collections::HashMap`, `use serde::Serialize`) binds an outside item; calls through it produce no edge, and a project item of the same name is not substituted.
- `Some(x)`, `Ok(x)`, `Err(e)`, and macro invocations produce no edge.
- A private `use` in a module forwards a path through it as a pub one would.
- A function `run` and a local `let run = |x| …; run(1)` in the same file: the call is shadowed and has no edge.
- A `mod x;` whose `x.rs` and `x/mod.rs` both exist, or neither, resolves to nothing.
- A bin root calling `app::util::run()` for its own library `app` resolves into the library crate; a workspace sibling crate name does not.
- `impl Shape for Circle { fn area(&self) { self.draw(); } }` resolves `self.draw()` to `Circle::draw` only when exactly one such label exists.
- When native is disabled, unavailable, or fails to load, the WASM or regex fallback remains usable. The regex fallback records no calls, so it produces use text but no call edges; exact parity is required between native and WASM only.
- CRLF input must produce the same normalized parser results as LF input.

## Interfaces

- The native parseCodeBatch result shape is unchanged. Rust call names keep their qualifiers in the existing calleeName string.
- A new indexer module, `packages/indexer/src/rust-resolver.ts`, holds crate and module discovery, use-tree expansion, the shadow marker, and the call resolver. Crate discovery reads the workspace file list and, per crate, the `[package] name` line of `Cargo.toml`; it runs no Cargo command and needs no TOML parser.
- Use bindings are derived from the cached `importPaths` text at graph time, so no new cached field is needed for them. The shadow marker rides on the call record in the existing `calls` JSON and is added wherever a Rust parse result is produced: the parseDocument path and both native batch sites.

## Coordination

The Go (landed), Python, and Ruby plans edit the same native parser file, the same shared parser version tags, and the cap and resolver block of `buildGraphGeneration`. To keep them independent of landing order:

- Each plan re-verifies names and paths on HEAD in its Task 1 before editing.
- Version tags are incremented from the value left by the previous plan.
- The parity manifest is created by the first plan to land and extended by the others; this plan owns only the Rust entries.
- This plan follows the Go work's per-language pattern: a Rust cap condition at the three cap sites and a Rust resolver branch ahead of the OXC and global fallbacks. It does not add `rust` to the OXC set or restructure the OXC gate. The 20-call native slice is removed for Rust only at both sites; Python keeps its own unless its plan changes it.

## Verification

- Add a Rust graph fixture as a small Cargo package with duplicate function names in file modules and inline modules, `crate`/`self`/`super` paths, child-module paths, explicit use aliases and nested use groups, a `pub use` re-export, `Type::function`, `Self::function`, and `self.method()` calls, a binary root using its own library, shadowing by a closure, and unresolved or external imports.
- Assert exact call targets, zero false positives, and no edge for glob imports, trait dispatch, unknown-receiver method calls, and external crates.
- Include more than 30 symbols and 20 calls in one Rust file and require all of them in the graph, while a Python file keeps its caps.
- Require exact native/WASM parity for maintained Rust fixtures, including CRLF and turbofish forms, and keep Python and Go pins unchanged.
- Verify cache invalidation, focused Rust and graph tests, the full Bun suite, the native build, and the existing three-platform native CI.
- Record graph size and elapsed time for the fixture corpus as informational data.

## Out of scope

Python, Go, Ruby, TypeScript, JavaScript, Cargo workspace cross-crate resolution, `#[path]` module attributes, macro expansion, trait dispatch, receiver type inference, file-level imports edges for Rust, and schema/API changes.

## Related context

None. This repository has no docs/llm wiki.
