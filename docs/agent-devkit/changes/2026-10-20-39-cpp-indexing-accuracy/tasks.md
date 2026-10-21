# C++ indexing accuracy and native parity tasks

Issue: #39

## Design

[C++ indexing accuracy and native parity](design.md)

## Global Constraints

- Resolve only unique targets: a candidate group (same fully qualified name) with one definition and at most one declaration, or no definition and one declaration. Do not infer variable receiver types, inheritance, overload choice, template specialization, macro-generated declarations, using-directives, compiler flags, or system include paths.
- Resolve quoted includes from the including directory, then the workspace root, then a unique path-suffix match, enforcing workspace containment. Angle/system includes do not create workspace imports edges.
- Remove generic 30-symbol/20-call graph limits for C++ only, at the `uncapped` decision in buildGraphGeneration and at both native `callExpressions.slice(0, 20)` sites. Never add cpp to OXC_GRAPH_LANGUAGES. Keep DB/API shapes unchanged.
- A C++ file sees itself plus recursively reachable literal quoted includes inside the workspace.
- The resolver reads only existing ParsedDocument fields (symbols with line ranges, importPaths, calls); no source re-read, cache payload, or schema change.
- A .h file with a syntax error gets generic text chunks and no graph records, identically on the native and WASM paths.
- If both AST paths fail, generic text chunks remain searchable and no C++ graph records are emitted; parsing does not throw. Add no regex C++ parser.
- The grammar must ship in the published CLI: apps/cli dependencies and tsup externals, not only packages/indexer.
- Parser tags advance from implementation baseline; full openez reindex rebuilds graph artifacts and other languages' stale rows.

## Impact map

Entry: packages/indexer/src/index-workspace.ts::indexWorkspace (L529) and buildGraphGeneration (L1096); packages/indexer/src/parsers/parser-registry.ts::parseDocument (L45); packages/native/src/parser.rs::get_config/get_language_fn (L1448/L1458).
Flow: scanWorkspaceFiles (extensions come from codeExtensions; none of the C++ extensions, nor .c, is present today) → indexWorkspace → native parseCodeBatch (gated by TS_LANGS, L397) when available, otherwise parseDocument → TreeSitterParser → native/WASM extraction → parsed_documents cache → buildGraphGeneration (NATIVE_LANGS gate L1125, cap decision L1521, import-edge loop L1584 via resolveModuleSpecifier L1676) → C++ resolver → SQLite graph artifacts.
State changes: C++ files are ingested for the first time; chunks, cached includes/calls, and graph artifacts are produced; other languages' rows reparse on the tag bump; no schema migration.
External effects: reads workspace C++ source and quoted include paths only; no compiler, compilation database, system include search, or network.
Change candidates: packages/indexer/src/languages.ts; packages/indexer/src/tree-sitter/configs.ts; packages/indexer/src/tree-sitter/parse.ts; packages/indexer/src/tree-sitter/loader.ts; packages/indexer/src/parsers/tree-sitter-parser.ts; packages/indexer/src/index-workspace.ts; packages/indexer/src/cpp-resolver.ts (new); packages/indexer/package.json; apps/cli/package.json; apps/cli/tsup.config.ts; pnpm-lock.yaml; packages/native/Cargo.toml; packages/native/Cargo.lock; packages/native/src/parser.rs; tests/cpp-indexer.test.ts (new); tests/cpp-resolver.test.ts (new); tests/cpp-edge-accuracy.test.ts (new); tests/fixtures/cpp-edges/**; tests/fixtures/parity/cpp/**; tests/native-wasm-parity.test.ts; tests/parsed-documents-cache.test.ts; AGENTS.md; apps/cli/README.md.
Verification: parser/resolver/edge-accuracy fixtures, classification, parity incl. CRLF, include-cycle/containment checks, .h error fallback, cache reparse, above-cap graph, Bun tests, typecheck, native build/CI, built-CLI smoke test, install-size record.
Verified at: 0519b8284324722863d9123a457f28b389389f61 (HEAD; working tree also contains uncommitted issue #39 changes, line numbers above are from that working tree on 2026-10-20 and must be re-traced before implementation).

## Tasks

### Task 1 — Record the implementation baseline

Files: none (check only), plus updating Verified at and the line numbers in this file.
Interfaces: records current language detection, grammar dispatch, cache tags, caps, and test state.
Change: re-trace the working tree for C++ extension handling (confirm no C/C++ extension is scanned and how inferDocumentKind lowercases extensions), parser dispatch, the TS_LANGS/NATIVE_LANGS sets, native grammar, cache versions (currently native-v5/fallback-v5) and their literal types, all graph-cap sites, the import-edge loop, and the REQUIRED_FIXTURES manifest in the parity test. Run current indexer/parity/cache and full-suite checks; record baseline failures in Result.
Verify: bun test tests/index-workspace.test.ts tests/native-wasm-parity.test.ts tests/parsed-documents-cache.test.ts, then bun test. Any existing failure is recorded before C++ edits.
Progress: todo
Result: none

### Task 2 — Add C++ parser, translation-unit, and parity fixtures

Files: tests/cpp-indexer.test.ts (new); tests/cpp-resolver.test.ts (new); tests/cpp-edge-accuracy.test.ts (new); tests/fixtures/cpp-edges/**; tests/fixtures/parity/cpp/**; tests/native-wasm-parity.test.ts; tests/parsed-documents-cache.test.ts.
Interfaces: specifies extraction and visible-target behavior for Tasks 3 and 4. Each cpp-edges fixture directory holds sources, expected-edges.json, and baseline.json in the shape used by tests/fixtures/go-edges.
Change: cover declarations, namespaces, templates, out-of-line members, direct/transitive/cyclic quoted includes, angle includes, `include/` suffix includes (unique and ambiguous), namespaces with namesakes, enclosing-namespace lookup, class-scope name hiding, implicit-this, declaration/definition pairing (calls inside the .cpp reach its definition; a caller in another file reaches the header declaration), overload and duplicate-definition ambiguity, receiver negatives, outside-workspace paths, CRLF, cache refresh, .h/.C/.c classification, a .h with a syntax error (text chunks only), and >30 symbols/20 calls. Add the cpp parity fixtures (and their #crlf cases) to REQUIRED_FIXTURES.
Verify: bun test tests/cpp-indexer.test.ts tests/cpp-resolver.test.ts tests/cpp-edge-accuracy.test.ts tests/native-wasm-parity.test.ts tests/parsed-documents-cache.test.ts. Before parser wiring, C++ cases fail because its extensions are not indexed; existing cases remain unchanged.
Progress: todo
Result: none

### Task 3 — Wire C++ grammars and extraction

Files: packages/indexer/src/languages.ts; packages/indexer/src/tree-sitter/configs.ts; packages/indexer/src/tree-sitter/parse.ts; packages/indexer/src/tree-sitter/loader.ts; packages/indexer/src/parsers/tree-sitter-parser.ts; packages/indexer/src/index-workspace.ts; packages/indexer/package.json; apps/cli/package.json; apps/cli/tsup.config.ts; pnpm-lock.yaml; packages/native/Cargo.toml; packages/native/Cargo.lock; packages/native/src/parser.rs; C++ parser/parity fixtures.
Interfaces: consumes current parser contract; produces the design's symbol contract (namespace symbols with ranges, `Owner::member` names, `declaration` symbols for prototypes, qualified calls, literal quoted includes) through native and WASM.
Change: register the C++ source/header extensions in codeExtensions, with an exact-case `.C` check in inferDocumentKind ahead of lowercasing; map .h to cpp and leave .c unindexed; add compatible pinned grammars (npm tree-sitter-cpp for WASM, Rust crate for native) and record the ABI check; add cpp to TS_LANGS and NATIVE_LANGS; extract namespace/type/function/method/declaration/include/call forms. For .h, treat a root syntax error as a parse failure (generic chunks, no graph records) on both paths. TreeSitterParser has no regex fallback for cpp: when the WASM parse returns null, return generic fallback chunks with no symbols or calls instead of throwing. Add the dependency to apps/cli and its tsup externals. Advance tags (and their literal types) from Task 1.
Verify: bun test tests/cpp-indexer.test.ts tests/native-wasm-parity.test.ts. Expect exact parser output including CRLF, correct .h/.C/.c handling, a grammar-unavailable run that yields chunks with no symbols and no throw, and unchanged existing languages. Record pinned versions and the install-size delta (npm pack unpacked size) in Result.
Progress: todo
Result: none

### Task 4 — Resolve quoted includes and translation-unit calls

Files: packages/indexer/src/cpp-resolver.ts (new); packages/indexer/src/index-workspace.ts; tests/cpp-resolver.test.ts; tests/cpp-edge-accuracy.test.ts; tests/fixtures/cpp-edges/\*\*.
Interfaces: consumes parsed symbols/includes and workspace files; emits existing imports/calls edges.
Change: resolve quoted includes from importer directory, then workspace root, then a unique path-suffix match, with containment; compute transitive visibility with a cycle guard; build qualified-name candidate groups (declaration/definition pairing) and apply the design's lookup order for qualified, unqualified, and this-> calls. Route C++ imports through the resolver in resolveModuleSpecifier and keep the generic resolveImport returning null for cpp. Drop external, outside-workspace, overloaded, duplicate-definition, inherited, and unknown-receiver targets. Extend the uncapped decision and both native slice(0, 20) sites for C++ only. Symbol nodes are looked up by (file, label), so a declaration and definition of one name in a single file share a lookup entry; fixtures must assert each edge lands on the expected file and label.
Verify: bun test tests/cpp-resolver.test.ts tests/cpp-edge-accuracy.test.ts tests/cpp-indexer.test.ts. Positive calls reach one exact visible target; negatives have no edge; false positives are 0; cycles terminate; above-cap entries remain; other languages' caps are unchanged.
Progress: todo
Result: none

### Task 5 — Document and validate C++ support

Files: AGENTS.md; apps/cli/README.md; tests/parsed-documents-cache.test.ts; tests/native-wasm-parity.test.ts; native CI verification.
Interfaces: documents extensions, include behavior, resolver limits, the headers-only effect on C repositories, and the reindex requirement.
Change: update language guidance (Indexing Expectations and the supported-languages row) and complete focused/full validation, including the built-CLI smoke test.
Verify: focused C++ tests; bun test; pnpm typecheck; pnpm --filter @openez-graph/native build; OPENEZ_NATIVE_EXPECT=1 bun test tests/cpp-indexer.test.ts tests/native-wasm-parity.test.ts; pnpm build:web && pnpm build:cli, then init and index a temporary C++ workspace with bun apps/cli/dist/cli.cjs and confirm C++ symbols are indexed; existing Linux x64/macOS arm64/Windows x64 native CI.
Progress: todo
Result: none

## Files inspected, no change

- packages/indexer/src/scanner.ts — builds its file list from codeExtensions and the native scanner matches extensions case-sensitively, so registering the extensions (including `.C`) is enough.
- packages/indexer/src/parsers/parser-registry.ts — remains the dispatch entry point.
- packages/indexer/src/parsers/types.ts — ParsedDocument shape stays unchanged.
- packages/native/index.d.ts — native batch API stays unchanged.

## Approval Gate

Status: approved

## Decision Log

- Declarations and definitions are paired by fully qualified name instead of kept as separate candidates. Keeping them separate made every call inside a `.cpp` to a method declared in its own header ambiguous, which removes the main use case; CodeGraph's translation-unit fixture also expects a source to implement its header. The ceiling is an overload declared in one file and defined in another, which can mispair.
- Quoted includes add a unique path-suffix fallback because `include/`-style layouts are common and the importer directory and workspace root alone miss them; several matches stay unresolved, so it remains unique-only. Cut it if unique-only strictness is preferred.
- .h files with a syntax error are text-chunked only, so macro-heavy C headers are not turned into misleading C++ symbols. Other C++ extensions keep partial trees.
- Lowercase .c stays unindexed (it is not scanned today), so C repositories gain headers only; adding a C parser is out of scope.
- Using-directives and inheritance are accepted ceilings rather than modeled; they can only change which lexically found target is chosen, never create a target from an unrelated namesake.
- Grammars ship as npm packages, matching the existing four. tree-sitter-cpp is about 42 MB unpacked, so the combined Java/C#/C++ footprint (about 116 MB against about 54 MB for the existing four) is recorded in Task 3. Vendoring only the .wasm files is a follow-up if that size is a problem.
