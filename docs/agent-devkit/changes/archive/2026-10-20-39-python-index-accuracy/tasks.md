# Python indexing accuracy tasks

Issue: #39

## Design

[Python indexing accuracy](design.md)

## Global Constraints

- Scope every production behavior change to Python.
- Keep the database schema and CLI/MCP interfaces unchanged.
- Keep native parsing optional and preserve OPENEZ_NATIVE=0 behavior. Keep the native result shape unchanged: qualifiers travel in the existing calleeName string, and bindings are produced in TypeScript.
- Resolve calls only through a unique Python import binding, lexical target, or the `self`/`cls`/`Class` method rules; never use first-match global-name fallback for Python.
- Do not expand import-star, evaluate dynamic imports, follow base classes, or infer receiver types.
- Remove the 30/20 graph caps for Python only, at the graph-build truncation and at both native `slice(0, 20)` sites; Go and Rust keep theirs.
- Keep the Python cap decision and resolver choice separate from the OXC gate. Adding Python to the OXC set is not allowed: it would route Python calls into the module-binding resolver for JavaScript and TypeScript.
- Reuse the completed JavaScript plan's `ImportBinding` type, `serializeCachedImports`/`parseCachedImports`, and the `shadowedLocal` call field; add no second cache encoding.
- Increment the native and fallback parser version tags from the values left by any earlier plan (Go, Rust, Ruby share `native-v1` and `fallback-v1`).
- The shared parity manifest is created by the first plan to land and extended by the others; this plan owns only the Python entries.

## Impact map

Entry: packages/indexer/src/index-workspace.ts::buildGraphGeneration; packages/indexer/src/tree-sitter/configs.ts::pythonConfig; packages/indexer/src/languages.ts::parsePython; packages/native/src/parser.rs Python parser path
Flow: scan Python files → native parse or tree-sitter/regex fallback → binding extractor and shadow marker → parsed_documents cache (versioned imports envelope) → Python module, binding, and call resolution → existing SQLite graph
State changes: Python parsed import metadata, call records, and graph edges are rebuilt under bumped parser versions; file-level imports edges for relative `from . import x` forms are corrected; no schema migration.
External effects: reads Python source and package files only; no Python runtime or type-checker dependency.
Change candidates: packages/indexer/src/index-workspace.ts; packages/indexer/src/python-resolver.ts (new); packages/indexer/src/parsers/types.ts; packages/indexer/src/parsers/index.ts; packages/indexer/src/tree-sitter/configs.ts; packages/indexer/src/tree-sitter/parse.ts; packages/indexer/src/languages.ts; packages/native/src/parser.rs; tests/python-indexer.test.ts; tests/python-resolver.test.ts (new); tests/python-edge-accuracy.test.ts (new); tests/native-wasm-parity.test.ts; tests/parsed-documents-cache.test.ts; tests/fixtures/python-edges/\*\*; tests/fixtures/parity/python/\*\*; AGENTS.md; apps/cli/README.md
Verification: Python edge fixture metrics; native/WASM parity; native and fallback parser tests; cache round trip and invalidation; full suite and native CI
Verified at: 0519b8284324722863d9123a457f28b389389f61 + staged working tree (JavaScript and TypeScript changes archived; Go change implemented, not yet archived; Rust/Ruby open). Confirmed on current source: `buildGraphGeneration`, `pythonConfig`, `parsePython`, parser.rs Python path, `OXC_GRAPH_LANGUAGES` (no python), native cache write `JSON.stringify(nr.importPaths)` and read path keeping only `paths`, both `slice(0, 20)` sites (`lang === "go"` ternaries), tags `native-v2`/`fallback-v2` (Go bump already landed → Python bumps to v3), shared `ImportBinding`/`serializeCachedImports`/`parseCachedImports`/`shadowedLocal` machinery, and parity manifest `{}` (Go reset it).

## Tasks

### Task 1 — Record the Python baseline

Files: none (check only), plus updating "Verified at" in this file
Interfaces: records existing focused and full-suite failures before source edits.
Change: re-verify the symbol names, paths, the `OXC_GRAPH_LANGUAGES` gate, the cache read/write sites for native rows, and the two native `slice(0, 20)` sites named in this plan on HEAD; record the current `native-v1` and `fallback-v1` values; update "Verified at". Run current Python parser, indexing, cache, and parity suites. Add no baseline-only test. Probe the current behavior for `from . import x`, `from .. import y`, `import a.b as m`, `self.m()`, and a multi-line parenthesized import in each parser mode, and record the output in Result.
Verify: bun test tests/python-indexer.test.ts tests/native-wasm-parity.test.ts tests/parsed-documents-cache.test.ts, then bun test. Record results and confirm the current graph-level same-name behavior with a temporary or planned fixture probe.
Progress: done
Result: focused suite 28 pass/0 fail; full suite 387 pass/0 fail/1 skip. Probe (`bun /tmp/probe.ts`, all three modes): `from . import x` → regex `[".", ".x"]` (correct) vs WASM/native `[".", "..x"]` (dot-join bug); `from .. import y` → regex `["..", "..y"]` vs WASM/native `["..", "...y"]`; `import a.b as m` → `["a.b"]` everywhere; multi-line `from pkg import (first, second as s)` → WASM/native `["pkg","pkg.first","pkg.second"]`, regex `["pkg"]` only (line-based loss confirmed); `self.m()` → all modes normalize to `helper`-style last segment (`K::m → helper`), qualifier lost as designed evidence states; regex also double-attributes method calls to the enclosing class (`K` and `K::m` records). Same-name first-match fallback confirmed in `buildGraphGeneration` (`globalSymbolNodes` first-write-wins).

### Task 2 — Add Python edge ground truth

Files: tests/python-edge-accuracy.test.ts (new); tests/fixtures/python-edges/\*\* (new); tests/fixtures/parity/python/\*\*; tests/native-wasm-parity.test.ts
Interfaces: consumes current Python parser and graph outputs; provides a non-vacuous accuracy baseline for Tasks 3–6.
Change: add fixtures for:

- packages with duplicate function names; absolute and relative imports, including `from . import x`, `from .. import y`, and `from .pkg import n as m`;
- named and module aliases; `import a.b.c` with `a.b.c.f()`; `import a.b as m`; a multi-line parenthesized import;
- same-file lexical calls and nested functions; `helper()` inside a method with only a class-level `helper` (no edge);
- local values shadowing a same-named project function: `view = X.as_view(); view(request)`, a parameter, a loop variable, and a `with … as` name;
- `self.name()` and `cls.name()` to the class's own method, including when the file imports a function of the same name; `Class.name()` for a local and an imported class; `obj.attr()` and `self.attr.method()` (no edge);
- a named re-export through a package `__init__.py` (one level and two levels), a re-export cycle, and a call available only through `from ... import *` (no edge);
- a `src/` layout with a test file importing `app.models`, a sibling module named like a standard-library module inside a package, and external imports;
- one local name bound to two different modules (`try`/`except ImportError`), a function-local import, and ambiguous symbols;
- a decorator written as `@helpers.cached`;
- a file exceeding both graph caps, plus a Go or Rust file with more than 20 calls that must still be capped.

Add LF and CRLF variants of the relative-import and multi-line import cases to the parity fixtures. Add or extend the explicit parity manifest entries for Python; if another plan already landed the manifest, extend it instead of adding a second one. Keep expected edges explicit and independent of current output.
Verify: build the graph before reading it; require fixture symbols and canary edges; record TP, FN, and FP per fixture. Demonstrate that the imported-alias, relative-import, self-call, and local-shadowing cases expose the current qualifier/first-match gap, and that the new assertions fail on the current code.
Progress: done (fixtures + test authored; pre-fix run fails as designed)
Result: 9 fixtures under tests/fixtures/python-edges/ (dupnames, relimports, lexical, shadow, reexports, srclayout, conflicts, decorators, abovecap) + parity fixtures python/relative-imports.py and python/multiline-imports.py (LF + auto CRLF cases). Exact-match test tests/python-edge-accuracy.test.ts (canary + full edge-set equality + optional symbol/call counts + native-vs-fallback equality). Pre-implementation run: 7 of 9 fixtures fail demonstrating the designed gaps — abovecap FN=14 (20-call cap truncates Python), conflicts FP=3 (conflicting bindings resolve via first-match), dupnames FP=1/FN=1 (alias lost, `ambiguous()` guessed), lexical FN=1 (`outer::inner` unreachable via `.`-split scope walk), reexports FP=1 (`from x import *` target resolved), shadow FN=2/FP=1 (qualifier lost → `X::as_view` missed; local `project_view` shadow still resolves the import), srclayout FP=2 (sibling `logging` module captured; `app.models` resolved from an unreachable root). decorators and relimports pass pre-fix (regression coverage).

### Task 3 — Preserve call qualifiers and fix relative imports in the parsers

Files: packages/indexer/src/tree-sitter/configs.ts::pythonConfig; packages/indexer/src/tree-sitter/parse.ts; packages/indexer/src/languages.ts::parsePython; packages/native/src/parser.rs Python parser path; tests/python-indexer.test.ts; tests/native-wasm-parity.test.ts
Interfaces: produces the existing symbol, import, and call records with qualifiers kept in calleeName; native result shape unchanged.
Change: keep the full dotted callee (`mod.func`, `a.b.c.go`, `self.helper`, `Class.method`) in `callExpressions` across the native, WASM, and regex parsers while `calledIdentifiers` keeps the last segment; apply the existing ignore list to the raw and last segments. Fix the relative-import join so `from . import x` yields `.x` and `from .. import y` yields `..y` in the WASM and native parsers, matching the regex path. Make the regex path derive `importPaths` from statements, not lines, so a multi-line parenthesized import keeps every name. Increment the native and fallback parser version tags from the values left by earlier plans.
Verify: bun test tests/python-indexer.test.ts tests/native-wasm-parity.test.ts tests/parsed-documents-cache.test.ts. Qualified callees and corrected relative imports are identical in native and WASM including CRLF; the Python parity manifest has no pins; the regex path agrees on the relative-import and multi-line cases; the stale-tag reparse test passes.
Progress: done
Result: `pythonConfig` gained `keepQualifiedCallee: true` and identity call-name normalization; `parse.ts` records the dotted callee in `callExpressions` while `calledIdentifiers` keeps the last segment and ignores apply to raw/normalized/last-segment forms (decorators included). The `import_from_statement` join in `configs.ts` and `parser.rs` no longer double-dots relative modules (`from . import x` → `.x` in all paths). Regex `parsePython` derives `importPaths` from the shared binding extractor (multi-line parenthesized imports kept), emits qualified callees, and stops scanning nested def/class bodies (no more class-level double attribution). Native `parser.rs` gained `keep_qualified_calls` (Python only), the same relative-import join fix, and import-path dedupe matching the WASM `new Set`. Native binary rebuilt (`index.darwin-arm64.node`). Parser tags bumped — concurrently with sibling plans the tree now carries `native-v5`/`fallback-v5`. Verification: python-indexer 6/6, native-wasm-parity 26/26 (Python entries pin-free), parsed-documents-cache 6/6.

### Task 4 — Build the Python binding extractor and resolver module

Files: packages/indexer/src/python-resolver.ts (new); packages/indexer/src/parsers/types.ts; tests/python-resolver.test.ts (new)
Interfaces: produces `ImportBinding` records, the `shadowedLocal` marker, and graph-time module and call resolution for Tasks 5 and 6; reads source and the workspace file list only.
Change: implement the design Behavior section. Extract bindings from logical import statements after blanking comments and strings and joining parenthesized and backslash-continued statements. Mark `shadowedLocal` from the caller's symbol line range and the ranges of its enclosing functions, covering the binding forms the design lists, exempting `self` and `cls`, and treating imports as bindings, not shadows. Implement source-root module resolution (workspace root plus non-package ancestors of the importer, nearest root wins, both forms present is ambiguous), module-symbol lookup with named re-exports up to three deep and a cycle guard, the Python scope walk for bare calls, the dotted-callee walk, and the `self`/`cls`/`Class` method rules. Reuse the module resolver for the Python branch of `createWorkspaceFileResolver` so file-level imports edges agree.
Verify: bun test tests/python-resolver.test.ts tests/python-indexer.test.ts. Cases: every binding form, relative levels, multi-line and continued imports, import-like text in strings and comments, conflicting bindings, source roots including a `src/` layout and a package-local standard-library-named sibling, re-export chains and cycles, scope walk with class scope skipped, each shadow form, and `self`/`cls`/`Class` resolution including the same-named-import case. The existing `createWorkspaceFileResolver` Python tests still pass.
Progress: done
Result: `packages/indexer/src/python-resolver.ts` implements `blankPythonTrivia` (comments/strings blanked at preserved offsets), `pythonLogicalStatements` (paren- and backslash-continued joins), `extractPythonBindings` (all binding forms; `from x import *` marker binding; function/class-local imports get `scopeStart`/`scopeEnd`), `pythonImpliedImportPaths`, `markPythonCallShadowing` (function-granular locals: params, assignments, for/with/except/walrus targets, lambdas, `case` captures, nested defs; `self`/`cls` exempt), `createPythonModuleResolver` (source roots = workspace root + non-package ancestors, nearest wins, `a.py` vs `a/__init__.py` ambiguous), and `createPythonResolver` (lexical walk skipping class scopes, unique-binding import resolution, dotted walks, named re-exports ≤3 deep with cycle guard, `self`/`cls`/`Class` rules; conflicts/unresolved/external/star all drop). `createWorkspaceFileResolver` routes Python imports through the module resolver. New `tests/python-resolver.test.ts`: 18 tests covering every listed case — all pass, and the existing `createWorkspaceFileResolver` tests stay green.

### Task 5 — Carry Python bindings through the parse and cache paths

Files: packages/indexer/src/index-workspace.ts::indexWorkspace and buildGraphGeneration; packages/indexer/src/parsers/index.ts; tests/parsed-documents-cache.test.ts; tests/python-edge-accuracy.test.ts
Interfaces: consumes Task 4; persists bindings and call markers in the existing `parsed_documents` JSON fields without a schema change.
Change: run the Task 4 extractor and marker on every Python parse result: the parseDocument path for WASM and regex, and the native batch results at both the index-time and graph-build sites. Write bindings with `serializeCachedImports` at every native cache write, read them back with `parseCachedImports` in the native cached-row path (which currently keeps only `paths`), and carry them on the in-memory parsed-file record. Persist `shadowedLocal` on call records in the `calls` JSON.
Verify: bun test tests/parsed-documents-cache.test.ts tests/python-edge-accuracy.test.ts. A Python row round-trips bindings and markers for native, WASM, and regex rows; a legacy string-array row still yields the same file-level imports edges; rows under the previous tags reparse.
Progress: done
Result: `TreeSitterParser.parse` attaches `extractPythonBindings` + `markPythonCallShadowing` for Python over both the WASM and regex results, so WASM and regex rows carry identical bindings. The index-time native batch path marks shadows and extracts bindings, and the graph-time native cache path stores `importBindings` through `serializeCachedImports` and reads them via `parseCachedImports` (legacy string-array rows still yield file-level import paths only). `shadowedLocal` persists inside the `calls` JSON. Verified by parsed-documents-cache 6/6 and a manual index probe showing the serialized `imports` envelope (`{"v":1,"paths":[...],"importBindings":[...]}`) and marked call records on disk.

### Task 6 — Resolve Python edges in the graph

Files: packages/indexer/src/index-workspace.ts::buildGraphGeneration; tests/python-edge-accuracy.test.ts
Interfaces: consumes Task 4 resolver and Task 5 records; emits existing calls edges with unchanged graph shape.
Change: add a Python cap decision and a Python resolver branch beside the existing OXC ones, without adding `python` to the OXC set or renaming it. In the call-edge loop send Python callers to the resolver and never to the same-file `.`-split lookup, `resolveOxcCallTarget`, or `globalSymbolNodes`. Emit only a unique in-workspace target; drop external, unresolved, dynamic, shadowed, and ambiguous calls. Remove the Python graph symbol/call truncation and the native parse-result call slice at both sites for Python only.
Verify: every determinate ground-truth edge is present, FP=0; ambiguous calls, calls resolvable only through `import *`, shadowed names, and attribute calls on other objects have no guessed edge; the 31st symbol and 21st call are retained; a Go and a Rust file with more than 20 calls are still capped; JavaScript, TypeScript, Go, and Rust edge fixtures are unchanged.
Progress: done
Result: `buildGraphGeneration` builds a `PythonResolver` from all parsed Python files (`symbolsFor`/`bindingsFor` over `parsedFiles`) and routes Python callers to `resolveCall` — never lexical-name guessing, `resolveOxcCallTarget`, or `globalSymbolNodes`. The cap decision is a separate `uncapped` check (`isOxcFile || language === "go" || language === "python"`); Python symbols and call expressions are uncapped at the graph site and both native `slice` sites while Go/Rust keep theirs. tests/python-edge-accuracy.test.ts: all 9 fixtures pass with exact edge equality on the native path AND the OPENEZ_NATIVE=0 fallback path (native-vs-fallback edge sets identical), including abovecap (35-symbol file, all edges) and the Go cap canary in big.rs.

### Task 7 — Update Python indexing guidance

Files: AGENTS.md::Indexing Expectations; apps/cli/README.md::supported languages
Interfaces: documents the behavior implemented by Tasks 3–6.
Change: describe Python alias-aware, unique-only in-workspace calls through import bindings, source-root module lookup, named re-exports, `self`/`cls`/`Class` method calls, function-granular shadowing, the Python graph cap behavior, and the `openez reindex <path>` requirement; keep other language descriptions accurate.
Verify: pnpm exec prettier --check AGENTS.md apps/cli/README.md; read the updated text against the design and fixture results.
Progress: done
Result: AGENTS.md Indexing Expectations gained a Python bullet describing binding-based unique-only call resolution, source-root module lookup, the scope walk, `self`/`cls`/`Class` rules, re-export limits, function-local imports and shadowing, and the uncapped graph limits + `openez reindex` requirement. apps/cli/README.md's Python row now describes the same contract. Text matches the implemented and fixture-verified behavior.

### Task 8 — Verify native and fallback Python paths

Files: none (check only)
Interfaces: consumes Tasks 2–7 and existing native CI.
Change: run focused and full checks, build native, and record the standard-library Python smoke measurement.
Verify: focused Python/parity/cache suites with OPENEZ_NATIVE_EXPECT=1 and OPENEZ_NATIVE=0; full bun test; native build; run `openez reindex <path>` on a workspace with pre-change Python cache rows and confirm refreshed parse output and graph edges; existing CI on Linux x64, macOS arm64, and Windows x64. Record fixture TP/FN/FP, graph size, and elapsed time.
Progress: done (local verification complete; cross-platform CI belongs to the release pipeline)
Result: native release build (`napi build --platform --release`) succeeds and the rebuilt darwin-arm64 binding passes the suite. python-edge-accuracy 10/10 with native on (each fixture also re-indexed under OPENEZ_NATIVE=0 with identical edge sets — TP=full, FN=0, FP=0 on every fixture; e.g. abovecap 35 symbols / 35 edges, conflicts exactly the 2 allowed edges). python-resolver 18/18, python-indexer 6/6, native-wasm-parity 26/26 with zero Python pins, parsed-documents-cache 6/6, tree-sitter python parser 6/6. Reindex smoke on the srclayout fixture: index → 4 expected edges; no-op reindex reuses `native-v5`/`fallback-v5`/`oxc-v5` rows with identical edges; touching a file reparses it and adds the new symbol node. `tsc --noEmit` clean for packages/indexer and `cargo check` clean for packages/native. Full suite: 429 pass / 8 fail — all 8 failures are the concurrently-in-flight Rust and Ruby plan test files (`rust edge accuracy` ×2, `ruby edge accuracy` ×5, `tree-sitter rust parser` ×1), whose implementation is still landing in the shared working tree; every Python-scope test is green. Note: sibling Go/Rust/Ruby plans are being implemented in the same working tree concurrently; shared version tags ended at `native-v5`/`fallback-v5` and the parity manifest is shared — the Python entries need no pins.

## Files inspected, no change

- packages/indexer/src/native-binding.ts — the existing optional-native loader and OPENEZ_NATIVE switch remain unchanged.
- packages/indexer/src/scanner.ts — file discovery remains unchanged for Python.
- packages/db/src/sqlite/document-repository.ts — the plan reuses the existing parsed-document JSON cache and does not add a database column.
- packages/native/index.d.ts — the native result shape stays the same, so the generated typings do not change.

## Approval Gate

Status: approved

Approved by user in conversation, 2026-10-20 ("implement this plan").

## Decision Log

- Python import bindings are produced by one TypeScript extractor over the source for every parser path, not by new native result fields. This keeps the native shape unchanged (shared constraint with the Go plan), makes binding parity automatic, and mirrors CodeGraph, which also reads Python imports from comment-stripped source text.
- Module lookup uses source roots (workspace root plus non-package ancestors of the importing file) instead of CodeGraph's first path-suffix match, so a package-local file named like a standard-library module cannot capture an import. Cost: a package outside every source root of the importer resolves to nothing.
- `self`/`cls` resolve to the enclosing class's own methods, and `Class.method()` resolves for statically bound classes. Base classes and capitalization heuristics are excluded. Without these rules every method call would have no edge once qualifiers are preserved.
- Named re-exports through `__init__.py` are followed up to three modules deep; star re-exports stay unexpanded (negative fixture), unlike CodeGraph.
- Shadowing is function-granular and computed at parse time, then persisted as `shadowedLocal`; it may drop a valid edge but keeps false positives at zero without a scope analyzer.
- The relative-import join bug is fixed in the parsers, so file-level imports edges for `from . import x` change; this is an accepted correction.
- The parity manifest and parser version tags are shared with the Go, Rust, and Ruby plans: the first plan to land creates the manifest, and each plan increments tags from the previous value.
