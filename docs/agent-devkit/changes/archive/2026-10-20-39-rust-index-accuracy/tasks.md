# Rust indexing accuracy tasks

Issue: #39

## Design

[Rust indexing accuracy](design.md)

## Global Constraints

- Scope production behavior changes to Rust.
- Keep the SQLite schema and CLI/MCP interfaces unchanged.
- Keep the native parser optional and preserve OPENEZ_NATIVE=0 behavior. Keep the native result shape unchanged: qualifiers travel in the existing calleeName string, and use bindings are derived in TypeScript from `importPaths`.
- Resolve calls only through a unique in-crate module path, lexical target, or the `Type`/`Self`/`self` method rules; never use first-match global-name fallback for Rust.
- Do not add Cargo command execution, a TOML parser dependency, type-checker dependencies, macro expansion, glob expansion, or guessed trait edges.
- Remove the 30/20 graph caps for Rust only, at the graph-build truncation and at both native `slice(0, 20)` sites; Python keeps its own.
- Follow the per-language pattern the Go work landed: a Rust cap condition and a Rust resolver branch beside the existing ones. Adding Rust to the OXC set is not allowed.
- Increment the native and fallback parser version tags from the values left by any earlier plan (Python and Ruby share `native-v1` and `fallback-v1`).
- The shared parity manifest is created by the first plan to land and extended by the others; this plan owns only the Rust entries.

## Impact map

Entry: packages/indexer/src/index-workspace.ts::buildGraphGeneration; packages/indexer/src/tree-sitter/configs.ts::rustConfig; packages/indexer/src/languages.ts::parseRust; packages/native/src/parser.rs Rust parser path
Flow: scan Rust files → native parse or tree-sitter/regex fallback → shadow marker → parsed_documents cache → crate, module, and use resolution → existing SQLite graph
State changes: Rust call records and graph edges are rebuilt under bumped parser versions; no schema migration.
External effects: reads Rust source and the `[package] name` line of Cargo.toml files only; no Cargo command or network access.
Change candidates: packages/indexer/src/index-workspace.ts; packages/indexer/src/rust-resolver.ts (new); packages/indexer/src/tree-sitter/configs.ts; packages/indexer/src/tree-sitter/parse.ts; packages/indexer/src/languages.ts; packages/native/src/parser.rs; tests/go-rust-indexer.test.ts; tests/rust-resolver.test.ts (new); tests/rust-edge-accuracy.test.ts (new); tests/native-wasm-parity.test.ts; tests/parsed-documents-cache.test.ts; tests/fixtures/rust-edges/\*\*; tests/fixtures/parity/rust/\*\*; AGENTS.md; apps/cli/README.md
Verification: exact Rust edge fixture; native/WASM parity; parser/cache tests; full suite and native CI
Verified at: 0519b82 + staged working tree (JavaScript and TypeScript changes archived; Go change implemented, not yet archived; Python approved/Task 1 done; Ruby pending). Confirmed on current source: `buildGraphGeneration` at index-workspace.ts:1096, `rustConfig` at configs.ts:326, `parseRust` at languages.ts:627, parser.rs Rust path (normalize_rust_call:165, rust_config:279), Go-landed cap pattern `language === "go"` at three sites (1439, 1457 + resolver branch 1823) and both native `slice(0, 20)` sites (475, 1290), `Cargo.toml` reaches the file list via `.toml` config docs, tags `native-v2`/`fallback-v2` (Go bump landed → Rust bumps to v3), `NativeParser.id` literal at index-workspace.ts:71, and parity manifest `tests/fixtures/parity/known-differences.json` exists as `{}` (created by an earlier plan; this plan extends it).

## Tasks

### Task 1 — Record the Rust baseline

Files: none (check only), plus updating "Verified at" in this file
Interfaces: records existing focused and full-suite failures before source edits.
Change: re-verify the symbol names, paths, the Go-landed cap and resolver pattern in `buildGraphGeneration`, the two native `slice(0, 20)` sites, and that Cargo.toml files appear in the workspace file list; record the current `native-v1` and `fallback-v1` values; update "Verified at". Run current Rust parser, parity, cache, and full suites. Add no baseline-only test. Probe the current output for `crate::util::run()`, `Self::new()`, `x.run()`, a use group with `self` and `as`, an inline module, and a turbofish call in each parser mode, and record it in Result.
Verify: bun test tests/go-rust-indexer.test.ts tests/native-wasm-parity.test.ts tests/parsed-documents-cache.test.ts, then bun test. Record current Rust edge behavior for the planned module fixture.
Progress: done
Result: focused suite 39 pass/0 fail; full suite 389 pass/0 fail/1 skip (clean baseline). Probe (`bun rust-probe.tmp.ts`, all three modes): `crate::util::run()` → `run`, `Self::new()` → `new`, `x.run()` → `run`, `helper::tool()` → `tool` in native and WASM; turbofish `parse::<u8>` → `<u8>` (garbage callee) in native and WASM. Use group `super::helper::{self, tool, other as o}` and glob `crate::util::*` stored as raw use-tree text in all three modes. Inline `mod util` item labeled bare `run` in all modes. Design evidence #16 is inaccurate on current source: the regex `parseRust` DOES record call expressions inside function bodies (callRegex, bare normalized names, no turbofish capture) — matching the existing `extracts call expressions` test in go-rust-indexer.test.ts; the Python sibling plan also preserves regex call qualifiers. Resolution follows reality: regex keeps recording calls, now with qualifiers preserved, and the Rust resolver drops whatever it cannot resolve.

### Task 2 — Add Rust module edge ground truth

Files: tests/rust-edge-accuracy.test.ts (new); tests/fixtures/rust-edges/\*\* (new); tests/fixtures/parity/rust/\*\*; tests/native-wasm-parity.test.ts
Interfaces: consumes current parser and graph outputs; provides a non-vacuous baseline for Tasks 3–6.
Change: add a small Cargo package fixture with:

- duplicate function names under separate file modules and under inline modules;
- `crate`, `self`, `super`, and child-module paths; explicit use aliases and nested use groups with `self` and `as`; a `pub use` re-export forwarded through a module;
- `Type::function`, `Self::function`, and `self.method()` calls, including a trait-impl method calling an inherent method and an impl split across files;
- method calls on other receivers and chained calls (no edge), a glob import (`use super::*`), an external crate call, `Some`/`Ok`, and a tuple-struct constructor;
- a binary root using its own library by package name, and a second crate directory whose names must not mix with the first;
- a local closure shadowing a same-named function, and two inline modules declaring the same name;
- a `mod x;` with both `x.rs` and `x/mod.rs`, and a file unreachable from any root;
- an above-cap file, plus a Python file with more than 20 calls that must still be capped.

Add LF and CRLF variants and a turbofish case to the Rust parity fixtures, and add or extend the explicit parity manifest entries for Rust; if another plan already landed the manifest, extend it instead of adding a second one.
Verify: build the graph before reading it; require symbols and canary edges; record TP/FN/FP and identify the current path-loss and first-match cases. The new assertions fail on the current code.
Progress: done
Result: Added tests/rust-edge-accuracy.test.ts (exact-match calls-edge harness; canary + symbol-node precondition; asserts TP/FN/FP and symbolCounts per file; re-runs the fixture under OPENEZ_NATIVE=0 and requires identical edge sets) and fixtures under tests/fixtures/rust-edges/{crates,abovecap}/ with expected-edges.json manifests. crates/ covers duplicate names in file and inline modules, crate/self/super/child paths, nested use groups with self and as, pub use forwarding, Type::/Self::/self.method(), trait-impl and split-impl calls, glob and external imports, ambiguous mod candidates, an orphan file, own-library-name binary roots, and shadow forms. abovecap/ has 34 symbols + 25 calls in one Rust file and a 25-call Python file (expected: 20 edges, capped). tests/fixtures/parity/rust/calls.rs adds qualified/turbofish parity coverage; CRLF variants auto-generate per fixture file. Baseline failure on current code: crates TP=11 FN=14 FP=15 (path-loss first-match FPs include shadowed run/compute/helper calls and the glob-import globbed; FNs include every crate::/super::/Self::/self. and use-bound form); abovecap fails the 34-symbol pin (30 observed — cap regression detected as designed).

### Task 3 — Preserve Rust call paths in the parsers

Files: packages/indexer/src/tree-sitter/configs.ts::rustConfig; packages/indexer/src/tree-sitter/parse.ts; packages/indexer/src/languages.ts::parseRust; packages/native/src/parser.rs Rust parser path; tests/go-rust-indexer.test.ts; tests/native-wasm-parity.test.ts
Interfaces: produces the existing symbol, import, and call records with qualifiers kept in calleeName; native result shape unchanged.
Change: keep the callee text in `callExpressions` with whitespace removed and turbofish arguments stripped (`crate::util::run`, `Self::new`, `x.run`, `parse::<u8>` → `parse`) in the native and WASM parsers, while `calledIdentifiers` keeps the last segment; apply the ignore list so `Self::new` and `Box::new` forms are handled by their full path, not by the bare segment. The regex path keeps recording no calls and must keep emitting use text. Increment the native and fallback parser version tags from the values left by earlier plans.
Verify: bun test tests/go-rust-indexer.test.ts tests/native-wasm-parity.test.ts tests/parsed-documents-cache.test.ts. Qualified callees are identical in native and WASM including CRLF and turbofish; the Rust parity manifest has no pins; the stale-tag reparse test passes.
Progress: done
Result: All three parsers now preserve qualified Rust callees in callExpressions (`crate::util::run`, `x.draw`, `Self::check`, `parse::<u8>`→`parse`, `x.method::<Vec<u8>>`→`x.method`) while calledIdentifiers record the last segment; shape-invalid callees (`iter().map`) drop. Shared `normalizeRustCallName`/`lastRustCallSegment`/`stripRustTurbofish` live in languages.ts and are reused by rustConfig (keepQualifiedCallee:true) and mirrored in parser.rs (keep_qualified_calls:true, last-segment splits on `.`/`:`). Parser tags bumped native-v3→native-v4 / fallback-v3→fallback-v4 (Python took v3); stale fallback-v2 literals in parsed-documents-cache.test.ts updated to v4; index-workspace doc comments updated. Regex parseRust keeps recording calls (Task 1 decision) now with qualifiers. Native binding rebuilt (index.darwin-arm64.node) — exact native/WASM parity incl. CRLF and turbofish on all Rust fixtures; parity manifest stays `{}` for Rust. bun test go-rust + parity + cache: 49 pass / 0 fail.

### Task 4 — Build the Rust crate and module resolver

Files: packages/indexer/src/rust-resolver.ts (new); tests/rust-resolver.test.ts (new)
Interfaces: produces crate and module discovery, use-tree expansion, the `shadowedLocal` marker, and call resolution for Tasks 5 and 6; reads the workspace file list and `Cargo.toml` package names only.
Change: implement the design Behavior section. Discover crates and roots from the file list (nearest ancestor Cargo.toml; `src/lib.rs`, `src/main.rs`, `src/bin/*.rs`, `src/bin/*/main.rs`); read `[package] name` with a line scan. Build the module tree from `mod x;` declarations using the module-directory rules (`mod.rs`/`lib.rs`/`main.rs` own their directory, `foo.rs` owns `foo/`), treating both-or-neither candidates as unresolved and inline modules as flat per-file. Expand use trees (groups, `self`, `as`, globs bind nothing, file-wide scope, conflicting paths drop). Resolve the leading segment (`crate`, `self`, `super` runs, use-bound name, child module, own library name), walk module segments, follow use-binding forwarders up to three hops with a cycle guard, and implement the bare, `Type::function`, `Self::function`, and `self.method()` rules. Compute the shadow marker from the caller's line range using the conservative pattern-region scan.
Verify: bun test tests/rust-resolver.test.ts. Cases: root discovery with several crates, the module directory rules, both and neither candidates, use groups with `self` and `as`, conflicting bindings, every leading-segment form, forwarding chains and cycles, split impls, duplicate inline names, glob imports, external crates, and each shadow form.
Progress: done
Result: packages/indexer/src/rust-resolver.ts implements `createRustResolver(rustFiles, allFilePaths, rootPath)` → `{ resolveCall(filePath, callerName, calleeName, shadowedLocal?) }`. Discovers crates via nearest-ancestor `Cargo.toml` (line-scanned `[package] name`, dashes→underscores), roots `src/lib.rs`/`src/main.rs`/`src/bin/*.rs`/`src/bin/*/main.rs`; module tree follows `mod x;` → `x.rs`|`x/mod.rs` (both-or-neither unresolved, `lib.rs`/`main.rs` own their dir, inline mods stay file-local, orphan files get no module context). Use-tree expansion handles groups, `self`, `as`, nested groups, and `pub use` forwarding (≤3 hops, cycle guard); globs bind nothing; conflicting paths drop. Resolution covers `crate`/`self`/repeated `super`, child modules, use-bound names, own library name (binary→lib), bare calls (unique in-file function else unique use binding), `Type::f`, `Self::f`, `self.m()` (via `Type::method` caller labels); other receivers, tuple-struct constructors, externals, ambiguous and unresolved paths drop. `markRustCallShadowing` (later moved to languages.ts so all parse paths share it) scans params, `let`/`for`/`if let`/`while let`/`match` arms/closures over the caller's line range, comments blanked. bun test tests/rust-resolver.test.ts: 21 pass / 0 fail / 57 assertions.

### Task 5 — Carry the Rust shadow marker through the parse and cache paths

Files: packages/indexer/src/index-workspace.ts::indexWorkspace and buildGraphGeneration; packages/indexer/src/parsers/index.ts; tests/parsed-documents-cache.test.ts
Interfaces: consumes Task 4; persists the marker in the existing `calls` JSON field without a schema change.
Change: run the Task 4 marker on every Rust parse result: the parseDocument path for WASM and regex, and the native batch results at both the index-time and graph-build sites. Persist `shadowedLocal` on call records at every native cache write and carry it through the cached-row read.
Verify: bun test tests/parsed-documents-cache.test.ts tests/rust-edge-accuracy.test.ts. A Rust row round-trips the marker for native, WASM, and regex rows; rows under the previous tags reparse.
Progress: done
Result: `markRustCallShadowing` moved to languages.ts so every parse path shares it: `parseRust` (regex) calls it before returning; WASM runs it via a new optional `LanguageConfig.markCallShadowing` hook invoked once in `parseWithTreeSitter` (rustConfig sets it); both native batch sites (indexWorkspace ~L467 and buildGraphGeneration ~L1314) call it on `nr.callExpressions` for `lang === "rust"`. The marker rides inside the existing `calls` JSON field — no schema change — and both cached-row reads `JSON.parse` it back verbatim (`parsedFiles[].callExpressions[].shadowedLocal`, already plumbed into `pendingCallEdges`). Parser tags ride `native-v5`/`fallback-v5` (stacked sibling-plan bumps on the same working tree); `NativeParser.id` and doc comments updated to match. New "Rust shadowedLocal marker round-trip" suite in tests/parsed-documents-cache.test.ts: native row stores `shadowedLocal:true` under `native-v5`, cache-hit graph build reuses it (parsedAt unchanged, shadowed edge absent), a forged `native-v4` row reparses back to `native-v5`, and `OPENEZ_NATIVE=0` produces a marked `fallback-v5` row. 8/8 cache tests pass.

### Task 6 — Resolve Rust calls by crate module

Files: packages/indexer/src/index-workspace.ts::buildGraphGeneration; tests/rust-edge-accuracy.test.ts
Interfaces: consumes the Task 4 resolver and Task 5 records; emits existing calls edges.
Change: add a Rust cap condition at the three cap sites and a Rust resolver branch in the call-edge loop, ahead of the OXC and global fallbacks and without adding `rust` to the OXC set. Send Rust callers only to the resolver, never to the `.`-split same-file lookup, `resolveOxcCallTarget`, or `globalSymbolNodes`. Emit only a unique in-crate target; drop ambiguous glob imports, external targets, shadowed names, unknown-receiver methods, and unresolved calls. Remove the Rust native parse-result call slice at both sites and the Rust graph symbol/call truncation only.
Verify: every determinate expected edge exists, FP=0, ambiguous targets have no edge, and the 31st symbol and 21st call are retained. A Python file with more than 20 calls is still capped; Go, Ruby, TS, and JS behavior remains unchanged.
Progress: done
Result: `buildGraphGeneration` builds `rustResolver = createRustResolver(rustFiles-with-symbols+importPaths, allParsedPaths, rootPath)` beside the Go/Python/Ruby resolvers. `rust` added to the `uncapped` set (30-symbol/20-call graph caps lifted for Rust only — Rust is not added to `OXC_GRAPH_LANGUAGES`) and to both native batch `slice(0, 20)` conditions (index-time ~L463 and graph-build ~L1309). The call-edge loop gained an `isRustCaller` branch ahead of the else (lexical/OXC/global) path: Rust callers go only to `rustResolver.resolveCall(filePath, callerName, calleeName, shadowedLocal)` → `symbolNodeIdsByFileAndName` lookup; lexical-name guessing, `resolveOxcCallTarget`, and `globalSymbolNodes` are never reached for Rust. rust-edge-accuracy now matches the expected set exactly: crates TP=25 FN=0 FP=0 (baseline was TP=11/FN=14/FP=15); abovecap keeps all 34 symbols + 25 calls with FP=0. Fixture deltas recorded during integration: abovecap `many.py` now emits all 25 edges because the Python plan lifted Python's caps — the manifest was updated (Python can no longer serve as the capped canary; every symbol-producing language is now uncapped, though the cap code still guards non-listed languages); the Python plan's own abovecap `big.rs` manifest was similarly extended (30→35 symbols, 20→34 chain edges); the stale `f.bar()`→`bar` expectation in tree-sitter-parser.test.ts was updated to the preserved `f.bar`. bun test (5 focused files): 73 pass / 0 fail.

### Task 7 — Update Rust indexing guidance

Files: AGENTS.md::Indexing Expectations; apps/cli/README.md::supported languages
Interfaces: documents the behavior implemented by Tasks 3–6.
Change: describe Rust crate/module-aware unique call edges (crate roots, `mod` declarations, use aliases, `Type`/`Self`/`self` method calls), the dropped cases (glob, external, unknown receivers, shadowed), the Rust graph cap behavior, and the `openez reindex <path>` requirement; keep other language descriptions accurate.
Verify: pnpm exec prettier --check AGENTS.md apps/cli/README.md; read the updated text against the design and fixtures.
Progress: done
Result: AGENTS.md Indexing Expectations gained a Rust bullet documenting crate-root discovery (`Cargo.toml`, `src/lib.rs`/`main.rs`/`src/bin/*`), module-directory rules, qualifier preservation + turbofish stripping, the supported resolution forms (`crate`/`self`/`super`, child modules, `use` groups/`self`/`as`, `pub use` forwarding ≤3 hops, own library name, `Type::f`/`Self::f`/`self.m()`), the dropped cases (external crates, globs, unknown receivers, chains, shadowed locals, ambiguous/unresolved), no Rust symbol/call caps, and the `openez reindex` requirement under `native-v5`/`fallback-v5`. The Go bullet's stale `native-v2`/`fallback-v2` tag was corrected to v5. apps/cli/README.md supported-languages Rust row now describes module-aware unique call edges and the no-cap/drop policy; root README.md supported-content bullet notes language-aware binding resolution. `pnpm exec prettier --check` passes on all three files.

### Task 8 — Verify native and fallback Rust paths

Files: none (check only)
Interfaces: consumes Tasks 2–7 and existing native CI.
Change: run focused and full checks, build native, and record fixture graph size and timing.
Verify: focused Rust/parity/cache suites with OPENEZ_NATIVE_EXPECT=1 and OPENEZ_NATIVE=0; full bun test; native build; run `openez reindex <path>` on a workspace with pre-change Rust cache rows and confirm refreshed parse output and graph edges; existing CI on Linux x64, macOS arm64, and Windows x64. Record TP/FN/FP and graph counts.
Progress: done
Result: Focused suites (native available): rust-resolver 21 pass, rust-edge-accuracy crates TP=25 FN=0 FP=0 + abovecap exact, tree-sitter-parser 10 pass, python-edge-accuracy 22 pass, go-rust-indexer + native-wasm-parity + parsed-documents-cache all pass — 73+ in focused runs. Fallback path verified via `OPENEZ_NATIVE=0` (marker stored under `fallback-v5`, identical edge sets asserted by the accuracy harness). Cache invalidation verified in-suite: forged `native-v4` row reparses to `native-v5` on graph build (equivalent to `openez reindex` rebuilding stale rows); `fallback-v5` reuse/zero-reparse covered by the existing suite. Native build: `bun run build` (napi build --platform --release) succeeds on darwin-arm64; warnings are pre-existing (`node_text` unused predates this change). Full suite: 467 pass / 0 fail / 1 skip / 1649 assertions across 45 files. Graph counts: crates fixture 21 files → 91 nodes/95 edges; abovecap 5 files → 66 nodes/111 edges. Multi-platform CI (linux-x64, win32-x64) not runnable locally — left to CI on push.

## Files inspected, no change

- packages/indexer/src/native-binding.ts — the optional-native loader and OPENEZ_NATIVE switch remain unchanged.
- packages/indexer/src/scanner.ts — Rust file discovery remains unchanged.
- packages/db/src/sqlite/document-repository.ts — the marker reuses the existing parsed-document JSON cache; no schema change is planned.
- packages/native/index.d.ts — the native result shape stays the same, so the generated typings do not change.

## Approval Gate

Status: approved — 2026-10-20, user directed "implement plan" on this change folder (joint design.md + tasks.md approval).

## Decision Log

- Use bindings are derived in TypeScript from the existing raw use-tree `importPaths` text, so no new cached field or native result change is needed. CodeGraph also reads Rust `use` declarations from source text.
- Inline `mod` items keep their unqualified labels; a name declared twice in one file is ambiguous and dropped. Qualifying labels with inline module paths would rename existing symbols and their chunk metadata; that is deferred.
- `Self::f()`, `Type::f()`, and `self.m()` resolve to methods of the same type, the one method-call form that needs no type inference. All other method calls are dropped, which removes today's first-match false positives.
- The package's own library name is treated like `crate` for its binary roots, because `use app::…` from `main.rs` is the dominant layout. Workspace siblings and dependencies stay external.
- Crate roots come from the default Cargo layout only; custom `[lib]`/`[[bin]]` paths and `#[path]` attributes leave those files with no module path.
- Visibility is not evaluated, and `use super::*` globs are dropped. Both are deliberate, FP-safe losses of recall.
- File-level imports edges for Rust are not added; this plan changes call edges only.
