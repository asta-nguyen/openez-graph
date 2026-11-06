# Benchmark summary: retrieval ranking (2026-11-05)

Full detail: [results.md](results.md). Corpus: 321 files, ~1868 chunks. Variants: control (HEAD `retrieval.ts`), exact only (exact-symbol stage, old graph ordering), full (exact-symbol + identifier-shaped tokens + degree-aware ordering).

## MRR, control → full (recall@5 unchanged in every concept/identifier cell)

| Config        | concept       | identifiers   | relations     |
| ------------- | ------------- | ------------- | ------------- |
| lexical       | 0.510 → 0.510 | 0.965 → 1.000 | 0.207 → 0.207 |
| lexical+graph | 0.557 → 0.566 | 0.974 → 1.000 | 0.333 → 0.357 |
| hybrid        | 0.509 → 0.508 | 1.000 → 1.000 | 0.207 → 0.207 |
| hybrid+graph  | 0.557 → 0.566 | 1.000 → 1.000 | 0.333 → 0.357 |

## Acceptance: all pass

- Identifier MRR improves under `lexical` (0.965 → 1.000).
- Concept recall@5 unchanged (0.706) and MRR drop ≤ 0.03 everywhere (worst −0.001).
- Relations under `lexical+graph` do not drop (MRR +0.024).

## Notes

- First attempt (all word tokens eligible) dropped concept MRR by 0.050 under `lexical+graph`; restricting to identifier-shaped tokens fixed it (Task 6). That attempt is kept in results.md as history.
- Degree-aware ordering only shows up in relations (+0.024); exact-only vs full is identical on concept except "where is workspace indexing implemented?" (miss → rank 6).
- Identifier suite is near saturation (one case, `indexWorkspace`, had headroom), so it cannot show larger gains.
