# Local Embedding CLI Design

## Goal

Add an explicit `openez embed [path]` workflow that uses a configured embedding
provider without making `init`, `index`, `reindex`, or `watch` perform network
downloads or embedding work.

## Scope

This slice covers three providers through one command: OpenAI calls the remote
API, Ollama uses the model already managed by the local Ollama daemon, and the
new local static preset loads the published public Model2Vec artifact
`astanguyen/jina-code-static-256` at pinned revision
`b4459b817b536239ebbf8e29ff487fea4b16f3f7`. The local artifact is public,
ungated, 256-dimensional F16 Model2Vec data and has passed anonymous download
and `StaticModel` smoke tests.

The command downloads local model files into a global OpenEZ cache, verifies
the pinned artifact, and stores vectors in the selected workspace database.
Indexing remains responsible for documents, chunks, FTS, parse cache, and graph
data only. Embedding is incremental: changed chunks lose their old vectors and
the next `openez embed` run fills missing rows.

## Architecture

`EmbeddingProvider` remains the shared interface. Provider construction is
split from indexing so `getEmbeddingProvider()` is used by retrieval and the
explicit embed service, not by `indexWorkspace()`. A small model catalog maps a
user-facing preset to its engine, Hugging Face repository, immutable revision,
checksum metadata, and dimensions.

The local static provider has two isolated responsibilities: a global artifact
cache/downloader and a Model2Vec runtime. The cache uses in-process
de-duplication plus atomic publish (temporary downloads, checksum validation,
and atomic rename). The runtime loads the artifact's ByteLevel BPE tokenizer
and F16 embedding matrix, mean-pools token vectors, and normalizes the result
to the same `number[][]` interface as OpenAI and Ollama. No Python process is
required at runtime.

## Data flow

```text
openez config set ...
        |
        v
openez embed <workspace>
        |
        +--> provider config validation
        +--> local cache hit or pinned download + checksum
        +--> scan workspace chunks / find missing active-model rows
        +--> batch embed
        +--> insert embeddings(provider, model, dimensions, input_hash)
        v
code_query = FTS + graph + vector when active-model rows exist
```

`code_query` never downloads a model. If the configured provider is unavailable
or the workspace has no active-model vectors, retrieval logs the reason and
falls back to FTS + graph.

## Configuration and CLI

Existing `embedding.provider` values remain valid. Add `embedding.local_model`
with the default `jina-code-static-256` when `provider=local`. CLI and web
settings expose the preset and provider; saving config never downloads.

The new command is:

```bash
openez embed [path]
```

It resumes missing vectors by default. `--force` is limited to deleting and
rebuilding embeddings for the active provider/model; it does not touch FTS,
graph, memories, or other providers. A successful run reports provider, model,
cache status, chunks considered, vectors written, and failed batches.

## Safety and failure handling

- Never use a shared Hugging Face token; public downloads are anonymous.
- Pin the full model commit and verify the catalog checksum before activation.
- Download to a temporary path and atomically publish only after validation.
- Retry bounded 429/5xx/network failures; keep the last valid cache on failure.
- De-duplicate in-flight downloads per model within a process so concurrent
  calls share the same load; cross-process serialization is not guaranteed
  unless a filesystem lock is added.
- Preserve partial workspace progress; rerunning `embed` resumes missing rows.
- Validate vector count, dimensions, finite values, and consistent model key
  before inserting a batch.

## Verification

Tests must cover: model catalog validation; cache hit/miss and checksum failure;
Model2Vec tokenizer/matrix output shape and normalization; explicit embed
incremental behavior; `index`/`reindex` never invoking providers; OpenAI/Ollama
provider dispatch; retrieval fallback with no vectors; and the existing
fixture-backed retrieval Recall@5/MRR gate with graph expansion enabled.

## Non-goals

- No automatic embedding during `init`, `index`, `reindex`, or `watch`.
- No model pruning/garbage collector in this slice; old model rows remain
  available for rollback and are filtered by active provider/model.
- No new database, queue, ANN extension, Python runtime, or Ollama model
  downloader.
- No release or Hugging Face upload from OpenEZ itself.
