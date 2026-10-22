# Go indexing accuracy and native parity tasks

Issue: #39

## Design

[Go indexing accuracy and native parity](design.md)

## Global Constraints

- Keep the current SQLite schema, MCP tools, CLI commands, graph node shape, and graph edge shape unchanged.
- The native parser stays optional; OPENEZ_NATIVE=0 must continue to force the fallback path.
- Bump existing parser version tags when Go parser output changes, incrementing from the value left by any earlier plan that landed first (Python, Rust, Ruby share `native-v1` and `fallback-v1`). Run a full `openez reindex <path>` so cached parse results and graph artifacts are rebuilt. A no-op incremental index does not prove refresh.
- Resolve Go calls only to unique in-workspace targets; unresolved, ambiguous, and shadowed calls create no edge.
- Native and WASM results must match exactly on the maintained Go parity fixtures. Python and Rust outputs and pins remain unchanged.
- Go files under vendor produce no graph symbols or calls, while their documents and chunks remain searchable.
- Remove the 30-symbol and 20-call graph limits for Go only, at the graph-build truncation and at both native `slice(0, 20)` sites; retain current limits for every other language, including Python and Rust.
- Keep the Go cap decision and the Go resolver choice separate from the OXC gate. Adding Go to the OXC set is not allowed: it would route Go calls into the module-binding resolver.
- Add no runtime dependency on the Go toolchain, go/packages, SCIP, or network access.
- Do not add a language to the native extension in this change.
- The shared parity manifest is created by the first plan to land and extended by the others; this plan owns only the Python, Go, and Rust entries.

## Impact map

Entry: `packages/indexer/src/index-workspace.ts::indexWorkspace` (528; native batch at 414) and `buildGraphGeneration` (1095); `packages/indexer/src/parsers/tree-sitter-parser.ts::TreeSitterParser.parse` (48); `packages/indexer/src/languages.ts::parseGo` (424); `packages/native/src/parser.rs::parse_code_native` (830)
Flow: `scanWorkspaceFiles` → `indexWorkspace` → native `parseCodeBatch` when available, otherwise `parseDocument` → `TreeSitterParser.parse` → `parseWithTreeSitter` or regex `parseGo` → `parsed_documents` cache → lazy `buildGraphGeneration` → current global name fallback for Go calls → atomic SQLite graph replacement. Current Go call names lose package qualifiers in all three parser paths.
State changes: parse symbols/imports/calls and `native-v1` or `fallback-v1` rows are cached; graph artifacts are atomically replaced. No database schema migration.
External effects: reads workspace Go source and `go.mod` files; no network or Go toolchain runtime. Native build verification uses the existing GitHub Actions workflow.
Change candidates: packages/indexer/src/index-workspace.ts; packages/indexer/src/go-resolver.ts (new); packages/indexer/src/tree-sitter/configs.ts; packages/indexer/src/tree-sitter/parse.ts; packages/indexer/src/languages.ts; packages/native/src/parser.rs; tests/go-rust-indexer.test.ts; tests/go-edge-accuracy.test.ts; tests/go-resolver.test.ts (new); tests/native-wasm-parity.test.ts; tests/parsed-documents-cache.test.ts; tests/fixtures/go-edges/\*\*; tests/fixtures/parity/go/\*\*; tests/fixtures/parity/known-differences.json; AGENTS.md; apps/cli/README.md
Verification: targeted Go parser, resolver, edge-accuracy, native-WASM parity, and parsed-document cache tests; full bun test; native package build; OPENEZ_NATIVE_EXPECT=1 focused suites; green native CI matrix on all three platforms; standard-library net graph-count and timing smoke check
Verified at: 0519b8284324722863d9123a457f28b389389f61 (HEAD; current JS/TS implementation is also present in the working tree)

## Tasks

### Task 1 — Record the implementation baseline

Files: none (check only), plus updating "Verified at" in this file
Interfaces: records current focused and full-suite failures before source edits.
Change: re-verify the symbol names, paths, and the two native `slice(0, 20)` sites named in this plan on HEAD; record the current `native-v1` and `fallback-v1` values and whether the OXC gate in `buildGraphGeneration` has been renamed; update "Verified at". Run the existing Go edge, Go parser, native parity, parsed-document cache, and full test suites. Record the current edge metrics, test totals, and any native-platform limitation in Result.
Verify: bun test tests/go-edge-accuracy.test.ts tests/go-rust-indexer.test.ts tests/native-wasm-parity.test.ts tests/parsed-documents-cache.test.ts, then bun test. Expected baseline edge metrics are packages: package TP 3, FN 1, FP 0; types: package TP 2, FN 1, type TP 0, FN 3, FP 0.
Progress: done
Result: Current source re-traced at HEAD `0519b8284324722863d9123a457f28b389389f61` plus the JS/TS working-tree changes; parser names, the OXC resolver gate, and both native `slice(0, 20)` sites confirmed. Focused Go/parser/parity/cache suite: 37 pass / 0 fail across 4 files; full suite: 361 pass / 1 skip / 0 fail across 38 files. Fresh fixture scoring matches packages TP=3/FN=1/FP=0 and types package TP=2/FN=1, type TP=0/FN=3, FP=0. Native binding loads on local Darwin arm64; cross-platform native CI remains for Task 7.

### Task 2 — Make Go fixtures and parity coverage complete

Files: tests/go-edge-accuracy.test.ts; tests/native-wasm-parity.test.ts; tests/fixtures/go-edges/\*\*; tests/fixtures/parity/go/\*\*; tests/fixtures/parity/known-differences.json
Interfaces: consumes the current parser and graph outputs; produces non-vacuous assertions for Tasks 3–5.
Change: add exact Go fixtures for:

- duplicate names in imported packages;
- an explicit alias beside an external unaliased import whose last path element equals the alias (`github.com/x/pb/v3` beside `v3 "…/client/v3"`), in both import declaration orders and in LF and CRLF;
- an unaliased workspace import whose directory name differs from its declared package (`…/client/v3` declaring `clientv3`);
- `Map[int](x)`, `pkg.Map[int](x)`, and multi-argument `F[int, string](x)` instantiations;
- grouped const/var declarations, including several names in one spec and the blank identifier `_`;
- vendor files, and a go.mod plus package under `testdata`;
- a nested module, sibling modules, an import that only shares a prefix with a module path, and two modules declaring one path;
- a `foo_test` external test package and a `_test.go` file that must not be an import target;
- local shadowing: `store := newStore(); store.Get(k)` beside an import named `store`, a `func(context *Context)` parameter named like an import, and `init := func(){…}; init(t)`;
- a bare call to a name that exists only as a method, and an unexported `pkg.helper` call;
- duplicate function names in one package (build-tagged files);
- an import block with trailing comments and import-like text inside comments and raw strings;
- files with more than 30 symbols and 20 calls.

Add an explicit required parity-fixture manifest covering the Python, Go, and Rust entries, and fail on missing fixtures, unknown pin keys, or pins that no longer occur. If another plan already landed a manifest, extend it instead of adding a second one. Preserve the existing ground-truth edge definitions; do not update baselines to accept regressions.
Verify: bun test tests/go-edge-accuracy.test.ts tests/native-wasm-parity.test.ts. The package-qualification, generic-instantiation, grouped-declaration, shadowing, fixture-presence, and pin-integrity assertions cover current gaps; both import orders must resolve the explicit alias to the same package. The new assertions fail on the current code, and no baseline file is edited to make them pass.
Progress: done
Result: 11 edge fixtures (abovecap, dupnames, imports, modules, packages, resolution, shadow, testpkg, types, vendor plus alias/generic/CRLF cases inside them); parity test now requires a manifest of go/python/rust fixtures incl. CRLF variants, validates exact pin keys, and fails on missing, stale, or orphaned pins.

### Task 3 — Align Go extraction across parser paths

Files: packages/indexer/src/tree-sitter/configs.ts::goConfig; packages/indexer/src/tree-sitter/parse.ts::parseWithTreeSitter; packages/indexer/src/languages.ts::parseGo; packages/native/src/parser.rs::go*config and walk_tree; tests/go-rust-indexer.test.ts; tests/native-wasm-parity.test.ts
Interfaces: produces the existing symbol, import, calledIdentifiers, and callExpressions records consumed by buildGraphGeneration; keeps the NativeParser result shape unchanged.
Change: extract each package-level identifier in grouped and single const/var declarations in native, WASM, and regex Go paths; do not emit local variables or the blank identifier as top-level symbols. Preserve package selectors in Go call names for graph resolution (`pkg.Func`, and `pkg.Func[T]` normalized to `pkg.Func`), normalize unqualified generic instantiations to their declared function name, and retain the tested generic and pointer receiver naming. Make native and WASM Go output identical for maintained fixtures, including the recursive-call case currently pinned as a difference: the canonical form is the receiver-qualified native `Node::Traverse`, so the WASM path changes. Increment the native and fallback parser version tags from the values left by earlier plans so cached results are reparsed.
Verify: bun test tests/go-rust-indexer.test.ts tests/native-wasm-parity.test.ts tests/parsed-documents-cache.test.ts. All named extraction cases pass; Go parity differences are empty; Python and Rust pins are unchanged.
Progress: done
Result: all three paths now emit package-qualified callees (`a.New`, `pkg.F`), strip generic instantiations (`Map[int]`→`Map`, `pkg.F[int,string]`→`pkg.F`; bare generics ride `type_conversion_expression`), emit one symbol per name in grouped/single const/var specs skipping `*` and locals, and qualify receiver calls via the final selector segment (`Node::Traverse`everywhere).`native-v1`→`native-v2`, `fallback-v1`→`fallback-v2`. Go parity diff empty — Go pins removed, manifest is `{}`. Generic receivers keep `[T]` (`Stack[T]::Push`) consistently across paths.

### Task 4 — Build the Go package resolver

Files: packages/indexer/src/go-resolver.ts (new); tests/go-resolver.test.ts (new)
Interfaces: produces module discovery and matching, a per-file Go context `{ packageName, imports, localNamesByCaller }`, and import-name binding for Task 5; reads workspace go.mod and Go source only and persists nothing.
Change: implement the rules in the design Behavior section. Discover `go.mod` files (ignoring those under `vendor`, `testdata`, and directories starting with `_` or `.`), read the `module` directive with comments stripped and optional quotes removed, give each file its nearest ancestor module, and match an import to the module with the longest `/`-bounded path prefix (a tie goes to the importing file's own module). Identify a package by (directory, declared package name); exclude `_test.go` files from import targets; resolve an import to nothing when its directory declares more than one non-test package name. Bind an import to its written alias, otherwise to the target's declared package name; external or unmatched imports bind no name; blank and dot imports bind nothing; two imports binding one name drop calls through it. Scan only the file header for imports (stop at the first top-level `func`, `type`, `var`, or `const` outside a block comment) after blanking comments and string and raw-string contents; handle CRLF. Build `localNamesByCaller` from receivers, parameters, results, and `:=`/`var`/`const` names inside each function body (closures included), keyed by the parser's caller name and unioned across same-named functions. Memoize per graph build; an unreadable file has no context.
Verify: bun test tests/go-resolver.test.ts. Cases: module nesting, siblings, prefix-only imports, same-path modules, `testdata` go.mod ignored, quoted and commented `module` directives, import blocks with trailing comments and import-like text in strings, declared package name versus directory name, alias versus external unaliased import in both orders, `foo_test` and `_test.go`, repeated `init` functions, CRLF input, and pointer and generic receivers as caller names.
Progress: done
Result: `packages/indexer/src/go-resolver.ts` + `tests/go-resolver.test.ts` (14 tests). Import scanning uses a comments-only blanked copy (strings preserved for import paths); local scanning uses full trivia blanking. Longest-prefix module matching, own-module tie-break (equal-length same-path matches without an own-module winner are ambiguous → no binding), declared-name binding, `_`/`.` no-binding, duplicate-name ambiguity, `_test` package rules, and function-granular locals (receiver/params/results/`:=`/`var`/`const`, unions for repeated `init`). Per-directory package index is built once — `declaredPackageName`/`packageFiles` stay O(1) per call edge instead of rescanning the workspace. Review round: grouped `a, b T` parameter names and function-literal parameters now join the caller's local names; a malformed nested go.mod registers a module boundary that blocks parent-module resolution for files under it (`moduleDirectiveOf` validates the path so `module (` is not read as the path `(`); and `vendor`/`testdata`/`_*`/`.*` directories can never be import targets.

### Task 5 — Resolve Go calls in the graph

Files: packages/indexer/src/index-workspace.ts::indexWorkspace and buildGraphGeneration; tests/go-edge-accuracy.test.ts; tests/fixtures/go-edges/\*\*
Interfaces: consumes Go selectors and parsed symbols from Task 3 and the resolver from Task 4; emits existing calls edges with unchanged metadata shape.
Change: add a Go cap decision and a Go resolver branch beside the existing OXC ones, without adding `go` to the OXC set or renaming it. In the call-edge loop, send Go callers (other than parser-qualified `Type::method` callees, which keep their existing same-file lookup) to the resolver and never to the same-file lexical lookup, `resolveOxcCallTarget`, or `globalSymbolNodes`. Resolve unqualified calls only to a package-level function of the caller's own package and package-qualified calls only to an exported package-level function declared directly in the imported package; emit an edge only for one matching target and skip any call whose qualifier or bare callee is in the caller's local names. Exclude Go files under vendor from graph symbols and calls while retaining their document chunks. Remove the Go-only symbol and call truncation in `buildGraphGeneration` and the native `nr.callExpressions.slice(0, 20)` at both the index-time and graph-build sites for Go; leave the 30/20 limits unchanged for other languages, including Python and Rust on the same native path. Do not resolve go.work replace directives, external packages, unknown receiver methods, or interface dispatch.
Verify: bun test tests/go-edge-accuracy.test.ts tests/native-wasm-parity.test.ts tests/parsed-documents-cache.test.ts. The packages fixture reaches package TP 4/FN 0/FP 0; the types fixture reaches package TP 3/FN 0/FP 0 while type TP 0/FN 3 stays unchanged. The 31st Go symbol and 21st Go call appear in the graph; a Python and a Rust file with more than 20 calls are still capped; shadowing, bare-call-no-method, unexported-qualifier, nested-module, `_test` package, and vendor fixtures produce exactly their expected edges with FP 0; vendor files have no graph symbols or calls but their chunks remain searchable; native and OPENEZ_NATIVE=0 edge sets match.
Progress: done
Result: `buildGraphGeneration` resolves Go calls via `goResolver` (`Type::method` keeps same-file lookup; qualified calls need exported package-level functions in the bound package; bare calls only within the caller's package files; local names suppress edges) and never falls back to `globalSymbolNodes` for Go. Vendor files are skipped before file-node creation — no graph nodes or edges at all — while their documents/chunks stay indexed; the vendor fixture asserts zero file and symbol nodes under `vendor/`. Go caps removed at the graph-build truncation and both native `slice(0, 20)` sites; Python/Rust caps intact. Fixture scores: packages 4/0/0, types 3/0/0 (type tier 0/3 unchanged), imports 4/0/0, resolution 2/0/0, shadow 2/0/0, vendor 1/0/0, modules 3/0/0, testpkg 3/0/0, dupnames 1/0/0, abovecap 31/0/0 — all FP 0, edge sets identical with and without native.

### Task 6 — Update Go indexing guidance

Files: AGENTS.md::Indexing Expectations; apps/cli/README.md::supported languages
Interfaces: documents the behavior implemented by Tasks 3–5.
Change: state that Go indexing extracts package-level functions, methods, types, consts, and vars; resolves only unique in-workspace package calls through `go.mod` module paths and declared package names; drops unresolved, ambiguous, unexported, and shadowed calls (shadowing is function-granular); omits vendor files from the graph while retaining text indexing; uses no Go-specific graph truncation; and needs `openez reindex <path>` after upgrading. Keep TypeScript, Python, Rust, and native platform descriptions accurate.
Verify: pnpm exec prettier --check AGENTS.md apps/cli/README.md; read the updated language guidance against the design and focused test results.
Progress: done
Result: AGENTS.md Indexing Expectations + README supported-languages row updated — package-level symbols, go.mod/declared-name resolution, dropped unresolved/ambiguous/unexported/shadowed calls, function-granular shadowing, vendor graph exclusion with text indexing, no Go caps, `openez reindex` after upgrade.

### Task 7 — Verify the complete native and fallback paths

Files: none (check only)
Interfaces: consumes Tasks 2–6 and the existing native CI matrix.
Change: run the full test suite, native build and both parser modes; record the Go standard-library net graph counts and elapsed time, including the extra per-file source read, against the prior operational result.
Verify: bun test; pnpm --filter @openez-graph/native build; OPENEZ_NATIVE_EXPECT=1 bun test tests/native-wasm-parity.test.ts tests/go-edge-accuracy.test.ts tests/go-resolver.test.ts tests/go-rust-indexer.test.ts tests/parsed-documents-cache.test.ts; repeat the focused suites with OPENEZ_NATIVE=0; run `openez reindex <path>` on a workspace with pre-change Go cache rows and confirm refreshed parse output and graph edges; require the native CI matrix to pass on Linux x64, macOS arm64, and Windows x64. Record the measured graph counts and elapsed time without making timing a functional gate.
Progress: done except cross-platform CI (needs push)
Result: bun test 387 pass / 1 skip / 0 fail (39 files); native build clean; OPENEZ_NATIVE_EXPECT=1 focused suite 63/0; OPENEZ_NATIVE=0 focused suite 47/0 (parity skips native-required cases). `openez reindex` on the Go stdlib corpus reparsed stale rows to `native-v2`/`fallback-v2` (7831/155 files) and rebuilt the graph: 8,109 files, 221,073 nodes, 299,268 edges (86,237 Go call edges, same-package bare + receiver-qualified), graph build ≈17s end-to-end including ~2.2s resolver construction over 8,086 Go files. The first pass over this corpus surfaced an O(files × calls) hot loop in `declaredPackageName`/`packageFiles` (>7min, killed); indexing per-directory package files once at resolver construction brought the build to ≈17s. Native CI matrix pending push.

## Files inspected, no change

- packages/indexer/src/native-binding.ts — optional native loader and OPENEZ_NATIVE kill switch remain unchanged.
- packages/indexer/src/scanner.ts — workspace discovery remains unchanged; vendor is excluded only from Go graph generation.
- packages/indexer/src/tree-sitter/loader.ts — WASM grammar loading and fallback behavior remain unchanged.
- packages/db/src/sqlite/document-repository.ts — parsed-document cache persists JSON fields and parser versions; no schema change is planned.
- apps/cli/tsup.config.ts and .github/workflows/native.yml — existing binary packaging and native CI matrix are reused.

## Approval Gate

Status: approved

Approved by user 2026-10-20 (conditional request to move to the Go task after the JavaScript and TypeScript review passed).

## Decision Log

- Go package and import context is reconstructed from source at graph generation instead of persisted in the parsed-document imports payload. CodeGraph resolves Go imports from source at resolution time the same way. Revisit persistence only if the net corpus measurement shows the extra read matters.
- Per-directory package membership is indexed once when the resolver is built. The naive "scan every Go file per lookup" made `declaredPackageName`/`packageFiles` O(files) per call edge; on the Go stdlib corpus (≈8k files, tens of thousands of calls) that turned the graph build into an O(files × calls) loop measured in minutes. A single pass over `goFiles` populating `dir → {nonTestNames, filesByPackage}` keeps lookup O(1) and brought the corpus graph build to ≈17s.
- Shadowing is function-granular, not block-granular. It may drop a valid edge; it keeps false positives at zero without a scope analyzer or any change to the native result shape.
- An unaliased workspace import binds the target's declared `package` name, not the last path element; an external unaliased import binds no name.
- Packages are keyed by (directory, declared package name) and `_test.go` files never provide import targets. CodeGraph keys by directory only; this rule comes from Go semantics.
- The parity manifest is owned by whichever of the Go, Python, Rust, and Ruby plans lands first; later plans extend it for their own languages. Version tags are incremented from the value left by the previous plan.
