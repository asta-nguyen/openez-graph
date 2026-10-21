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
Verified at: 0519b8284324722863d9123a457f28b389389f61 (HEAD; working tree also contains uncommitted issue #39 changes, line numbers above are from that working tree on 2026-10-20 and must be re-traced before implementation).

## Tasks

### Task 1 — Record the implementation baseline

Files: none (check only), plus updating Verified at and the line numbers in this file.
Interfaces: records existing parser, version, cap, and test behavior before edits.
Change: re-trace the working tree for Java extension detection (confirm .java is not scanned), parser dispatch, the TS_LANGS/NATIVE_LANGS sets, native grammar dispatch, the cache tags (currently native-v5/fallback-v5) and their literal types, all graph-cap sites, the import-edge loop, and the REQUIRED_FIXTURES manifest in the parity test. Run existing indexer/parity/cache and full-suite checks; record failures in Result.
Verify: bun test tests/index-workspace.test.ts tests/native-wasm-parity.test.ts tests/parsed-documents-cache.test.ts, then bun test. Expected: baseline failures, if any, are recorded without assigning them to Java.
Progress: todo
Result: none

### Task 2 — Add Java parser, graph, and parity fixtures

Files: tests/java-indexer.test.ts (new); tests/java-resolver.test.ts (new); tests/java-edge-accuracy.test.ts (new); tests/fixtures/java-edges/**; tests/fixtures/parity/java/**; tests/native-wasm-parity.test.ts; tests/parsed-documents-cache.test.ts.
Interfaces: fixtures define the behavior consumed by Tasks 3 and 4. Each java-edges fixture directory holds sources, expected-edges.json, and baseline.json in the shape used by tests/fixtures/go-edges.
Change: cover packages/nested types, single-type/static imports, external-name ownership, same-package types and single-import-over-same-package precedence, wildcard-only names, package-qualified receivers, bare/this and imported-type calls, nested-to-outer calls (no edge), static import blocked by an enclosing declaration, anonymous-class bare calls (not emitted), overloaded/unknown-receiver negatives, comments/strings, CRLF, cache refresh, and more than 30 symbols/20 calls. Add the java parity fixtures (and their #crlf cases) to REQUIRED_FIXTURES.
Verify: bun test tests/java-indexer.test.ts tests/java-resolver.test.ts tests/java-edge-accuracy.test.ts tests/native-wasm-parity.test.ts tests/parsed-documents-cache.test.ts. Before parser work, Java cases fail because .java is not indexed; existing-language cases remain unchanged.
Progress: todo
Result: none

### Task 3 — Wire Java grammar and extraction

Files: packages/indexer/src/languages.ts; packages/indexer/src/tree-sitter/configs.ts; packages/indexer/src/tree-sitter/parse.ts; packages/indexer/src/tree-sitter/loader.ts; packages/indexer/src/parsers/tree-sitter-parser.ts; packages/indexer/src/index-workspace.ts; packages/indexer/package.json; apps/cli/package.json; apps/cli/tsup.config.ts; pnpm-lock.yaml; packages/native/Cargo.toml; packages/native/Cargo.lock; packages/native/src/parser.rs; Java parser and parity fixtures.
Interfaces: consumes the current parse result contract; produces the design's symbol contract (package symbol, `Owner::member` names, raw imports, qualified calls) through native and WASM.
Change: register .java/java in codeExtensions; add compatible pinned grammars (npm package for WASM, Rust crate for native) and record the ABI check; add java to TS_LANGS and NATIVE_LANGS; add the AST rules for packages, types, fields, methods, constructors, imports, and invocations, skipping bare/this calls inside anonymous class bodies. TreeSitterParser currently falls back to `REGEX_FALLBACKS[language]`, which does not exist for java: when the WASM parse returns null, return generic fallback chunks with no symbols or calls instead of throwing. Add the dependency to apps/cli and its tsup externals. Advance parser tags (and their literal types) from Task 1.
Verify: bun test tests/java-indexer.test.ts tests/native-wasm-parity.test.ts. Expected: exact Java parity including CRLF; a test with the grammar made unavailable yields chunks, no symbols, no throw; existing language results are unchanged. Record the pinned versions and the install-size delta (npm pack unpacked size) in Result.
Progress: todo
Result: none

### Task 4 — Resolve Java imports and calls without name guessing

Files: packages/indexer/src/java-resolver.ts (new); packages/indexer/src/index-workspace.ts; tests/java-resolver.test.ts; tests/java-edge-accuracy.test.ts; tests/fixtures/java-edges/\*\*.
Interfaces: consumes parsed Java symbols/imports/calls; emits existing imports/calls edges.
Change: build the package/type/method index once per graph build; apply the type lookup order, innermost-type bare/this calls, single static import, and package-qualified receivers from the design. Route Java imports through the resolver in resolveModuleSpecifier and keep the generic resolveImport returning null for java. Drop non-unique/external/wildcard/inherited/unknown-receiver targets. Extend the uncapped decision and both native slice(0, 20) sites for Java only. Note that symbol nodes are looked up by (file, label); the edge-accuracy fixtures must assert the edge lands on the expected file and label.
Verify: bun test tests/java-resolver.test.ts tests/java-edge-accuracy.test.ts tests/java-indexer.test.ts. Every positive reaches one exact target; every negative has no edge; false positives are 0; the above-cap fixture retains all Java entries; Python, Go, Ruby, and Rust caps are unchanged.
Progress: todo
Result: none

### Task 5 — Document and validate Java support

Files: AGENTS.md; apps/cli/README.md; tests/parsed-documents-cache.test.ts; tests/native-wasm-parity.test.ts; native CI verification.
Interfaces: documents extensions, fallback behavior, resolver limits, and reindex requirement.
Change: update support guidance (Indexing Expectations and the supported-languages row) and complete focused/full validation, including the built-CLI smoke test.
Verify: bun test tests/java-indexer.test.ts tests/java-resolver.test.ts tests/java-edge-accuracy.test.ts tests/native-wasm-parity.test.ts tests/parsed-documents-cache.test.ts; bun test; pnpm typecheck; pnpm --filter @openez-graph/native build; OPENEZ_NATIVE_EXPECT=1 bun test tests/java-indexer.test.ts tests/native-wasm-parity.test.ts; pnpm build:web && pnpm build:cli, then init and index a temporary Java workspace with bun apps/cli/dist/cli.cjs and confirm Java symbols are indexed; require the three-platform native CI matrix.
Progress: todo
Result: none

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
