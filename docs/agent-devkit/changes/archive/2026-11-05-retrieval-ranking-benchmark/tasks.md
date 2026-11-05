# Retrieval ranking benchmark tasks

## Design

[Retrieval ranking benchmark, exact-symbol lookup, and hub-aware graph ranking](design.md)

## Global Constraints

- `tests/fixtures/retrieval-eval.json` (concept suite, 17 cases) is not edited.
- No change to settings defaults, RRF weights for FTS (2) and vector (1), `graphHops`,
  `maxGraphNeighbors`, DB schema, MCP tool schemas, CLI, or dependencies.
- Exact-symbol list joins the first `reciprocalRankFusion` call with weight 3.
- A token matching more than 5 symbol nodes contributes nothing.
- Exact-symbol matching is case-sensitive equality on `graph_nodes.label` with
  `type = 'symbol'`; `.` and `::` forms are both tried.
- Graph candidate order: `distance ASC, degree ASC, documents.path ASC, chunks.id ASC`;
  no degree cutoff.
- No runtime flag for the exact-symbol stage; its ablation is baseline run vs.
  post-change run.
- Exact-symbol tokens are eligible only when identifier-shaped (contain `_`, `$`, `.`,
  `::`, or a lowercase→uppercase transition) or equal to the whole trimmed query.
- Acceptance (revised, see Decision Log): identifier suite recall@5 or MRR improves
  under `lexical`; concept suite recall@5 does not drop and concept MRR drops ≤ 0.03
  under every configuration that has a same-corpus control; relations suite under
  `lexical+graph` does not drop.

## Suggested executors

| Task                      | Executor                                                      | Why                                                       |
| ------------------------- | ------------------------------------------------------------- | --------------------------------------------------------- |
| 1, 2, 5, 6, 7             | Sonnet 5.5, medium effort                                     | Fixtures, benchmark wiring, running and recording numbers |
| 3, 4                      | Sonnet 5.5, medium effort (high if Task 3's tests fail twice) | Small, test-first ranking changes in one file             |
| Final `review-and-verify` | Opus 5.5                                                      | Judges the acceptance numbers against the design          |

Each executor starts by reading `design.md` and this file, and runs the
implementation baseline in `design.md` → `## Verification` before its first source
edit (Task 1 for the whole change).

## Impact map

```text
Entry: packages/core/src/retrieval.ts::codeQuery
Flow: apps/mcp/src/mcp-core.ts (code_query, ensureGraph: ensureGraphReady) and
  apps/web/src/server/index.ts (search, skipGraphExpand: true) → codeQuery →
  repo.fullTextSearch ∥ vectorSearch → reciprocalRankFusion (packages/core/src/rrf.ts)
  → ensureGraph → graphExpand (recursive CTE over graph_nodes/graph_edges) → RRF →
  token-budget selection
State changes: none found in the ranking path (query_logs insert is unchanged)
External effects: none found
Change candidates: packages/core/src/retrieval.ts (codeQuery, graphExpand, new
  exact-symbol helper), tests/embed-benchmark.test.ts, two new fixtures, a retrieval
  test file, README.md:40, apps/cli/README.md:108, AGENTS.md:157
Verification: bun test tests/retrieval-eval.test.ts tests/fts-retrieval.test.ts
  tests/hybrid-retrieval.test.ts tests/e2e-search.test.ts tests/graph-lifecycle.test.ts
  tests/mcp-tools.test.ts; pnpm benchmark:retrieval; pnpm typecheck; bun test
Verified at: aa317e087dcafde080e0536f65a561360cc8dbb0
```

Web search (`skipGraphExpand: true`) gains the exact-symbol stage whenever the
workspace graph has already been built, because the stage reads existing
`graph_nodes`; it does not trigger a graph build.

## Tasks

### Task 1 — Benchmark suites and graph configurations

Files: tests/fixtures/retrieval-eval-identifiers.json (new),
tests/fixtures/retrieval-eval-relations.json (new),
tests/embed-benchmark.test.ts::runEvaluation, tests/embed-benchmark.test.ts::"retrieval benchmark"
Interfaces: consumes `parseRetrievalCases`, `evaluateRetrieval`, `summarizeQuality`
(packages/indexer/src/retrieval-eval.ts, unchanged) and `ensureGraphReady`
(packages/indexer/src); produces the per-configuration × per-suite report used by
Tasks 2 and 5.
Change:

- Identifier fixture, ≥ 10 `{ query, expectedPaths }` cases. Each query is or contains
  one symbol name; `expectedPaths` is the defining file only. ≥ 3 cases use a label
  that also appears as a word in other files' bodies (candidates to verify:
  `codeQuery`, `graphExpand`, `vectorSearch`); ≥ 2 use `.`-qualified TS member labels
  present in `graph_nodes` (for example `createWorkspaceResolver.resolveWorkspaceByPath`,
  `fitToTokenBudget.measure`). Pick only labels carried by ≤ 5 symbol nodes.
- Relations fixture, ≥ 6 cases of the form "what calls X" / "what does X call";
  `expectedPaths` lists only files other than X's own file that are one `calls` edge
  away. Confirm each with OpenEZ `code_context` (hops 1) before committing it.
- `runEvaluation` takes the suite cases and a graph toggle: graph off passes
  `skipGraphExpand: true`; graph on passes `ensureGraph: ensureGraphReady`.
- The test runs configurations in order `lexical`, `lexical+graph`, and with
  `OPENEZ_BENCHMARK_EMBEDDINGS=1` also `hybrid`, `hybrid+graph`, over all three suites,
  and logs one object keyed by configuration then suite with `recallAt5`, `mrr`,
  `duplicatePathRate`, `evaluatedRuns`, `avgLatencyMs`.
- The stale-path check covers all three fixtures.
- The existing floors (recall@5 ≥ 0.7, MRR ≥ 0.45) apply to the concept suite under
  `lexical`; the embeddings tolerance check (≥ lexical − 0.02) stays on the concept
  suite. New suites are not gated.
- Raise the `beforeAll`/test timeouts only if the graph build exceeds 120 s.
  Verify: `bun test tests/retrieval-eval.test.ts` passes unchanged (concept fixture not
  edited); `pnpm benchmark:retrieval` passes and prints `lexical` and `lexical+graph`
  results for `concept`, `identifiers`, `relations`; deleting one new fixture's
  expected file path in a scratch copy produces the "Stale retrieval fixture paths" error.
  Progress: done
  Result: bun test (retrieval-eval etc.) passes; `pnpm benchmark:retrieval` prints all 3 suites for lexical and lexical+graph; stale-path error reproduced — pass

### Task 2 — Record the baseline

Files: docs/agent-devkit/changes/archive/2026-11-05-retrieval-ranking-benchmark/results.md (new)
Interfaces: consumes Task 1's report; produces the baseline table that Task 5 compares.
Change: On the Task 1 commit, before any `packages/core/src/retrieval.ts` edit, run
`pnpm benchmark:retrieval`; if an embedding provider is configured locally, also run
`pnpm benchmark:retrieval:embeddings`, otherwise write "embeddings: not run, no
provider". Record commit SHA, date, files/chunks counts, and a table of configuration ×
suite × (recall@5, MRR, duplicatePathRate, avgLatencyMs). List every identifier and
relations case that misses top 5 under `lexical+graph`, with its first relevant rank.
Verify: `results.md` contains the SHA from `git rev-parse HEAD`, both lexical
configurations for all three suites, and the miss list; numbers match the console
output of the run.
Progress: done
Result: results.md baseline written with SHA, both lexical and hybrid configurations, miss lists — pass

### Task 3 — Exact-symbol candidate list in codeQuery

Files: packages/core/src/retrieval.ts::codeQuery, packages/core/src/retrieval.ts (new
module-private exact-symbol helper), tests/exact-symbol-retrieval.test.ts (new)
Interfaces: consumes `createWorkspaceRepository(...).queryRaw` and `ChunkHit`; produces a
`ChunkHit[]` list fused into the first RRF call. `CodeQueryInput` and `CodeQueryResult`
are unchanged.
Change:

- When `skipGraphExpand` is false, call `input.ensureGraph(workspaceId)` before the
  FTS/vector/exact searches instead of after them; graph expansion keeps using the
  same built graph.
- Tokens: matches of `/[A-Za-z_$][\w$]*(?:(?:::|\.)[A-Za-z_$][\w$]*)*/g`, length ≥ 3,
  deduplicated in query order; each token with `.` is also tried with `::`, and each
  with `::` also with `.`.
- For each token, select symbol nodes with `label` equal to a form of the token, joined
  to `chunks` (on `ref_id`) and `documents`; skip the token when it matches > 5 nodes.
- Collect hits in token order, dedupe by path, and pass them as a third list to the
  first `reciprocalRankFusion` call with weights `[2, 1, 3]` aligned to FTS, vector,
  exact. Keep the existing filter that drops empty lists, and keep weights aligned
  with the lists that remain.
- No catch is added around `ensureGraph`.
- Test cases (write first, confirm they fail where behavior is new):
  1. Workspace with `defines-target.ts` declaring `function computeLedgerTotal` and three
     files whose comments repeat `computeLedgerTotal` at least three times each (so FTS
     alone ranks a mentioning file first — assert that on the graph-less run); after
     graph build, query `computeLedgerTotal` → first source path is `defines-target.ts`.
  2. Seven files each declaring `function run`; query `run` → result ordering equals the
     same query with `skipGraphExpand: true` before the graph exists (no exact boost).
  3. TS class `Billing` with method `total`, whose graph label is `Billing.total`;
     query `Billing::total` → the defining file is first.
  4. Fresh index, no graph built, `skipGraphExpand: true`, query `computeLedgerTotal`
     → sources equal FTS-only ranking (exact list empty, no error).
  5. Query `how are things stored`, in a fixture with no symbol labelled `how`, `are`,
     `things`, or `stored` → sources after graph build equal sources before graph build.
  6. Symbol node whose chunk was deleted → no error, node ignored.
     Verify: `bun test tests/exact-symbol-retrieval.test.ts tests/retrieval-eval.test.ts
tests/hybrid-retrieval.test.ts tests/e2e-search.test.ts tests/graph-lifecycle.test.ts
tests/mcp-tools.test.ts` passes; `pnpm typecheck` passes.
     Progress: done
     Result: `bun test tests/exact-symbol-retrieval.test.ts` and related suites pass (69 tests); `pnpm typecheck` clean — pass

### Task 4 — Degree-aware graph neighbor ordering

Files: packages/core/src/retrieval.ts::graphExpand, tests/exact-symbol-retrieval.test.ts
(or a new tests/graph-expand-ranking.test.ts)
Interfaces: consumes the graph built by `ensureGraphReady`; produces the same
`ChunkHit[]` shape and score formula `1.0 / (distance + 1)`.
Change:

- Compute each candidate symbol node's degree as the count of `graph_edges` rows where
  it is `from_node_id` or `to_node_id`.
- Order candidates by `distance ASC, degree ASC, documents.path ASC, chunks.id ASC` in
  the `candidate_chunks` selection (before its `LIMIT`) and in the final `SELECT`.
- Walk, hops, seeds, edge types, and limits are unchanged; no degree cutoff.
- Test cases (write first):
  1. `seed.ts::start` calls `hub.ts::sharedUtil` and `leaf.ts::specificStep`;
     `sharedUtil` is also called from 6 other files. With `maxGraphNeighbors` = 1 and
     `graphHops` = 1, the graph neighbor returned for seed `start` is `leaf.ts`.
  2. Two neighbors with equal distance and degree in `b-file.ts` and `a-file.ts` →
     `a-file.ts` precedes `b-file.ts`, stable across two runs.
     Verify: the new graph test passes; `bun test tests/retrieval-eval.test.ts
tests/e2e-search.test.ts tests/graph-lifecycle.test.ts` passes (the
     `callerGraph`→`helper-graph.ts` assertion still holds); `pnpm typecheck` passes.
     Progress: done
     Result: `bun test tests/graph-expand-ranking.test.ts` and related suites pass; `pnpm typecheck` clean — pass

### Task 6 — Identifier-shaped token eligibility

Files: packages/core/src/retrieval.ts::exactSymbolSearch, tests/exact-symbol-retrieval.test.ts
Interfaces: consumes Task 3's `exactSymbolSearch`; produces the same `ChunkHit[]` list.
Change: Before the label lookup, keep a token only when it contains `_`, `$`, `.`, `::`,
or matches `/[a-z][A-Z]/`, or when it equals `query.trim()`. Everything else in
`exactSymbolSearch` and `codeQuery` is unchanged.
Test cases (write first, confirm 1 and 2 fail before the change):

1. Fixture with `function local()` in `other.ts` and the expected answer in
   `hint.ts` (FTS-ranked first for the query); query `where is the local workspace
hint written?` after graph build → first source equals the graph-less run's first
   source (`local` is not boosted).
2. Same for `function index()` and a sentence containing `index`.
3. Bare query `local` → `other.ts` is first (whole-query exception).
4. Existing Task 3 cases 1–6 still pass (`computeLedgerTotal`, `Billing::total` are
   identifier-shaped).
   Verify: `bun test tests/exact-symbol-retrieval.test.ts tests/graph-expand-ranking.test.ts
tests/retrieval-eval.test.ts tests/e2e-search.test.ts` passes; `pnpm typecheck` passes.
   Progress: done
   Result: exact-symbol, graph-expand, retrieval-eval, e2e-search tests pass (25); 2 new tests failed before the change; typecheck clean — pass

### Task 7 — Isolated re-measurement

Files: docs/agent-devkit/changes/archive/2026-11-05-retrieval-ranking-benchmark/results.md
Interfaces: consumes Tasks 3, 4, 6; produces the numbers Task 5 judges.
Change: On one unchanged corpus (record files/chunks), run `pnpm benchmark:retrieval`
and, when a local provider is configured, `pnpm benchmark:retrieval:embeddings`, for
three variants of `packages/core/src/retrieval.ts`, restoring the working version after
each: (a) control = HEAD `retrieval.ts`; (b) exact only = working version with the
`graphExpand` ORDER BY changes reverted to HEAD; (c) full = working version. Revert
by copying file contents, never `git stash`/`git checkout` over other changes. Add one
table per variant and, for every concept case whose first relevant rank differs from
control, a row `query | control | exact only | full`.
Verify: `git diff HEAD -- packages/core/src/retrieval.ts` after the runs equals the
diff before them; `results.md` has all three variants for every configuration run and
the moved-case table.
Progress: done
Result: results.md has control/exact-only/full for lexical and hybrid configurations plus moved-case table; retrieval.ts diff unchanged — pass

### Task 5 — Post-change benchmark and documentation

Files: docs/agent-devkit/changes/archive/2026-11-05-retrieval-ranking-benchmark/results.md,
README.md:40, apps/cli/README.md:108, AGENTS.md:157
Interfaces: consumes Task 7's numbers (run Tasks 6 and 7 first); the earlier
post-change run stays in `results.md` as history.
Change:

- Rerun the same benchmark commands as Task 2 and add an "After" table plus a delta
  column per configuration × suite, and the updated miss list.
- Evaluate the acceptance criteria from Global Constraints and write pass/fail for each.
  If any fails, stop and report it with the misses; do not tune weights, limits, or
  token rules (that is a new decision for `plan-feature`).
- Docs: README.md:40 and apps/cli/README.md:108 mention exact symbol-name matching
  alongside FTS/vector and graph expansion; AGENTS.md:157 states "Retrieval defaults to
  FTS + exact symbol-name lookup + graph expansion." with the embeddings sentence kept.
  Verify: `results.md` has before/after for every configuration run in Task 2 and an
  explicit pass/fail line per acceptance criterion; `bun test` and `pnpm typecheck` pass;
  `pnpm format:check` passes on the edited Markdown.
  Progress: done
  Result: all four acceptance criteria pass (results.md); README.md, apps/cli/README.md, AGENTS.md updated — pass

## Files inspected, no change

- packages/core/src/rrf.ts — RRF uses rank only (`weight / (k + index + 1)`); explains
  why score-gap seed cutoff is out of scope.
- packages/indexer/src/retrieval-eval.ts — metrics helpers reused as-is.
- tests/retrieval-eval.test.ts — CI quality gate on the concept fixture with
  `skipGraphExpand: true`; must stay green unchanged.
- packages/config/src/types.ts — defaults `graphHops: 1`, `maxGraphNeighbors: 15`
  (unchanged; with 1 hop a transit-hub guard would have no effect).
- packages/db/src/sqlite/workspace-db.ts — `graph_nodes`/`graph_edges` schema; no
  migration needed.
- apps/web/src/server/index.ts — search route calls `codeQuery` with
  `skipGraphExpand: true`.
- tests/e2e-search.test.ts, tests/graph-lifecycle.test.ts — existing `codeQuery`
  assertions to keep green.
- Local index of this repo — 1166 symbol nodes, p99 symbol degree 12, max 37; label
  formats `name` and `Owner.member` (TS) / `Owner::member` (other languages); `run`
  carries 14 nodes.

## Approval Gate

Status: approved

## Decision Log

- 2026-11-05 — Revision after the first post-change benchmark failed the concept
  limit under `lexical+graph` (MRR 0.587 → 0.537). Evidence: of 17 concept queries only
  two have an eligible exact hit under the original rule (`local` → a JS fixture,
  `index` → `tests/exact-symbol-retrieval.test.ts`); the −0.050 is two rank 1→2 swaps
  (−0.5 each) offset by one none→6 (+0.167). One swap on 17 cases is 0.029, so the
  0.02 limit was below metric resolution. Changes: Task 6 adds identifier-shaped token
  eligibility; Task 7 re-measures with a same-corpus control and an exact-only variant
  so degree ordering's effect ("SQLite workspace registry" 1→2, no exact hit) is
  isolated; acceptance becomes concept recall@5 unchanged and MRR drop ≤ 0.03. Tasks
  1–4 keep their results. Gate reset to pending.
