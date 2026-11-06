# Results

## Baseline (before ranking changes)

- Commit: `aa317e087dcafde080e0536f65a561360cc8dbb0` plus uncommitted Task 1 changes (benchmark wiring and fixtures only; no `packages/core/src/retrieval.ts` edit)
- Date: 2026-11-05
- Workspace: 317 files, 1847 chunks; suites: concept 17, identifiers 19, relations 7 cases
- `lexical`, `lexical+graph` from `pnpm benchmark:retrieval`; `hybrid`, `hybrid+graph` from `pnpm benchmark:retrieval:embeddings` (local embedding provider)
- `lexical+graph` concept latency includes the one-time graph build.

| configuration | suite       | recall@5 | MRR   | duplicatePathRate | avgLatencyMs |
| ------------- | ----------- | -------- | ----- | ----------------- | ------------ |
| lexical       | concept     | 0.706    | 0.544 | 0.000             | 14.2         |
| lexical       | identifiers | 1.000    | 0.965 | 0.000             | 2.5          |
| lexical       | relations   | 0.714    | 0.298 | 0.000             | 6.0          |
| lexical+graph | concept     | 0.706    | 0.586 | 0.000             | 1553.4       |
| lexical+graph | identifiers | 1.000    | 0.974 | 0.000             | 3.7          |
| lexical+graph | relations   | 0.571    | 0.310 | 0.000             | 6.4          |
| hybrid        | concept     | 0.706    | 0.543 | 0.000             | 34.9         |
| hybrid        | identifiers | 1.000    | 1.000 | 0.000             | 37.8         |
| hybrid        | relations   | 0.714    | 0.298 | 0.000             | 42.0         |
| hybrid+graph  | concept     | 0.706    | 0.586 | 0.000             | 1524.0       |
| hybrid+graph  | identifiers | 1.000    | 1.000 | 0.000             | 21.8         |
| hybrid+graph  | relations   | 0.571    | 0.310 | 0.000             | 23.6         |

### Misses (first relevant rank not 1)

- lexical/identifiers: `indexWorkspace` rank 3
- lexical/relations: `what calls getBrainSettings` rank 2; `what calls reciprocalRankFusion` rank 2; `what calls formatEmbeddingInput` rank 2; `what calls parseRetrievalCases` rank 4; `what does codeQuery call` rank none; `what does embedWorkspace call` rank none; `what calls evaluateRetrieval` rank 3
- lexical+graph/identifiers: `indexWorkspace` rank 2
- lexical+graph/relations: `what calls getBrainSettings` rank 2; `what calls reciprocalRankFusion` rank 2; `what calls formatEmbeddingInput` rank 2; `what calls parseRetrievalCases` rank 2; `what does codeQuery call` rank none; `what does embedWorkspace call` rank none; `what calls evaluateRetrieval` rank 6
- hybrid+graph/identifiers:
- hybrid+graph/relations: `what calls getBrainSettings` rank 2; `what calls reciprocalRankFusion` rank 2; `what calls formatEmbeddingInput` rank 2; `what calls parseRetrievalCases` rank 2; `what does codeQuery call` rank none; `what does embedWorkspace call` rank none; `what calls evaluateRetrieval` rank 6

## After (exact-symbol stage + degree-aware ordering)

Same commands as the baseline. The corpus grew from 317 files / 1847 chunks to 320 files / 1858 chunks (the three new test files), so the baseline above is not a like-for-like control.

| configuration | suite       | recall@5 | MRR   | duplicatePathRate | avgLatencyMs |
| ------------- | ----------- | -------- | ----- | ----------------- | ------------ |
| lexical       | concept     | 0.706    | 0.504 | 0.000             | 14.4         |
| lexical       | identifiers | 1.000    | 1.000 | 0.000             | 2.8          |
| lexical       | relations   | 0.714    | 0.207 | 0.000             | 6.3          |
| lexical+graph | concept     | 0.706    | 0.537 | 0.000             | 1496.4       |
| lexical+graph | identifiers | 1.000    | 1.000 | 0.000             | 4.4          |
| lexical+graph | relations   | 0.714    | 0.357 | 0.000             | 8.6          |
| hybrid        | concept     | 0.706    | 0.473 | 0.000             | 33.4         |
| hybrid        | identifiers | 1.000    | 1.000 | 0.000             | 22.0         |
| hybrid        | relations   | 0.714    | 0.207 | 0.000             | 24.4         |
| hybrid+graph  | concept     | 0.706    | 0.537 | 0.000             | 1520.0       |
| hybrid+graph  | identifiers | 1.000    | 1.000 | 0.000             | 22.6         |
| hybrid+graph  | relations   | 0.714    | 0.357 | 0.000             | 25.0         |

### Misses (first relevant rank not 1)

- lexical/identifiers:
- lexical/relations: `what calls getBrainSettings` rank 3; `what calls reciprocalRankFusion` rank 3; `what calls formatEmbeddingInput` rank 3; `what calls parseRetrievalCases` rank 5; `what does codeQuery call` rank none; `what does embedWorkspace call` rank none; `what calls evaluateRetrieval` rank 4
- lexical+graph/identifiers:
- lexical+graph/relations: `what calls getBrainSettings` rank 2; `what calls reciprocalRankFusion` rank 2; `what calls formatEmbeddingInput` rank 2; `what calls parseRetrievalCases` rank 2; `what does codeQuery call` rank none; `what does embedWorkspace call` rank none; `what calls evaluateRetrieval` rank 2
- hybrid+graph/identifiers:
- hybrid+graph/relations: `what calls getBrainSettings` rank 2; `what calls reciprocalRankFusion` rank 2; `what calls formatEmbeddingInput` rank 2; `what calls parseRetrievalCases` rank 2; `what does codeQuery call` rank none; `what does embedWorkspace call` rank none; `what calls evaluateRetrieval` rank 2

## Control: old `retrieval.ts` on the current corpus (lexical only)

Run with `packages/core/src/retrieval.ts` reverted to HEAD, same 320-file corpus. Hybrid was not re-run on the old code.

| configuration | suite       | recall@5 | MRR   | duplicatePathRate | avgLatencyMs |
| ------------- | ----------- | -------- | ----- | ----------------- | ------------ |
| lexical       | concept     | 0.706    | 0.514 | 0.000             | 22.0         |
| lexical       | identifiers | 1.000    | 0.965 | 0.000             | 3.8          |
| lexical       | relations   | 0.714    | 0.207 | 0.000             | 12.7         |
| lexical+graph | concept     | 0.706    | 0.587 | 0.000             | 1468.4       |
| lexical+graph | identifiers | 1.000    | 0.974 | 0.000             | 4.3          |
| lexical+graph | relations   | 0.714    | 0.333 | 0.000             | 9.8          |

## Acceptance

Compared against the control (same corpus), since the corpus changed between runs.

| Criterion                                                 | Result                                                                                                                                 |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Identifier suite recall@5 or MRR improves under `lexical` | PASS: MRR 0.965 → 1.000 (`indexWorkspace` rank 3 → 1)                                                                                  |
| Concept drop ≤ 0.02, `lexical`                            | PASS: MRR 0.514 → 0.504 (−0.010), recall@5 unchanged                                                                                   |
| Concept drop ≤ 0.02, `lexical+graph`                      | **FAIL**: MRR 0.587 → 0.537 (−0.050), recall@5 unchanged                                                                               |
| Concept drop ≤ 0.02, `hybrid` / `hybrid+graph`            | not measurable against a control; vs. the original baseline `hybrid` MRR 0.543 → 0.473 (−0.070), `hybrid+graph` 0.586 → 0.537 (−0.049) |
| Relations suite under `lexical+graph` does not drop       | PASS: recall@5 0.714 → 0.714, MRR 0.333 → 0.357                                                                                        |

Concept cases that moved under `lexical+graph` (control → after): "where is workspace indexing implemented?" none → 6; "where is the SQLite workspace registry opened?" 1 → 2; "where is the local workspace hint written?" 1 → 2; "how does the retrieval pipeline work?" 7 → 8.

Likely cause (not verified in isolation): ordinary English words in concept queries ("workspace", "registry", "indexing", "written") equal symbol labels carried by ≤ 5 nodes, so the exact list boosts unrelated definers. The design deliberately has no stopword list. Per Task 5, weights, limits and token rules are not tuned here; the fix is a new decision for `plan-feature`.

## Isolated re-measurement (Task 7)

One corpus for all variants: 321 files, 1867–1868 chunks (the one-chunk difference is the change folder's own files being re-indexed). Variants of `packages/core/src/retrieval.ts`: control = HEAD; exact only = working version with the `graphExpand` ORDER BY reverted to HEAD; full = working version including Task 6 token eligibility. `git diff HEAD -- retrieval.ts` was identical before and after the runs.

### Control (HEAD)

| configuration | suite       | recall@5 | MRR   | duplicatePathRate | avgLatencyMs |
| ------------- | ----------- | -------- | ----- | ----------------- | ------------ |
| lexical       | concept     | 0.706    | 0.510 | 0.000             | 16.0         |
| lexical       | identifiers | 1.000    | 0.965 | 0.000             | 2.4          |
| lexical       | relations   | 0.714    | 0.207 | 0.000             | 6.7          |
| lexical+graph | concept     | 0.706    | 0.557 | 0.000             | 1605.7       |
| lexical+graph | identifiers | 1.000    | 0.974 | 0.000             | 4.1          |
| lexical+graph | relations   | 0.714    | 0.333 | 0.000             | 8.9          |
| hybrid        | concept     | 0.706    | 0.509 | 0.000             | 37.4         |
| hybrid        | identifiers | 1.000    | 1.000 | 0.000             | 22.1         |
| hybrid        | relations   | 0.714    | 0.207 | 0.000             | 23.6         |
| hybrid+graph  | concept     | 0.706    | 0.557 | 0.000             | 1681.8       |
| hybrid+graph  | identifiers | 1.000    | 1.000 | 0.000             | 21.8         |
| hybrid+graph  | relations   | 0.714    | 0.333 | 0.000             | 25.6         |

### Exact only

| configuration | suite       | recall@5 | MRR   | duplicatePathRate | avgLatencyMs |
| ------------- | ----------- | -------- | ----- | ----------------- | ------------ |
| lexical       | concept     | 0.706    | 0.510 | 0.000             | 21.3         |
| lexical       | identifiers | 1.000    | 1.000 | 0.000             | 3.4          |
| lexical       | relations   | 0.714    | 0.207 | 0.000             | 7.7          |
| lexical+graph | concept     | 0.706    | 0.556 | 0.000             | 1605.4       |
| lexical+graph | identifiers | 1.000    | 1.000 | 0.000             | 6.3          |
| lexical+graph | relations   | 0.714    | 0.333 | 0.000             | 15.0         |
| hybrid        | concept     | 0.706    | 0.508 | 0.000             | 37.6         |
| hybrid        | identifiers | 1.000    | 1.000 | 0.000             | 22.7         |
| hybrid        | relations   | 0.714    | 0.207 | 0.000             | 24.8         |
| hybrid+graph  | concept     | 0.706    | 0.556 | 0.000             | 1654.0       |
| hybrid+graph  | identifiers | 1.000    | 1.000 | 0.000             | 76.4         |
| hybrid+graph  | relations   | 0.714    | 0.333 | 0.000             | 41.0         |

### Full

| configuration | suite       | recall@5 | MRR   | duplicatePathRate | avgLatencyMs |
| ------------- | ----------- | -------- | ----- | ----------------- | ------------ |
| lexical       | concept     | 0.706    | 0.510 | 0.000             | 14.7         |
| lexical       | identifiers | 1.000    | 1.000 | 0.000             | 2.7          |
| lexical       | relations   | 0.714    | 0.207 | 0.000             | 6.5          |
| lexical+graph | concept     | 0.706    | 0.566 | 0.000             | 1563.9       |
| lexical+graph | identifiers | 1.000    | 1.000 | 0.000             | 4.6          |
| lexical+graph | relations   | 0.714    | 0.357 | 0.000             | 8.1          |
| hybrid        | concept     | 0.706    | 0.508 | 0.000             | 33.0         |
| hybrid        | identifiers | 1.000    | 1.000 | 0.000             | 21.2         |
| hybrid        | relations   | 0.714    | 0.207 | 0.000             | 23.7         |
| hybrid+graph  | concept     | 0.706    | 0.566 | 0.000             | 1635.5       |
| hybrid+graph  | identifiers | 1.000    | 1.000 | 0.000             | 48.3         |
| hybrid+graph  | relations   | 0.714    | 0.357 | 0.000             | 61.0         |

### Concept cases whose first relevant rank moved

| configuration                                | query                                    | control | exact only | full |
| -------------------------------------------- | ---------------------------------------- | ------- | ---------- | ---- |
| lexical, lexical+graph, hybrid, hybrid+graph | how does the retrieval pipeline work?    | 8       | 9          | 9    |
| lexical+graph, hybrid+graph                  | where is workspace indexing implemented? | none    | none       | 6    |

Token eligibility removed the earlier regressions ("SQLite workspace registry", "local workspace hint"); the remaining one-rank move for the pipeline query comes from the exact stage, not degree ordering (exact only = full).

## Acceptance (final, Decision Log revision)

| Criterion                                                 | Result                                                                                                     |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Identifier suite recall@5 or MRR improves under `lexical` | PASS: MRR 0.965 → 1.000                                                                                    |
| Concept recall@5 does not drop, every configuration       | PASS: 0.706 → 0.706 in all four                                                                            |
| Concept MRR drop ≤ 0.03, every configuration              | PASS: lexical 0.510 → 0.510; lexical+graph 0.557 → 0.566; hybrid 0.509 → 0.508; hybrid+graph 0.557 → 0.566 |
| Relations under `lexical+graph` does not drop             | PASS: recall@5 0.714 → 0.714, MRR 0.333 → 0.357                                                            |
