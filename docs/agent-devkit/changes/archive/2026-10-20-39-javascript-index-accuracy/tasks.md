# JavaScript indexing accuracy tasks

Issue: #39

## Design

[JavaScript indexing accuracy](design.md)

## Global Constraints

- Scope production behavior changes to JavaScript.
- Keep OXC as the parser; add no SCIP or JavaScript runtime dependency.
- Keep SQLite schema and CLI/MCP interfaces unchanged.
- Resolve only unique in-workspace module/export targets; drop unresolved and ambiguous edges.
- Preserve TypeScript behavior in this change.
- Remove graph caps for JavaScript only.

## Impact map

Entry: packages/indexer/src/parsers/oxc-parser.ts::extractImports and OxcParser.parse; packages/indexer/src/index-workspace.ts::buildGraphGeneration
Flow: scan JS/JSX/MJS/CJS files → OXC parse and cache → ESM/CommonJS binding resolution → existing SQLite graph
State changes: JavaScript parse metadata and call edges are rebuilt under the bumped OXC parser version; no schema migration.
External effects: reads JavaScript source and workspace modules only; no runtime module loading.
Change candidates: packages/indexer/src/parsers/oxc-parser.ts; packages/indexer/src/parsers/types.ts; packages/indexer/src/index-workspace.ts; tests/javascript-edge-accuracy.test.ts; tests/oxc-parser.test.ts; tests/parsed-documents-cache.test.ts; tests/fixtures/javascript-edges/\*\*; AGENTS.md; apps/cli/README.md
Verification: exact JS fixture edges, cache invalidation, no TS regression, full suite
Verified at: 0519b8284324722863d9123a457f28b389389f61

## Tasks

### Task 1 — Record the JavaScript baseline

Files: none (check only)
Interfaces: records existing parser, cache, and full-suite failures before source edits.
Change: run current OXC, graph, cache, and full suites. Add no baseline-only test.
Verify: bun test tests/oxc-parser.test.ts tests/index-workspace.test.ts tests/parsed-documents-cache.test.ts, then bun test. Record baseline JS edge metrics for the planned fixture.
Progress: done
Result: focused run 46 pass / 0 fail; full suite 333 pass / 1 skip (retrieval benchmark) / 0 fail across 36 files — clean baseline, no pre-existing failures.

### Task 2 — Add JavaScript edge ground truth

Files: tests/javascript-edge-accuracy.test.ts (new); tests/fixtures/javascript-edges/\*\* (new)
Interfaces: consumes current OXC and graph outputs; provides a non-vacuous baseline for Tasks 3 and 4.
Change: create fixtures for ESM bindings, CommonJS namespace/destructured require and static exports, local re-exports, duplicate names, external imports, computed require, and an above-cap file.
Verify: graph is built before assertions; fixtures contain canary edges; record TP/FN/FP and demonstrate the current missing or misdirected cases.
Progress: done
Result: 5 fixtures under tests/fixtures/javascript-edges/ (esm, reexports, cjs, negative, above-cap) + tests/javascript-edge-accuracy.test.ts. Committed baselines under current code — cjs TP=1/FN=6/FP=0, esm TP=4/FN=2/FP=1 (decoyFn misdirected to decoy.js), negative TP=1/FN=0/FP=1 (ambiguous dup resolved to dupa.js), reexports TP=2/FN=2/FP=0, above-cap TP=20/FN=15/FP=0 (20-call cap; runAll hoisted first so a canary survives the 30-symbol cap). All canaries observed; suite passes against baseline.

### Task 3 — Extract and cache JavaScript module bindings

Files: packages/indexer/src/parsers/oxc-parser.ts; packages/indexer/src/parsers/types.ts; packages/indexer/src/index-workspace.ts::indexWorkspace and buildGraphGeneration; tests/oxc-parser.test.ts; tests/parsed-documents-cache.test.ts; tests/javascript-edge-accuracy.test.ts
Interfaces: produces internal ESM/CommonJS binding metadata consumed by Task 4 and persisted in the existing JSON cache field without changing the SQLite schema.
Change: preserve local ESM bindings and re-export records, recognize static string-literal require forms, and record supported static CommonJS exports. Keep runtime `importPaths: string[]` unchanged. Persist `{version: 1, paths, bindings, commonJsExports, reExports}` in the existing `parsed_documents.imports` JSON field; read legacy string arrays and build file-level imports edges from `paths` only. Update the index-time writer and lazy graph-build reader/writer so cached graph builds retain the binding records. Keep dynamic/computed loads unresolved. Bump the OXC parser version.
Verify: bun test tests/oxc-parser.test.ts tests/parsed-documents-cache.test.ts tests/javascript-edge-accuracy.test.ts. Add a round-trip assertion from OXC parse through the index-time cache write to graph construction from cache; confirm the legacy string-array cache still produces the same file-level imports edges.
Progress: done
Result: `extractModuleBindings` produces `importBindings` (ESM default/named/aliased/namespace, static CJS namespace + destructured require), `exportBindings` (local/reexport/star; CJS `exports.name`, `module.exports.name`, object-literal `module.exports`), plus first-class exported symbols for CJS function/class property values. Static require literals join `importPaths`; computed requires produce nothing. Cache `imports` column stores `{v,paths,importBindings,exportBindings}` for rows with binding data (legacy array shape otherwise; readers handle both); `PARSER_VERSION_OXC` bumped to `oxc-v3`. New tests: 4 binding tests in oxc-parser.test.ts (18 pass) + module-binding payload + oxc-v2→v3 reparse test in parsed-documents-cache.test.ts (24 pass across both files).

### Task 4 — Resolve JavaScript calls by module export

Files: packages/indexer/src/index-workspace.ts::buildGraphGeneration; tests/javascript-edge-accuracy.test.ts
Interfaces: consumes Task 3 binding records; emits existing calls edges.
Change: map imported local names and namespace members to unique workspace exports. Drop external, unresolved, computed, and ambiguous targets. Remove JS graph caps only.
Verify: all determinate fixture edges match exact targets with FP=0; the 31st symbol and 21st call are retained; TS edge fixtures remain unchanged.
Progress: done
Result: `buildGraphGeneration` resolves JS calls via `importBindings`/`exportBindings`: named/default/destructured bindings → bound module export; `ns.member()` on namespace bindings; `exports.x()`/`module.exports.x()` self-module calls. `collectModuleExports` expands local/reexport/star entries with ESM precedence (explicit match wins over star expansion), cycle guard, and ambiguity drops (duplicate export entries or >1 distinct star target). JS files no longer fall back to the global first-match map; non-JS languages keep it. Symbol (30) and call (20) caps removed for `javascript`/`jsx` only. All 5 fixtures match expected edges exactly (FP=0), incl. 36-symbol/35-call above-cap file; added self-module-call coverage (`exports.nsFn()`/`module.exports.prop()` → mod.cjs locals). Full suite 344 pass / 0 fail.

### Task 5 — Update JavaScript indexing guidance

Files: AGENTS.md::Indexing Expectations; apps/cli/README.md::supported languages
Interfaces: documents the behavior implemented by Tasks 3 and 4.
Change: describe static ESM/CommonJS workspace resolution, dropped dynamic imports, unique-only edges, and JavaScript graph cap behavior.
Verify: pnpm exec prettier --check AGENTS.md apps/cli/README.md; read the updated language guidance against the design and tests.
Progress: done
Result: AGENTS.md Indexing Expectations documents static ESM/CJS binding resolution, unique-only edges, dropped dynamic/external/ambiguous calls, JS-only cap removal, and the oxc-v3 reindex requirement. README supported-languages row describes binding-based JS call resolution. Prettier passes on both files.

### Task 6 — Verify JavaScript indexing

Files: none (check only)
Interfaces: consumes Tasks 2–5.
Change: run focused and full checks, then record representative workspace graph size and timing.
Verify: bun test tests/oxc-parser.test.ts tests/javascript-edge-accuracy.test.ts tests/parsed-documents-cache.test.ts; bun test; run `openez reindex <path>` on a workspace with pre-change JavaScript cache rows and confirm refreshed parse output and graph edges; confirm TypeScript fixtures are unchanged. Timing remains informational.
Progress: done
Result: Focused trio 30 pass / 0 fail; full `bun test` 344 pass / 1 skip (retrieval benchmark) / 0 fail across 37 files — TypeScript behavior unchanged (all existing TS/index-workspace tests green). Cache invalidation verified end-to-end: downgraded a 19-file JS workspace to `oxc-v2` rows → `buildGraphGeneration` reparsed to `oxc-v3` with binding payloads and produced 36 symbol→symbol call edges. Representative workspace (express/body-parser/finalhandler/router/send/serve-static lib dirs, 19 files / 176K CJS): index ~50–96ms, graph build ~9–151ms, 129 nodes / 152 edges / 36 symbol calls — real cross-file `require`/`exports` edges confirmed by inspection. `pnpm build:web` + `pnpm build:cli` pass; `tsc --noEmit` on indexer clean; prettier clean on all touched files.

## Files inspected, no change

- packages/indexer/src/native-binding.ts — native language routing remains limited to Python, Go, and Rust.
- packages/db/src/sqlite/document-repository.ts — binding metadata reuses existing JSON cache fields without a schema migration.
- packages/indexer/src/tree-sitter/configs.ts — JavaScript and TypeScript remain on the OXC path; tree-sitter language configuration is not changed.

## Approval Gate

Status: approved

Approved by user 2026-10-20 ("approve plan and implement").

## Decision Log

None.
