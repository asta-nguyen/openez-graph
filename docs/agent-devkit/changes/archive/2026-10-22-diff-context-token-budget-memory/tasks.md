# MCP response budget memory use tasks

## Design

[MCP response budget memory use](design.md)

## Global Constraints

- Budget compliance uses an exact cl100k count of the final serialized JSON; size estimates only schedule trimming.
- Keep MCP schemas, response envelopes, protected error text, existing minimum array sizes, and current truncation priorities.
- Use the explicit cl100k_base encoding for every tokenizer operation; do not rely on the gpt-tokenizer package default.
- Keep the current metrics.truncated behavior when formattedSummary alone is removed and makes the response fit.
- The Task 2 fitter change is conditional on the post-Task-1 production replay exceeding either the 900 MiB or 35-second limit.

## Impact map

Entry: apps/mcp/src/server.ts::createAndStartMcpServer → apps/mcp/src/mcp-core.ts::createMcpServer
Flow: diff_context handler → catch-up/index and analyzeDiffContext → jsonResponse → fitToTokenBudget → packages/core/src/tokenizer.ts::countTokens/truncateToTokenLimit → gpt-tokenizer; the same fitter also serves code_query, code_context, graph_neighbors, and memory_recall
State changes: fitToTokenBudget mutates a structuredClone; before fitting, diff_context can update in-memory catchupState and workspace SQLite/index graph state
External effects: diff_context may run incremental indexing, graph generation, and Git diff/show commands; response fitting itself clones, trims, tokenizes, serializes, and returns one MCP text block
Change candidates: apps/mcp/src/mcp-core.ts::jsonResponse/fitToTokenBudget/diff_context; packages/core/src/tokenizer.ts::loadTokenizer/countTokens/truncateToTokenLimit; packages/core/package.json::dependencies.gpt-tokenizer; pnpm-lock.yaml; tests/mcp-tools.test.ts; tests/index-workspace.test.ts
Verification: baseline and post-Task-1 production CLI diff_context replay at Bun 1.3.14 with separate workspace/registry state and 900 MiB / 35-second watchdog; independent cl100k response count; relevant Bun tests, full Bun suite, typecheck, and CLI build if Task 2 is needed
Verified at: 0cd44909a8fd1b29de815a96e4925a505efe026c

## Tasks

### Task 1 — Prove the current-source baseline, then adopt cache-safe cl100k counting

Files: packages/core/package.json::dependencies.gpt-tokenizer; packages/core/src/tokenizer.ts::loadTokenizer/countTokens/truncateToTokenLimit; pnpm-lock.yaml:330-345,3323-3324,7504; tests/index-workspace.test.ts:606-632
Interfaces: Keep the existing exported tokenizer signatures. Load encode, decode, and countTokens from the explicit cl100k_base encoding; no MCP caller or database interface changes.
Change: Before editing source or dependencies, run the existing relevant tokenizer exactness, tokenizer concurrency, chunking, and MCP budget tests and record their outcomes. Build the current CLI from the pinned source, run the production diff_context request ref v1.5.0 / limit 10 / maxTokens 6500 against a disposable workspace with separate registry and SQLite state, and record peak footprint, elapsed time, exact response count/hash, and envelope validity under the 900 MiB / 35-second watchdog. Invoke the CLI through an MCP stdio client and sample its process with /usr/bin/vmmap -summary every 500 ms; stop it if either limit is exceeded. If neither limit is exceeded, stop before source changes and return the measurements for re-scoping. If the baseline reproduces, upgrade gpt-tokenizer to 4.1.0, explicitly import gpt-tokenizer/encoding/cl100k_base, and use its exact countTokens API for counts while retaining encode/decode for truncation. Compare the fixed sample and compact JSON serialization of the parsed report-input.json payload against the recorded 2.9.0 cl100k counts. Rebuild the CLI and repeat the identical production replay from freshly reset scratch state. If the replay is within both limits and exact count and response contract checks pass, omit Task 2; only continue to Task 2 if either limit remains exceeded.
Verify: Record the pre-edit results of bun test tests/index-workspace.test.ts tests/tokenizer-concurrency.test.ts tests/chunking.test.ts tests/mcp-tools.test.ts. After the dependency change, rerun those tests and pnpm typecheck. Require exact parity for the fixed sample and saved report payload using an independent cl100k tokenizer. For the built-CLI smoke, call diff_context with ref set to "The tokenizer must leave fast mode after indexing." and maxTokens 1000; independently assert that sample's exact count differs from ceil(sample.length / 4), and require metrics.responseTokens to equal an independent count of the raw serialized response. The pre-change production replay must exceed at least one watchdog limit; the post-Task-1 replay must stay at or below both limits if Task 2 is to be omitted. In either replay, preserve the 6,500-token bound and workspaces envelope.
Progress: done
Result: On Bun 1.3.14, the pre-change production replay exceeded the 35-second watchdog (35.03s, 247.3 MiB peak, no response). Upgraded to gpt-tokenizer 4.1.0 with explicit cl100k_base loading. Independent parity matched the 2.9.0 counts for the fixed sample (9 tokens) and compact report payload (63,077 tokens). The post-Task-1 replay still exceeded the time limit (35.17s, 328.8 MiB peak), so Task 2 was required.

### Task 2 — Batch response trimming only if Task 1 still exceeds the watchdog

Files: apps/mcp/src/mcp-core.ts::jsonResponse/fitToTokenBudget; apps/mcp/src/mcp-core.ts:1025-1143; tests/mcp-tools.test.ts:238-275
Interfaces: Keep all MCP tool schemas and response shapes unchanged. The shared fitter owns formattedSummary-first removal and returns exact-cl100k JSON within the caller's budget.
Change: Start this task only if the post-Task-1 production replay exceeds either 900 MiB or 35 seconds. Remove diff_context's separate full-payload token-count precheck. Move formattedSummary-first removal into fitToTokenBudget so it is retained when the full response fits and removed first when it does not. Preserve metrics.truncated=false when removing only formattedSummary makes the response fit; set it true only if further content is trimmed. Replace per-item full-payload BPE checks with deterministic batch pruning guided by serialized-size estimates; exact-count each batch boundary and the final response, continue trimming if needed, and preserve array minimums, protected error text, workspace envelope, metrics, and minimal fallback. Add regression cases where summary removal alone is sufficient and where summary removal must be followed by additional trimming; verify both truncation flag outcomes and exact serialized counts.
Verify: bun test tests/mcp-tools.test.ts and the full bun test suite; pnpm typecheck; pnpm build:cli. Run the same disposable production diff_context replay with Bun 1.3.14 and the 900 MiB / 35-second watchdog. The final response must satisfy the exact independent cl100k count, remain at or below 6,500 tokens, preserve the workspaces envelope, and keep the built CLI metrics.responseTokens equal to an independent tokenizer count rather than the ceil(length / 4) fallback. If Task 1 met both watchdog limits, do not make this fitter change and record it as unnecessary.
Progress: done
Result: Moved formattedSummary-first removal into the shared fitter and batched deterministic array/string trimming with exact counts at batch boundaries and finalization. The final production replay completed in 28.72s with a 234.2 MiB peak; independent cl100k count and metrics.responseTokens both equal 6,323 (budget 6,500), and the workspaces envelope remained valid. Targeted tests: 59 passed; full suite: 681 passed, 1 skipped; typecheck: 8/8; CLI build and bundled-tokenizer MCP smoke passed (independent response count 95). Prettier and git diff --check passed.

## Files inspected, no change

- apps/mcp/src/server.ts — production MCP entry point and server startup.
- packages/core/src/index.ts — exported tokenizer surface.
- packages/core/src/graph.ts — exact token counting during graph response preparation.
- packages/core/src/retrieval.ts — exact token counting for retrieval selection and metrics.
- packages/core/src/embeddings.ts — shared tokenizer consumer.
- apps/cli/tsup.config.ts — confirms the core dependency is included in the CLI bundle.
- README.md — existing diff_context budget and response-envelope documentation remains accurate.
- docs/llm/AGENTS.md and docs/llm/INDEX.md — docs/llm does not exist, so there is no verified wiki coverage.
- /Users/nus/Documents/Codex/2026-10-22-bun-2611-memory/REPORT.md — source report for the original bundle replay and its limitations.
- /Users/nus/Documents/Codex/2026-10-22-bun-2611-memory/report-input.json — fixed pre-fit report payload, 242,758 characters.
- /Users/nus/Documents/Codex/2026-10-22-bun-2611-memory/budget-repro.cjs and run-budget-repro.py — standalone copied fitter and watchdog driver; neither exercises current MCP source.

## Approval Gate

Status: approved

## Decision Log

2026-10-22 — Revised after review: require a current-source replay before edits and after Task 1; make Task 2 conditional on the post-Task-1 watchdog result; document the external report fixture and the copied-helper limitation; correct the tokenizer cache/default-encoding description; specify summary-only metrics.truncated behavior and independent built-CLI token verification. Approval state: pending.
2026-10-22 — User approved implementation through Devin CLI with SWE-2 Max and full permission mode. Approval state: approved.
