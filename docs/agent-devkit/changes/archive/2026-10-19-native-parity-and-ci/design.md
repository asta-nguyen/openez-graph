# Native parity tests and multi-platform native CI

Issue: [#39](https://github.com/asta-nguyen/openez-graph/issues/39)

## Goal

Make the optional Rust native extension (`packages/native`) trustworthy and shippable beyond Linux x64, so later Go improvements that edit `packages/native/src/parser.rs` can be shipped without hand-built Docker binaries. This change adds (C0) a parity test that pins the exact differences between native and WASM output, and a Go edge-accuracy baseline, and (C1) a GitHub Actions workflow that builds and tests the native binary on three platforms and a packaging path that ships those binaries in the CLI. It does not change parser extraction or resolution logic. Enabling native on additional platforms can expose differences that already exist between native and WASM; the parity fixture pins record those differences, and the release documentation discloses them.

This is change 1 of a four-change program that brings OpenEZ's Go support closer to CodeGraph's:

| Change   | Content                                                                                                               | Folder                                      |
| -------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 1 (this) | Parity harness, edge-accuracy baseline, native CI and packaging                                                       | this folder                                 |
| 2        | Go extraction fixes in all three parser paths (vendor exclude, generic receiver, const/var, symbol/call cap handling) | separate folder, later                      |
| 3        | Package-aware Go call resolution (qualifier on calls, per-package index, go.mod, import aliases, unique-or-drop)      | separate folder, later                      |
| Later    | Local receiver type inference, implicit interface edges, gap chunks                                                   | decided from this change's baseline numbers |

## Scope

In scope:

1. A shared loader `packages/indexer/src/native-binding.ts` that finds the native binding through the generated `packages/native/index.js` loader (replacing the hardcoded `index.linux-x64-gnu.node` path in `index-workspace.ts` and `scanner.ts`) and supports an `OPENEZ_NATIVE=0` kill switch.
2. `tests/native-wasm-parity.test.ts`: for Python, Go and Rust fixtures, the difference between native `parseCodeBatch` output and the WASM tree-sitter output on normalized fields must equal the committed `tests/fixtures/parity/known-differences.json` exactly (an empty difference for fixtures without an entry). This change records existing differences; it does not fix them. Includes a CRLF variant of each fixture.
3. `tests/go-edge-accuracy.test.ts` with fixtures under `tests/fixtures/go-edges/`: index fixture workspaces through `indexWorkspace`, compare `graph_edges` with hand-written `expected-edges.json`, score every observed call edge, report true positives and false negatives per tier plus false positives overall, and enforce a ratchet against a committed `baseline.json`.
4. `.github/workflows/native.yml`: matrix build on `ubuntu-22.04` (linux-x64-gnu), `macos-14` (darwin-arm64) and `windows-latest` (win32-x64-msvc); each leg deletes any pre-existing `packages/native/*.node`, builds its own binary, checks that its exact expected output file exists, runs the parity and Go-related tests against it, and uploads only that file as an artifact.
5. `apps/cli/tsup.config.ts` copies every `packages/native/index.*.node` present, plus `index.js`, into `dist/native/`.
6. Stop committing native binaries: remove `packages/native/index.node` and `packages/native/index.linux-x64-gnu.node` from the Git index and ignore `packages/native/*.node`.
7. Release documentation: `AGENTS.md` "Release Workflow" and `.agents/skills/release-cli/SKILL.md` gain a step to fetch the CI binaries and verify them before building and publishing; `apps/cli/README.md` states which platforms get native acceleration, what the fallbacks are, and that native and fallback extraction are not guaranteed identical (known differences are tracked in the parity tests and issue #39).

Out of scope: any change to Go extraction or resolution behavior (changes 2 and 3), gap chunks, type inference, additional platforms (macOS x64, Linux arm64, Windows arm64, musl), per-platform npm packages, publishing from CI, adding native support for more languages, any DB schema, MCP or CLI command change.

## Behavior

- This change does not alter parser extraction or call-resolution logic. Enabling native on additional platforms can expose differences already present between native and WASM output (for example, a recursive call is added to native `calledIdentifiers` but not to WASM's). The parity test pins those differences exactly for its fixtures; Go graph edge parity is required for the dedicated edge-accuracy fixtures, while broader parity improvements are handled in change 2.
- The binding is loaded via `dist/native/index.js`, which selects `index.<platform>.node` by `process.platform` and `process.arch`. On linux-x64, darwin-arm64 and win32-x64 the CLI uses native for file scanning (`scanWorkspaceFast`) and Python/Go/Rust parsing (`parseCodeBatch`). On any other platform, or when loading fails, the existing fallbacks apply (fast-glob scan; WASM then regex parsing).
- `OPENEZ_NATIVE=0` forces the fallbacks even when a binary is present. It affects both the scanner and the parser.
- The CLI npm package contains up to three binaries (about 5 MB each) under `dist/native/`.
- The workflow runs on `workflow_dispatch`, and on `pull_request` and `push` to `main` when paths under `packages/native/**`, `packages/indexer/src/**`, `tests/**`, or the workflow file change. It needs only `contents: read`, uses no secrets, and each leg fails the run when its parity or Go tests fail (`fail-fast: false` so all legs report).
- Releases stay manual on the maintainer's machine. Before `pnpm build:cli`, the maintainer downloads the artifacts of the successful workflow run for the release commit, or for an earlier commit when no commit after it touched `packages/native/`, places them in `packages/native/`, and checks that all three `index.*.node` files exist.

## Edge cases

- No binary for the platform, or the binary fails to load (for example glibc mismatch): `loadNativeBinding()` returns `null`; callers use the existing fallbacks. Never throws to the caller.
- Native returns `null` for a single file: the existing per-file fallback to WASM/regex stays unchanged.
- Windows line endings: every parity fixture is also run with `\r\n` content so a CRLF-only divergence fails the Windows leg.
- Native-versus-WASM differences discovered while writing the parity test are written to `tests/fixtures/parity/known-differences.json` as exact `onlyNative`/`onlyWasm` entries per fixture and field (change 2 is expected to remove them). The suite fails on any difference that is not pinned, any pinned entry whose content changed, and any pinned difference that no longer occurs, so a pin cannot hide an additional regression.
- Stale binaries: until the committed binaries are untracked, a CI checkout still contains the old Linux binary. Each leg deletes every `packages/native/*.node` before building, requires its exact output file, and uploads only that file, so no artifact carries another platform's or an older binary and extracting all artifacts into one directory cannot overwrite a fresh build.
- Missing native in the test environment: parity tests are skipped locally when no binary loads, and fail when `OPENEZ_NATIVE_EXPECT=1` (set by the workflow).
- Windows leg cannot build or pass for a reason not fixable within this change: remove that leg from the matrix, document win32-x64 as fallback-only, and continue; do not weaken the parity assertions.
- Fresh clone after binaries leave Git: native is absent until `pnpm --filter @openez-graph/native build` (needs Rust) or a CI artifact is placed in `packages/native/`. The CLI still works through fallbacks. `pnpm build:cli` prints a warning when no binary is found; the release procedure treats fewer than three binaries as a stop condition unless the maintainer explicitly accepts a reduced platform list.
- The Go edge-accuracy ratchet must not depend on the host: the test indexes each fixture normally and, when native is loadable, again with `OPENEZ_NATIVE=0`, and requires identical edge sets. The graph is built on demand, not by `indexWorkspace`, so each run calls `ensureGraphReady` before reading edges and asserts that the graph has symbol nodes and a known canary edge; an unbuilt graph therefore cannot pass as empty-equals-empty.
- The runtime is Bun (`engines.bun >= 1.1.0`); N-API loading under Bun on each OS is validated by the parity test itself running under `bun test` on each leg.
- Musl-based Linux (for example Alpine) gets the fallback path; it is documented, not built.

## Interfaces

- New environment variables: `OPENEZ_NATIVE=0` (user-facing kill switch), `OPENEZ_NATIVE_EXPECT=1` (test/CI only: a missing native binary fails the parity tests), and `OPENEZ_UPDATE_BASELINE=1` (test only: the Go edge-accuracy test rewrites `baseline.json`, and the parity test rewrites `known-differences.json`, instead of asserting).
- New module `packages/indexer/src/native-binding.ts` exporting `loadNativeBinding(candidates?: string[]): unknown | null` (cached; `candidates` are module specifiers tried in order, defaulting to `<dirname>/native/index.js` then `@openez-graph/native`, and exist so a test can force a load failure) and `resetNativeBindingCache(): void`. `resolveNativeParser()` and the scanner call it; `resetNativeParserCache()` also resets the binding cache. The existing `NativeParser` interface and `parseCodeBatch` signature do not change.
- CLI package layout: `dist/native/index.js` and `dist/native/index.<platform>.node` (at most three); the `dist/node_modules/@openez-graph/native` shim stays as is.
- Workflow artifact names: `native-linux-x64-gnu`, `native-darwin-arm64`, `native-win32-x64-msvc`, each containing one `index.<triple>.node`.
- Test fixtures: `tests/fixtures/parity/{python,go,rust}/` plus `tests/fixtures/parity/known-differences.json`, and `tests/fixtures/go-edges/<case>/` with `expected-edges.json` and `baseline.json`.
- No change to the database schema, MCP tool signatures, CLI commands, or `parseCodeBatch` result shape.

## Verification

- Record a baseline before the first source edit: `bun test` on the current tree (existing failures noted, none fixed here).
- A final full `bun test` run is compared with the recorded baseline: no failure outside the baseline set, and the new parity and edge-accuracy tests pass. On the maintainer's Mac, build the local binary with `pnpm --filter @openez-graph/native build` and run the parity test with `OPENEZ_NATIVE_EXPECT=1`.
- `OPENEZ_NATIVE=0` makes `resolveNativeParser()` and the scanner use fallbacks; after `ensureGraphReady` has built the graph, indexing a Go fixture with and without it yields the same non-empty `graph_edges` set.
- The workflow completes green on all legs that remain in the matrix; each leg's log shows the parity and Go tests executing against that leg's own binary.
- `pnpm build:web && pnpm build:cli` lists `index.js` and the available `index.*.node` files in `apps/cli/dist/native/`; `bun apps/cli/dist/cli.cjs --version` and `--help` work; a temp-directory `init` plus `status` succeeds, with and without `OPENEZ_NATIVE=0`.
- Informational, not a gate: time indexing of the Go standard library source with and without native on the maintainer's Mac and record the result in the change notes.
- Review the release docs by following them once end to end against the first successful workflow run.

## Related context

None. No verified `docs/llm/` wiki pages exist in this repository.
