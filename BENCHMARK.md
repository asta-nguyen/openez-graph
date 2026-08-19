# Retrieval benchmark

Date: 2026-08-10  
Commit: working tree based on `36722f9` (`feat/enhance`)

## Scope

- Workspace: `openez`
- Corpus: 180 files, 979 chunks
- Evaluation set: 17 fixture-backed queries
- Retrieval: SQLite FTS5, graph expansion excluded from the FTS quality comparison
- Embeddings: disabled for this baseline

## Command

```bash
pnpm benchmark:retrieval
```

The command indexes the selected workspace incrementally, rejects stale expected paths, runs real
queries, and enforces Recall@5 and MRR floors.

## Result

| Metric              | FTS only |
| ------------------- | -------: |
| Recall@5            |   76.47% |
| MRR                 |   0.6564 |
| Queries hit         |    13/17 |
| Duplicate path rate |       0% |
| Average latency     |  12.1 ms |

Quality floors: Recall@5 ≥ 70%, MRR ≥ 0.45.

The normal test suite also copies the fixture's expected files into an isolated workspace and runs
the same FTS quality gates. A separate graph-enabled case verifies that a call edge can add a
related file to retrieval results.

## Optional embedding comparison

Embedding comparison is intentionally opt-in because it may download/use a configured provider. Indexing and embedding are separate commands:

```bash
openez config set embedding.provider local
openez embed .
OPENEZ_BENCHMARK_EMBEDDINGS=1 pnpm benchmark:retrieval:embeddings
```

Raw task queries are embedded without hard-coded synonym expansion. Publish a new FTS+embedding
table only after running this command against a named provider/model.
