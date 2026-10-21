# Java indexing accuracy and native parity tasks

Issue: #39

## Design

[Java indexing accuracy and native parity](design.md)

## Global Constraints

- Native and WASM parsing must agree, while external, unresolved, and ambiguous calls stay unlinked.
- Resolve only unique calls per the design Behavior (type lookup order, innermost-type bare calls, single static import). Do not infer variable receiver types, overload choice, inheritance, or dynamic dispatch.
- Emit imports edges only for explicit imports mapping to one in-workspace file. External and wildcard imports do not create guessed edges.
- Remove generic 30-symbol and 20-call graph limits for Java only, at the `uncapped` decision in buildGraphGeneration and at both native `callExpressions.slice(0, 20)` sites. Never add java to OXC_GRAPH_LANGUAGES. Keep database/public APIs unchanged.
- The resolver reads only existing ParsedDocument fields (symbols with line ranges, importPaths, calls); no source re-read, cache payload, or schema change.
- If both AST paths fail, generic text chunks remain searchable and no Java symbols/calls are emitted; parsing does not throw. Add no regex Java parser.
- The grammar must ship in the published CLI: apps/cli dependencies and tsup externals, not only packages/indexer.
- Bump parser cache versions from the implementation baseline and run openez reindex after the change.

## Impact map

Entry: packages/indexer/src/index-workspace.ts::indexWorkspace (L529) and buildGraphGeneration (L1096); packages/indexer/src/parsers/parser-registry.ts::parseDocument (L45); packages/native/src/parser.rs::get_config/get_language_fn (L1448/L1458).
Flow: scanWorkspaceFiles (extensions come from codeExtensions; .java is absent today) → indexWorkspace → native parseCodeBatch (gated by TS_LANGS, L397) when available, otherwise parseDocument → TreeSitterParser → native/WASM extraction → parsed_documents cache → buildGraphGeneration (NATIVE_LANGS gate L1125, cap decision L1521, import-edge loop L1584 via resolveModuleSpecifier L1676) → Java resolver → SQLite graph artifacts.
State changes: Java files are ingested for the first time; chunks, cached imports/calls, and graph artifacts are produced; other languages' rows reparse on the tag bump; no schema migration.
External effects: reads Java source only; no JDK, Maven/Gradle, dependency download, or network.
Change candidates: packages/indexer/src/languages.ts; packages/indexer/src/tree-sitter/configs.ts; packages/indexer/src/tree-sitter/parse.ts; packages/indexer/src/tree-sitter/loader.ts; packages/indexer/src/parsers/tree-sitter-parser.ts; packages/indexer/src/index-workspace.ts; packages/indexer/src/java-resolver.ts (new); packages/indexer/package.json; apps/cli/package.json; apps/cli/tsup.config.ts; pnpm-lock.yaml; packages/native/Cargo.toml; packages/native/Cargo.lock; packages/native/src/parser.rs; tests/java-indexer.test.ts (new); tests/java-resolver.test.ts (new); tests/java-edge-accuracy.test.ts (new); tests/fixtures/java-edges/**; tests/fixtures/parity/java/**; tests/native-wasm-parity.test.ts; tests/parsed-documents-cache.test.ts; AGENTS.md; apps/cli/README.md.
Verification: Java parser/resolver/edge-accuracy fixtures, parity including CRLF, cache reparse, above-cap graph fixture, Bun tests, typecheck, native build/CI, built-CLI smoke test, install-size record.
Verified at: c7d06076bc98982ee4a89440b80021b9ec0bb7e4 (HEAD of worktree branch codex/39-java-20261021, clean tree). Re-traced 2026-10-21: indexWorkspace L529, buildGraphGeneration L1096, parseDocument L45, parser.rs get_config L1433 / get_language_fn L1443; TS_LANGS L397, NATIVE_LANGS L1125, uncapped decision L1523, native slice(0,20) sites L463 and L1310, import-edge loop L1586, resolveModuleSpecifier L1678. `.java` absent from codeExtensions (languages.ts L21-36) — not scanned today. Cache tags `native-v5`/`fallback-v5`/`oxc-v5` at L59-61; `NativeParser.id` L82. Parity REQUIRED_FIXTURES L363-369; manifest `{}`.

## Tasks

### Task 1 — Record the implementation baseline

Files: none (check only), plus updating Verified at and the line numbers in this file.
Interfaces: records existing parser, version, cap, and test behavior before edits.
Change: re-trace the working tree for Java extension detection (confirm .java is not scanned), parser dispatch, the TS_LANGS/NATIVE_LANGS sets, native grammar dispatch, the cache tags (currently native-v5/fallback-v5) and their literal types, all graph-cap sites, the import-edge loop, and the REQUIRED_FIXTURES manifest in the parity test. Run existing indexer/parity/cache and full-suite checks; record failures in Result.
Verify: bun test tests/index-workspace.test.ts tests/native-wasm-parity.test.ts tests/parsed-documents-cache.test.ts, then bun test. Expected: baseline failures, if any, are recorded without assigning them to Java.
Progress: done
Result: Fresh checkout baseline (no .java scanning; pnpm install run first — husky prepare fails harmlessly on the worktree git lock). Focused: 45 pass / 16 skip / 0 fail — all 16 skips are native-wasm parity cases (no native binding built yet). Full suite: 459 pass / 17 skip / 0 fail / 1570 assertions across 45 files [9.34s]. No baseline failures to carry.

### Task 2 — Add Java parser, graph, and parity fixtures

Files: tests/java-indexer.test.ts (new); tests/java-resolver.test.ts (new); tests/java-edge-accuracy.test.ts (new); tests/fixtures/java-edges/**; tests/fixtures/parity/java/**; tests/native-wasm-parity.test.ts; tests/parsed-documents-cache.test.ts.
Interfaces: fixtures define the behavior consumed by Tasks 3 and 4. Each java-edges fixture directory holds sources, expected-edges.json, and baseline.json in the shape used by tests/fixtures/go-edges.
Change: cover packages/nested types, single-type/static imports, external-name ownership, same-package types and single-import-over-same-package precedence, wildcard-only names, package-qualified receivers, bare/this and imported-type calls, nested-to-outer calls (no edge), static import blocked by an enclosing declaration, anonymous-class bare calls (not emitted), overloaded/unknown-receiver negatives, comments/strings, CRLF, cache refresh, and more than 30 symbols/20 calls. Add the java parity fixtures (and their #crlf cases) to REQUIRED_FIXTURES.
Verify: bun test tests/java-indexer.test.ts tests/java-resolver.test.ts tests/java-edge-accuracy.test.ts tests/native-wasm-parity.test.ts tests/parsed-documents-cache.test.ts. Before parser work, Java cases fail because .java is not indexed; existing-language cases remain unchanged.
Progress: done
Result: Fixtures and suites added before implementation: tests/java-indexer.test.ts (15 cases — symbols/imports/calls/CRLF/fallback), tests/java-resolver.test.ts (23 cases — bare/this/static/qualified resolution matrix), tests/java-edge-accuracy.test.ts + tests/fixtures/java-edges/{types,imports,packages,anonymous,resolution,abovecap} (6 fixtures, calls+imports edge scoring), tests/fixtures/parity/java/{example,calls}.java. Java parity fixtures registered in tests/native-wasm-parity.test.ts REQUIRED_FIXTURES.

### Task 3 — Wire Java grammar and extraction

Files: packages/indexer/src/languages.ts; packages/indexer/src/tree-sitter/configs.ts; packages/indexer/src/tree-sitter/parse.ts; packages/indexer/src/tree-sitter/loader.ts; packages/indexer/src/parsers/tree-sitter-parser.ts; packages/indexer/src/index-workspace.ts; packages/indexer/package.json; apps/cli/package.json; apps/cli/tsup.config.ts; pnpm-lock.yaml; packages/native/Cargo.toml; packages/native/Cargo.lock; packages/native/src/parser.rs; Java parser and parity fixtures.
Interfaces: consumes the current parse result contract; produces the design's symbol contract (package symbol, `Owner::member` names, raw imports, qualified calls) through native and WASM.
Change: register .java/java in codeExtensions; add compatible pinned grammars (npm package for WASM, Rust crate for native) and record the ABI check; add java to TS_LANGS and NATIVE_LANGS; add the AST rules for packages, types, fields, methods, constructors, imports, and invocations, skipping bare/this calls inside anonymous class bodies. TreeSitterParser currently falls back to `REGEX_FALLBACKS[language]`, which does not exist for java: when the WASM parse returns null, return generic fallback chunks with no symbols or calls instead of throwing. Add the dependency to apps/cli and its tsup externals. Advance parser tags (and their literal types) from Task 1.
Verify: bun test tests/java-indexer.test.ts tests/native-wasm-parity.test.ts. Expected: exact Java parity including CRLF; a test with the grammar made unavailable yields chunks, no symbols, no throw; existing language results are unchanged. Record the pinned versions and the install-size delta (npm pack unpacked size) in Result.
Progress: done
Result: `.java`→`java` in codeExtensions; tree-sitter-java@0.23.5 (npm) + tree-sitter-java 0.23.5 (cargo) added to indexer/CLI deps + tsup externals + Cargo.lock. WASM javaConfig (package/class/interface/enum/record/enum-constant/method/ctor/compact-ctor/field symbols, `Owner::member` + `<anonymous>` context, raw import specifiers, method_invocation receiver preservation, anonymous+enum-constant-body bare/this suppression). Rust java_config mirrors it via new LanguageConfig.call_extract; extractNames parent-qualified (Go unaffected — topLevelOnly). Java has no regex parser: TreeSitterParser falls back to makeFallbackChunks. Parity: 30/30 incl. java LF+CRLF identical, zero pinned diffs.

### Task 4 — Resolve Java imports and calls without name guessing

Files: packages/indexer/src/java-resolver.ts (new); packages/indexer/src/index-workspace.ts; tests/java-resolver.test.ts; tests/java-edge-accuracy.test.ts; tests/fixtures/java-edges/\*\*.
Interfaces: consumes parsed Java symbols/imports/calls; emits existing imports/calls edges.
Change: build the package/type/method index once per graph build; apply the type lookup order, innermost-type bare/this calls, single static import, and package-qualified receivers from the design. Route Java imports through the resolver in resolveModuleSpecifier and keep the generic resolveImport returning null for java. Drop non-unique/external/wildcard/inherited/unknown-receiver targets. Extend the uncapped decision and both native slice(0, 20) sites for Java only. Note that symbol nodes are looked up by (file, label); the edge-accuracy fixtures must assert the edge lands on the expected file and label.
Verify: bun test tests/java-resolver.test.ts tests/java-edge-accuracy.test.ts tests/java-indexer.test.ts. Every positive reaches one exact target; every negative has no edge; false positives are 0; the above-cap fixture retains all Java entries; Python, Go, Ruby, and Rust caps are unchanged.
Progress: done
Result: packages/indexer/src/java-resolver.ts — static package/type/member index; resolveCall (bare/this innermost-type → member-block check → single static import; member-type → file type → single-type import → same-package; dotted = package-qualified only; unique methods only; ambiguity/external/overload → null) and resolveImport (explicit single/static imports → unique workspace type's file; wildcard/external → null). Wired: NATIVE_LANGS+TS_LANGS+"java", uncapped decision, both native slice(0,20) sites, resolveModuleSpecifier java branch, isJavaCaller dispatch. OXC_GRAPH_LANGUAGES untouched. Edge suite 7/7, FP=0 all fixtures, abovecap retains 25/25 call edges + 40 methods; resolver 23/23.

### Task 5 — Document and validate Java support

Files: AGENTS.md; apps/cli/README.md; tests/parsed-documents-cache.test.ts; tests/native-wasm-parity.test.ts; native CI verification.
Interfaces: documents extensions, fallback behavior, resolver limits, and reindex requirement.
Change: update support guidance (Indexing Expectations and the supported-languages row) and complete focused/full validation, including the built-CLI smoke test.
Verify: bun test tests/java-indexer.test.ts tests/java-resolver.test.ts tests/java-edge-accuracy.test.ts tests/native-wasm-parity.test.ts tests/parsed-documents-cache.test.ts; bun test; pnpm typecheck; pnpm --filter @openez-graph/native build; OPENEZ_NATIVE_EXPECT=1 bun test tests/java-indexer.test.ts tests/native-wasm-parity.test.ts; pnpm build:web && pnpm build:cli, then init and index a temporary Java workspace with bun apps/cli/dist/cli.cjs and confirm Java symbols are indexed; require the three-platform native CI matrix.
Progress: done
Result: Docs: AGENTS.md indexing-expectations bullet + apps/cli/README.md supported-language row and native-acceleration text updated for Java. Verification — focused Java+cache+parity suites: 75 pass/0 fail (java-indexer 15, java-resolver 23, edge-accuracy 7×7 incl. native/fallback edge-set identity, parity 30/30 incl. #crlf, cache 8/8: stale native-v4→native-v6 reparse, fallback-v6 reuse, oxc-v5 untouched). Full bun test: 524 pass / 1 skip / 0 fail / 1877 assertions (baseline 459). pnpm typecheck: 8/8. pnpm --filter @openez-graph/native build: release OK (tree-sitter-java 0.23.5 crate in Cargo.lock). OPENEZ_NATIVE_EXPECT=1 focused run: 75/75. pnpm build:web+build:cli: dist/cli.cjs 3.53 MB + index.darwin-arm64.node copied. CLI smoke: `init`+`reindex` on a temp Java workspace → parsed_documents row tagged native-v6 with symbols app/Outer/Outer::caller/Outer::helper/Outer::Inner/Outer::Inner::deep. Install-size evidence: npm pack tarball ships only dist/ (grammars are install-time deps); tree-sitter-java@0.23.5 unpacked = 6,152 KB (grammar .wasm 408 KB) vs siblings python 7,408/go 3,828/rust 14,772/ruby 30,192 KB; apps/cli/dist = 11,904 KB, unchanged by the external grammar. INCOMPLETE GATE: the three-platform native CI matrix (linux-x64, macOS-arm64, windows-x64) cannot be run locally — only darwin-arm64 built/verified here; CI must confirm the other two.

Review fixes (coordinator round 1): (1) java-resolver.ts singleTypeImports/staticImports now Map<string,Set<string>> — a conflicting import set (two distinct qualified owners of one simple/member name) resolves to null regardless of source order, while a single external import still reserves its name; resolveImport stays per-specifier. New tests/java-resolver.test.ts "conflicting imports" block (8 cases incl. both orders, dup-identical imports still resolving, external+workspace conflict, per-specifier import edges) and new tests/fixtures/java-edges/conflicts end-to-end fixture (conflicting single-type + static imports, reversed-order file, single-import control): 9 TP, 0 FN, 0 FP. (2) configs.ts javaExported + parser.rs java_node_exported now detect the actual `public` modifier token child instead of text-matching — `@Doc("public API")` no longer marks a declaration exported; contains_word helper removed. New parser test + parity example.java annotation coverage. Fresh verification: focused 93 pass / 0 fail (incl. OPENEZ_NATIVE_EXPECT=1 93/93), full bun test 534 pass / 1 skip / 0 fail, pnpm typecheck 8/8, native release rebuild OK, parity 30/30 incl. CRLF unchanged.

## Files inspected, no change

- packages/indexer/src/scanner.ts — builds its file list from codeExtensions (the native scanner matches extensions case-sensitively), so registering .java is enough.
- packages/indexer/src/parsers/parser-registry.ts — remains the dispatch entry point.
- packages/indexer/src/parsers/types.ts — ParsedDocument shape stays unchanged.
- packages/native/index.d.ts — native batch API stays unchanged.

## Approval Gate

Status: approved

## Decision Log

- Grammars ship as npm packages, matching the existing four. tree-sitter-java is about 6 MB unpacked. Vendoring only the .wasm files is a follow-up if the recorded install-size delta (this plan plus the C# and C++ plans) is a problem.
- The resolver reads only existing ParsedDocument fields; package and owner facts travel as a package symbol and `Owner::member` names, following the Rust/Ruby/Go naming convention. Go's source re-read is not needed here because Java's package and imports sit in persisted fields.
- Fixtures follow the repository's edge-accuracy ratchet (expected-edges.json plus baseline.json) with a separate resolver unit test file.
- Known ceilings accepted: nested-to-outer calls and inherited members are unresolved; an inherited method shadowing a static import is undetected.
