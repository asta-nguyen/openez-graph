# OpenEZ vs Graphify — comparison study

Date: 2026-11-06
Mode: open-source Graphify CLI (`graphifyy`, local `graphify-out/graph.json`) vs
OpenEZ local workspaces. No hosted services; everything on-machine.

## Corpora

| Repo               | Lang             | Root                                         | OpenEZ workspace   | Graphify artifact |
| ------------------ | ---------------- | -------------------------------------------- | ------------------ | ----------------- |
| openez (this repo) | TS monorepo      | `/Users/nus/projects/Asta/openez`            | `openez` (indexed) | `graphify-out/`   |
| wy-ask-api         | Python (FastAPI) | `/Users/nus/projects/ons-mebarek/wy-ask-api` | `wy-ask-api`       | `graphify-out/`   |
| wyask-fe           | TS (Next.js 16)  | `/Users/nus/projects/ons-mebarek/wyask-fe`   | `wyask-fe`         | `graphify-out/`   |

## Eval sets

- `eval/wy-ask-api/{concept,identifiers,relations,docs}.json` — 31 cases
- `eval/wyask-fe/{concept,identifiers,relations,docs}.json` — 27 cases
- `eval/openez/` — reuse `tests/fixtures/retrieval-eval*.json` (45 cases, already
  fixture-backed by `tests/embed-benchmark.test.ts`)

Format mirrors `packages/indexer/src/retrieval-eval.ts`: each case is
`{query, expectedPaths}`; hit@5 = any expected path inside top-5 returned
paths, MRR = 1/rank of first relevant. Same metric code for both tools so the
comparison is apples-to-apples.

## Ground truth provenance

Every `expectedPaths` entry was verified against the target repo on
2026-11-06 before indexing: files exist on disk, identifiers are real exported
symbols (`grep export`/`def`/`class`), and relation edges were verified via
the openez `code_context` graph (`build_agent`, `EmailEventEmitter`,
`search_documents`) or direct import greps (`lib/api/client`, `useEnvelope`,
`queryClient`) for wyask-fe.

Caveats:

- `expectedPaths` are representative acceptable answers, not exhaustive
  (e.g. `build_agent` has ~40 test callers; only the two non-test callers are
  listed). Identical lists apply to both tools, so relative scores stay fair.
- FastAPI `Depends()` and LangChain tool binding are dynamic — no static call
  edge exists, so e.g. `get_current_user`/`search_documents` have no callers;
  they appear in `identifiers`, not `relations`.
- Both tools must exclude `.venv/`, `node_modules/`, `dist/`, `__pycache__/`
  symmetrically for corpus parity. Verify per-tool ignore behavior at index time.
- wy-ask-api's openez graph was stale at eval authoring time
  (indexGeneration 76 > graphGeneration 75); `openez reindex` required before
  measuring.

## Commands (as run, 2026-11-06)

```bash
uv tool install graphifyy                       # graphify + graphify-mcp
# openez side uses the DEV version from this repo, not the installed binary:
cd /Users/nus/projects/Asta/openez
pnpm openez reindex /Users/nus/projects/Asta/openez
pnpm openez reindex /Users/nus/projects/ons-mebarek/wy-ask-api
pnpm openez reindex /Users/nus/projects/ons-mebarek/wyask-fe   # workspace registered via `openez init`
(cd <repo> && graphify extract . --code-only)   # per repo, deterministic
```

WARNING: `/opt/homebrew/bin/openez` (installed binary) is a stale build — it
scans 0 files on wyask-fe and misreports workspace doc counts. Always use
`pnpm openez` from this repo for measurements.

## Results

`REPORT.md` — full tables. Raw runner output: `openez-eval.json`,
`graphify-eval.json`. Re-run: `bun run-openez-eval.ts` from the repo root,
`python3 run-graphify-eval.py`, and, for warm in-process Graphify latency,
`~/.local/share/uv/tools/graphifyy/bin/python graphify-warm-latency.py`.

## Metrics

- Index: wall time, artifact size (`.openez/` vs `graphify-out/`), node/edge counts
- Retrieval: Recall@5, MRR, avg latency per suite
- Graph: caller/callee spot precision on the `relations` cases
- Token cost: openez `query_logs.tokens_returned` vs graphify `token_budget` trims

Results go in `REPORT.md` in this directory.
