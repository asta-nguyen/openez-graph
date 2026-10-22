# C# indexing accuracy and native parity tasks

Issue: #39

## Design

[C# indexing accuracy and native parity](design.md)

## Global Constraints

- Resolve calls only to a unique same-type bare/this call (across partial parts), explicitly type-qualified call, or uniquely bound using-static call. Do not infer receiver variable types or choose overloads by argument types.
- Emit imports edges only when an explicit using binding resolves to one in-workspace file.
- Index both bodies of #if/#else directives: blank only directive text while preserving source offsets and both branches, identically on the native and WASM paths.
- Global using is scoped to the caller's project root (nearest ancestor directory with a \*.csproj, else the workspace root); the project file is only located, never read.
- Remove generic 30-symbol and 20-call graph limits for C# only, at the `uncapped` decision in buildGraphGeneration and at both native `callExpressions.slice(0, 20)` sites. Never add csharp to OXC_GRAPH_LANGUAGES. Keep DB and public interfaces unchanged.
- The resolver reads only existing ParsedDocument fields (symbols with line ranges, importPaths, calls); no source re-read, cache payload, or schema change.
- If both AST paths fail, generic text remains searchable and no C# graph records are emitted; parsing does not throw. Add no regex C# parser.
- The grammar must ship in the published CLI: apps/cli dependencies and tsup externals, not only packages/indexer.
- Advance cache tags from the implementation baseline and run openez reindex.

## Impact map

Entry: packages/indexer/src/index-workspace.ts::indexWorkspace (L529) and buildGraphGeneration (L1096); packages/indexer/src/parsers/parser-registry.ts::parseDocument (L45); packages/native/src/parser.rs::get_config/get_language_fn (L1433/L1443).
Flow: scanWorkspaceFiles (extensions come from codeExtensions; .cs/.csx are absent today) → indexWorkspace → native parseCodeBatch (gated by TS_LANGS, L397) when available, otherwise parseDocument → TreeSitterParser → native/WASM extraction → parsed_documents cache → buildGraphGeneration (NATIVE_LANGS gate L1125, cap decision L1521, import-edge loop L1584 via resolveModuleSpecifier L1676) → C# resolver → SQLite graph artifacts.
State changes: C# files are ingested for the first time; chunks, cached usings/calls, and graph artifacts are produced; other languages' rows reparse on the tag bump; no schema migration.
External effects: reads .cs/.csx source and lists directories for \*.csproj names; no project evaluation, dotnet, NuGet, or network.
Change candidates: packages/indexer/src/languages.ts; packages/indexer/src/tree-sitter/configs.ts; packages/indexer/src/tree-sitter/parse.ts; packages/indexer/src/tree-sitter/loader.ts; packages/indexer/src/parsers/tree-sitter-parser.ts; packages/indexer/src/index-workspace.ts; packages/indexer/src/csharp-resolver.ts (new); packages/indexer/package.json; apps/cli/package.json; apps/cli/tsup.config.ts; pnpm-lock.yaml; packages/native/Cargo.toml; packages/native/Cargo.lock; packages/native/src/parser.rs; tests/csharp-indexer.test.ts (new); tests/csharp-resolver.test.ts (new); tests/csharp-edge-accuracy.test.ts (new); tests/fixtures/csharp-edges/**; tests/fixtures/parity/csharp/**; tests/native-wasm-parity.test.ts; tests/parsed-documents-cache.test.ts; AGENTS.md; apps/cli/README.md.
Verification: parser/resolver/edge-accuracy fixtures, conditional/partial/no-edge cases, parity incl. CRLF, cache reparse, above-cap graph, Bun tests, typecheck, native build/CI, built-CLI smoke test, install-size record.
Verified at: 0519b8284324722863d9123a457f28b389389f61 (HEAD; working tree also contains uncommitted issue #39 changes, line numbers above are from that working tree on 2026-10-20 and must be re-traced before implementation).
Re-verified at: c7d06076bc98982ee4a89440b80021b9ec0bb7e4 (Task 1 re-trace; line numbers refreshed — all index-workspace.ts positions unchanged, parser.rs dispatch now at L1433/L1443).

## Tasks

### Task 1 — Record the implementation baseline

Files: none (check only), plus updating Verified at and the line numbers in this file.
Interfaces: records shared parser, cache, cap, and native dispatch state.
Change: re-trace the working tree for C# detection (confirm .cs/.csx are not scanned), grammar dispatch and the loader's `tree-sitter-${language}` naming, the TS_LANGS/NATIVE_LANGS sets, parser tags (currently native-v5/fallback-v5) and their literal types, all graph-cap sites, the import-edge loop, and the REQUIRED_FIXTURES manifest in the parity test; run current indexer/parity/cache and full suite; record baseline failures in Result.
Verify: bun test tests/index-workspace.test.ts tests/native-wasm-parity.test.ts tests/parsed-documents-cache.test.ts, then bun test. Existing failures are recorded, not attributed to C#.
Progress: done
Result:

- Re-traced at `c7d06076bc98982ee4a89440b80021b9ec0bb7e4`; baseline commit `0519b82` is an ancestor. Working-tree line numbers match the map except parser.rs dispatch (now L1433/L1443 — updated above).
- Confirmed: `.cs`/`.csx` absent from `codeExtensions` (languages.ts L21-36); loader `resolveGrammarWasm` builds `tree-sitter-${language}` for both package and artifact names (loader.ts L51-63) — csharp needs explicit mapping to `tree-sitter-c-sharp` / `tree-sitter-c_sharp.wasm`; `LANGUAGE_CONFIGS`/`REGEX_FALLBACKS` cover python/go/rust/ruby only; `TS_LANGS` (L397) and `NATIVE_LANGS` (L1125) = `{python,go,rust,ruby}`; tags `oxc-v5`/`native-v5`/`fallback-v5` (L59-61, literal `readonly id: "native-v5"` L82); call slices at L463 and L1310, symbol/call caps at L1529/L1548 gated by `uncapped` (L1523); import-edge loop L1590 → `resolveModuleSpecifier` L1678 (generic `resolveImport` already returns null for non-relative non-py/rb paths — safe for C#); `REQUIRED_FIXTURES` in tests/native-wasm-parity.test.ts has no csharp entries.
- WASM grammar verified: npm `tree-sitter-c-sharp@0.23.5` ships `tree-sitter-c_sharp.wasm` at package root; crates.io `tree-sitter-c-sharp = "0.23.5"` available. Sample parse confirmed node types: `file_scoped_namespace_declaration`, `namespace_declaration` (name=qualified_name), `class/struct/interface/record/enum/delegate_declaration`, `method/constructor/destructor_declaration`, `field_declaration`→`variable_declarator`, `using_directive` (full directive text incl. `global using`/`using X = ...`/`using static`), `invocation_expression` (function = identifier | member_access_expression | generic_name | conditional_access_expression), `preproc_*` nodes. The grammar already parses both `#if`/`#else` branch bodies; the blanking pre-pass is still applied for offset-stable parity.
- `pnpm install` was required (worktree had no deps). Emitted expected warning: `prepare: error: could not lock config file /Users/nus/projects/Asta/openez/.git/config` (husky targeting the main checkout) — install completed.
- Baseline `bun test tests/index-workspace.test.ts tests/native-wasm-parity.test.ts tests/parsed-documents-cache.test.ts`: 45 pass, 16 skip, 0 fail (native parity cases skipped — no native binary loaded at that point).
- Baseline full `bun test`: 459 pass, 17 skip, 0 fail across 45 files in 12.10s. No baseline failures to attribute.
- `pnpm --filter @openez-graph/native build`: success (release profile, 28.70s) → `packages/native/index.darwin-arm64.node`; subsequent native runs are unskipped.

### Task 2 — Add C# parser, graph, and parity fixtures

Files: tests/csharp-indexer.test.ts (new); tests/csharp-resolver.test.ts (new); tests/csharp-edge-accuracy.test.ts (new); tests/fixtures/csharp-edges/**; tests/fixtures/parity/csharp/**; tests/native-wasm-parity.test.ts; tests/parsed-documents-cache.test.ts.
Interfaces: specifies extraction/resolver behavior for Tasks 3 and 4. Each csharp-edges fixture directory holds sources (plus empty \*.csproj marker files where project roots matter), expected-edges.json, and baseline.json in the shape used by tests/fixtures/go-edges.
Change: cover namespace forms (file-scoped, block, nested, dotted), parent-namespace lookup, nested/partial types across files, the same type identity in two project roots (no edge), alias/global (scoped by project root)/static using, external alias reserving a name, ignored external ordinary usings, partial calls, overload/unknown-receiver negatives, #if/#else (both bodies indexed, duplicate member gets no edge), CRLF, cache refresh, and >30 symbols/20 calls. Add the csharp parity fixtures (and their #crlf cases) to REQUIRED_FIXTURES.
Verify: bun test tests/csharp-indexer.test.ts tests/csharp-resolver.test.ts tests/csharp-edge-accuracy.test.ts tests/native-wasm-parity.test.ts tests/parsed-documents-cache.test.ts. Before parser work, C# cases fail because .cs/.csx are not indexed; existing cases remain unchanged.
Progress: done
Result:

- tests/csharp-indexer.test.ts (17 tests): discovery (.cs/.csx → csharp, parseDocument routing), file-scoped/block/nested/dotted namespaces with ranges (file-scoped spans to EOF incl. trailing-newline line count), all type + member kinds under `Owner::member` (incl. multi-declarator fields, enum members, ctor/dtor sharing `Outer::Outer`, nested types, local declarators excluded), full using-directive text (ordinary/alias/global/static), nested-namespace usings dropped, `#if`/`#else` both bodies at original offsets (`blankCSharpDirectives` blanks only #if-family directive lines, `#region` untouched), qualified call forms kept (`this.M`, `Ns.Type.M`, `Alias.M`, generics stripped) with `?.`/expression receivers dropped and `new`/keywords never calls, CRLF ≡ LF, WASM failure → generic chunks + parser `fallback`, bogus grammar → null without throw. All pass.
- tests/csharp-resolver.test.ts (11 tests): real `.cs`/`.csproj` temp workspaces parsed through the WASM path; partial-merge same-type/`this.` calls across files, overloads and `#if`/`#else` duplicates ambiguous (dedupe keyed on file+name+line), parent-namespace lookup, nested member-type chains (`Inner.M`, `Outer.Inner.M`, `Ns.Outer.Inner.M`, `global::…`), ordinary-using binding, alias→workspace type, external alias reserving a name (verified the same name resolves through an ordinary using when the alias is absent), unique vs ambiguous using-static, global using scoped to the declaring project root, same identity in two project roots → ambiguous (and unambiguous inside its own root), variable receiver/inherited/external drops, imports edges (single-file namespace → edge; multi-file namespace/type → none; undeclared → none). All pass.
- tests/csharp-edge-accuracy.test.ts + fixtures `basic`, `roots`, `using-forms`, `conditionals`, `negatives`, `file-scoped-csx`, `above-cap` (35 symbols / 25 calls — uncapped verified at graph level). Baselines generated via `OPENEZ_UPDATE_BASELINE=1`: every fixture 100% TP, 0 FN, 0 FP; native-vs-fallback edge sets identical.
- tests/fixtures/parity/csharp/{example.cs,file-scoped.cs} added; `csharpConfig` joined LANG_CONFIG and both files added to REQUIRED_FIXTURES — `#crlf` cases covered automatically.
- tests/parsed-documents-cache.test.ts: tags bumped to `*-v6` throughout; new `C# parsed-documents cache` test asserts `.cs` rows cache under `native-v6`/`fallback-v6`, cache hits skip reparse, and `native-v5`/`fallback-v5` stale rows reparse.
- Verify: `bun test tests/csharp-indexer.test.ts tests/csharp-resolver.test.ts tests/csharp-edge-accuracy.test.ts tests/native-wasm-parity.test.ts tests/parsed-documents-cache.test.ts` → all pass (17+14+9+30+9 after review round 1), `OPENEZ_NATIVE_EXPECT=1` parity shows zero pinned diffs for both csharp fixtures incl. `#crlf`.

### Task 3 — Wire C# grammars and extraction

Files: packages/indexer/src/languages.ts; packages/indexer/src/tree-sitter/configs.ts; packages/indexer/src/tree-sitter/parse.ts; packages/indexer/src/tree-sitter/loader.ts; packages/indexer/src/parsers/tree-sitter-parser.ts; packages/indexer/src/index-workspace.ts; packages/indexer/package.json; apps/cli/package.json; apps/cli/tsup.config.ts; pnpm-lock.yaml; packages/native/Cargo.toml; packages/native/Cargo.lock; packages/native/src/parser.rs; C# parser/parity fixtures.
Interfaces: consumes current parse contract; produces the design's symbol contract (namespace symbols with ranges, `Owner::member` names, full using text, qualified calls) through native and WASM.
Change: register .cs/.csx as csharp in codeExtensions; add compatible pinned grammars (npm tree-sitter-c-sharp for WASM with a loader mapping csharp → tree-sitter-c-sharp / tree-sitter-c_sharp.wasm, matching Rust crate for native) and record the ABI check; add csharp to TS_LANGS and NATIVE_LANGS; extract namespaces/types/members/usings/invocations; blank only #if/#elif/#else/#endif directive text before parsing on both paths, keeping both bodies and offsets. TreeSitterParser has no regex fallback for csharp: when the WASM parse returns null, return generic fallback chunks with no symbols or calls instead of throwing. Add the dependency to apps/cli and its tsup externals. Advance parser tags (and their literal types) from Task 1.
Verify: bun test tests/csharp-indexer.test.ts tests/native-wasm-parity.test.ts. Expect exact parity including conditional branches and CRLF, grammar-unavailable yields chunks with no symbols and no throw, and existing languages unchanged. Record pinned versions and the install-size delta (npm pack unpacked size) in Result.
Progress: done
Result:

- languages.ts: `.cs`/`.csx` → `csharp`; `blankCSharpDirectives` blanks `#if`/`#elif`/`#else`/`#endif` directive lines to spaces (indentation preserved, `\r` retained for CRLF, `\n`/`\r\n` untouched, `#region`/`#pragma`/`#error`/etc. left intact).
- loader.ts: `GRAMMAR_PACKAGES` maps `csharp` → package `tree-sitter-c-sharp` + artifact `tree-sitter-c_sharp.wasm`; other languages keep the `tree-sitter-${language}` convention; `tree-sitter-wasms` monolith fallback preserved.
- parse.ts: `preprocess` hook applied before `parseContent`; `eofSpanNodeTypes` extends a symbol's endRow to `lines.length` (file-scoped namespace).
- configs.ts: `csharpConfig` — namespace/class/struct/interface/record/enum/delegate + method/ctor/dtor/property/field(`variable_declarator` guarded to `field_declaration`)/`enum_member_declaration`; `using_directive` full-text imports with `declaration_list`-nested directives dropped; `invocation_expression` calls keep the qualified dotted callee with generic args stripped and non-identifier-paths ( `?.`, `(expr)`, `Foo()` chained receivers ) returning `""`; `keepQualifiedCallee` records last-segment calledIdentifiers; `preprocess: blankCSharpDirectives`; `eofSpanNodeTypes: {file_scoped_namespace_declaration}`.
- tree-sitter-parser.ts: `csharp` registered; WASM null → `makeFallbackChunks` with parser `fallback` (no regex C# parser exists; no symbols/imports/calls; no throw).
- review round 2 (extraction): namespace symbols emit fully qualified dotted names via parent-walk `extractName`/`extract_name` (WASM + native); `csharpExported`/`csharp_exported` detect the `modifier` child token instead of substring `public`; native `is_exported` signature is now `(node, source, name)` mirroring WASM.
- index-workspace.ts: `TS_LANGS`/`NATIVE_LANGS` include `csharp`; tree-sitter tags bumped to `native-v6`/`fallback-v6` + literal `readonly id: "native-v6"` (`oxc-v5` unchanged after review round 1); both native `callExpressions.slice(0, 20)` sites and the `uncapped` decision include `csharp` (caps unchanged for all other languages).
- native: `tree-sitter-c-sharp = "0.23.5"` in Cargo.toml/Cargo.lock; `csharp_config()` ports the WASM rules (`blank_directives: true`, identical member/import/call semantics incl. keep-qualified calledIdentifiers + last-segment ignores, `file_scoped_namespace_declaration` → `total_lines` EOF span, `using_directive` full text with `declaration_list` drop); `parse_code_native`/`parse_code_batch` apply `blank_csharp_directives` (identical blanking regex semantics) before parsing.
- packaging: `tree-sitter-c-sharp@0.23.5` (pinned) in packages/indexer + apps/cli dependencies and apps/cli tsup externals.
- Verify: `bun test tests/csharp-indexer.test.ts tests/native-wasm-parity.test.ts` → all pass; `OPENEZ_NATIVE_EXPECT=1` parity: `csharp/example.cs` + `csharp/file-scoped.cs` LF and `#crlf` — ZERO pinned differences (exact native/WASM agreement incl. conditional branches and using text). `pnpm --filter @openez-graph/native build` → release OK → `index.darwin-arm64.node` refreshed. Grammar-unavailable path verified via spy-forced WASM null → `fallback` chunks, no throw. Install-size delta recorded under Task 5 (npm pack unpacked size measurement).

### Task 4 — Resolve C# bindings and partial types

Files: packages/indexer/src/csharp-resolver.ts (new); packages/indexer/src/index-workspace.ts; tests/csharp-resolver.test.ts; tests/csharp-edge-accuracy.test.ts; tests/fixtures/csharp-edges/\*\*.
Interfaces: consumes parsed symbols/usings and workspace files; emits existing imports/calls edges.
Change: discover project roots by listing directories (memoized, project files never read); compute each symbol's namespace chain from namespace line ranges; merge partial parts per project root; apply the design's type lookup order, aliases, global/static using, and explicit type calls. Route C# imports through the resolver in resolveModuleSpecifier and keep the generic resolveImport returning null for csharp. Drop external, ambiguous, overload, inherited, extension, and unknown receiver targets. Extend the uncapped decision and both native slice(0, 20) sites for C# only. Symbol nodes are looked up by (file, label); fixtures must assert the edge lands on the expected file and label.
Verify: bun test tests/csharp-resolver.test.ts tests/csharp-edge-accuracy.test.ts tests/csharp-indexer.test.ts. Positive cases reach exact unique targets; negative cases emit no edge; false positives are 0; above-cap entries remain; other languages' caps are unchanged.
Progress: done
Result:

- csharp-resolver.ts (new, ~500 lines): `resolveCSharpCalls(workspace, parsedDocs)` — project-root discovery via directory listing only (nearest ancestor holding `*.csproj`, memoized per directory, project files never read/evaluated); namespace chains derived from parser-qualified namespace names + line ranges (deepest earlier containing declaration; round 2); partial merge keyed on (projectRoot, namespaceChain, typeName); lookup order same-type members → enclosing-type chain → namespace chain → usings level (ordinary usings + aliases + global usings scoped to the caller's project root) → compilation unit; unique-only resolution — overloads, duplicate conditional-branch members, inherited/extension/delegate/external and cross-project duplicate identities all resolve to nothing; alias names reserve their local slot even when the target is external; `using static` binds uniquely named members of exactly one in-workspace type; explicit type-qualified and namespace-qualified calls honored; variable receivers never resolve. `resolveCSharpImport` emits an imports edge only for an explicit using resolving to exactly one in-workspace file.
- index-workspace.ts: C# imports routed through the resolver (`resolveImport` returns null for csharp); C# calls branch replaces global-name guessing with `resolveCSharpCalls`; `uncapped` extended for csharp; both native `.slice(0, 20)` call sites cover csharp.
- Dedupe: internal `MemberCandidate` carries `startLine` so same-name members in one file (overloads, both `#if` bodies) stay distinct candidates; `startLine` is stripped at the public result boundary.
- Verify: `bun test tests/csharp-resolver.test.ts tests/csharp-edge-accuracy.test.ts tests/csharp-indexer.test.ts` → 40 pass / 0 fail. Edge fixtures (8 workspaces incl. above-cap and same-line siblings) → 100% true positives, 0 false positives, 0 false negatives; 25 above-cap member edges retained.

### Task 5 — Document and validate C# support

Files: AGENTS.md; apps/cli/README.md; tests/parsed-documents-cache.test.ts; tests/native-wasm-parity.test.ts; native CI verification.
Interfaces: documents file support, conditional behavior, resolver limits, and reindex requirement.
Change: update language guidance (Indexing Expectations and the supported-languages row) and run full validation, including the built-CLI smoke test.
Verify: focused C# tests; bun test; pnpm typecheck; pnpm --filter @openez-graph/native build; OPENEZ_NATIVE_EXPECT=1 bun test tests/csharp-indexer.test.ts tests/native-wasm-parity.test.ts; pnpm build:web && pnpm build:cli, then init and index a temporary C# workspace with bun apps/cli/dist/cli.cjs and confirm C# symbols are indexed; existing three-platform native CI.
Progress: done (local verification complete; three-platform native CI gate cannot be run locally — left to CI)
Result:

- AGENTS.md Indexing Expectations + apps/cli/README.md supported-languages row now document C#: `.cs`/`.csx` discovery; `tree-sitter-c-sharp` native+WASM; `Owner::member` naming; partial-type merge per project root (`*.csproj` found by listing, never read); ordinary/alias/global/static using rules incl. external-alias name reservation and ignored undeclared ordinary usings; `#if`/`#elif`/`#else`/`#endif` blanking with preserved offsets and both branches indexed; resolver limitations (no inherited/extension/delegate/variable-receiver/overload/cross-project targets); generic-text fallback when the AST path fails; no C# graph caps; `native-v6`/`fallback-v6` tags (`oxc-v5` unchanged — OXC rows do not reparse) and the required `openez reindex` after upgrade.
- Verify results (all fresh, run from this worktree):
  - `bun test tests/csharp-indexer.test.ts tests/csharp-resolver.test.ts tests/csharp-edge-accuracy.test.ts tests/native-wasm-parity.test.ts tests/parsed-documents-cache.test.ts` → 79 pass / 0 fail (post-review).
  - `bun test` (full suite) → 520 pass, 1 skip, 0 fail, 1904 expect() calls across 48 files (post-review).
  - `pnpm typecheck` → 8/8 packages clean.
  - `CARGO_HOME="$PWD/.cargo-home" pnpm --filter @openez-graph/native build` → release build OK, `index.darwin-arm64.node` refreshed.
  - `OPENEZ_NATIVE_EXPECT=1 bun test tests/csharp-indexer.test.ts tests/native-wasm-parity.test.ts` → all pass, native loaded; `csharp/example.cs` + `csharp/file-scoped.cs` LF and `#crlf` byte-identical between native and WASM, zero pinned diffs.
  - `pnpm build:web` → vite build OK; `pnpm build:cli` → tsup OK (dist/cli.cjs 3.54 MB, frontend dist + native loader copied).
  - CLI smoke: temp workspace (`App.csproj` + `src/Widget.cs` + `src/Helper.cs`) → `bun apps/cli/dist/cli.cjs init` indexed both files as `language: csharp` with `native-v6` cache rows; `bun apps/cli/dist/cli.cjs reindex` rebuilt cleanly; graph build produced symbols `Acme.Core`/`Widget`/`Widget::Run`/`Widget::Step`/`Acme.Util`/`Helper`/`Helper::Add` and calls edges `Widget::Run -> Widget::Step` (same-type) and `Widget::Run -> Helper::Add` (cross-file via `using Acme.Util;`).
- Install-size evidence: `tree-sitter-c-sharp@0.23.5` unpacked 65M (decision log estimated ~68M; mostly `prebuilds/` native binaries for every platform), shipped `tree-sitter-c_sharp.wasm` artifact 5.1M — vs ~54M combined for the existing four grammars (go 3.7M, python 7.2M, rust 14M, ruby 29M).
- Three-platform native CI (native.yml linux-x64-gnu/darwin-arm64/win32-x64-msvc): cannot run locally — the single darwin-arm64 build + parity is green here; CI gate remains for the pipeline.
- Cleanup: task-created artifacts removed (`.pnpm-store/`, `packages/.cargo-home/`, `packages/indexer/{dump-cs,dump-cs2,cs-smoke,cs-debug,cs-resolver-smoke,cs-native-smoke}.ts`, temp smoke workspace). All changes uncommitted.

## Review round 1 — coordinator fixes

Three issues found in review; all fixed in this worktree and re-verified.

1. **Same-line overloads resolved uniquely (fixed).** `memberTargets` deduped
   on `file\0name\0startLine`, collapsing two declarations sharing one
   physical line. `MemberCandidate` now carries the emission `index`
   (position in the file's symbol array) and every dedupe/target key uses
   `file\0name\0index`, so same-line overloads, `#if`/`#else` duplicates,
   and any same-position declarations stay distinct occurrences → ambiguous
   → no edge. Regression coverage: `csharp-resolver same-line declarations >
   same-line overloads never resolve` plus a compact `#if` duplicate case.

2. **namespaceOf line-containment conflated same-line sibling namespaces
   (fixed).** Two root causes:
   - Shared walker pop: `parse.ts` and `parser.rs` expired context frames on
     `startRow > endRow` only, so a sibling declaration on the context's end
     row inherited its name (`Worker::M::B`). Both walkers now store the
     context node's `endByte`/`end_byte` and pop when
     `node.startIndex >= frame.endByte` — byte-position expiry separates
     same-line siblings from children. (The C++ worktree is also correcting
     this shared pop; identical semantics, reconcile at serial integration.)
   - `namespaceOf` now runs an emission-order stack simulation per file: a
     namespace nests inside the stack top when strictly line-contained, or
     when ranges are equal and no non-namespace symbol intervened (an
     intervening member marks same-line siblings). Types/members chain from
     all live namespaces whose ranges contain them. `namespace A{W} B{W}`
     one-liner now yields `A.Worker` and `B.Worker` instead of a merged
     `A.B.Worker`; compact nested `A{B{W}}` still resolves `A.B`.
   - Member attribution: `memberOwnerByFile` maps each member symbol to the
     nearest preceding same-named type in emission order, so same-named
     types sharing one line range keep distinct member sets.
   - Coverage: resolver unit test asserts `A.Worker.RunA` / `B.Worker.RunB`
     resolve per identity, cross-members reject, and `A.B.Worker.Shared` has
     no target; end-to-end fixture `tests/fixtures/csharp-edges/same-line/`
     (`namespace A { class Worker {...} } namespace B { class Worker {...} }`
     on one line) proves `Worker::RunA`/`Worker::RunB` stay distinct with 3
     member TPs, 0 FP/FN.

3. **OXC parser tag reverted.** `PARSER_VERSION_OXC` restored to `oxc-v5` —
   JS/TS/Markdown/config rows no longer reparse on this change. C#
   tree-sitter rows keep `native-v6`/`fallback-v6`; the shared
   `native-v6`/`fallback-v6` bump stands for all native languages.
   `parsed-documents-cache` test now asserts `.js` rows stay `oxc-v5` while
   `.cs` rows cache under `native-v6`/`fallback-v6`; stale `oxc-v2` rows
   still reparse to `oxc-v5`.

Post-fix verification (fresh, this worktree): `bun test` 520 pass / 1 skip /
0 fail (48 files); focused C# suite 79 pass / 0 fail;
`OPENEZ_NATIVE_EXPECT=1` parity exact incl. CRLF with native loaded;
`pnpm typecheck` 8/8 clean; `cargo build --release` (worktree-local
CARGO_HOME) no warnings. Three-platform native CI gate unchanged — pipeline.

## Review round 2 — coordinator fixes

Two further findings; both fixed and re-verified.

1. **Same-line namespace heuristic unsound for nested-after-member
   (fixed — exactly, not via fail-closed).** The round-1 heuristic marked an
   equal-range namespace a sibling whenever a non-namespace symbol
   intervened — wrong for `namespace A { class X {} namespace B { ... } }`
   on one line, where B is truly nested. Replaced guessing with a
   parser-derived representation that keeps the public/cached payload shape:
   namespace symbols now emit their fully qualified dotted name via
   `extractName`/`extract_name` walking `node.parent` through ancestor
   `namespace_declaration`s (`A.B` for B inside A, `B` for a top-level
   sibling — identical shape, name was already dotted). `namespaceOf` is now
   the deepest — most-qualified — earlier declaration containing the symbol,
   same-depth ties to the latest declaration. Paired coverage prevents
   guessing: same-line siblings `A{W}B{W}` resolve `B` at top level while
   nested-after-member `A{X}B{Y}` resolves `A.B` (plus `A.B.C` chains and
   `B.Y.M()`/`using B;` rejecting). Mirrored in WASM configs.ts and native
   parser.rs; parity verified byte-identical on all cases.

2. **`csharpExported`/`csharp_exported` substring false positive (fixed).**
   `[Doc("public API")] class Internal` marked exported because the first
   20 chars contained "public". Both parsers now detect the actual
   `modifier` child token (`modifier` → `public`), so attribute text can
   never fake accessibility. Native `is_exported` signature changed from
   `(name, text20)` to `(node, source, name)` — mirroring WASM's
   `isExported(name, node)`; python/go/rust/ruby predicates adapted
   (rust_pub_check keeps its 20-byte check internally). Regression coverage:
   `[Doc("public API")] class Internal` → exported=false on type and member;
   `[Doc("public")] public class P` → exported=true, non-public member
   stays false.

Post-fix verification (fresh, this worktree): `bun test` 524 pass / 1 skip /
0 fail (48 files); focused C# suite 83 pass / 0 fail;
`OPENEZ_NATIVE_EXPECT=1` parity exact incl. CRLF with native loaded;
`pnpm typecheck` 8/8 clean; `cargo build --release` clean. Three-platform
native CI gate unchanged — pipeline.

## Review round 3 — coordinator fixes (final)

Two remaining findings; both fixed and re-verified.

1. **Namespace selection preferred depth over recency (fixed).**
   `namespaceOf` picked the most-qualified containing declaration, so
   `namespace A.B { X } namespace B { Y }` on one line put Y in `A.B`.
   With parser-derived qualified names carrying the nested-vs-sibling
   distinction (`A.B` vs `B`), the rule is now simply the **latest
   preceding declaration whose line range contains the symbol** — deeper
   dotted names still nest exactly, while same-line siblings supersede.
   Coverage: `mixed-depth` resolver test (`B.Y.M` resolves, `A.B.Y.M` and
   its depth-preferred reading are null, `using B;` resolves) + end-to-end
   fixture `tests/fixtures/csharp-edges/mixed-depth/`; all prior
   nested-after-member (`A{B{Y}}` → `A.B`) and sibling cases unchanged.

2. **Same (file,label) symbol collision routed calls to the wrong graph
   node (fixed — occurrence routing, not fail-closed).**
   `symbolNodeIdsByFileAndName` keys `${file}\0${label}`, so two
   `Worker::Shared` nodes in one file (namespaces `A` and `B`) collapsed to
   the last-written node and both call edges pointed at it. Added an
   internal occurrence map `symbolNodeIdsByFileAndIndex`
   (`${file}\0${emissionIndex}` — the definedSymbols array position the
   resolver already tracks) built in the same `_symMeta` loop — no DB or
   public-shape change. `CSharpResolver` gained `resolveCallOccurrence`
   returning `{filePath, name, index}`; `resolveCall` delegates and still
   returns `{filePath, name}`. The C# call branch in buildGraphGeneration
   looks the target up by occurrence, falling back to the label map.
   Coverage: resolver test proves distinct indices for
   `A.Worker.Shared`/`B.Worker.Shared`; node-level test in
   csharp-edge-accuracy asserts `dup-label` fixture edges reach 2
   DISTINCT `to_node_id`s on both native and WASM-fallback paths
   (previously 1 — the wrong-node collision).

Post-fix verification (fresh, this worktree): `bun test` 529 pass / 1 skip /
0 fail (48 files); focused C# suite 88 pass / 0 fail with
`OPENEZ_NATIVE_EXPECT=1` (native+WASM parity incl. CRLF, edge baselines
matched on both paths); `pnpm typecheck` 8/8 clean. Native binary unchanged
this round (resolver/graph are TypeScript). Three-platform native CI gate
unchanged — pipeline.

## Review round 4 — coordinator fix (final)

One remaining finding; fixed and re-verified.

1. **Caller-identity ambiguity could attach calls to the wrong source node
   (fixed — fail closed).** `callerContext` accepted multiple same-file
   symbols sharing `callerName` when they shared a namespace (overloads,
   `#if` duplicates, same-named members), while buildGraphGeneration maps
   the caller node by `(file,label)` — so a call from one occurrence could
   edge from the other's node. Call records carry no position and adding
   one would change the cached parser payload, so occurrence routing is not
   available caller-side. `callerContext` now requires exactly one
   same-file symbol with the caller's label (`syms.length !== 1 → null`),
   which drops resolution — and therefore any edge — for ambiguous
   callers. Callee-side occurrence routing (`resolveCallOccurrence` +
   `symbolNodeIdsByFileAndIndex`) is unchanged. Coverage: resolver test —
   two `T::M` overloads calling distinct unique targets resolve to null on
   both `resolveCall` and `resolveCallOccurrence` while a unique caller
   still resolves; new fixture `tests/fixtures/csharp-edges/dup-caller/`
   passes scoring (ambiguous callers' edges would be false positives) and
   a dedicated node-level test asserts zero `calls` edges originate from
   `T::M` on both native and WASM-fallback paths.

Post-fix verification (fresh, this worktree): `bun test` 532 pass / 1 skip /
0 fail (48 files); focused C# suite 91 pass / 0 fail with
`OPENEZ_NATIVE_EXPECT=1` (native+WASM parity incl. CRLF; edge baselines
matched on both paths); `pnpm typecheck` 8/8 clean; `git diff --check`
clean. Native binary unchanged (TypeScript-only fix). Three-platform
native CI gate unchanged — pipeline.

## Review round 5 — same-line sibling namespace scopes

One remaining finding; fixed and re-verified.

1. **A namespace-scoped using leaked into a sibling same-name declaration
   sharing its start line (fixed — declaration identity + true ancestors).**
   Scope keys were `<qualified-name>@<decl-line>` and symbol ancestors were
   inferred from line ranges, so `namespace N { using A; C } namespace N { D }`
   on one line gave both blocks the key `N@1` and counted the first block as
   a covering ancestor of the second block's members — `D::Caller` resolved
   through a using it never saw. Both parsers now suffix the scope key with
   `#<ordinal>` (ordinal of the declaration among same-named, same-line
   declarations — document order parser-side, emission order resolver-side),
   and the resolver builds each symbol's lexical ancestor chain by realizing
   the innermost declaration's dotted prefixes: a candidate must precede and
   enclose the next-inner declaration, and its range must extend past the
   line the inner declaration starts on (a same-line sibling's range always
   ends there or is identical; a true parent's always runs further).
   Unprovable same-line nesting falls out fail-closed — a missed ancestor
   using is never a wrong edge. Cache tags bumped `native-v7`/`fallback-v7`
   → `native-v8`/`fallback-v8` since the importPaths payload encoding
   changed; `packages/native/index.darwin-arm64.node` rebuilt. Coverage:
   resolver tests — one-line sibling blocks do not share usings and keep
   distinct scopes in both directions incl. `#1` imports-edge ownership;
   indexer test — sibling blocks emit `N@1`/`N@1#1`; edge fixture
   `ns-same-line` (binding tier, 0 FP) and parity fixture
   `csharp/sibling-ns.cs` prove identical native/WASM output.

Post-fix verification (fresh, this worktree): `bun test` 659 pass / 1 skip /
0 fail (54 files); focused C# suite 131 pass / 0 fail;
`OPENEZ_NATIVE_EXPECT=1` parity clean incl. `sibling-ns.cs` and `#crlf`;
`pnpm typecheck` 8/8 clean; Prettier clean on changed files;
`git diff --check` clean. Three-platform native CI gate unchanged — the
binding rebuild is local and CI builds from source.

## Review round 6 — per-level precedence, malformed using parity, true ancestry

Three independently confirmed findings; all fixed and re-verified.

1. **Using directives bound only after all enclosing namespace declarations
   (fixed — per-level precedence).** `resolveTypeName` checked declared
   types at every enclosing level before consulting any usings, so
   `A.Thing` captured `Thing.F()` inside
   `namespace A.B { using U; ... }` even though `A.B.U.Thing` binds at the
   inner level (dotnet compiles that case unambiguously). The resolver now
   walks namespace levels innermost→global and, at each level, checks that
   level's declared types then that level's alias, ordinary, and
   using-static bindings; the first level that binds the name decides —
   an ambiguous or reserved inner binding ends the lookup rather than
   falling outward. Compilation-unit usings plus the project root's global
   usings bind only after all enclosing levels. Coverage: resolver tests —
   inner using beats outer declaration (edge lands on `A.B.U.Thing.F`, not
   `A.Thing.F`), ambiguous inner usings produce no edge rather than the
   outer type, an inner external alias reserves the name, an inner
   workspace alias beats outer declarations, and a same-level declared
   type still beats its own level's usings; edge fixture
   `ns-precedence/` pins the three-file repro.

2. **A malformed `using` inside a non-namespace declaration list leaked
   compilation-unit text on WASM (fixed — drop, native parity).**
   `class C { using A; ... }` lands the directive in a class-body
   `declaration_list`; native dropped it while WASM returned an empty
   scope and emitted `importPaths: ["using A;"]`. WASM now returns a null
   scope for any `declaration_list` not owned by a
   `namespace_declaration` and drops the entry, matching native;
   legitimate compilation-unit and namespace usings are unaffected.
   Coverage: parser tests — dropped directive, surviving legitimate
   usings; parity fixture `csharp/malformed-using.cs` (LF+CRLF) proves
   identical native/WASM output.

3. **Same-line nested namespaces failed closed out of their enclosing
   usings (fixed — parser-serialized ancestry).** On one physical line,
   `A{using U; B{}}` (nested — dotnet compiles) and `A{using U;} A.B{}`
   (sibling — CS0103) emit byte-identical symbol payloads, so no resolver
   rule over line ranges can distinguish them. Both parsers now serialize
   each symbol's innermost enclosing namespace declaration as the
   `name@line[#k]` scope key in the existing optional `ParsedSymbol.receiver`
   field (a namespace declaration carries its *parent's* key; file-scoped
   members find their declaration via the nearest preceding sibling, since
   they are compilation-unit siblings rather than children). The resolver
   rebuilds true lexical ancestors by walking that chain instead of
   inferring from ranges, so the nested case binds `using U` while the
   sibling case still cannot see it. `ParsedDocument`/`ParsedSymbol`
   shape, DB schema, and graph kind vocabulary are unchanged — `receiver`
   was already an optional serialized field. Cache tags bumped
   `native-v8`/`fallback-v8` → `native-v9`/`fallback-v9` because the
   serialized symbol payload changed; `packages/native/index.darwin-arm64.node`
   rebuilt. Coverage: parser tests — receiver keys on nested, file-scoped,
   and same-named sibling declarations; resolver tests — same-line nested
   usings reach members (multi-level chain included) while a closed
   same-line sibling's usings do not reach a dotted declaration; edge
   fixture `ns-nested-sameline/` pins both outcomes in one workspace.

Failing-before proof: 13 focused regressions failed for the expected
reasons before the fix (both edge fixtures, both malformed-using tests,
three receiver tests, both same-line ancestry tests, four of five
per-level precedence tests) and all pass after.

Post-fix verification (fresh, this worktree): `bun test` 676 pass / 1 skip /
0 fail (54 files); focused C# suite 148 pass / 0 fail;
`OPENEZ_NATIVE_EXPECT=1` parity clean incl. `malformed-using.cs` and
`#crlf`; `tsc` clean for `packages/indexer`; Prettier clean on changed
files; `git diff --check` clean. `cargo clippy` reports 19 pre-existing
deny-level lints (identical on `bc2289b` — rustc 1.95 toolchain drift,
none in the changed code). Three-platform native CI gate unchanged — the
binding rebuild is local and CI builds from source.

## Review round 7 — native graph re-parse dropped receiver scope keys

One remaining finding; fixed and re-verified.

1. **`buildGraphGeneration`'s native re-parse stripped `receiver` (fixed —
   copy the field through the mapping, like parseInline).** The C# parsers
   emit `name@line[#k]` scope keys in the optional `receiver` symbol field
   (round 6) and `CSharpResolverFileInput` expects them, but the
   `nr.symbols` → `definedSymbols` mapping in `buildGraphGeneration` did not
   copy it. `indexWorkspace`'s `parseInline` does copy it (L454), so
   index-written `native-v9` rows carry the keys and cache-hit graph builds
   masked the bug; it surfaced only when the graph path itself re-parsed
   natively (e.g. indexed via `fallback-v9` then graphed with the native
   binding, or a stale-tag row), and the re-parse then persisted the
   receiver-less shape into `parsed_documents`, keeping later cache hits
   broken. Without receivers every symbol read as compilation-unit level,
   so the same-line sibling `namespace A.B` bound `Thing` as a declared
   type and emitted a `D::N -> Thing::F` edge that must not exist, while
   the nested case emitted its edge for the wrong reason (declared-type
   binding instead of the scoped `using U`). The mapping now spreads
   `receiver` identically to `parseInline`, and `ParsedFile.definedSymbols`
   declares the optional field so it reaches `createCSharpResolver`. No tag
   bump: the serialized payload shape already carried `receiver` since v9 —
   only the graph-path write was non-conformant — and re-parsing on the
   next content/version change self-heals previously stripped rows.
   Coverage: `parsed-documents-cache` test — index under
   `OPENEZ_NATIVE=0`, graph build under native (forcing the real
   `indexWorkspace`/`buildGraphGeneration` re-parse): `Consumer.cs#C::M ->
   Lib.cs#Thing::F` edges (same-line nested using), `Consumer.cs#D::N ->
   Lib.cs#Thing::F` does not (same-line sibling), and the rewritten
   `native-v9` row keeps `receiver` `A.B@1`/`A.B@2` on `C::M`/`D::N`.

Failing-before proof: the new regression failed pre-fix on the sibling
assertion — the receiver-less resolver emitted the forbidden
`Consumer.cs#D::N -> Lib.cs#Thing::F` false positive (and the cache rows
carried no `receiver`); all assertions pass post-fix.

Post-fix verification (fresh, this worktree): `bun test` 677 pass / 1 skip /
0 fail (54 files); focused C# suite 95 pass / 0 fail;
`OPENEZ_NATIVE_EXPECT=1` parity clean incl. `#crlf` on
`tests/native-wasm-parity.test.ts` + `tests/csharp-indexer.test.ts` (83
pass); `pnpm typecheck` 8/8 clean; Prettier clean on changed files;
`git diff --check` clean. Native binary unchanged (TypeScript-only fix).
Three-platform native CI gate unchanged — pipeline.

## Review round 8 — stale `namespaceOf` ancestry comment

One documentation-only finding; corrected and re-verified.

1. **`namespaceOf`'s docstring still described line-range ancestry (fixed —
   comment only).** The JSDoc above `namespaceOf` in
   `packages/indexer/src/csharp-resolver.ts` read "precomputed per file
   from emission order + line ranges" — stale since round 6 moved ancestry
   to parser-serialized `receiver` scope keys (f651ee0): `nsChain` is now
   `scopeNamespace(s.receiver)`, the semantic namespace of the innermost
   enclosing declaration. The comment now states receiver-based namespace
   ancestry. Nearby comments re-audited: the surviving "emission order"
   mentions cover `memberOwner` attribution and the `name@line#k` ordinal,
   both still emission-order-driven, and `membersOf`'s range filter is
   real — no other stale wording.

Post-fix verification (fresh, this worktree): Prettier clean on changed
files; `git diff --check` clean. Documentation-only; no test rerun.

## Files inspected, no change

- packages/indexer/src/scanner.ts — builds its file list from codeExtensions (the native scanner matches extensions case-sensitively), so registering .cs/.csx is enough.
- packages/indexer/src/parsers/parser-registry.ts — remains the dispatch entry point.
- packages/indexer/src/parsers/types.ts — ParsedDocument shape stays unchanged.
- packages/native/index.d.ts — native batch API stays unchanged.

## Approval Gate

Status: approved

## Decision Log

- Grammars ship as npm packages, matching the existing four. tree-sitter-c-sharp is about 68 MB unpacked, so the combined Java/C#/C++ grammar footprint (about 116 MB against about 54 MB for the existing four) is recorded in Task 3. Vendoring only the .wasm files is a follow-up if that size is a problem.
- Global using is scoped by project root found from \*.csproj file names rather than workspace-wide, because workspace-wide contradicts the no cross-project guessing goal. Project files are never parsed.
- Partial merge keys on namespace, enclosing-type chain, and name within one project root, so no `partial` modifier needs to be extracted; valid C# only repeats a type identity within a project when it is partial.
- Types are visible across project roots by namespace (ProjectReference is not read); a lookup that reaches the same identity in two roots is ambiguous.
- Ordinary usings of namespaces the workspace does not declare are ignored rather than reserving names, since two using-supplied types of one name at a level do not compile.
- Local-function/lambda shadowing is an accepted ceiling instead of a new rule.
