# Retrieval benchmark: OpenEZ vs Graphify

Date: 2026-11-06. OpenEZ: release 1.7.0, default configuration, no embeddings. Graphify:
`graphifyy` 0.9.103 with `--code-only`, which makes no LLM calls.

## Corpora and questions

| Corpus                 | Files indexed by OpenEZ | Questions |
| ---------------------- | ----------------------: | --------: |
| Rust + TS desktop app  |                     187 |        40 |
| Python FastAPI service |                   1,876 |        31 |
| TS Next.js frontend    |                     933 |        27 |

Each question has expected files verified against the source with grep. Both tools get the same
questions, answers, and scoring: Recall@5 is whether an expected file is in the top five files,
MRR is 1/rank of the first expected file. Graphify results are ranked by distinct file so that
several nodes from one file count once, as they do for OpenEZ.

## Results (Recall@5 / MRR)

| Corpus                 | Suite (questions) | OpenEZ      | Graphify    |
| ---------------------- | ----------------- | ----------- | ----------- |
| Rust + TS desktop app  | concept (15)      | .40 / .37   | .53 / .27   |
|                        | identifiers (10)  | 1.00 / 1.00 | 1.00 / 1.00 |
|                        | relations (8)     | 1.00 / .94  | .50 / .16   |
|                        | docs (7)          | .86 / .78   | N/A         |
| Python FastAPI service | concept (11)      | .91 / .71   | .45 / .31   |
|                        | identifiers (10)  | 1.00 / 1.00 | .80 / .80   |
|                        | relations (4)     | .75 / .75   | .50 / .28   |
|                        | docs (6)          | .50 / .50   | N/A         |
| TS Next.js frontend    | concept (9)       | .89 / .69   | .78 / .37   |
|                        | identifiers (9)   | 1.00 / 1.00 | .89 / .89   |
|                        | relations (4)     | .75 / .75   | .75 / .25   |
|                        | docs (5)          | .80 / .80   | N/A         |

Across the nine code suites, OpenEZ leads Recall@5 in 6, Graphify in 1, and 2 tie. OpenEZ leads MRR
in 8 and 1 ties. Graphify's docs suites are N/A because `--code-only` indexes no documentation; its
optional LLM pass does, and was not measured.

## Read this before quoting the numbers

- **The Python and Next.js results are optimistic.** OpenEZ's ranking was improved using those same
  questions, and many of them name the answer's file.
- **The desktop app concept suite is the fairest number.** It was written before either tool ran,
  avoids file names, and nothing was tuned against it. There Graphify has the better recall
  (.53 vs .40) and OpenEZ the better MRR (.37 vs .27); the recall gap is two of 15 questions. Both
  tools miss most questions phrased differently from the code.
- The desktop app's identifier and relation suites exposed three OpenEZ defects that were then
  fixed, so those two rows are after-the-fix numbers.
- Suites are small: one question moves a score by .07 to .25.
- OpenEZ's authors wrote the questions. The Python and Next.js repositories and all question sets
  are private, so these runs cannot be reproduced publicly.

## Speed and size

| Corpus                 | OpenEZ query, median / p95 | Graphify in-process, median / p95 | OpenEZ index | Graphify extract |
| ---------------------- | -------------------------- | --------------------------------- | -----------: | ---------------: |
| Rust + TS desktop app  | 8 / 13 ms                  | 6 / 27 ms                         |        0.5 s |            3.9 s |
| Python FastAPI service | 66 / 122 ms                | 41 / 486 ms                       |       15.8 s |           81.2 s |
| TS Next.js frontend    | 11 / 17 ms                 | 11 / 51 ms                        |        2.9 s |            8.2 s |

- Query latency is comparable. Graphify's CLI costs about 290 ms to 2.2 s per query because each call
  starts Python and reloads the graph; the in-process figures load it once, as its MCP server does.
- OpenEZ's index time excludes its call graph, which it builds on the first graph query. Graphify's
  includes its graph and community detection.
- On disk, OpenEZ uses 262 MB against 121 MB on the Python service and 31 MB against 7.4 MB on the
  Next.js frontend.

## What differs beyond the numbers

- OpenEZ returns code chunks an agent can use directly. Graphify returns graph nodes and edges, and
  the agent then reads the files.
- Graphify covers more languages, and adds community clustering, reports, and LLM-based extraction
  from documents, PDFs, and images. None of that was measured here.

## Repository quality gate

`pnpm benchmark:retrieval` indexes this repository, runs its fixture-backed suites, rejects stale
expected paths, and fails below Recall@5 70% or MRR 0.45 on the concept suite. Add
`pnpm benchmark:retrieval:embeddings` to compare a configured embedding provider.
