# Retrieval ranking benchmark, exact-symbol lookup, and hub-aware graph ranking

## Goal

Make `code_query` ranking changes measurable, then fix the two ranking weaknesses
found while comparing OpenEZ with Graphify:

1. Identifier queries (`codeQuery`, `Invoice::build`) have no exact-name signal:
   RRF keeps only rank, so a chunk that _defines_ the symbol ties with chunks that
   merely mention it.
2. Graph expansion orders neighbors by hop distance, then alphabetically by path,
   so high-degree utility symbols (`createWorkspaceRepository`, in-degree 24) and
   arbitrary alphabetic winners take the `maxGraphNeighbors` slots.

Observable success: the benchmark reports recall@5 and MRR per query suite and per
pipeline configuration, the identifier suite improves after the exact-symbol stage,
and the existing concept suite does not drop more than 0.02 in recall@5 or MRR.

## Scope

In scope:

- Extend the existing opt-in benchmark (`tests/embed-benchmark.test.ts`,
  `pnpm benchmark:retrieval`) to measure graph expansion and per-suite results.
- Two new gold fixtures: identifier queries and relationship queries.
- An exact-symbol candidate list in `codeQuery`.
- Degree-aware, deterministic neighbor ordering in `graphExpand`.
- Documentation lines that describe the retrieval pipeline.

Out of scope (recorded follow-ups, not part of this change):

- Score-gap seed cutoff. RRF scores are compressed (all observed scores fall
  between 0.014 and 0.021), so a ratio cutoff cannot fire without a
  magnitude-preserving fusion step.
- Chunk-level (instead of path-level) dedupe, and same-file neighbor surfacing.
- Vector-scan cost (`rankStoredEmbeddings` selects `chunks.content` for every row).
- Truncation hint text, PreToolUse hooks, edge confidence labels.
- Any change to RRF weights, `graphHops`, `maxGraphNeighbors`, or other settings defaults.
- Embedding provider changes.

## Behavior

### Benchmark

- Suites: the existing `tests/fixtures/retrieval-eval.json` (concept, 17 cases,
  unchanged), plus `tests/fixtures/retrieval-eval-identifiers.json` (≥10 cases)
  and `tests/fixtures/retrieval-eval-relations.json` (≥6 cases). The new files use
  the existing `{ query, expectedPaths }` shape, so `parseRetrievalCases` is unchanged.
- Identifier cases: the query is or contains one symbol name; the expected path is
  the defining file. At least 3 cases use a label that also appears as a word in
  other files' bodies, and at least 2 use `.`-qualified TS member labels.
- Relationship cases: the query names a symbol and asks for its callers or callees
  (for example "what calls graphExpand"); `expectedPaths` lists only files that are
  _not_ the symbol's own file and are reached by one `calls` edge. Each case is
  checked with `code_context` before it is committed.
- Configurations, run in this order on the same indexed workspace:
  `lexical` (embedding provider `none`, `skipGraphExpand: true`) and
  `lexical+graph` (provider `none`, `ensureGraph: ensureGraphReady`); with
  `OPENEZ_BENCHMARK_EMBEDDINGS=1` also `hybrid` and `hybrid+graph`.
- Output: one `console.log` object with, for each configuration × suite,
  `recallAt5`, `mrr`, `duplicatePathRate`, `evaluatedRuns`, `avgLatencyMs`.
- The existing FTS floors (recall@5 ≥ 0.7, MRR ≥ 0.45) still apply to the concept
  suite under `lexical`. The new suites are reported, not gated.
- "Lexical" deliberately includes the exact-symbol stage once it exists: the
  ablation for that stage is the baseline run versus the post-change run, not a
  runtime flag.

### Exact-symbol stage (`codeQuery`)

- When `skipGraphExpand` is false, `ensureGraph` runs before candidate search
  instead of after it, so the graph is current for the exact-symbol lookup.
- Query tokens: matches of `/[A-Za-z_$][\w$]*(?:(?:::|\.)[A-Za-z_$][\w$]*)*/g`,
  at least 3 characters, deduplicated. A token containing `.` is also tried with
  `::`, and a token containing `::` is also tried with `.`.
- A token is eligible only when it is identifier-shaped — it contains `_`, `$`, `.`,
  `::`, or a lowercase letter immediately followed by an uppercase letter — or when it
  equals the whole trimmed query (a bare lookup such as `tokenize`). Plain words
  inside a sentence (`local`, `index`, `workspace`) never reach the label lookup.
- A token matches `graph_nodes` rows with `type = 'symbol'` and a `label` that is
  equal to it (case-sensitive), joined to the row's chunk and document.
- If a token matches more than 5 symbol nodes, it contributes nothing (generic
  labels such as `run` or `helper`).
- Results are deduplicated by path, ordered by token order in the query, and passed
  to the first `reciprocalRankFusion` call as a third list with weight 3. The
  existing FTS (2) and vector (1) weights are unchanged.
- Seeds for graph expansion are still the top `min(finalLimit, 5)` fused entries.

### Graph neighbor ordering (`graphExpand`)

- Each candidate neighbor carries its symbol-node degree (count of `graph_edges`
  rows where it is `from_node_id` or `to_node_id`).
- Candidate ordering, both before the `LIMIT` and in the final result, is
  `distance ASC, degree ASC, documents.path ASC, chunks.id ASC`.
- No degree cutoff: on this repository p99 symbol degree is 12 and the maximum is 37,
  so a fixed threshold such as Graphify's `max(50, p99)` would never apply.
- Traversal (edges walked, hop count, seed set, returned score formula) is unchanged.

## Edge cases

- Graph not built (`skipGraphExpand: true` on a fresh index): the exact-symbol list
  is empty and ranking equals today's FTS/vector ranking. `retrieval-eval.test.ts`
  runs in this state and must keep passing unchanged.
- Symbol node whose `ref_id` no longer matches a chunk (one exists in the current
  repo index): dropped by the inner join, no error.
- Query with no identifier-shaped token of length ≥ 3: exact list empty.
- English words equal to a symbol label (`index`, `local`): ignored inside a sentence
  by the eligibility rule; still matched when the word is the whole query. No stopword
  list is added. Consequence: a single-word lowercase symbol (`tokenize`) gets the exact
  boost only as a bare query; inside a sentence it relies on FTS as before.
- `ensureGraph` rejection: behaves as today (the error propagates from `codeQuery`);
  moving the call earlier does not add a catch.
- Benchmark fixture path that no longer exists: the run fails with the existing
  "Stale retrieval fixture paths" error, now also for the new fixtures.
- Graph build exceeds the 120 s hook timeout on a large repository: raise the
  timeout in the benchmark only.

## Interfaces

- `codeQuery` (`packages/core/src/retrieval.ts`): input and output types unchanged;
  ranking of `sources` changes. This is the behavior behind the MCP `code_query` tool
  and the web search route; no MCP schema change.
- `graphExpand` (same file, module-private): signature unchanged.
- `tests/embed-benchmark.test.ts`: reports per configuration and suite; the
  `pnpm benchmark:retrieval` and `pnpm benchmark:retrieval:embeddings` scripts are
  unchanged.
- New fixtures: `tests/fixtures/retrieval-eval-identifiers.json`,
  `tests/fixtures/retrieval-eval-relations.json`.
- No schema, migration, settings, CLI, or dependency change.

## Verification

- Baseline before any source edit: `bun test tests/retrieval-eval.test.ts
tests/fts-retrieval.test.ts tests/hybrid-retrieval.test.ts tests/e2e-search.test.ts
tests/mcp-tools.test.ts` and `pnpm typecheck`, failures recorded.
- Benchmark baseline: `pnpm benchmark:retrieval` on the commit that adds the new
  fixtures and configurations, before the ranking changes; numbers saved in
  `results.md` in this folder.
- Exact-symbol stage: a unit test in `tests/hybrid-retrieval.test.ts` (or a new
  `tests/exact-symbol-retrieval.test.ts`) proving (a) a defining file outranks a
  mentioning file for a bare identifier query, (b) a label carried by more than 5
  nodes contributes nothing, (c) `.`/`::` alternates resolve, (d) no graph means no
  change.
- Graph ordering: a unit test where a seed calls one hub (high degree) and one
  leaf; with `maxGraphNeighbors` = 1 the leaf is returned; and an equal-degree tie
  resolves by path.
- Post-change: `pnpm benchmark:retrieval` again; `results.md` records before/after
  per suite and configuration, always against a control run of HEAD
  `retrieval.ts` on the same corpus. Acceptance: identifier suite recall@5 or MRR
  improves under `lexical`; concept suite recall@5 does not drop and concept MRR drops
  by no more than 0.03 under every configuration measured with a control; relations
  suite under `lexical+graph` does not drop. The 0.03 limit is one rank-1→2 swap on the
  17-case concept suite (0.5 / 17 = 0.029); a smaller limit is below the metric's
  resolution.
- Isolation: the post-change run also measures "exact only" (degree ordering reverted)
  so each change's effect on the concept suite is attributed.
- Full `bun test` and `pnpm typecheck` pass.

## Related context

None. `docs/llm/` does not exist in this repository.
