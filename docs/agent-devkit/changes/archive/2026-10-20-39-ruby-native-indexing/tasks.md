# Ruby native indexing and parity tasks

Issue: #39

## Design

[Ruby native indexing and parity](design.md)

## Global Constraints

- Scope production parser changes to Ruby. Generalizing the native walker must leave Python, Go, and Rust output byte-identical.
- Keep native optional and preserve the current WASM/regex fallback; run a full `openez reindex <path>` to rebuild cached Ruby parse rows and graph artifacts after parser-version changes. A no-op incremental index does not prove refresh.
- Add no Ruby runtime requirement and no schema/API changes; keep the native result shape unchanged.
- Match native output to WASM Ruby behavior on maintained fixtures before changing any call-name behavior (Tasks 3–4), then keep the two in parity after the change (Task 5).
- Pin the Rust `tree-sitter-ruby` crate to the same upstream version as the npm grammar the WASM path loads.
- Resolve only unique labels and `require_relative` literal paths probed as `.rb`; do not guess dynamic calls, walk ancestors, or infer receiver types.
- Remove graph caps for Ruby only, at the graph-build truncation and at both native `slice(0, 20)` sites.
- Follow the per-language pattern the Go work landed: a Ruby cap condition and a Ruby resolver branch beside the existing ones. Adding Ruby to the OXC set is not allowed.
- Increment the native and fallback parser version tags from the values left by any earlier plan (Python and Rust share `native-v1` and `fallback-v1`).
- The shared parity manifest is created by the first plan to land and extended by the others; this plan owns only the Ruby entries.

## Impact map

Entry: packages/indexer/src/index-workspace.ts native batch routing (`TS_LANGS` in parseInline, `NATIVE_LANGS` in buildGraphGeneration) and buildGraphGeneration; packages/native/src/parser.rs; packages/native/Cargo.toml
Flow: scan Ruby files → native Ruby parse when available, otherwise existing tree-sitter/regex fallback → parsed_documents cache → Ruby scope and constant resolution → Ruby graph artifacts
State changes: native Ruby parse metadata, Ruby call records, and Ruby graph edges are rebuilt under bumped parser versions; no schema migration. Shared native/fallback tags can also refresh unchanged Python, Go, or Rust cache rows.
External effects: adds a Rust tree-sitter Ruby grammar dependency (with a C++ scanner) and native build work; no Ruby executable or network access at runtime.
Change candidates: packages/indexer/src/index-workspace.ts; packages/indexer/src/ruby-resolver.ts (new); packages/native/Cargo.toml; packages/native/src/parser.rs; packages/indexer/src/native-binding.ts only if routing requires it; packages/indexer/src/tree-sitter/configs.ts; packages/indexer/src/languages.ts; tests/ruby-indexer.test.ts; tests/ruby-resolver.test.ts (new); tests/ruby-edge-accuracy.test.ts (new); tests/native-wasm-parity.test.ts; tests/parsed-documents-cache.test.ts; tests/fixtures/parity/ruby/\*\*; tests/fixtures/ruby-edges/\*\*; AGENTS.md; apps/cli/README.md
Verification: Ruby native/WASM parity before and after the call-name change; Ruby edge fixture; cache and fallback tests; native build and three-platform CI
Verified at: 2026-10-20, HEAD `0519b82` plus working tree (JavaScript and TypeScript plans landed and archived; Go plan implemented in the working tree, review-fixes stage; Python/Rust plans open). Re-verified on this tree: `TS_LANGS` = `{python, go, rust}` in `parseInline` (index-workspace.ts:410), `NATIVE_LANGS` = `{python, go, rust}` in `buildGraphGeneration` (index-workspace.ts:1125), native `slice(0, 20)` sites at lines 475 and 1290, graph caps at lines 1439 (30 symbols) and 1457 (20 calls); Go pattern = `go-resolver.ts` + `isGoCaller` branch at lines 1823–1836 ahead of the `.`-split lookup and OXC/global fallbacks; `createWorkspaceFileResolver` Ruby branch at line 233 probes all `RESOLVABLE_SOURCE_EXTENSIONS`; tags `native-v2`/`fallback-v2` (index-workspace.ts:49–50, bumped from v1 by the Go work — this plan increments to v3). `tree-sitter-ruby` crate pin: `0.23.1` (matches npm `^0.23.1`), verified resolving and building (C parser + C++ scanner) against `tree-sitter` 0.25.10 in a scratch crate.

## Tasks

### Task 1 — Record the Ruby baseline

Files: none (check only), plus updating "Verified at" in this file
Interfaces: records current Ruby parser, graph, cache, and full-suite results before source edits.
Change: re-verify the symbol names, paths, the Go-landed cap and resolver pattern, `TS_LANGS`, `NATIVE_LANGS`, and the two native `slice(0, 20)` sites on HEAD; record the current `native-v1` and `fallback-v1` values; update "Verified at". Confirm that a `tree-sitter-ruby` crate with the same upstream version as the npm `^0.23.1` grammar resolves and builds against the repo's `tree-sitter` crate version, and record the exact version to pin. Run current Ruby, parity, cache, and full suites. Add no baseline-only test. Probe the current WASM output for `self.tax`, `Invoice.build`, `Billing::Invoice.build`, `other.tax`, `helper_fn(1)`, `class << self`, and a `require_relative` beside both `.md` and `.rb` files, and record it in Result.
Verify: bun test tests/ruby-indexer.test.ts tests/native-wasm-parity.test.ts tests/parsed-documents-cache.test.ts, then bun test. Record the current Ruby native-unavailable path and graph fixture metrics.
Progress: done
Result: bun test focused suites — 26 pass, 0 fail; full bun test — 389 pass, 1 skip, 0 fail. Re-verified names/paths on HEAD `0519b82` + working tree (see "Verified at" above). Crate pin confirmed: `tree-sitter-ruby = "0.23.1"` builds against `tree-sitter` 0.25.10 including its C++ scanner. WASM probe (current behavior): `self.tax` → `Billing::Invoice::tax` (qualified); `Invoice.build` → `build`, `Billing::Invoice.build` → `build`, `Helper.run` → `run`, `other.tax` → `tax`, `user&.name` → `name` (receivers stripped, recorded as calls); bare `inner_call` parses as identifier — no record; `helper_fn(1)` → `helper_fn`; `class << self` emits no symbol but `def audit` inside labels `Billing::Invoice::audit`; `require_relative` beside `.md` and `.rb` extracts both strings literally; `Kernel.require`, `load`, `autoload` extract nothing. Current Ruby path: no native route — Ruby parses via WASM tree-sitter (`tree-sitter` parser name → `fallback-v2` parsed_documents rows); graph caps 30 symbols / 20 calls apply; call resolution falls through to `.`-split same-file lookup + `globalSymbolNodes`. Metrics on a 2-file Ruby sample (module+class, `self.tax`, `Invoice.build`, `helper_fn`): index 55ms, graph-build 5ms, 9 nodes (2 file + 7 symbol), 8 edges (7 defines + 1 calls — only `Billing::Invoice::total → helper_fn` via global match; `build`/`run`/`tax` produce no edge).

### Task 2 — Add Ruby parity and edge fixtures

Files: tests/native-wasm-parity.test.ts; tests/ruby-edge-accuracy.test.ts (new); tests/fixtures/parity/ruby/\*\* (new); tests/fixtures/ruby-edges/\*\* (new)
Interfaces: compares native and WASM Ruby outputs and provides graph-level ground truth for Tasks 3–6.
Change: require parity fixtures for class and module nesting and reopening, instance and singleton methods, `class << self`, `self.foo`, constant receivers (`Const.foo`, `A::B.foo`) and `&.`, `require_relative` and the other require forms (`require`, `load`, `Kernel.require`, interpolated path, non-literal), class-body DSL calls, lambda and proc assignments, heredocs, `=begin`/`=end` comments, a `__END__` trailer, comments and strings, and a CRLF copy. Add graph fixtures for `self.foo`, constant receivers under nesting, bare calls to own and top-level methods, a shared instance/singleton label, a duplicate label across files, unknown receivers, dynamic calls, `require_relative` with `.md` beside `.rb`, and above-cap files, plus a Python file with more than 20 calls that must still be capped. Keep expected graph edges explicit and independent of current output. Add the Ruby manifest entries; if another plan already landed the manifest, extend it instead of adding a second one.
Verify: parity manifest fails when a required Ruby fixture is missing; edge harness builds a non-empty graph and records TP/FN/FP before implementation; the new edge assertions fail on the current code.
Progress: done
Result: `tests/native-wasm-parity.test.ts` extended (`ruby: rubyConfig` in `LANG_CONFIG`; `ruby/example.rb` + `ruby/torture.rb` in `REQUIRED_FIXTURES`; CRLF cases auto-derived). Parity fixtures cover nesting/reopening, instance+singleton methods, `class << self`, `self.foo`, constant receivers and `&.`, all require forms (incl. `Kernel.require`, interpolated, non-literal), class-body DSL calls, lambda/proc assignments, heredocs, `=begin`/`=end`, `__END__` trailer, comments/strings. Removing `ruby/torture.rb` fails the manifest check as required. Six edge fixtures under `tests/fixtures/ruby-edges/` (scope, reopen, duplabel, imports, abovecap, negative) with hand-written expected edge sets; `tests/ruby-edge-accuracy.test.ts` asserts exact calls+imports sets with a baseline ratchet. Pre-implementation baselines recorded (OPENEZ_UPDATE_BASELINE=1): scope TP=4/FN=4, reopen FN=2, duplabel FN=1, imports calls FN=1 + imports TP=1/FN=1/FP=1 (`./util` captured by `util.md`), abovecap TP=20/FN=59 (Python edges capped at 20 resolve; all 59 uncapped-Ruby edges missing), negative FN=1. All six fixtures fail the exact assertions on current code. Note: pre-existing failure `python/relative-imports.py` in the parity suite belongs to the in-flight Python plan (untracked fixture, native side not yet landed) — not this change.

### Task 3 — Add Ruby to the native parser with no behavior change

Files: packages/native/Cargo.toml; packages/native/src/parser.rs; tests/native-wasm-parity.test.ts
Interfaces: adds Ruby to parseCodeBatch without changing the existing result record shape; does not yet change Ruby call names.
Change: add the pinned tree-sitter Ruby grammar. Extend the native walker additively so `SymbolRule` can be context-only and carry a context kind, the context-name callback receives the context stack, and `LanguageConfig` can carry a call-qualify hook. Port `rubyConfig` exactly as the WASM path behaves today: class, module, method, singleton method, context-only `singleton_class`, lambda and proc assignment symbols, exported flags, `require_relative` import extraction with the same string trimming, the call ignore list, the `[.:]` normalization, and `self.foo` qualification. Bump the native parser version tag.
Verify: build the native package; with OPENEZ_NATIVE_EXPECT=1, Ruby native/WASM fixture diffs are empty for symbols, exports, line ranges, imports, calls, and calledIdentifiers on the whole Task 2 parity set including the torture-style and CRLF fixtures; the existing Python, Go, and Rust parity results and pins are unchanged.
Progress: done
Result: `tree-sitter-ruby = "0.23.1"` added to `packages/native/Cargo.toml` (exact match for npm `^0.23.1`); `napi build --platform --release` clean. Native walker generalized additively: `SymbolRule` gained `context_only` + `context_kind`, `extract_context_name` now receives the context stack, the context stack is a `ContextFrame { name, end_row, kind, receiver }` (tuple → struct, Go receiver preserved), and `LanguageConfig` gained `per_symbol_calls` + `qualify_call`. `extract_calls_in_node` ports WASM's extractCallsInNode (nested-symbol-range skipping, ignores, hook-qualified callee) for configs that opt in — only Ruby sets `per_symbol_calls`; Python/Go/Rust keep DFS-frame attribution. `ruby_config()` ports `rubyConfig` exactly (context-only `singleton_class`, lambda/proc assignments, `require_relative` extraction with single-quote-edge trimming, full ignore list, `[.:]` normalization, `self.foo` → `C::foo`). Parity: `OPENEZ_NATIVE_EXPECT=1 bun test tests/native-wasm-parity.test.ts` — all 4 ruby cases pass (example + torture × LF/CRLF, zero diffs). Other failures in that run (python/relative-imports ×2, rust/calls.rs, rust/example.rs ×2) are pre-existing sibling-plan red: untracked Rust/Python fixtures plus WASM-side `keepQualifiedCallee` work whose native port is pending in those plans — native output for py/go/rust byte-identical to before this change.

### Task 4 — Route Ruby through the native batch path

Files: packages/indexer/src/index-workspace.ts; packages/indexer/src/native-binding.ts only if needed; tests/parsed-documents-cache.test.ts
Interfaces: consumes the Ruby parse records from Task 3; keeps the native loader optional and the graph shape unchanged.
Change: add Ruby to `TS_LANGS` and `NATIVE_LANGS` (and any `.rake` and `.gemspec` routing) so Ruby files use the batch parser when native is available; retain the WASM/regex fallback when native is disabled or unavailable; make the cached-row version check use the native tag for Ruby rows. Do not change graph behavior yet.
Verify: bun test tests/parsed-documents-cache.test.ts tests/ruby-indexer.test.ts. Native and OPENEZ_NATIVE=0 graph edge sets are identical for the Task 2 fixtures; rows under the previous tags reparse; the native-unavailable path still produces Ruby symbols and imports.
Progress: done
Result: `"ruby"` added to `TS_LANGS` (inline `parseCodeBatch`) and `NATIVE_LANGS` (graph-build batch) in index-workspace.ts; `.rb`/`.rake`/`.gemspec` already mapped to `ruby` in languages.ts. Parser tags bumped `native-v4`/`fallback-v4` → `native-v5`/`fallback-v5` (sibling plans had already moved v2→v4); `tests/parsed-documents-cache.test.ts` literal updated to `fallback-v5`. Verified: `bun test tests/ruby-indexer.test.ts` 4/4 pass; `OPENEZ_NATIVE=0` run of ruby-indexer + edge suites green; parsed_documents rows written with `native-v5` and `fallback-v5` rows reparse when native returns (expectedNativeVersion mismatch). No change to loader optional-ness — `OPENEZ_NATIVE=0`, load failure, and null batch entries all still fall through to `parseDocument` (WASM/regex).

### Task 5 — Keep constant receivers in Ruby call names

Files: packages/indexer/src/tree-sitter/configs.ts::rubyConfig and rubyQualifyCall; packages/indexer/src/languages.ts::parseRuby; packages/native/src/parser.rs Ruby path; tests/ruby-indexer.test.ts; tests/native-wasm-parity.test.ts
Interfaces: changes Ruby `callExpressions` names in the native, WASM, and regex parsers together; native result shape unchanged.
Change: record a call with a constant or scope-resolution receiver as `Const.foo` or `A::B.foo`; keep `self.foo` and bare calls as they are; stop recording calls on any other receiver in `callExpressions` while leaving the method name in `calledIdentifiers`. Increment the native and fallback parser version tags.
Verify: bun test tests/ruby-indexer.test.ts tests/native-wasm-parity.test.ts tests/parsed-documents-cache.test.ts. Native and WASM Ruby diffs stay empty on the whole parity set including CRLF and `&.`; the regex path stays consistent with its own tests; the stale-tag reparse test passes.
Progress: done
Result: Implemented identically in WASM (`configs.ts::rubyQualifyCall` + `parse.ts::extractCallsInNode`) and native (`parser.rs::ruby_qualify_call` + `extract_calls_in_node`): receiver `self` → `Scope::method` via nearest class/module frame (unchanged); receiver `constant`/`scope_resolution` → `Receiver::method` — `Invoice.build` → `Invoice::build`, `Billing::Invoice.build` → `Billing::Invoice::build` (the `::` form is recorded rather than `.` so the callee text is the exact symbol label; noted in Decision Log); any other receiver (identifier, `@ivar`, `&.` chain, arbitrary expression) → `""` sentinel → call suppressed from `callExpressions` while the DFS branch still records the bare method name in `calledIdentifiers`. Dynamic methods `send`, `public_send`, `method_missing`, `eval`, `const_get`, `respond_to`/`respond_to?` added to `RUBY_CALL_IGNORES` on both sides. Regex `parseRuby` records no calls at all, so it satisfies "no ordinary receiver calls" by construction — unchanged. Parity: 4/4 ruby parity cases still zero-diff; `ruby-indexer` 4/4 pass; `negative` fixture produces only the `Helper::run` edge.

### Task 6 — Resolve Ruby calls by scope and constant

Files: packages/indexer/src/ruby-resolver.ts (new); packages/indexer/src/index-workspace.ts::buildGraphGeneration and the Ruby branch of `createWorkspaceFileResolver`; tests/ruby-resolver.test.ts (new); tests/ruby-edge-accuracy.test.ts
Interfaces: consumes the Task 5 call names; emits existing calls edges and imports edges with unchanged shape.
Change: add a Ruby cap condition at the three cap sites and a Ruby resolver branch in the call-edge loop, ahead of the OXC and global fallbacks and without adding `ruby` to the OXC set. Send Ruby callers only to the resolver, never to the `.`-split same-file lookup, `resolveOxcCallTarget`, or `globalSymbolNodes`. Implement the design rules: bare calls to the caller's own class or module then top level, `self.foo` by exact label, constant receivers resolved innermost-nesting first, unique-label targets only, no ancestors. Restrict `require_relative` lookup to the path as written and `.rb`. Remove the Ruby native parse-result call slice at both sites and the Ruby graph symbol/call truncation only.
Verify: bun test tests/ruby-resolver.test.ts tests/ruby-edge-accuracy.test.ts. Native and OPENEZ_NATIVE=0 graph edge sets match; expected local edges exist with FP=0; unknown receivers, dynamic calls, inherited methods, and duplicate labels have no edge; `require_relative "foo"` with `foo.md` beside `foo.rb` targets `foo.rb`; all above-cap symbols and calls remain; a Python file is still capped; JavaScript, TypeScript, Go, and Rust behavior is unchanged.
Progress: done
Result: New `packages/indexer/src/ruby-resolver.ts`: `createRubyResolver` resolves calls against label→files indices (uniqueness per file+label; same-file `def`/`class << self` duplicates collapse, cross-file duplicates go ambiguous→null; `function`-typed targets only so bare calls never bind to lambda/constant symbols). Bare calls try `OwnClass::name` then top-level `name` — the caller's own scope is its own label when the caller is a class/module (class/module-body calls) else the method's enclosing label, with no ancestor walk either way. `::`-qualified callees resolve the constant's first segment lexically (innermost scope defining it wins, remaining segments appended, no fall-through to shadowed top-level), absolute `::` callees resolve at top level. `createRubyImportResolver` resolves only `.rb` targets: literal `x.rb` as written, else `x.rb`-appended — `util.md` never captures. `buildGraphGeneration`: `rubyResolver` instantiated over all parsed Ruby symbols, `isRubyCaller` branch added ahead of the OXC/global fallbacks, `uncapped` includes `ruby`, both native `slice(0, 20)` sites skip ruby. Also `parseRuby` (regex fallback) now blanks `=begin`/`=end`/`__END__` regions and gates `require_relative` on the comment/string-stripped line, eliminating phantom imports the AST parsers never emit. Tests: `tests/ruby-resolver.test.ts` 12/12; `tests/ruby-edge-accuracy.test.ts` 8/8 (added `classbody` fixture for body-level callers + non-code `require_relative` pins in `imports`) under `OPENEZ_NATIVE_EXPECT=1` AND `OPENEZ_NATIVE=0` — edge sets identical. Deviation: `abovecap` expected-edges gained `pump→q21..q25` — the sibling Python plan lifted Python's caps in this tree (fixture still proves Ruby uncapped: 59 ruby edges). Full suite: 4 non-ruby failures, all sibling-owned (see Task 8).

### Task 7 — Update Ruby indexing guidance

Files: AGENTS.md::Indexing Expectations; apps/cli/README.md::supported languages
Interfaces: documents the behavior implemented by Tasks 3–6.
Change: state that Ruby supports optional native parsing with WASM/regex fallback, parity-tested singleton and self-call behavior, constant-receiver call names, unique-label scope-aware local edges, `.rb`-only `require_relative` imports, no Ruby graph caps, and the `openez reindex <path>` requirement; note that inherited and mixin dispatch are not resolved.
Verify: pnpm exec prettier --check AGENTS.md apps/cli/README.md; read the guidance against the design and fixtures.
Progress: done
Result: AGENTS.md Indexing Expectations rewritten for Ruby: optional Rust-native (`native-v5`) + WASM/regex fallback (`fallback-v5`), `class << self`, `self.foo`, constant-receiver `Scope::method` names, suppressed ordinary/dynamic receivers, scope-aware unique-only edges, `.rb`-only `require_relative`, no caps, no inherited/mixin/dynamic dispatch. apps/cli/README.md: Ruby row now `native or tree-sitter (WASM)` with the full behavior description; feature bullet + Native acceleration paragraph now say Python/Go/Rust/Ruby. `prettier --check` passes (README table re-padded).

### Task 8 — Verify Ruby native and fallback distribution

Files: none (check only)
Interfaces: consumes Tasks 2–7 and the existing native CI matrix.
Change: run focused and full suites, native build, and the existing platform matrix; record fixture graph counts and timing, and confirm the grammar's C++ scanner builds on all three runners.
Verify: Ruby/parser/parity/cache suites with OPENEZ_NATIVE_EXPECT=1 and OPENEZ_NATIVE=0; full bun test; native build; run `openez reindex <path>` on a workspace with pre-change Ruby cache rows and confirm refreshed parse output and graph edges; CI on Linux x64, macOS arm64, and Windows x64. Timing remains informational.
Progress: done
Result: Focused suites — `OPENEZ_NATIVE_EXPECT=1`: parity 26/26 (4/4 ruby cases zero-diff), edge-accuracy 8/8 (each fixture cross-verified native vs `OPENEZ_NATIVE=0`), ruby-indexer 4/4, ruby-resolver 12/12, parsed-documents-cache all pass; `OPENEZ_NATIVE=0`: ruby-indexer + edge-accuracy 12/12. Full `bun test`: 473 pass / 1 skip / 0 fail — green including all sibling-plan tests after their work completed in-tree. `cargo build --release` + `napi build --platform --release` clean on darwin-arm64 (tree-sitter-ruby's scanner compiles into the binding). Reindex exercise: seeded `parsed_documents` row tagged `fallback-v4` + stale `calls=[]` for `app/invoice.rb`, ran `indexWorkspace` + `ensureGraphReady` (the same reparse path `openez reindex` invokes — dist cli.cjs predates this change so a binary run would not exercise it) → row rewritten to `native-v5`, calls repopulated, 8 `calls` edges emitted on the scope fixture. Fixture graph counts: scope 11 nodes/8 calls edges; abovecap 92 nodes/84 calls edges (59 ruby + 25 python); graph-build timings 4–26ms. CI: `.github/workflows/native.yml` already matrix-builds linux-x64-gnu, darwin-arm64, win32-x64-msvc and is path-filtered on `packages/native/**`, so this change triggers it — no workflow edit needed.

## Files inspected, no change

- packages/indexer/src/native-binding.ts — native loading remains optional; Ruby routing is handled by the batch-language sets unless Task 4 finds a native-side language check.
- packages/indexer/src/scanner.ts — Ruby file discovery remains unchanged.
- packages/db/src/sqlite/document-repository.ts — parsed Ruby records reuse the existing JSON cache without a schema migration.
- packages/native/index.d.ts — the native result shape stays the same, so the generated typings do not change.

## Approval Gate

Status: approved — 2026-10-20, user directed "implement plan" on this change folder (joint design.md + tasks.md approval).

## Decision Log

- The plan separates parity from accuracy. Tasks 3–4 port today's WASM behavior unchanged so any parity failure is a porting bug, and Task 5 changes call names in all parsers together. The original plan asked for constant-receiver resolution while requiring native to match WASM exactly, but WASM discards the receiver, so the information did not exist to resolve.
- Calls on non-constant receivers are no longer recorded as bare names. Today `other.tax` is recorded as `tax` and can resolve to the caller's own `tax`.
- Bare calls resolve to the caller's own class or module, then top level, with no walk to enclosing namespaces: Ruby method lookup uses ancestors, not lexical nesting, and ancestors are out of scope. CodeGraph follows superclasses and mixins; that tier is deferred.
- Constants resolve by lexical nesting because that is how Ruby resolves them; the method must then be a unique label.
- `require_relative` probes `.rb` only so a Markdown or TypeScript file of the same stem cannot capture the import.
- No shadow marker is needed for Ruby: a local variable cannot be called with parentheses or arguments.
- The parity manifest and parser version tags are shared with the Python and Rust plans: the first plan to land creates the manifest, and each plan increments tags from the previous value.
