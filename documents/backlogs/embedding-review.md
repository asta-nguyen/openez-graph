# Embedding & Chunking Review — Verified Issues

> Source: code review dated 2026-07-23. All items verified against actual codebase.
> **Default path: `EMBEDDING_PROVIDER=none` — embedding is opt-in, not default.**
> Items below only apply when a provider is enabled (`ollama` or `openai`).

## Priority 1 — Should fix

### 1. Ollama concurrency unbounded

- **File:** `packages/core/src/embeddings.ts:70-84`
- **Issue:** `OllamaEmbeddingProvider.embed` fires `Promise.all(texts.map(...))` — all chunks in one call simultaneously. Large file with hundreds of chunks → hundreds of concurrent requests to local Ollama → OOM/throttling.
- **Fix:** Add concurrency limit (p-limit style, 4-8 concurrent). Simple semaphore or chunk-batched `Promise.all`.
- **Scope:** Only affects `ollama` provider. `openai` sends single batch request.

### 2. Content-based dedup for embeddings

- **File:** `packages/indexer/src/index-workspace.ts:305-359` (`writeEmbeddingsToRepo`)
- **Issue:** Dedup only by `chunk_id` (skip if embedding row exists). Two chunks with identical content but different IDs → re-embed wastefully. Common in boilerplate-heavy codebases.
- **Fix:** Hash by `formatEmbeddingInput(provider, chunk, "document")` output (NOT `contentHash` alone — input includes path/heading/nomic prefix). Reuse embedding if formatted-input hash matches.
- **Nuance:** `formatEmbeddingInput` at `embeddings.ts:19-33` prepends `path:` / `heading:` and nomic `search_document:` prefix. Dedup key must account for this.

### 3. OpenAI batch — no token budget splitting

- **File:** `packages/core/src/embeddings.ts:49-56`
- **Issue:** `OpenAIEmbeddingProvider.embed` sends all `texts` in one API call. No check on total token count or item count against API limits.
- **Fix:** Split into sub-batches by estimated total tokens (e.g. 300k tokens max per request for `text-embedding-3-small`). Track cumulative token count while iterating.

### 4. No retry / error handling in providers

- **File:** `packages/core/src/embeddings.ts:49-56` (OpenAI), `:70-84` (Ollama)
- **Issue:** If `provider.embed()` throws, `writeEmbeddingsToRepo` catches at `index-workspace.ts:355` but returns 0 — entire batch lost. No retry, no partial success.
- **Fix:** Add retry with exponential backoff (2-3 attempts). For partial-failure tolerance, embed in smaller sub-batches and persist whichever succeed.

## Priority 2 — Nice to have

### 5. Tokenizer mismatch (chunking vs embedding)

- **File:** `packages/core/src/tokenizer.ts:1` (gpt-tokenizer / GPT-2 BPE)
- **Issue:** `countTokens` and `splitToTokenLimit` use GPT-2 BPE for all providers. Ollama `nomic-embed-text` and OpenAI `text-embedding-3-small` use different tokenizers. Token counts drift — may over-split or still exceed real model limit.
- **Fix options:**
  - Use provider-specific tokenizer (heavy, adds deps).
  - Or keep GPT-2 BPE but add safety margin (e.g. `targetTokens * 0.8`).
- **Note:** Only matters when embedding is enabled. Default path (no provider) uses tokenizer for chunking only — no mismatch.

### 6. `OLLAMA_EMBED_MAX_TOKENS` magic number

- **File:** `packages/core/src/embeddings.ts:7`
- **Issue:** Hardcoded `1800`, unrelated to `settings.chunking.targetTokens`. If targetTokens changes, this stays static.
- **Fix:** Derive from chunking config or make configurable. At minimum, document why 1800.

### 7. `splitToTokenLimit` cuts across syntax boundaries

- **File:** `packages/core/src/tokenizer.ts:33-55`
- **Issue:** Pure token-window split — can cut mid-statement. Applied via `boundChunks` at `index-workspace.ts:145-158` after symbol extraction.
- **Fix:** Prefer splitting at method/block boundaries first, fall back to token window. Complex; low priority since `indexCode` already splits by symbol and oversized symbols are rare.

### 8. Fallback 80-line window uses line count, not tokens

- **File:** `packages/indexer/src/code.ts:137`
- **Issue:** `for (let index = 0; index < lines.length; index += 80)` — line-based, inconsistent with token-based chunking elsewhere. Minified/generated files with very long lines → oversized chunks.
- **Fix:** Use `splitToTokenLimit` on the full content instead of line slicing.

## Priority 3 — After profiling

### 9. Embedding stored as JSON string

- **File:** `packages/indexer/src/index-workspace.ts:350` (`JSON.stringify(embedding)`)
- **Read path:** `packages/core/src/retrieval.ts:56-63` (`parseEmbedding` — `JSON.parse` per row per query)
- **Issue:** JSON string is larger than BLOB and slower to parse for cosine similarity.
- **Fix:** Store as Float32Array BLOB. Consider `sqlite-vec` extension for real vector index.
- **Caveat:** `retrieval.ts:87` already comments: _"linear scan is enough for local SQLite; use sqlite-vec after profiling proves otherwise."_ This is an intentional decision, not an oversight. Profile first.
- **AGENTS.md constraint:** Project is SQLite-first, local-first, low-setup. `sqlite-vec` adds native extension dependency — evaluate tradeoff.

## Already handled (no action needed)

### Orphan cleanup — IMPLEMENTED

- `resetDocumentArtifacts` at `packages/indexer/src/index-workspace.ts:133-143` deletes embeddings + graph nodes + chunks.
- Called at:
  - Line 417: file removed from workspace (incremental) → delete document + artifacts.
  - Line 484: file changed → reset old artifacts before re-index.
- **No action needed.** Original review incorrectly claimed this was missing.

## Not yet addressed (future consideration)

### Config versioning for re-chunking

- **File:** `packages/indexer/src/index-workspace.ts:452-456`
- **Issue:** Incremental check is `contentHash + mtimeMs` at file level. If `targetTokens` / `overlapTokens` changes, old chunks won't re-split.
- **Fix:** Store chunking config hash alongside document. If config hash differs → force re-chunk even if content unchanged. Separate from re-embed logic.
