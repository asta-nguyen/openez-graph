# Parallel Parse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the uncommitted parallel-parse change (worker pool for `parseInline` phase 2) after verifying the pool engages from source and bundled, parallel output matches serial output, and the parallel path has test coverage. Code is written; this plan is verify → harden → split → commit.

**Architecture:** Five tasks, in order. Task 1 resolves the one unknown that conditions everything else (whether `resolveParseWorkerEntry` works from source given the indexer is `"type": "module"`). Tasks 2–3 prove correctness and record numbers. Task 4 covers the pool with tests. Task 5 removes the scratch probe and lands two bisectable commits. Design spec: `docs/superpowers/specs/2026-10-10-parallel-parse-design.md`.

**Tech Stack:** Bun 1.4.3, TypeScript, `node:worker_threads`, oxc-parser, tsup (CLI bundling), `bun check`, `bun test`.

## Global Constraints

- Output parity is non-negotiable: parallel path must produce chunk-identical results to serial (same `parseSingleTask`, but prove it — Task 2).
- Both fallback levels stay: slice→serial and pool→serial. Do NOT remove the serial path.
- `PARSE_WORKER_MIN_FILES` / `PARSE_WORKER_MAX` stay as-is until Task 3 measures real numbers — do NOT tune blind.
- Package manager stays pnpm; `turbo`/`tsup`/`vite` untouched.
- Each task must leave `bun check` clean and `bun test` green (310 pass / 1 skip baseline).
- Follow existing code style: compact code, prettier-formatted, comments only where load-bearing.

---

## File Structure

**Already changed (uncommitted, this plan's subject):**

- Modify: `packages/indexer/src/index-workspace.ts` (+151/−23 — `parseSingleTask`, `parseTasksSerial`, pool, gate)
- New: `packages/indexer/src/parse-worker.ts` (worker entry)
- New: `apps/cli/src/parse-worker.ts` (tsup shim)
- Modify: `apps/cli/tsup.config.ts` (second entry)
- New: `packages/indexer/probe-oxc.cjs` (scratch — Task 5 removes or relocates it)

**This plan adds:**

- `docs/superpowers/specs/2026-10-10-parallel-parse-design.md` (written)
- `docs/superpowers/plans/2026-10-10-parallel-parse.md` (this file)
- Test coverage for the parallel path (Task 4 — new or extended test files under `tests/`)

---

## Task 1: Confirm the pool engages from source, fix entry resolution if not

**Files:**

- Read: `packages/indexer/src/index-workspace.ts` (`resolveParseWorkerEntry`, `:518`)
- Modify (only if needed): same function

**Interfaces:**

- Consumes: uncommitted pool code
- Produces: known-good worker engagement from source (`bun src/cli.ts`) — or a fix

**Background:** `@openez-graph/indexer` is `"type": "module"`, so `__dirname` may be `undefined` when `index-workspace.ts` runs from source under Bun ESM. If so, `resolveParseWorkerEntry` throws, `parseInline` catches, and indexing silently degrades to serial — correct but means the feature only works bundled.

- [ ] **Step 1: Run an index from source on a 64+ file workspace and watch stderr**

  ```sh
  bun apps/cli/src/cli.ts index <path-with-64-plus-files> 2>&1 | grep '\[t\]'
  ```

  - If worker pool engaged: no `worker pool unavailable` line, and phase-2 timing reflects parallel parse.
  - If the `worker pool unavailable (... path.join ...)` line appears: `__dirname` is undefined from source — proceed to Step 2.
  - For a deterministic 64+ file fixture, reuse the repo itself (`/home/giogio/Project/openez-graph`, minus `node_modules`/`.git` — same file set as `probe-oxc.cjs`).

- [ ] **Step 2 (only if Step 1 shows fallback): add `import.meta.dirname` fallback**

  In `resolveParseWorkerEntry`, resolve the base directory as `__dirname ?? import.meta.dirname` (verify `bun check` + runtime accept this in both CJS-bundled and ESM-source contexts; tsup defines `__dirname` in CJS output so bundled behavior is unchanged). Re-run Step 1 and confirm engagement.

- [ ] **Step 3: Confirm the bundled path engages**

  ```sh
  pnpm build:cli && node dist/cli.cjs index <same-64-plus-file-workspace> 2>&1 | grep '\[t\]'
  ```

  Expect no fallback line and `dist/parse-worker.cjs` present in `apps/cli/dist/`. (If `pnpm` is unavailable in this env — pnpm 10 needs Node 22.5+, env has Node 20 — run `bunx tsup` in `apps/cli` directly and invoke with `bun dist/cli.cjs`. Do NOT "fix" pnpm as part of this task.)

## Task 2: Prove serial/parallel output parity

**Files:**

- Read: `packages/indexer/src/index-workspace.ts` (`parseSingleTask`, `:477`)

**Interfaces:**

- Consumes: engaged pool from Task 1
- Produces: evidence that pool output is chunk-identical to serial output

- [ ] **Step 1: Index the same workspace twice — pool vs forced-serial — and diff chunk output**

  Forced-serial run: temporarily set `PARSE_WORKER_MIN_FILES` to `Infinity` (revert after; do NOT commit this). Compare the resulting workspace DBs (`.openez/*.sqlite`): dump `chunks` + `documents` tables from both runs and `diff`. Expect zero differences — both paths share `parseSingleTask`, so any diff is a real bug (e.g. nondeterministic ordering in the `results` map merge).

  ```sh
  sqlite3 run-a.sqlite "SELECT id, content_hash FROM chunks ORDER BY id;" > a.txt
  sqlite3 run-b.sqlite "SELECT id, content_hash FROM chunks ORDER BY id;" > b.txt
  diff a.txt b.txt
  ```

  (Adjust table/column names to the actual schema in `packages/db/src/sqlite/`.)

- [ ] **Step 2: Confirm progress semantics match**

  Both runs must report identical `(done, total)` sequences ending at `(total, total)` — the per-file `result` messages exist for this. Any stall or double-count is a bug in `runWorkerSlice` message handling.

## Task 3: Benchmark and record numbers in the design doc

**Files:**

- Modify: `docs/superpowers/specs/2026-10-10-parallel-parse-design.md` (replace "Expected gains (unmeasured)" with measured table)

**Interfaces:**

- Consumes: verified pool from Tasks 1–2
- Produces: recorded wall-time numbers justifying the constants

- [ ] **Step 1: Time pool vs forced-serial on 3 workspaces (small <64 files, medium ~200, large 1000+)**

  Use the `[t]` phase timers the indexer already prints (`phase3 parse`, `TOTAL`). Three runs each, report medians. Expect: small identical (serial both), medium/large parse-phase speedup toward core count, zero change in DB-write phases.

- [ ] **Step 2: Write the numbers into the design doc**

  Replace the unmeasured expectations section with a table (workspace, files, serial parse ms, parallel parse ms, speedup, worker count engaged). Only then consider touching `PARSE_WORKER_MIN_FILES`/`PARSE_WORKER_MAX` — and only with a follow-up note, not in this landing.

## Task 4: Cover the parallel path with tests

**Files:**

- New or extended test files under `tests/` (follow existing fixture style)

**Interfaces:**

- Consumes: verified pool from Tasks 1–2
- Produces: suite that fails if the pool regresses

**Background:** The current suite (33 files, 310 tests) passes with the pool present but fixtures are almost certainly under 64 files, so the pool never engages — Tasks 1–3 prove it manually, this task locks it in.

- [ ] **Step 1: Add a test that indexes a synthetic 64+ file workspace and asserts chunk parity with serial**

  Generate N small TS/markdown files in a temp dir (or extend an existing fixture), run `indexWorkspace` (pool engaged), and assert the chunk set equals a forced-serial run's chunk set (same technique as Task 2, in-process). Keep N just over the threshold (e.g. 70) so the test stays fast.

- [ ] **Step 2: Add a worker-failure fallback test**

  Spawn path with a bogus entry (or kill the worker mid-slice) and assert indexing still completes with full results — the slice→serial fallback. Unit-test `runWorkerSlice`'s rejection path if it's exported; otherwise test through `indexWorkspace` with an unresolvable entry and assert the `[t] worker pool unavailable` fallback produces complete output. (May require exporting a test hook — prefer dependency injection of the entry resolver over exporting internals.)

- [ ] **Step 3: Full suite green**

  `bun test` — 311+ pass, 0 fail. If the new 70-file test is flaky under `bun test --parallel` (shared temp dirs across workers), isolate its temp dir per run — do NOT weaken the assertion.

## Task 5: Remove the probe, split commits, land

**Files:**

- Delete or relocate: `packages/indexer/probe-oxc.cjs`
- Commits: the four change files

**Interfaces:**

- Consumes: verified + tested pool from Tasks 1–4
- Produces: two bisectable commits on the branch

- [ ] **Step 1: Deal with `probe-oxc.cjs`**

  It has hardcoded absolute paths (`/home/giogio/...`) and lives in the package dir — it must not ship as-is. Either delete it (numbers already served their purpose; Task 3 replaces them) or move to `bench/` with relative paths. Default: delete.

- [ ] **Step 2: Split into two commits and verify each**
  - Commit 1 (refactor, zero behavior change): `packages/indexer/src/index-workspace.ts` hunks for `ParseTask`/`ParseResult` export + `parseSingleTask` + `parseTasksSerial` + gate calling serial on both branches. Verify: `bun check`, `bun test`, plus a manual index diff showing identical DB output vs pre-change code.
  - Commit 2 (pool): remaining `index-workspace.ts` hunks + `packages/indexer/src/parse-worker.ts` + `apps/cli/src/parse-worker.ts` + `apps/cli/tsup.config.ts`. Verify: `bun check`, `bun test`, Task 2 parity re-run.
  - Commit messages: `refactor(indexer): extract shared single-task parse` / `feat(indexer): parallelize phase-2 parse with worker pool`. No generated-by trailers.

- [ ] **Step 3: Final gates before push**

  `bun check` clean, `bun test` green, `git status` shows only the intended files. Do NOT bundle the unrelated uncommitted changes (`tsconfig.base.json` `baseUrl` removal, `bun check` script swaps) into these commits — those are a separate change with a separate rationale; commit or revert them independently.
