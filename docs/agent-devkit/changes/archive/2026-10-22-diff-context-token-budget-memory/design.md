# MCP response budget memory use

## Goal

Prevent multi-gigabyte memory growth when OpenEZ compacts a large MCP response, while preserving the exact cl100k token budget and existing response contracts. Treat the observed behavior as memory bloat or retention; the evidence does not establish a permanent native leak.

## Scope

The change covers the shared MCP response fitter and the tokenizer it uses. The fitter serves code_query, code_context, graph_neighbors, memory_recall, and diff_context. The tokenizer is also used by graph construction, retrieval, embeddings, and the bundled CLI.

Upgrade gpt-tokenizer to 4.1.0 and select its explicit cl100k_base encoding. Do not use the package root import: 4.1.0 defaults to o200k_base, while 2.9.0 defaulted to cl100k_base. The 4.1.0 merge cache is still present and bounded at 100,000 entries; it uses circular/FIFO eviction and does not refresh recency on a cache hit. In 2.9.0, a cache hit is refreshed with Map.delete() followed by Map.set(). The intended benefit is removal of that per-hit refresh churn while retaining exact BPE counting, not removal of all tokenizer caching.

No MCP input schema, response envelope, workspace behavior, SQLite state, or retrieval/indexing policy changes. README.md and AGENTS.md already describe the response contract and remain accurate. docs/llm is absent, so no wiki delta applies.

## Behavior

- A response that fits its budget retains optional content, including formattedSummary.
- When a response exceeds its budget, formattedSummary is removed first. The fitter then trims the existing eligible arrays and strings in deterministic priority order, respecting current minimum array sizes and protected fields.
- Preserve current metrics.truncated semantics: if removing only formattedSummary makes the response fit, metrics.truncated remains false. Set it to true only when more content must be trimmed after the summary is removed.
- Cheap serialized-size estimates schedule removals in batches. They never authorize a response to be returned. Exact cl100k counts validate after batches and on the final serialized response; if the response is still over budget, trimming continues.
- metrics.responseTokens describes the final serialized JSON and is at or below maxTokens. Existing minimal-response fallbacks remain available when the remaining protected response cannot fit.
- Tokenizer exports keep their current signatures. countTokens uses the explicit cl100k_base countTokens API; truncation continues to use cl100k_base encode and decode.
- No local fork, approximate counter, periodic GC, or cache-size tuning is part of this design.

## Baseline and replay gate

Before changing source or dependencies, record the existing relevant test results and replay the production diff_context path with the current code at commit 0cd44909a8fd1b29de815a96e4925a505efe026c, gpt-tokenizer 2.9.0, and Bun 1.3.14. Build the current CLI, start its MCP server against a disposable workspace snapshot and separate registry/SQLite state, and call diff_context with ref v1.5.0, limit 10, and maxTokens 6500. Recreate or restore the same indexed workspace and registry state before each run; use the same source snapshot, Git ref, Bun version, CLI entry point, and request for the post-Task-1 replay. Call the server through an MCP stdio client, sample its process with /usr/bin/vmmap -summary every 500 ms, and stop the child if physical footprint exceeds 900 MiB or elapsed time exceeds 35 seconds. Record peak footprint, elapsed time, exact response token count, response hash, and whether the workspaces envelope is intact. Use a disposable one-off driver if needed; do not add a permanent baseline-only runner to the repository. Never point this replay at the user's normal workspace database.

The baseline must exceed at least one watchdog limit to establish that the current source still reproduces the issue. If it does not, stop before source changes and report the measurements for re-scoping. After Task 1, proceed to Task 2 only if the same replay still exceeds either limit. If Task 1 meets both limits and the exact-count and response-contract checks pass, Task 2 is unnecessary and its fitter changes must be omitted.

## Diagnostic artifacts

The investigation materials are outside the repository at /Users/nus/Documents/Codex/2026-10-22-bun-2611-memory/:

- REPORT.md contains the original measurements and reproduction notes.
- report-input.json is the saved 242,758-character pre-fit report payload.
- budget-repro.cjs and run-budget-repro.py are the standalone fitter copy and watchdog driver, with provenance.json and evidence/ alongside them.

The standalone helper copies the CLI 1.5.0 fitting loop and does not invoke the current source or MCP server. Use report-input.json as the fixed payload for independent cl100k count-parity checks and use the helper only as an auxiliary cache/fitter diagnostic. It does not satisfy the current-source replay gate or decide whether Task 2 is needed; those decisions use the production diff_context request above.

## Edge cases

- A response already below budget keeps formattedSummary and all other fields.
- Removing only formattedSummary can make the response fit; metrics.truncated remains false, matching current behavior.
- If summary removal is insufficient, subsequent trimming sets metrics.truncated to true and continues until the exact final count fits.
- If the size estimate differs substantially from BPE, exact checks trigger more trimming before the response is returned.
- The diff_context workspaces array remains non-empty when it exists. Existing minimums for results, nodes, callers, callees, relatedChunks, sources, and files remain in force.
- The error field remains actionable and protected from ordinary string truncation. The existing minimal diff response continues to preserve the workspace envelope.
- Very large arrays and strings are reduced in bounded batches; the fitter must make progress and retain its existing last-resort behavior.
- A broken tokenizer import in the CLI bundle can silently fall back to ceil(length / 4). Built-bundle verification therefore compares its reported responseTokens with a separate cl100k tokenizer and includes a sample whose exact count differs from that fallback.

## Interfaces

- MCP tool schemas and public response shapes do not change.
- jsonResponse and fitToTokenBudget remain internal MCP helpers. formattedSummary-first removal moves into the shared fitter so diff_context does not perform a separate full-response token count.
- Public tokenizer function signatures do not change. packages/core/package.json and pnpm-lock.yaml move to gpt-tokenizer 4.1.0, and packages/core/src/tokenizer.ts imports encode, decode, and countTokens from the explicit gpt-tokenizer/encoding/cl100k_base subpath.

## Verification

- Before the first source edit, run the existing tokenizer exactness, tokenizer concurrency, chunking, and MCP budget tests; record any baseline failures.
- Before and after Task 1, use the same production CLI diff_context replay, scratch workspace and registry state, Bun 1.3.14, and 900 MiB / 35-second watchdog. The pre-change run must reproduce at least one limit before implementation proceeds.
- Compare exact cl100k counts for the existing tokenizer sample and the compact JSON serialization of the parsed report-input.json payload before and after the upgrade. Use an independent import from gpt-tokenizer/encoding/cl100k_base for the post-upgrade expected counts.
- Verify the built CLI through MCP using diff_context with ref set to the fixed sample from tests/index-workspace.test.ts:606, "The tokenizer must leave fast mode after indexing.", and maxTokens 1000. The response echoes that sample in workspaces[0].ref. Independently assert the sample's exact count differs from ceil(sample.length / 4), then count the raw serialized response and require it to equal metrics.responseTokens. This exercises the bundled tokenizer path and detects its silent fallback.
- If Task 1 still exceeds either watchdog limit, batch the fitter work and run the relevant MCP tests, full Bun suite, typecheck, CLI build, independent built-bundle count, and the same production replay. Exact final response counts must remain within 6,500 and the workspaces envelope must remain valid.

## Related context

The repository has no docs/llm wiki pages. README.md and AGENTS.md already cover the affected diff_context response contract; no documentation delta is required.
