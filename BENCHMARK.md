# Retrieval Benchmark

Date: 2026-08-04 (v0.9.2 — FTS5 + optional Ollama bge-m3 embedding, full RRF fusion)

## Scope

- Workspace: `openez`
- Index: 128 files, 810 chunks, 810 embeddings (1024-dim Ollama bge-m3)
- Evaluation set: 23 queries (17 keyword + 6 semantic)
- FTS: SQLite FTS5 BM25, porter unicode61 tokenizer, prefix matching
- Embedding: Ollama `bge-m3`, cosine similarity, concurrency=4, batch=50
- Pipeline improvements: query expansion, similarity threshold (0.3), code file boost, path dedup, chunk size 1024, input hash dedup, embedding retry with exponential backoff
- Retrieval: full RRF fusion (FTS weight 2, vector weight 1 — vector can boost files FTS ranked low)

## Commands

Run benchmark:

```bash
npx vitest run tests/embed-benchmark.test.ts
```

Reindex embeddings:

```bash
openez config set embedding.provider ollama
openez config set embedding.ollama_model bge-m3
openez reindex .
```

## Results: FTS-only vs FTS+Embedding

| Metric      | FTS only | FTS + Embedding |
| ----------- | -------: | --------------: |
| Recall@5    |   91.30% |          95.65% |
| MRR         |   0.6838 |          0.6924 |
| Queries hit |    21/23 |           22/23 |
| Avg latency |     5 ms |          249 ms |

### By query type

| Query type           | FTS only | FTS + Embedding |
| -------------------- | -------: | --------------: |
| Keyword (17 queries) |  100.00% |         100.00% |
| Semantic (6 queries) |   66.67% |          83.33% |

### Analysis

With **full RRF fusion** (FTS weight 2, vector weight 1), vector results can boost files that FTS found but ranked low — improving semantic recall by +16.67% without any keyword regression. Key pipeline improvements:

1. **bge-m3 model** (567M params) — better code understanding than nomic-embed-text (137M)
2. **Query expansion** — appends related technical terms to semantic queries
3. **Similarity threshold 0.3** — filters out low-relevance vector results
4. **Code file boost** — prioritizes `.ts/.tsx/.py/.go/.rs` files over docs
5. **Path dedup** — one file can only occupy one slot in vector results
6. **Chunk size 1024 tokens** — more context per chunk for better embeddings
7. **Input hash dedup** — skips embedding chunks whose formatted input already exists in DB
8. **Embedding retry** — exponential backoff on transient errors (rate limit, timeout, 5xx)

**Current limitation**: 128-file eval set is small enough that FTS catches most queries via partial keyword match. 1/6 semantic queries still misses because the expected file (`repository.ts`) ranks #6-10 in vector results — just outside top 5. On 1000+ file codebases, FTS miss rate increases and embedding value becomes more visible.

### Recommendation

- **Default: FTS-only** — 100% recall on keyword queries, 50x faster, zero setup
- **Enable embedding** for semantic query support — +4.35% overall recall, +16.67% semantic recall, no keyword regression
- **Full RRF fusion**: FTS weighted 2x, vector weighted 1x — vector boosts files FTS ranked low without pushing FTS down
- **bge-m3 recommended** over nomic-embed-text for code search

## Previous Results (v0.4.0)

| Metric              | v0.3.2 (old) | v0.4.0 (new) |
| ------------------- | -----------: | -----------: |
| Recall@5            |       83.33% |       94.44% |
| MRR                 |       0.6176 |       0.6565 |
| Duplicate path rate |           0% |           0% |
| Avg latency         |    126.13 ms |     38.68 ms |
| p50 latency         |    123.44 ms |     18.65 ms |
| p95 latency         |    195.64 ms |    316.63 ms |
| Avg context tokens  |      2,381.5 |      2,944.6 |
| Avg sources         |         9.89 |        12.00 |
| Quality gate        |         PASS |         PASS |
| Queries hit         |        15/18 |        17/18 |

## Key improvements

1. **FTS5 instead of LIKE** — FTS5 virtual table with BM25 ranking, porter tokenizer, prefix matching. Replaced `LIKE '%query%'` (full table scan, hardcoded score 0.1).
2. **Cosine similarity instead of string-length comparison** — Vector search uses `dot(a,b) / (norm(a) * norm(b))` instead of `ORDER BY abs(length(embedding) - ?)`.
3. **Removed Postgres dead code** — Dropped `pg`, `drizzle-orm/node-postgres`, Postgres schema. SQLite-only.
4. **Configurable embedding** — `openez config set` CLI + Settings UI, AES-256-GCM encrypted API keys, global config in registry DB.
5. **Adaptive RRF fusion** — FTS results take priority, vector results fill gaps. Prevents embedding from reducing FTS recall.
