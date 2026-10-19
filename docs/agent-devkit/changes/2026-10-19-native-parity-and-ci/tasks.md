# Native parity tests and multi-platform native CI tasks

Issue: [#39](https://github.com/asta-nguyen/openez-graph/issues/39)

## Design

[Native parity tests and multi-platform native CI](design.md)

## Global Constraints

- This change alters no parser extraction or call-resolution logic. Enabling native on additional platforms can expose existing native-versus-WASM differences; the parity test pins these exactly for its fixtures. The dedicated Go edge fixtures must index to identical edges with native on and off.
- `OPENEZ_NATIVE=0` disables native for both the scanner (`scanWorkspaceFast`) and the parser (`parseCodeBatch`).
- No change to the database schema, MCP tool signatures, CLI commands, the `NativeParser` interface, or the `parseCodeBatch` result shape.
- The workflow uses only `permissions: contents: read`, no secrets, and `fail-fast: false`; each leg uploads only its own exact output file, and parity pins are never loosened to make a leg pass.
- Native binaries leave the Git index only after a green workflow run has been confirmed by the user.
- Commit and push only on explicit user request; the workflow cannot run until the branch is pushed.
- Change 1 of 4: no Go extraction or resolution behavior changes here (changes 2 and 3).

## Impact map

```text
Entry: packages/indexer/src/index-workspace.ts::resolveNativeParser (:86); packages/indexer/src/scanner.ts::scanWorkspaceFiles (native scan block, :117-147); apps/cli/tsup.config.ts (native copy block, :88-112)
Flow: hardcoded packages/*/native/index.linux-x64-gnu.node, else require("@openez-graph/native") → packages/native/index.js (platform picker) → index.<platform>.node
      → NativeParser.parseCodeBatch → parseInline (:359-473) and graph-build re-parse (:1164-1208); scanWorkspaceFast → scanner; null → fast-glob scan / chunkDocument (WASM then regex)
State changes: none at runtime (no DB or cache format change); Git index loses two committed binaries; CLI package gains up to three binaries
External effects: new GitHub Actions workflow (GitHub-hosted runners, uploaded artifacts); release procedure gains a "fetch CI binaries" step
Change candidates: packages/indexer/src/native-binding.ts (new); packages/indexer/src/index-workspace.ts; packages/indexer/src/scanner.ts; apps/cli/tsup.config.ts; .github/workflows/native.yml (new);
                   tests/native-binding.test.ts, tests/native-wasm-parity.test.ts, tests/go-edge-accuracy.test.ts (new); tests/fixtures/parity/**, tests/fixtures/go-edges/** (new);
                   .gitignore; AGENTS.md; .agents/skills/release-cli/SKILL.md; apps/cli/README.md; packages/native/index.node and index.linux-x64-gnu.node (untracked, last)
Verification: bun test (baseline first); new native-binding, parity and edge-accuracy tests; tests/scanner.test.ts and tests/parsed-documents-cache.test.ts unchanged and green; pnpm build:cli + dist smoke; first workflow run (needs push)
Verified at: 1de68a3fa8fa837f1af121008f7e79392d2e7790
```

## Tasks

### Task 1 — Record the test baseline

Files: none (check only)
Interfaces: produces the list of pre-existing `bun test` failures later tasks must not be blamed for.
Change: run the existing suite before any source edit and record failures. Create no baseline-only test.
Verify: `bun test` from the repo root; record pass/fail counts and each failing test name in `Result`.
Progress: done
Result: `bun test` — 310 pass, 1 skip (retrieval benchmark), 0 fail across 33 files. Clean baseline; no pre-existing failures.

### Task 2 — Shared native loader with kill switch

Files: packages/indexer/src/native-binding.ts::loadNativeBinding (new); packages/indexer/src/native-binding.ts::resetNativeBindingCache (new); packages/indexer/src/index-workspace.ts::resolveNativeParser; packages/indexer/src/index-workspace.ts::resetNativeParserCache; packages/indexer/src/scanner.ts::scanWorkspaceFiles; tests/native-binding.test.ts (new); .gitignore
Interfaces: produces `loadNativeBinding(candidates?: string[]): unknown | null` and `resetNativeBindingCache()`; consumed by `resolveNativeParser` and the scanner, and by Tasks 3 and 4. `NativeParser` and `parseCodeBatch` are unchanged.
Change: `loadNativeBinding` returns `null` when `OPENEZ_NATIVE=0`; otherwise tries `<dirname>/native/index.js` then `@openez-graph/native` (or the supplied `candidates`) in order, catches every load error and returns `null`, and caches the first result. `resolveNativeParser` and the scanner's native block use it instead of the hardcoded `index.linux-x64-gnu.node` path; `resetNativeParserCache` also resets the binding cache. Add `packages/native/*.node` to `.gitignore` so locally built binaries are never committed.
Verify: `bun test tests/native-binding.test.ts tests/scanner.test.ts tests/parsed-documents-cache.test.ts`. Named cases in `tests/native-binding.test.ts`:

- `OPENEZ_NATIVE=0` → `loadNativeBinding()` is `null` and `resolveNativeParser()` is `null`.
- `candidates` containing a module that throws on load → returns `null`, no exception.
- `candidates` containing a stub module exporting `parseCodeBatch` → returns that stub, and a second call returns the same object (cache).
- Existing scanner and parsed-documents-cache tests pass unchanged.
  Progress: done
  Result: `bun test tests/native-binding.test.ts tests/scanner.test.ts tests/parsed-documents-cache.test.ts` — 11 pass, 0 fail. `pnpm --filter @openez-graph/indexer typecheck` clean. `resolveNativeParser()` loads `index.darwin-arm64.node` via `packages/native/index.js`; `OPENEZ_NATIVE=0` returns null. Two implementation notes: (1) `packages/native` gained `build.rs` + `napi-build = "2"` build-dependency — without it `cargo build` fails on macOS (`-undefined dynamic_lookup` missing; it also supplies the Windows MSVC link setup), which is why only Linux binaries existed; (2) `scanWorkspaceFast` now receives `[...ALLOWED_EXTENSIONS]` — napi `Vec<String>` requires a JS Array, so the previous `Set` argument made the native scan throw and fall back every run.

### Task 3 — Native-versus-WASM parity test

Files: tests/native-wasm-parity.test.ts (new); tests/fixtures/parity/python/_, tests/fixtures/parity/go/_, tests/fixtures/parity/rust/\* (new); tests/fixtures/parity/known-differences.json (new)
Interfaces: consumes `loadNativeBinding`/`resolveNativeParser` (Task 2) and the existing `parseWithTreeSitter` with `pythonConfig`, `goConfig`, `rustConfig`; produces the suite the workflow (Task 6) runs on every leg.
Change: for each fixture file, run native `parseCodeBatch` and the WASM tree-sitter parser and compute, per field, the multiset difference between the two results as `{onlyNative: [...], onlyWasm: [...]}`. Fields: symbols (`name`, `symbolType`, `exported`, `startLine`, `endLine`, `receiver`, each symbol compared as one record), `importPaths`, `callExpressions` (`callerName`, `calleeName`), and `calledIdentifiers`; order is ignored. The test asserts the computed difference equals the entry for that fixture and variant in `tests/fixtures/parity/known-differences.json`, and an empty difference when there is no entry. The difference is computed by a pure function in the test file, which is itself unit-tested with synthetic parse results. Each fixture also runs with `\r\n` line endings. Fixtures cover: Python functions, classes, decorators, imports; Go functions, methods with pointer and value receivers, a generic receiver `Stack[T]`, grouped imports, calls through a receiver variable; Rust impl blocks, trait impls, `use` declarations. The suite is skipped when no native binding loads, and fails when `OPENEZ_NATIVE_EXPECT=1`. Differences found while writing the test are recorded in `known-differences.json` exactly as computed (this change fixes none of them); a difference that is not pinned, a pinned entry whose content differs, and a pinned difference that no longer occurs all fail the suite. Normalization is never loosened to remove a difference.
Verify: build the local binary (`pnpm --filter @openez-graph/native build`, needs Rust); `OPENEZ_UPDATE_BASELINE=1 OPENEZ_NATIVE_EXPECT=1 bun test tests/native-wasm-parity.test.ts` writes the pins; then `OPENEZ_NATIVE_EXPECT=1 bun test tests/native-wasm-parity.test.ts` passes; the synthetic unit cases pass (a call present only in the native-side result appears in `onlyNative`; the same call present in both results yields an empty difference); editing one pinned entry, deleting a pin whose difference still occurs, and adding a pin for a difference that does not occur each make the suite fail; without a local binary `bun test tests/native-wasm-parity.test.ts` reports skipped; `OPENEZ_NATIVE_EXPECT=1` with `OPENEZ_NATIVE=0` fails. Record every pinned difference in `Result`.
Progress: done
Result: `known-differences.json` pins one real difference for `go/example.go` and its `#crlf` variant: native `calledIdentifiers` contains `Node::Traverse` where WASM contains `Traverse` — the recursive-method-call case anticipated in the Decision Log (receiver-qualified self-call is excluded from `callExpressions` by both parsers; native records the qualified name in `calledIdentifiers`, WASM's top-level walk records the unqualified name). All other fields and fixtures are identical, including generic receivers (`Stack[T]::Push`), recursion, nested/async functions, `defer`/`go` anonymous calls, method chains, Rust generics, and Python comprehensions. Pin write mode verified (`OPENEZ_UPDATE_BASELINE=1` regenerates); assert mode 14 pass; `OPENEZ_NATIVE=0` → 6 fixture cases skipped, suite green; `OPENEZ_NATIVE=0` + `OPENEZ_NATIVE_EXPECT=1` → 1 fail; deleting the `go/example.go` pin fails exactly that case; a phantom pin fails exactly its fixture case.

### Task 4 — Go edge-accuracy baseline and ratchet

Files: tests/go-edge-accuracy.test.ts (new); tests/fixtures/go-edges/packages/ (new: `go.mod`, `a/a.go`, `a/helper.go`, `b/b.go`, `c/main.go`, `expected-edges.json`, `baseline.json`); tests/fixtures/go-edges/types/ (new: `go.mod`, `d/d.go`, `expected-edges.json`, `baseline.json`)
Interfaces: consumes `indexWorkspace`, `ensureGraphReady(workspaceId)` from `packages/indexer/src/graph-service` (`indexWorkspace` does not build the graph; it is built on demand), `createRegistryRepository`/`ensureWorkspace`, and `queryRaw` over `graph_nodes`/`graph_edges` (the pattern in `tests/index-workspace.test.ts`); produces per-fixture true positives and false negatives per tier plus overall false positives, consumed by changes 2 and 3 as their before/after measure.
Change: fixtures mirror the cases already probed against CodeGraph. `packages` fixture: two packages each declaring `New` and `helper`, `c/main.go` importing both. `types` fixture: types `F` and `G` with `Close`, field chain, `:=` from a constructor, explicit generic instantiation `Map[int](1)`, grouped `const`/`var` with several names. `expected-edges.json` lists ground-truth `calls` edges as `{from, to, tier}` using `file#symbol` labels (the file path comes from the symbol node's `filePath` metadata), with tier `package` (resolvable from package, qualifier and import knowledge) or `type` (needs receiver type inference). Each run uses a fresh temp registry and a fresh copy of the fixture, calls `indexWorkspace`, then `await ensureGraphReady(workspace.id)`, and only then reads nodes and edges. Each fixture also declares one canary edge that the current code already resolves (`packages`: `b/b.go#New` → `b/b.go#helper`, resolved by same-file lookup; `types`: `d/d.go#useG` → `d/d.go#newG`); each run fails unless symbol nodes exist, the observed `calls` set is non-empty, and the canary is observed, so an unbuilt graph cannot pass as an empty set. The observed set is every `calls` edge whose two endpoints are symbol nodes defined in the fixture. An observed edge listed in `expected-edges.json` is a true positive of its expected tier; an expected edge not observed is a false negative of its tier; an observed edge not listed is a false positive, counted once overall because it has no tier. `baseline.json` holds `truePositives` and `falseNegatives` per tier and one overall `falsePositives`. The test asserts `truePositives` per tier `>=` the baseline and overall `falsePositives <=` the baseline. With `OPENEZ_UPDATE_BASELINE=1` it writes `baseline.json` instead of asserting. When a native binding loads, it repeats the whole sequence (fresh registry and fixture copy, graph built the same way) with `OPENEZ_NATIVE=0` and requires identical edge sets. The initial `baseline.json` is generated from the current, unmodified behavior and may contain false positives and false negatives.
Verify: `OPENEZ_UPDATE_BASELINE=1 bun test tests/go-edge-accuracy.test.ts` writes baselines; then `bun test tests/go-edge-accuracy.test.ts` passes; editing one baseline number to a better value makes it fail; with a local binary built, the native-versus-fallback equality case passes. Each fixture's baseline must show `truePositives` greater than 0 in tier `package`; all zeros mean the graph was not built and the task is not done. Record the baseline numbers per tier and the overall false positives in `Result`.
Progress: done
Result: Baselines (darwin-arm64, native on): `packages` TP{package:3,type:0} FN{package:1,type:0} FP=0 — `main→b/b.go#New` unresolved (qualifier dropped: `b.New()` resolves to `a/a.go#New` and dedupes into the `a.New()` edge); `types` TP{package:2,type:0} FN{package:1,type:3} FP=0 — `Map[int]` unresolvable and `Close` calls cannot resolve to `F::Close`/`G::Close` without receiver-type inference; the `G::Close` body emits no `callExpression` in either parser (field-chain call needs gap-chunk/type work). Both fixtures show TP>0 in tier `package`. Assert mode 2 pass; baseline TP edit 3→4 fails exactly `packages`; the native-vs-`OPENEZ_NATIVE=0` repeat yields identical edge sets on both fixtures.

### Task 5 — Package every available native binary in the CLI

Files: apps/cli/tsup.config.ts (native copy block)
Interfaces: consumes `packages/native/index.js` and any `packages/native/index.*.node`; produces `apps/cli/dist/native/index.js` and `apps/cli/dist/native/index.<platform>.node`. The `dist/node_modules/@openez-graph/native` shim is unchanged.
Change: replace the single hardcoded `index.linux-x64-gnu.node` copy with a copy of every `index.*.node` present next to `index.js`; print which files were copied; print a warning when none are found (the build must still succeed).
Verify: with the locally built darwin-arm64 binary, `pnpm build:cli` prints the copied file and `ls apps/cli/dist/native` shows `index.js` and `index.darwin-arm64.node`; with the binary temporarily moved away, `pnpm build:cli` succeeds and prints the warning.
Progress: done
Result: `pnpm build:cli` copies `index.darwin-arm64.node`, `index.linux-x64-gnu.node` + `index.js` → `dist/native/` and logs each name; `bun apps/cli/dist/cli.cjs --version` (1.5.0) and `--help` work. With all `.node` moved away the build still succeeds and prints `⚠ No native .node binaries found — CLI will use WASM/regex fallbacks`. Note: the copy filter is `/^index\.[^.]+\.node$/`, which excludes bare `index.node` — it has no platform segment, the `index.js` picker never loads it, and shipping it would add ~4.7 MB dead weight on every platform. Review fix: the `dist/node_modules/@openez-graph/native` shim's `main` was `../../native/index.js`, resolving to `dist/node_modules/native/index.js` (missing) — corrected to `../../../native/index.js` → `dist/native/index.js` (verified resolvable after build), so the `@openez-graph/native` candidate actually works in the bundle.

### Task 6 — Native build and test workflow

Files: .github/workflows/native.yml (new)
Interfaces: consumes `pnpm --filter @openez-graph/native build` and the test files from Tasks 2-4; produces artifacts `native-linux-x64-gnu`, `native-darwin-arm64`, `native-win32-x64-msvc`, each containing one `index.<triple>.node`.
Change: triggers `workflow_dispatch`, and `pull_request` and `push` to `main` limited to `packages/native/**`, `packages/indexer/src/**`, `tests/**`, and the workflow file. Matrix `include` entries `{runner, binary, artifact}`: `ubuntu-22.04` with `index.linux-x64-gnu.node` and `native-linux-x64-gnu`, `macos-14` with `index.darwin-arm64.node` and `native-darwin-arm64`, `windows-latest` with `index.win32-x64-msvc.node` and `native-win32-x64-msvc`, and `fail-fast: false`. Each leg: check out, set up Node, pnpm (version from `packageManager`) and Bun, use the preinstalled stable Rust toolchain, `pnpm install --frozen-lockfile` with `HUSKY=0`, delete every `packages/native/*.node` (the checkout still tracks the old Linux binary until Task 9), build the native package, fail unless `packages/native/${{ matrix.binary }}` exists, run `bun test` on `tests/native-wasm-parity.test.ts tests/go-edge-accuracy.test.ts tests/native-binding.test.ts tests/go-rust-indexer.test.ts tests/tree-sitter-parser.test.ts tests/scanner.test.ts tests/parsed-documents-cache.test.ts` with `OPENEZ_NATIVE_EXPECT=1`, then upload exactly `packages/native/${{ matrix.binary }}` with `name: ${{ matrix.artifact }}` and `if-no-files-found: error`. Use `shell: bash` for these steps on every OS. Pin actions to major versions. If the Windows leg cannot be made green without weakening assertions, remove it from the matrix and record win32-x64 as fallback-only in the Decision Log.
Verify: the YAML parses (`bun -e` with the repo's YAML dependency, or `actionlint` when installed); the workflow run itself needs the branch pushed, so the real check is `cannot verify` until the user pushes and runs `gh workflow run native.yml`; then expect all legs green and three artifacts, each containing exactly one file with its own distinct name (extracting all three into one directory yields three files). Record the run URL in `Result`.
Progress: done
Result: `.github/workflows/native.yml` written and parses via `js-yaml` (`actionlint` not installed locally): triggers `workflow_dispatch`/`pull_request`/`push` to `main` scoped to the four path globs; `permissions: contents: read`, `fail-fast: false`, `shell: bash` on the delete/build/verify/test steps; matrix legs `ubuntu-22.04→index.linux-x64-gnu.node`, `macos-14→index.darwin-arm64.node`, `windows-latest→index.win32-x64-msvc.node`; each leg deletes `packages/native/*.node`, builds via `pnpm --filter @openez-graph/native build` on the preinstalled Rust toolchain, requires its exact binary, runs the seven test files with `OPENEZ_NATIVE_EXPECT=1`, and uploads only its binary (`if-no-files-found: error`). The green-run check is `cannot verify` until the branch is pushed and `gh workflow run native.yml` executes; run URL pending.

### Task 7 — Release documentation and platform note

Files: AGENTS.md (Release Workflow); .agents/skills/release-cli/SKILL.md; apps/cli/README.md
Interfaces: documents the artifacts and layout from Tasks 5 and 6.
Change: in both release procedures add a step before `pnpm build:cli`: find the successful `native.yml` run for the release commit (or an earlier commit when no later commit touched `packages/native/`), download its three artifacts one at a time by name (`native-linux-x64-gnu`, `native-darwin-arm64`, `native-win32-x64-msvc`) into `packages/native/`, require exactly the three expected files (`index.linux-x64-gnu.node`, `index.darwin-arm64.node`, `index.win32-x64-msvc.node`) and no other `index.*.node`, and treat fewer than three as a stop unless the user accepts a reduced platform list; after `pnpm build:cli`, require the same files in `apps/cli/dist/native/`. Add `native.yml` fetch to the Pitfalls. In `apps/cli/README.md` state that linux-x64, darwin-arm64 and win32-x64 use native acceleration for file scanning and Python/Go/Rust parsing; that other platforms (macOS x64, Linux arm64, musl) use the fallbacks (fast-glob scanning; WASM then regex parsing) and are slower; that native and fallback extraction are not guaranteed to be identical, with the known differences tracked in issue #39 and the parity tests; and that `OPENEZ_NATIVE=0` disables native.
Verify: `pnpm format:check` passes for the changed Markdown; a read-through confirms each command and path against Tasks 5 and 6; the procedure is walked once end to end against the first successful run when it exists (otherwise `cannot verify`).
Progress: done
Result: `AGENTS.md` Release Workflow and `.agents/skills/release-cli/SKILL.md` gained step "Fetch native binaries" (run for the release commit, else the last commit touching `packages/native/`; three `gh run download -n` calls into `packages/native/`; exactly three expected `index.*.node` required; fewer is a stop), a Pitfalls entry, and the post-build `dist/native/` listing check; sections renumbered. `apps/cli/README.md` gained "Native acceleration" (linux-x64-gnu/darwin-arm64/win32-x64-msvc accelerated; macOS x64, Linux arm64, musl, Windows arm64 fall back; `OPENEZ_NATIVE=0` killswitch; outputs not guaranteed identical, pins tracked in issue #39) and table rows updated to "native or tree-sitter (WASM)". `pnpm exec prettier --check` clean on all touched files (repo-wide `format:check` also flags unrelated untracked dirs `jina-code-static-build/`, `reviews/`, `packages/native/index.*` generated files — pre-existing). End-to-end walk against a real run: `cannot verify` until the workflow exists on the remote.

### Task 8 — Local end-to-end check and informational timing

Files: none (check only)
Interfaces: consumes the locally built binary, `pnpm build:cli`, and the built CLI.
Change: confirm the whole path works on the maintainer's machine and record how much native helps.
Verify:

- Final full-suite run: `bun test` from the repo root; compare the failing set with the Task 1 baseline, require no failure outside it, and record the counts in `Result`.
- `pnpm build:web && pnpm build:cli`; `bun apps/cli/dist/cli.cjs --version` and `--help` work.
- With `AI_MEMORY_REGISTRY_DB_PATH` pointing at a temp file (so the maintainer's real registry is untouched), in a temp directory containing a copy of the Go standard library `net` package, run `init` with and without `OPENEZ_NATIVE=0` and check `status` succeeds. `status` only reads existing counts and `init` does not build the graph, so then run a short `bun -e` script that calls `ensureGraphReady` for that workspace and reads `getNodeCount` and `getEdgeCount`. Both runs must report non-zero node and edge counts, proving both paths built a graph. Record both count pairs. This is an operational smoke check; parser differences are checked against the fixture pins in Task 3, and Go edge parity is asserted against the dedicated fixtures in Task 4.
- Informational, not a gate: record wall-clock time of `init` on that copy with native and with `OPENEZ_NATIVE=0` in `Result`.
  Progress: done
  Result: full `bun test` = 331 pass / 1 skip (retrieval benchmark) / 0 fail across 36 files vs the Task-1 baseline of 310/1/0 — no failures outside baseline. The run surfaced and fixed a real defect: `resolveNativeParser()` returned a warm cached parser under `OPENEZ_NATIVE=0` (an earlier suite file had populated the cache); it is now gated by `isNativeDisabled()` before the cache check. `pnpm build:web` + `pnpm build:cli` succeeded; `--version` = 1.5.0; `--help` lists all commands; `dist/native/` holds `index.js` + darwin-arm64 + linux-x64-gnu binaries (win32 absent locally — expected). End-to-end on a copy of Go stdlib `net` (437 files, temp registries via `AI_MEMORY_REGISTRY_DB_PATH`): native `init` TOTAL 436ms (1.30s wall), fallback `init` TOTAL 1637ms (1.75s wall); both `status` report `indexed`/`completed`, 7177 chunks; after `ensureGraphReady` both produce identical graphs — nodes=4767, edges=5823, calls=1493 (native graph-build 237ms, fallback 125ms). Timing informational only.

### Task 9 — Untrack the committed binaries (gated)

Files: packages/native/index.node; packages/native/index.linux-x64-gnu.node
Interfaces: depends on a green workflow run (Task 6) confirmed by the user.
Change: only after the user confirms the first workflow run is green on at least linux-x64, run `git rm --cached` on both binaries so the working-tree files stay in place; the `.gitignore` rule from Task 2 keeps them out of future commits. If no confirmed green run exists when this task is reached, stop and ask; do not remove them.
Verify: `git ls-files packages/native` no longer lists the two `.node` files; `git status` shows them as staged deletions only; `git check-ignore -v packages/native/index.node` matches the `.gitignore` rule.
Progress: todo
Result: none

## Files inspected, no change

- packages/native/index.js — generated loader that selects `index.<platform>.node` and its fallback packages
- packages/native/Cargo.toml, packages/native/package.json — build command and dependencies
- packages/native/src/parser.rs — native Go/Python/Rust extractor (changed in change 2, not here)
- tests/parsed-documents-cache.test.ts, tests/index-workspace.test.ts, tests/tree-sitter-parser.test.ts, tests/go-rust-indexer.test.ts, tests/scanner.test.ts — existing patterns and tests that must stay green
- pnpm-workspace.yaml, package.json — workspace layout, `packageManager`, `bun test`

## Approval Gate

Status: approved

Approved by user 2026-10-19 ("aprove plan rồi làm đi" on issue #39).

## Decision Log

- 2026-10-19 — Plan review (4 findings) addressed; approval state: pending.
  - Parity policy: this change records the existing native-versus-WASM differences and pins them exactly; it does not fix them (change 2 will). Fixing them means editing `parser.rs` and shipping a rebuilt binary before CI exists. Reading the source found one such difference: native adds a recursive call to `calledIdentifiers` before its self-call check, WASM skips it.
  - Edge scoring: false positives are counted overall; true positives and false negatives are per tier.
  - Workflow artifacts: each leg deletes stale `.node` files and uploads only its exact output file; the release step downloads artifacts one by one by name.
  - Task 8 gained a final full `bun test` run compared with the Task 1 baseline.
- 2026-10-19 — Second plan review (3 findings) addressed; approval state: pending.
  - Task 4 builds the graph with `ensureGraphReady` before reading edges and requires a non-empty graph plus a canary edge, so a never-built graph cannot give an empty-equals-empty pass. Task 8 got the same treatment because `status` and `init` do not build the graph, and uses a temp registry so the maintainer's registry is untouched.
  - Task 3's checks now exercise a one-sided difference (synthetic unit cases) and pin tampering; adding a call that both parsers extract would not change the difference.
  - Task 7's README text no longer promises identical fallback results; it states the fallbacks and the tracked differences.
- 2026-10-19 — Third plan review: clarified that newly enabling native can expose existing parser differences; removed an invalid parity expectation from the operational smoke check. Approval state remains pending.
