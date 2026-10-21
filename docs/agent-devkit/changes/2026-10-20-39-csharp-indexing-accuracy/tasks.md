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

Entry: packages/indexer/src/index-workspace.ts::indexWorkspace (L529) and buildGraphGeneration (L1096); packages/indexer/src/parsers/parser-registry.ts::parseDocument (L45); packages/native/src/parser.rs::get_config/get_language_fn (L1448/L1458).
Flow: scanWorkspaceFiles (extensions come from codeExtensions; .cs/.csx are absent today) → indexWorkspace → native parseCodeBatch (gated by TS_LANGS, L397) when available, otherwise parseDocument → TreeSitterParser → native/WASM extraction → parsed_documents cache → buildGraphGeneration (NATIVE_LANGS gate L1125, cap decision L1521, import-edge loop L1584 via resolveModuleSpecifier L1676) → C# resolver → SQLite graph artifacts.
State changes: C# files are ingested for the first time; chunks, cached usings/calls, and graph artifacts are produced; other languages' rows reparse on the tag bump; no schema migration.
External effects: reads .cs/.csx source and lists directories for \*.csproj names; no project evaluation, dotnet, NuGet, or network.
Change candidates: packages/indexer/src/languages.ts; packages/indexer/src/tree-sitter/configs.ts; packages/indexer/src/tree-sitter/parse.ts; packages/indexer/src/tree-sitter/loader.ts; packages/indexer/src/parsers/tree-sitter-parser.ts; packages/indexer/src/index-workspace.ts; packages/indexer/src/csharp-resolver.ts (new); packages/indexer/package.json; apps/cli/package.json; apps/cli/tsup.config.ts; pnpm-lock.yaml; packages/native/Cargo.toml; packages/native/Cargo.lock; packages/native/src/parser.rs; tests/csharp-indexer.test.ts (new); tests/csharp-resolver.test.ts (new); tests/csharp-edge-accuracy.test.ts (new); tests/fixtures/csharp-edges/**; tests/fixtures/parity/csharp/**; tests/native-wasm-parity.test.ts; tests/parsed-documents-cache.test.ts; AGENTS.md; apps/cli/README.md.
Verification: parser/resolver/edge-accuracy fixtures, conditional/partial/no-edge cases, parity incl. CRLF, cache reparse, above-cap graph, Bun tests, typecheck, native build/CI, built-CLI smoke test, install-size record.
Verified at: 0519b8284324722863d9123a457f28b389389f61 (HEAD; working tree also contains uncommitted issue #39 changes, line numbers above are from that working tree on 2026-10-20 and must be re-traced before implementation).

## Tasks

### Task 1 — Record the implementation baseline

Files: none (check only), plus updating Verified at and the line numbers in this file.
Interfaces: records shared parser, cache, cap, and native dispatch state.
Change: re-trace the working tree for C# detection (confirm .cs/.csx are not scanned), grammar dispatch and the loader's `tree-sitter-${language}` naming, the TS_LANGS/NATIVE_LANGS sets, parser tags (currently native-v5/fallback-v5) and their literal types, all graph-cap sites, the import-edge loop, and the REQUIRED_FIXTURES manifest in the parity test; run current indexer/parity/cache and full suite; record baseline failures in Result.
Verify: bun test tests/index-workspace.test.ts tests/native-wasm-parity.test.ts tests/parsed-documents-cache.test.ts, then bun test. Existing failures are recorded, not attributed to C#.
Progress: todo
Result: none

### Task 2 — Add C# parser, graph, and parity fixtures

Files: tests/csharp-indexer.test.ts (new); tests/csharp-resolver.test.ts (new); tests/csharp-edge-accuracy.test.ts (new); tests/fixtures/csharp-edges/**; tests/fixtures/parity/csharp/**; tests/native-wasm-parity.test.ts; tests/parsed-documents-cache.test.ts.
Interfaces: specifies extraction/resolver behavior for Tasks 3 and 4. Each csharp-edges fixture directory holds sources (plus empty \*.csproj marker files where project roots matter), expected-edges.json, and baseline.json in the shape used by tests/fixtures/go-edges.
Change: cover namespace forms (file-scoped, block, nested, dotted), parent-namespace lookup, nested/partial types across files, the same type identity in two project roots (no edge), alias/global (scoped by project root)/static using, external alias reserving a name, ignored external ordinary usings, partial calls, overload/unknown-receiver negatives, #if/#else (both bodies indexed, duplicate member gets no edge), CRLF, cache refresh, and >30 symbols/20 calls. Add the csharp parity fixtures (and their #crlf cases) to REQUIRED_FIXTURES.
Verify: bun test tests/csharp-indexer.test.ts tests/csharp-resolver.test.ts tests/csharp-edge-accuracy.test.ts tests/native-wasm-parity.test.ts tests/parsed-documents-cache.test.ts. Before parser work, C# cases fail because .cs/.csx are not indexed; existing cases remain unchanged.
Progress: todo
Result: none

### Task 3 — Wire C# grammars and extraction

Files: packages/indexer/src/languages.ts; packages/indexer/src/tree-sitter/configs.ts; packages/indexer/src/tree-sitter/parse.ts; packages/indexer/src/tree-sitter/loader.ts; packages/indexer/src/parsers/tree-sitter-parser.ts; packages/indexer/src/index-workspace.ts; packages/indexer/package.json; apps/cli/package.json; apps/cli/tsup.config.ts; pnpm-lock.yaml; packages/native/Cargo.toml; packages/native/Cargo.lock; packages/native/src/parser.rs; C# parser/parity fixtures.
Interfaces: consumes current parse contract; produces the design's symbol contract (namespace symbols with ranges, `Owner::member` names, full using text, qualified calls) through native and WASM.
Change: register .cs/.csx as csharp in codeExtensions; add compatible pinned grammars (npm tree-sitter-c-sharp for WASM with a loader mapping csharp → tree-sitter-c-sharp / tree-sitter-c_sharp.wasm, matching Rust crate for native) and record the ABI check; add csharp to TS_LANGS and NATIVE_LANGS; extract namespaces/types/members/usings/invocations; blank only #if/#elif/#else/#endif directive text before parsing on both paths, keeping both bodies and offsets. TreeSitterParser has no regex fallback for csharp: when the WASM parse returns null, return generic fallback chunks with no symbols or calls instead of throwing. Add the dependency to apps/cli and its tsup externals. Advance parser tags (and their literal types) from Task 1.
Verify: bun test tests/csharp-indexer.test.ts tests/native-wasm-parity.test.ts. Expect exact parity including conditional branches and CRLF, grammar-unavailable yields chunks with no symbols and no throw, and existing languages unchanged. Record pinned versions and the install-size delta (npm pack unpacked size) in Result.
Progress: todo
Result: none

### Task 4 — Resolve C# bindings and partial types

Files: packages/indexer/src/csharp-resolver.ts (new); packages/indexer/src/index-workspace.ts; tests/csharp-resolver.test.ts; tests/csharp-edge-accuracy.test.ts; tests/fixtures/csharp-edges/\*\*.
Interfaces: consumes parsed symbols/usings and workspace files; emits existing imports/calls edges.
Change: discover project roots by listing directories (memoized, project files never read); compute each symbol's namespace chain from namespace line ranges; merge partial parts per project root; apply the design's type lookup order, aliases, global/static using, and explicit type calls. Route C# imports through the resolver in resolveModuleSpecifier and keep the generic resolveImport returning null for csharp. Drop external, ambiguous, overload, inherited, extension, and unknown receiver targets. Extend the uncapped decision and both native slice(0, 20) sites for C# only. Symbol nodes are looked up by (file, label); fixtures must assert the edge lands on the expected file and label.
Verify: bun test tests/csharp-resolver.test.ts tests/csharp-edge-accuracy.test.ts tests/csharp-indexer.test.ts. Positive cases reach exact unique targets; negative cases emit no edge; false positives are 0; above-cap entries remain; other languages' caps are unchanged.
Progress: todo
Result: none

### Task 5 — Document and validate C# support

Files: AGENTS.md; apps/cli/README.md; tests/parsed-documents-cache.test.ts; tests/native-wasm-parity.test.ts; native CI verification.
Interfaces: documents file support, conditional behavior, resolver limits, and reindex requirement.
Change: update language guidance (Indexing Expectations and the supported-languages row) and run full validation, including the built-CLI smoke test.
Verify: focused C# tests; bun test; pnpm typecheck; pnpm --filter @openez-graph/native build; OPENEZ_NATIVE_EXPECT=1 bun test tests/csharp-indexer.test.ts tests/native-wasm-parity.test.ts; pnpm build:web && pnpm build:cli, then init and index a temporary C# workspace with bun apps/cli/dist/cli.cjs and confirm C# symbols are indexed; existing three-platform native CI.
Progress: todo
Result: none

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
