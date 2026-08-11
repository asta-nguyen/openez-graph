# Local Embedding CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add explicit openez embed [path], remove embedding work from index/reindex/watch, and benchmark the existing retrieval fixture after vectors are materialized.

**Architecture:** Keep EmbeddingProvider as the provider boundary. Add a small pinned Model2Vec catalog/cache/runtime using @huggingface/tokenizers plus a minimal safetensors reader; the explicit embedding service reuses the existing repository materialization logic. indexWorkspace() writes documents, chunks, parse cache, FTS, and graph invalidation only; retrieval remains read-only and falls back to FTS when active vectors are absent.

**Tech Stack:** TypeScript, Bun tests, SQLite workspace repositories, @huggingface/tokenizers 0.1.3, public Hugging Face HTTP downloads, pinned Model2Vec F16 artifact astanguyen/jina-code-static-256.

## Global Constraints

- Local artifact revision is b4459b817b536239ebbf8e29ff487fea4b16f3f7.
- Local model cache is global under ~/.openez/models/; vectors remain per-workspace SQLite data.
- init, index, reindex, and watch must not construct providers, download models, or write embeddings.
- openez embed is incremental by default; --force deletes only the active provider/model rows before rebuilding.
- Retrieval must never download a model; no active vectors means FTS + graph fallback.
- Do not add Python, Ollama download, ANN, queue, or model-GC infrastructure.

---

### Task 1: Add the pinned local Model2Vec runtime

**Files:**

- Modify: packages/core/package.json (add @huggingface/tokenizers 0.1.3)
- Create: packages/core/src/local-embedding.ts
- Modify: packages/core/src/embeddings.ts
- Modify: packages/core/src/index.ts
- Test: tests/local-embedding.test.ts

**Interfaces:**

- Produce LocalEmbeddingProvider implements EmbeddingProvider with provider: "local" and model: "jina-code-static-256".
- Produce LOCAL_EMBEDDING_MODELS with repo, revision, dimensions, and required file SHA-256 values.
- Produce getLocalEmbeddingModel(model?: string): Promise<LocalEmbeddingProvider> and getLocalEmbeddingCacheDir(model?: string): string.

- [ ] Step 1: Write failing runtime tests. Assert the catalog contains the pinned repo/revision/dimensions, a cache path is beneath ~/.openez/models, and a provider created with an injected fixture directory returns two finite 256-value normalized vectors.

- [ ] Step 2: Run the focused test and verify it fails.

Run: rtk bun test tests/local-embedding.test.ts

Expected: FAIL because the local provider/catalog exports do not exist.

- [ ] Step 3: Add the dependency and catalog. Add @huggingface/tokenizers 0.1.3. In local-embedding.ts, define the public artifact files (config.json, modules.json, tokenizer.json, model.safetensors) and checksums from the published snapshot; use os.homedir() and path.join(home, ".openez", "models", "astanguyen", "jina-code-static-256", revision) for the default cache.

- [ ] Step 4: Implement cache download and validation. Download each required file from https://huggingface.co/astanguyen/jina-code-static-256/resolve/<revision>/<file> with bounded retry for network/429/5xx errors. Write to a same-directory .part file, hash with crypto.createHash("sha256"), reject mismatches, then rename atomically. Use one in-process promise per cache key so concurrent callers share one download. The cache helper accepts an optional root directory for tests.

- [ ] Step 5: Implement Model2Vec loading. Construct new Tokenizer(JSON.parse(tokenizer.json), {}). Parse the safetensors header (8-byte little-endian header length followed by JSON), locate the embeddings tensor, decode F16 values to Float32Array, and retain its [vocab, 256] matrix. For each input, encode IDs, mean-pool rows with attention_mask, L2-normalize, and return number[][]; reject missing IDs, non-finite values, wrong dimensions, or empty input batches. Keep the runtime read-only after the validated cache is present.

- [ ] Step 6: Wire provider config. Extend EmbeddingProvider.provider to "openai" | "ollama" | "local"; add localModel to EmbeddingConfig, read embedding.local_model/OPENEZ_LOCAL_EMBEDDING_MODEL, default to jina-code-static-256, and dispatch provider=local through the lazy cache/provider constructor. Keep OpenAI/Ollama behavior unchanged.

- [ ] Step 7: Run focused tests.

Run: rtk bun test tests/local-embedding.test.ts tests/vector-search.test.ts

Expected: PASS; vector storage/retrieval tests remain green.

- [ ] Step 8: Commit.

```bash
git add packages/core/package.json packages/core/src/local-embedding.ts packages/core/src/embeddings.ts packages/core/src/index.ts tests/local-embedding.test.ts pnpm-lock.yaml
git commit -m "feat(core): add pinned local embedding provider"
```

### Task 2: Move embedding materialization into an explicit indexer service

**Files:**

- Create: packages/indexer/src/embed-workspace.ts
- Modify: packages/indexer/src/index-workspace.ts
- Modify: packages/indexer/src/index.ts
- Test: tests/embed-workspace.test.ts

**Interfaces:**

- Produce embedWorkspace(input: { workspaceId?: string; rootPath?: string; force?: boolean; onProgress?: (progress: { message: string; progress: number }) => Promise<void> | void }): Promise<{ workspaceId: string; provider: string; model: string; chunksConsidered: number; embeddingsWritten: number; embeddingFailures: number }>.
- Reuse the existing writeEmbeddingsToRepo batching, input hashes, duplicate reuse, dimension checks, and EmbeddingProvider serialization; do not duplicate those rules.

- [ ] Step 1: Extract the existing materializer. Move writeEmbeddingsToRepo and its imports from index-workspace.ts into embed-workspace.ts as an exported helper, preserving the current batch size, hash reuse, and error behavior.

- [ ] Step 2: Write failing service tests. After Task 3 Step 2 removes embedding materialization from indexWorkspace, create a temporary registered workspace with embedding.provider=local, index it, call embedWorkspace, assert the returned count equals the chunk count and the embeddings table contains the active provider/model rows. Call it again and assert embeddingsWritten is zero; call with force: true and assert rows are rebuilt. Until that removal is applied, the empty-before-embed assertion is expected to fail.

- [ ] Step 3: Implement workspace resolution and chunk collection. Resolve workspaceId or rootPath exactly as indexWorkspace() does, write .openez/workspace.json, load the configured provider, list documents, fetch each document's chunks, and map { id, content, path, heading }. If no provider is configured, throw No embedding provider configured; set embedding.provider first.

- [ ] Step 4: Implement force mode and progress. For force, execute DELETE FROM embeddings WHERE provider = ? AND model = ? before materialization. Report cache/provider/chunk progress through onProgress; leave all other providers, FTS, graph, and memories untouched.

- [ ] Step 5: Run service tests.

Run: rtk bun test tests/embed-workspace.test.ts

Expected: PASS for incremental reuse and force rebuild.

- [ ] Step 6: Commit.

```bash
git add packages/indexer/src/embed-workspace.ts packages/indexer/src/index-workspace.ts packages/indexer/src/index.ts tests/embed-workspace.test.ts
git commit -m "feat(indexer): expose explicit workspace embedding"
```

### Task 3: Remove embedding work from indexing and add openez embed

**Files:**

- Modify: packages/indexer/src/index-workspace.ts
- Modify: packages/indexer/src/types.ts
- Modify: apps/cli/src/cli.ts
- Test: tests/index-workspace.test.ts
- Test: tests/cli-embed.test.ts
- Modify: README.md

**Interfaces:**

- indexWorkspace() continues returning embeddingsWritten: 0 and embeddingFailures: 0 for backward-compatible summaries, but never calls getEmbeddingProvider() or writes embeddings rows.
- CLI command is openez embed [path] with --force; it prints the service result as JSON and exits non-zero on unregistered paths or provider errors.

- [ ] Step 1: Add the regression test first. Configure a fake/local provider, run indexWorkspace, assert the embeddings row count is zero, then run embedWorkspace and assert it becomes non-zero. Repeat with a full reindex to prove it does not delete or recreate vectors.

- [ ] Step 2: Remove index embedding branches. Delete provider construction/logging, unchanged-file backfill, allChunkRowsForEmbeddings, embedding progress, and post-transaction embedding calls from index-workspace.ts. Complete index runs with zero embedding fields and no embedding error message; retain summary fields for API compatibility.

- [ ] Step 3: Add CLI config exposure. Add embedding.local_model to EMBEDDING_CONFIG_KEYS, config get, and the printed config. Validate provider values as none, openai, ollama, or local; print the full valid list in errors.

- [ ] Step 4: Add the command. Import embedWorkspace, resolve/register the path using the existing readLocalWorkspaceConfig/registry flow, call it with force and progress logging, and print JSON. Do not call embedding from init, index, reindex, or watch.

- [ ] Step 5: Add CLI/help docs. Document:

```text
openez index <path>       # chunks/FTS/graph only
openez embed <path>       # configured provider vectors
openez embed <path> --force
```

- [ ] Step 6: Run regression and CLI tests.

Run: rtk bun test tests/index-workspace.test.ts tests/cli-embed.test.ts

Expected: PASS; command help includes embed, and index/reindex leave embedding count unchanged.

- [ ] Step 7: Commit.

```bash
git add packages/indexer/src/index-workspace.ts packages/indexer/src/types.ts apps/cli/src/cli.ts tests/index-workspace.test.ts tests/cli-embed.test.ts README.md
git commit -m "feat(cli): separate embedding from indexing"
```

### Task 4: Update the retrieval benchmark to exercise explicit embedding

**Files:**

- Modify: tests/embed-benchmark.test.ts
- Modify: tests/retrieval-eval.test.ts
- Modify: package.json
- Modify: docs/CODE_RAG_REVIEW.md

**Interfaces:**

- Default benchmark remains offline and deterministic: index fixture with provider none, then assert the existing Recall@5/MRR floors.
- Opt-in embedding benchmark uses OPENEZ_BENCHMARK_EMBEDDINGS=1, configures the selected provider, calls embedWorkspace() after indexing, and compares vector-enabled retrieval against the FTS baseline.

- [ ] Step 1: Update the benchmark test first. Import embedWorkspace; remove the assumption that indexWorkspace() creates vectors. In the opt-in branch, call embedWorkspace({ workspaceId }) and assert embeddingsWritten > 0 before evaluating.

- [ ] Step 2: Keep the baseline gate explicit. Run the same fixture with embedding.provider=none; assert recallAt5 >= 0.7, mrr >= 0.45, and graph expansion still finds the helper file. Restore registry settings in finally.

- [ ] Step 3: Add a runnable script. Keep benchmark:retrieval as the offline gate and add benchmark:retrieval:embeddings that sets OPENEZ_RUN_BENCHMARK=1 OPENEZ_BENCHMARK_EMBEDDINGS=1 and uses the existing test file.

- [ ] Step 4: Run both benchmark modes.

Run: rtk pnpm benchmark:retrieval

Expected: PASS with the fixture Recall@5/MRR floors.

Run: OPENEZ_BENCHMARK_WORKSPACE_PATH=$PWD OPENEZ_RUN_BENCHMARK=1 OPENEZ_BENCHMARK_EMBEDDINGS=1 rtk bun test tests/embed-benchmark.test.ts --timeout 120000

Expected: PASS after one pinned model download; output includes files, chunks, FTS metrics, and embedding metrics.

- [ ] Step 5: Update the review report. Replace the old “index implicitly embeds” finding with the explicit lifecycle: index builds lexical/graph artifacts, embed materializes configured vectors, code_query uses vectors only when rows exist and otherwise falls back.

- [ ] Step 6: Commit.

```bash
git add tests/embed-benchmark.test.ts tests/retrieval-eval.test.ts package.json docs/CODE_RAG_REVIEW.md
git commit -m "test: benchmark explicit embedding workflow"
```

### Task 5: Full verification and handoff

**Files:**

- Verify: packages/core, packages/indexer, apps/cli, tests

- [ ] Step 1: Run typecheck/build.

Run: rtk pnpm typecheck

Expected: PASS with the new provider and CLI exports.

- [ ] Step 2: Run the focused regression suite.

Run: rtk bun test tests/local-embedding.test.ts tests/embed-workspace.test.ts tests/index-workspace.test.ts tests/retrieval-eval.test.ts

Expected: PASS.

- [ ] Step 3: Smoke the CLI in a temporary workspace. Run openez init <temp> --no-index, openez index <temp>, confirm embedding count is zero, configure embedding.provider=local, run openez embed <temp>, then run openez status <temp>.

- [ ] Step 4: Inspect the diff.

Run: rtk git diff --check && rtk git status --short

Expected: no whitespace errors; only requested implementation/docs/tests plus pre-existing user changes remain.

- [ ] Step 5: Commit verification-only adjustments if needed.

```bash
git add packages/core packages/indexer apps/cli tests README.md docs/CODE_RAG_REVIEW.md package.json pnpm-lock.yaml
git commit -m "chore: verify explicit embedding workflow"
```
