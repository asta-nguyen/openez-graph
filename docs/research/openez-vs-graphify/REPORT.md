# OpenEZ vs Graphify — benchmark report

Date: 2026-11-06 (revised the same day) · OpenEZ: this repo's source (`feat/enhance-v3`) ·
Graphify: `graphifyy` 0.9.103, `--code-only`, local `graph.json`.

Methodology and eval-set provenance: [README.md](README.md). Raw results: `openez-eval.json`,
`graphify-eval.json`, and `graphify-warm-latency.py` output.

## What changed in this revision

The first run favoured OpenEZ in three ways; each is fixed here.

| Issue                                                                                    | Effect on the first run                                                       | Fix                                                                                                          |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Graphify was scored per `NODE` line, OpenEZ per file                                     | Graphify's "top 5" held fewer than 5 files in 69 of 90 queries                | `run-graphify-eval.py` ranks distinct files, like OpenEZ                                                     |
| Three relation answers were incomplete or wrong, checked against OpenEZ's own call graph | A correct answer outside the list scored as a miss                            | Re-derived from source with grep (below); one list for both tools                                            |
| Graphify latency was a cold CLI subprocess per query                                     | Python start-up plus a full `graph.json` load per query (2.2 s on wy-ask-api) | `graphify-warm-latency.py` loads the graph once, like its MCP server; both tools warmed up, medians reported |

Ground-truth edits (source-verified, non-test files):

- wyask-fe "what imports the api client": 5 service files → all 39 files importing `lib/api/client`.
- wyask-fe "what uses useEnvelope": dropped `HeaderDesktop.test.tsx` (never calls it); added
  `ClientEnvelopePage.tsx` and `CreateEnvelopeFlow.tsx` (both call `useEnvelope(`).
- wy-ask-api "what calls EmailEventEmitter": added `handoff_tools.py`, `_email_forms.py`,
  `chat_history.py`.
- Not verified: wyask-fe "what uses the shared queryClient" (left as authored).

The openez repo is reported separately: its eval set was written alongside OpenEZ's ranking work,
and the relation-query feature was tuned on those exact seven questions.

## Retrieval quality — external repos (Recall@5 / MRR)

OpenEZ "default" is what agents get over MCP (FTS + exact symbol + graph expansion). "lexical"
skips graph expansion. Graphify docs are N/A: `--code-only` indexes no documentation.

| Repo                   | Suite (n)        | OpenEZ default    | OpenEZ lexical | Graphify          |
| ---------------------- | ---------------- | ----------------- | -------------- | ----------------- |
| wy-ask-api (Python)    | concept (11)     | **.82** / **.36** | .55 / .45      | .45 / .31         |
|                        | identifiers (10) | **1.00** / .74    | 1.00 / 1.00    | .80 / **.80**     |
|                        | relations (4)    | **.75** / **.75** | .75 / .75      | .50 / .28         |
|                        | docs (6)         | .33 / .11         | .33 / .11      | N/A               |
| wyask-fe (TS, Next.js) | concept (9)      | .56 / .24         | .56 / .43      | **.78** / **.37** |
|                        | identifiers (9)  | .89 / .61         | 1.00 / .94     | .89 / **.89**     |
|                        | relations (4)    | .75 / **.56**     | .75 / .75      | .75 / .25         |
|                        | docs (5)         | .80 / .70         | .80 / .70      | N/A               |

Head-to-head on the six code suites (OpenEZ default vs Graphify):

- Recall@5: OpenEZ 3, Graphify 1, tie 2.
- MRR: OpenEZ 3 (wy-ask-api concept and relations, wyask-fe relations), Graphify 3 (both
  identifier suites, wyask-fe concept).

Suites hold 4–11 questions, so one question moves a score by 0.09–0.25. Read differences below
about 0.15 as noise.

## Retrieval quality — openez repo (home field)

| Suite (n)        | OpenEZ default | OpenEZ lexical | Graphify   |
| ---------------- | -------------- | -------------- | ---------- |
| concept (17)     | .88 / .67      | .76 / .67      | .82 / .61  |
| identifiers (19) | 1.00 / .94     | 1.00 / 1.00    | .95 / .95  |
| relations (7)    | 1.00 / 1.00    | 1.00 / 1.00    | 1.00 / .31 |
| docs (7)         | .86 / .70      | .86 / .70      | N/A        |

## Query latency (warm, per query)

| Repo       | OpenEZ default median / p95 | Graphify in-process median / p95 | Graphify CLI median |
| ---------- | --------------------------- | -------------------------------- | ------------------- |
| wy-ask-api | 78 / 160 ms                 | 41 / 486 ms                      | ~2,200 ms           |
| wyask-fe   | 11 / 17 ms                  | 11 / 51 ms                       | ~390 ms             |
| openez     | 17 / 107 ms                 | 6 / 12 ms                        | ~310 ms             |

Warm, the two are in the same range: Graphify has the lower median on two repos, OpenEZ the
lower tail on the large Python repo. Graphify's graph load (once per process) took 47–616 ms.
The CLI column is what an agent pays when it shells out to `graphify query` instead of using MCP.

## Indexing and footprint (from the first run, not re-measured)

| Repo       | OpenEZ reindex | Graphify extract | `.openez/` | `graphify-out/` |
| ---------- | -------------- | ---------------- | ---------- | --------------- |
| openez     | 3.0 s          | 10.0 s           | 28 MB      | 6.5 MB          |
| wy-ask-api | 15.8 s         | 81.2 s           | 281 MB     | 121 MB          |
| wyask-fe   | 2.9 s          | 8.2 s            | 31 MB      | 7.4 MB          |

OpenEZ builds its call graph lazily on the first graph query, so its reindex time excludes graph
construction; Graphify's extract includes its graph and Leiden communities. OpenEZ uses 2.3–4.3×
the disk.

## After the OpenEZ ranking fix (same day)

Finding 1 below was fixed in `packages/core/src/retrieval.ts`: after graph expansion, the best
pre-graph match and any file that defines a queried symbol keep their pre-graph rank (documents
already did). The graph still reorders and fills the remaining slots. Graphify was not re-run;
its numbers above are unchanged.

| Repo          | Suite       | OpenEZ default before | after           | Graphify      |
| ------------- | ----------- | --------------------- | --------------- | ------------- |
| wy-ask-api    | concept     | .82 / .36             | .73 / **.49**   | .45 / .31     |
|               | identifiers | 1.00 / .74            | **1.00 / 1.00** | .80 / .80     |
|               | relations   | .75 / .75             | **.75 / .75**   | .50 / .28     |
| wyask-fe      | concept     | .56 / .24             | .56 / **.42**   | **.78** / .37 |
|               | identifiers | .89 / .61             | **1.00 / .93**  | .89 / .89     |
|               | relations   | .75 / .56             | .75 / **.75**   | .75 / .25     |
| openez (home) | identifiers | 1.00 / .94            | 1.00 / 1.00     | .95 / .95     |

Other openez-repo suites and all docs suites are unchanged. One wy-ask-api concept question
("where is Supabase JWT authentication verified?") fell from rank 5 to 6: its best text match is
wrong, and pinning it plus two documents left too few slots for the graph's correct pick. Three
other questions on that suite moved from rank 2 to rank 1.

Head-to-head on the six external code suites after the fix: MRR OpenEZ 6, Graphify 0; Recall@5
OpenEZ 4, Graphify 1 (wyask-fe concept), tie 1.

## After the OpenEZ file-name stage (same day)

The three wyask-fe concept questions Graphify won all named their answer's file: "React Query
client" → `lib/query/queryClient.ts`, "global app store" → `stores/useAppStore.ts`, "app
constants" → `utils/constants.ts`. OpenEZ's FTS keeps `queryClient` and `useAppStore` as single
path tokens, and BM25 gives a path match little weight next to long files that repeat the
question's words. Graphify scores node and file names far above body text.

OpenEZ now adds a file-name candidate list to its first fusion: each file name and its directory
are split into words (camelCase, snake_case, kebab-case) and matched against the question's terms
by equality or a shared prefix of four or more letters ("authentication" ~ `Auth`, "provided" ~
`Provider`). Files are ranked by how much of their name the question covers; a partly covered
name needs two matching words, and a name shared by more than two files (`types`, `index`, `page`)
counts only when its directory matches too. Graphify was not re-run.

| Repo          | Suite       | before file names | after         | Graphify   |
| ------------- | ----------- | ----------------- | ------------- | ---------- |
| wy-ask-api    | concept     | .73 / .49         | **.91 / .71** | .45 / .31  |
|               | identifiers | 1.00 / 1.00       | 1.00 / 1.00   | .80 / .80  |
|               | relations   | .75 / .75         | .75 / .75     | .50 / .28  |
|               | docs        | .33 / .11         | **.50 / .50** | N/A        |
| wyask-fe      | concept     | .56 / .42         | **.89 / .69** | .78 / .37  |
|               | identifiers | 1.00 / .93        | 1.00 / .93    | .89 / .89  |
|               | relations   | .75 / .75         | .75 / .75     | .75 / .25  |
|               | docs        | .80 / .70         | .80 / **.80** | N/A        |
| openez (home) | concept     | .88 / .67         | **.94 / .80** | .82 / .61  |
|               | relations   | 1.00 / 1.00       | 1.00 / .86    | 1.00 / .31 |
|               | docs        | .86 / .70         | .86 / .67     | N/A        |

The openez relations drop is two questions where `docs/research/openez-vs-graphify/run-openez-eval.ts`
now ranks first: it does call the queried functions, but is not in the expected list. The openez
docs drop is "steps to publish a new CLI version", where `apps/cli/src/cli.ts` now ranks above
`AGENTS.md`. Median query latency changed by 0–6 ms.

A first version of the rules (one matching word could cover half a name; names shared by up to
five files counted) also matched `mcp-core.ts` on "core" and every `types.ts` on "types"; the
table shows the tightened version.

## Holdout: goko (fresh questions, no tuning)

`goko` is a Rust and TypeScript desktop app neither tool was developed against. The 40 questions in
`eval/goko/` were written and their answers grep-verified before either tool ran. Concept questions
deliberately avoid the answer's file name, which works against OpenEZ's new file-name stage. No
OpenEZ code was changed after seeing these results. Both tools ran on a scratch copy of the repo.
Graphify's default run also indexed 1,189 nodes from `.agents/`, which OpenEZ skips as hidden, so it
was measured again with that directory removed.

| Suite (n)        | OpenEZ default | OpenEZ lexical | Graphify        | Graphify without `.agents/` |
| ---------------- | -------------- | -------------- | --------------- | --------------------------- |
| concept (15)     | .40 / **.36**  | .47 / .37      | .47 / .26       | **.53** / .27               |
| identifiers (10) | 1.00 / .93     | 1.00 / .93     | 1.00 / **1.00** | 1.00 / **1.00**             |
| relations (8)    | **.62 / .58**  | .25 / .21      | .50 / .16       | .50 / .16                   |
| docs (7)         | **.86 / .78**  | .86 / .78      | N/A             | N/A                         |

Warm latency: OpenEZ 7.6 ms median, 13.3 ms p95; Graphify in-process (without `.agents/`) 6.4 ms
median, 26.9 ms p95. Index: OpenEZ 0.5 s for 187 files, 7.1 MB; Graphify default 3.9 s, 8.8 MB.

The large margins on the earlier repos did not carry over. Concept recall fell to about half for
OpenEZ and both tools miss most paraphrased questions: "what stops two copies of the daemon from
running at once?" never reaches `lock.rs` in either tool. The earlier eval questions often spelled
out the answer's file name, and the two ranking fixes were developed against them.

OpenEZ defects this run exposed, each verified in the index:

- **Rust methods are not found by bare name.** The label is `DaemonClient::connect_or_spawn`, so
  neither the exact-symbol stage nor "what calls connect_or_spawn" matches (ranks 3 and 7).
- **Calls inside nested functions do not roll up.** `upsertSession` is called from
  `startQuerySync.onSession`, so "what does startQuerySync call" finds nothing.
- **A call inside a JSX attribute has no edge.** `SessionItems.tsx` calls `usageTone(...)` in a
  `className`, but the graph's only caller of `usageTone` is `usageValue`. Cause not yet traced.

## After fixing the holdout defects

The three defects above are fixed. The third turned out not to involve JSX: `const SessionRow = memo(function SessionRow() {...})` was not recognized as a symbol at all, so every call inside it was lost. Goko's identifier and relation suites exposed these defects, so they are no longer untouched holdout data. Its concept suite (the real gap) did not change, and Graphify was not re-run.

| Repo       | Suite       | OpenEZ before | after           | Graphify    |
| ---------- | ----------- | ------------- | --------------- | ----------- |
| goko       | concept     | .40 / .36     | .40 / .37       | .53 / .27   |
|            | identifiers | 1.00 / .93    | 1.00 / 1.00     | 1.00 / 1.00 |
|            | relations   | .62 / .58     | **1.00 / .94**  | .50 / .16   |
|            | docs        | .86 / .78     | .86 / .78       | N/A         |
| wy-ask-api | concept     | .91 / .71     | .91 / .71       | .45 / .31   |
|            | identifiers | 1.00 / 1.00   | 1.00 / 1.00     | .80 / .80   |
|            | relations   | .75 / .75     | .75 / .75       | .50 / .28   |
| wyask-fe   | concept     | .89 / .69     | .89 / .69       | .78 / .37   |
|            | identifiers | 1.00 / .93    | **1.00 / 1.00** | .89 / .89   |
|            | relations   | .75 / .75     | .75 / .75       | .75 / .25   |

wy-ask-api and wyask-fe were measured on copies of their Git-tracked files with a temporary registry, because a reindex of the real wy-ask-api picked up 1,797 files from an unignored `graphify-out/` and nearly doubled its corpus. An A/B on those copies shows the parser fix adds about 1% chunks on wyask-fe (4,254 to 4,295), none on wy-ask-api, and no measurable latency: 66 / 122 ms and 11 / 17 ms (median / p95).

## Verdict

OpenEZ is modestly ahead, not clearly ahead. On the holdout it leads on relations and is the only
one answering documentation questions without an LLM pass; Graphify ranks exact identifiers slightly
better and has equal or better concept recall (within one or two questions of 15). On the earlier
repos OpenEZ led every external code suite (MRR 6 of 6, Recall@5 5 of 6 with one tie), but those
numbers are inflated by tuning and by question wording, so the holdout is the fairer estimate.

Neither tool handles paraphrased concept questions well (recall about .40–.53). Warm latency is
comparable; the earlier "4–20× faster" figure compared OpenEZ in-process against Graphify's CLI.
OpenEZ indexes faster. The answers differ in kind: OpenEZ returns code chunks and also covers
documentation; Graphify returns graph nodes and edges, after which the agent still reads the files.

## What this means for OpenEZ

1. **Paraphrased concept questions are the real gap** (.40 on the holdout). Keep `eval/goko` as an
   untuned check, and write new questions for any further tuning.
2. **Documentation questions on wy-ask-api are still weak** (.50 / .50).
3. **The "stale binary indexed 0 files on wyask-fe" finding was the `.gitignore` negation bug**,
   fixed in `988311c` and not yet released.
