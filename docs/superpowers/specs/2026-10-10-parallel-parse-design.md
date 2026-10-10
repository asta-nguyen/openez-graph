# Parallel Parse — Worker Pool for Indexing

**Date:** 2026-10-10
**Status:** Implemented (uncommitted) — pending verification/landing
**Scope:** Parallelize the serial parse loop in `parseInline` (TS/JS via oxc, markdown, config) with a `node:worker_threads` pool. Tree-sitter native batch path untouched.

## Background

`parseInline` (`packages/indexer/src/index-workspace.ts:353`) has two phases:

1. **Native tree-sitter batch** (`:379-447`) — Python/Go/Rust files go through `parseCodeBatch`, already rayon-parallel. Untouched by this change.
2. **Remaining files** — TS/JS (oxc), markdown, config went through `chunkDocument` + `boundChunks` in a serial `for` loop, one file at a time. `oxc-parser` `parseSync` is synchronous CPU-bound work, so on large workspaces this loop blocks the event loop and dominates `openez index` wall time.

`packages/indexer/probe-oxc.cjs` (scratch, uncommitted) times `parseSync` across this repo's own TS/JS files — the motivation probe showing per-file parse cost worth parallelizing.

`node:worker_threads` was chosen over in-process concurrency because the work is CPU-bound, not I/O-bound — threads are the only way to use more than one core. It works under both Bun (source/dev) and Node (bundled CLI is CJS), unlike `Bun.Worker` which would tie the indexer to Bun.

## Approach

Two commits, each shippable. Commit 1 is pure refactor + serial extraction (zero behavior change — output identical by construction). Commit 2 adds the pool and the worker entries. If the pool misbehaves anywhere, both fallback levels degrade to today's serial behavior rather than failing the index.

## Commit 1 — Shared single-task parse + serial extraction

Zero behavior change. All in `packages/indexer/src/index-workspace.ts`:

### `parseSingleTask` (`:477`) — exported, shared by both paths

```ts
export async function parseSingleTask(task: ParseTask): Promise<ParseResult> {
  const indexed = await chunkDocument({ ... });
  if (indexed.kind === "code") {
    indexed.chunks = boundChunks(indexed.chunks, task.targetTokens, task.overlapTokens, task.counter);
  }
  return indexed;
}
```

This is the exact body of the old serial loop (chunk + bound oversized symbol chunks), lifted verbatim. The worker calls this same function, so chunk output is identical on both paths. `ParseTask` (`:339`) and `ParseResult` (`:351`) changed from private to exported to support it.

### `parseTasksSerial` (`:499`) — the old loop, extracted

Same loop, plus a `results.has(task.id)` skip so a slice that partially completed in a dead worker doesn't re-parse finished files on fallback.

### Gate (`:452-467`)

```ts
const parallelizable =
  otherTasks.length >= PARSE_WORKER_MIN_FILES &&
  otherTasks.every((task) => task.counter === fastTokenCounter);
```

- `PARSE_WORKER_MIN_FILES = 64` — below this, worker startup outweighs the gain.
- `counter === fastTokenCounter` — `TokenCounter` is a function, not structured-cloneable, so it can't cross the worker boundary. The production path always uses it (`:854`, and `chunkDocument`'s default at `:301`); custom counters stay serial.

Pool failure (`parseTasksInWorkers` throws) falls back to `parseTasksSerial` with a `[t]` stderr note.

### Verification

`bun check` clean, `bun test` 310 pass / 1 skip / 0 fail. Serial path output unchanged (same code, moved).

## Commit 2 — Worker pool + dual entries + bundling

### Pool (`parseTasksInWorkers`, `:570`)

- `workerCount = min(PARSE_WORKER_MAX = 8, cpuCount - 1, ceil(tasks / 32))`; `< 2` throws → serial.
- Round-robin slices (`i % workerCount`) — even split without measuring file sizes first (a `ponytail:`-grade simplification; size-aware scheduling when profiling says so).
- `Promise.all` over slices; a slice whose worker fails is finished serially (`slice.filter((task) => !results.has(task.id))`) with a `[t]` stderr note. One broken worker never fails the index.

### Slice protocol (`runWorkerSlice`, `:529` + `packages/indexer/src/parse-worker.ts`)

- Parent strips `counter` before `workerData` (functions don't clone), worker reattaches `fastTokenCounter` (`parse-worker.ts:26`).
- One `{ type: "result", id, result }` message per file → merged into the parent's `results` map with identical `onProgress` semantics. `{ type: "done" }` resolves; uncaught worker failure posts `{ type: "error" }` and the parent treats it as "re-run the rest of this slice serially". Non-zero exit without `done` also rejects.

### Entry resolution (`resolveParseWorkerEntry`, `:518`)

Tries `parse-worker.cjs` → `parse-worker.js` → `parse-worker.ts` next to `__dirname`:

- **Bundled CLI:** `apps/cli/src/parse-worker.ts` is a 5-line re-export shim existing only so tsup's second entry (`apps/cli/tsup.config.ts:17`) emits `dist/parse-worker.cjs` beside `dist/cli.cjs`. `oxc-parser` and other native/wasm deps stay `external` (tsup config `:28-42`) and resolve from `node_modules` at runtime, same as the main entry.
- **From source:** `packages/indexer/src/parse-worker.ts` sits next to `index-workspace.ts`.

**Resolved 2026-10-10:** the pool engages from source — 9/9 benchmark runs on 135–158-doc workspaces ran parallel with zero fallback lines. No `import.meta.dirname` fix needed under Bun 1.4.3.

### Verification

- `bun check` clean (worker files included in `src/**/*.ts`).
- Serial/parallel output parity + timing on a 64+ file workspace — not yet run (plan Task 2/3).
- Current test suite passes but almost certainly never engages the pool (fixtures < 64 files) — plan Task 4.

## Out of scope

Explicitly not this change (separate decisions, separate specs):

- **Phase-1 tree-sitter batch** — already rayon-parallel; not touched.
- **Removing the serial path** — it stays as the fallback and the small-workspace path.
- **Tuning `PARSE_WORKER_MIN_FILES` / `PARSE_WORKER_MAX` / slice sizing** — constants are first guesses; tune from measured numbers (plan Task 3), not before.
- **Watch-path incremental indexing** — this change targets full-workspace `index`; `watch` re-indexes single files and never reaches the threshold.
- **`probe-oxc.cjs`** — scratch probe with hardcoded absolute paths; delete or move to `bench/` on landing (plan Task 5).
- **Bun 1.4.3 `bun check` swap / `tsconfig.base.json` `baseUrl` removal** — separate uncommitted change, separate rationale.

## Measured results (2026-10-10, Bun 1.4.3, 8 cores, `bun src/cli.ts` from source)

Medians of 3 fresh-index runs per cell (`.openez` deleted before each run). `parse` = `[t] phase3 parse`; `TOTAL` = full index incl. db-write/fts. Serial forced via temporary `PARSE_WORKER_MIN_FILES = Infinity` (reverted after).

| Workspace                                                | Docs indexed | Serial parse | Pool parse | Parse speedup | Serial TOTAL | Pool TOTAL |
| -------------------------------------------------------- | ------------ | ------------ | ---------- | ------------- | ------------ | ---------- |
| small (30 files, below threshold — serial both, control) | 29           | 97ms         | 92ms       | —             | 133ms        | 127ms      |
| medium (200 files)                                       | 135          | 377ms        | 385ms      | 0.98x         | 463ms        | 481ms      |
| large (664 files)                                        | 158          | 460ms        | 403ms      | 1.14x         | 560ms        | 510ms      |
| bigfiles (70 files, ~35KB avg)                           | 70           | 888ms        | 690ms      | 1.29x         | 1053ms       | 999ms      |

**Parity:** medium workspace pool vs serial DBs diffed clean — 135 `documents` rows and 765 `chunks` rows identical on `(path, content_hash, token_count)`.

**Why the gain is small:** worker spawn+init costs ~124–225ms per worker (measured: empty-task spawn of `parse-worker.ts` under Bun — transpile + import graph init), and all workers spawn concurrently so each index run pays ~150ms fixed, plus structured-clone of file contents and per-file IPC. The fixtures average 2–3ms/file (medium: 377ms / 135), so fixed cost ≈ parallel gain: 377/7 ≈ 54ms ideal + ~150ms fixed + clone/IPC ≈ 385ms actual. The pool only pays when parse work ≫ fixed cost (bigfiles: 888/3 ≈ 300ms + fixed ≈ 690ms actual).

**Follow-ups (not this landing):** persistent worker pool reused across index calls (kills the per-run spawn cost), fewer workers for small batches, size-aware slicing instead of round-robin, raising `PARSE_WORKER_MIN_FILES` or gating on total bytes rather than file count. Re-measure before changing any constant.

**Bottom line:** correctness and fallback design verified (parity identical, 12/12 pool runs engaged, 0 failures); throughput win is 1.0–1.3x on realistic small-file repos. Land for the architecture, not the numbers.
