# Retrieval Benchmark

Date: 2026-07-22 (v0.4.0 — FTS5 + cosine similarity)

## Scope

- Workspace: `openez`
- Index: 118 files, 640 chunks
- Evaluation set: 18 queries in `tests/fixtures/retrieval-eval.json`
- FTS: SQLite FTS5 BM25, porter unicode61 tokenizer, prefix matching
- Embedding: optional (Ollama `nomic-embed-text`), cosine similarity
- Retrieval: FTS5 + graph expansion + RRF fusion (k=60)

## Commands

Without embedding:

```bash
EMBEDDING_PROVIDER=none pnpm benchmark:retrieval --fail-on-quality
```

With Ollama embedding:

```bash
EMBEDDING_PROVIDER=ollama \
OLLAMA_EMBEDDING_MODEL=nomic-embed-text \
pnpm benchmark:retrieval --fail-on-quality
```

Reindex embeddings before benchmarking if model or embedding format changed:

```bash
EMBEDDING_PROVIDER=ollama \
OLLAMA_EMBEDDING_MODEL=nomic-embed-text \
pnpm reindex /path/to/workspace
```

## Results

| Metric | v0.3.2 (old) | v0.4.0 (new) |
| --- | ---: | ---: |
| Recall@5 | 83.33% | 94.44% |
| MRR | 0.6176 | 0.6565 |
| Duplicate path rate | 0% | 0% |
| Avg latency | 126.13 ms | 38.68 ms |
| p50 latency | 123.44 ms | 18.65 ms |
| p95 latency | 195.64 ms | 316.63 ms |
| Avg context tokens | 2,381.5 | 2,944.6 |
| Avg sources | 9.89 | 12.00 |
| Quality gate | PASS | PASS |
| Queries hit | 15/18 | 17/18 |

Quality gate:

- Recall@5 >= 0.80
- MRR >= 0.60
- Duplicate path rate <= 0.20

## Key improvements

1. **FTS5 instead of LIKE** — FTS5 virtual table with BM25 ranking, porter tokenizer, prefix matching. Replaced `LIKE '%query%'` (full table scan, hardcoded score 0.1).
2. **Cosine similarity instead of string-length comparison** — Vector search uses `dot(a,b) / (norm(a) * norm(b))` instead of `ORDER BY abs(length(embedding) - ?)`.
3. **Removed Postgres dead code** — Dropped `pg`, `drizzle-orm/node-postgres`, Postgres schema. SQLite-only.

## Conclusion

FTS5 + BM25 ranking improved Recall@5 from 83.33% to 94.44% (17/18 hit) and reduced average latency from 126ms to 39ms (3.3x faster). Only 1/18 query misses ("where are TypeScript symbols extracted?" — FTS5 does not match because the query is natural language, while `code.ts` uses `ts-morph` and does not contain the words "TypeScript symbols extracted").

Embedding remains optional. FTS-only is sufficient for most queries. Enable Ollama when semantic fallback is needed for queries without direct keyword overlap.
