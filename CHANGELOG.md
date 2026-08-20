# Changelog

All notable changes to OpenEZ Graph are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.0] - 2026-08-19

### Added

- **`code_outline` MCP tool** — retrieves a compact AST symbol hierarchy (functions, classes, methods, types) with line numbers and export flags for a single file, reducing token consumption by ~95% compared to full file reads. Supports TypeScript (oxc-parser), Python/Go/Rust/Ruby (tree-sitter), and fallback section chunking for Markdown/YAML/JSON/TOML. Resolves files by relative path, absolute path, dot-slash prefix, or unambiguous suffix match.
- **`code_outline` in agent setup instructions** — `openez setup codex/claude/opencode/windsurf/devin` now injects guidance to use `code_outline` before reading full files.

### Changed

- **`getFileOutline` path resolution** — uses `path.isAbsolute()` instead of `startsWith("/")` so Windows absolute paths (`C:\foo\bar.ts`) receive the same symlink realpath fallback as Unix absolute paths.
- **`getFileOutline` async realpath** — replaced `fs.realpathSync` with `fs.promises.realpath` to avoid blocking the MCP event loop on absolute-path cache misses.
- **AGENTS.md MCP Expectations** — `code_outline` classified as a single-workspace tool alongside `memory_write`, `index_workspace`, and `remove_workspace`.

### Fixed

- **Umami analytics ID** — reverted an unrelated `data-website-id` change introduced by the `code_outline` branch; main's Umami PRs (#27, #31) take precedence at merge time.
- **`getFileOutline` suffix disambiguation** — returns `null` when multiple files share the same basename suffix, preventing ambiguous outline lookups.
- **`getFileOutline` LIKE wildcard safety** — escapes `%` and `_` in suffix queries so wildcard characters in filenames don't cause false matches.
- **`outlineText` size formatting** — uses `String(sizeBytes)` instead of `toLocaleString()` to avoid locale-dependent formatting in the outline header.
- **Indexer `normalizeRelativePath`** — normalizes paths on document insert so Windows backslash paths are stored consistently.

## [1.3.1] - 2026-08-16

### Fixed

- **Reindex and DB open performance on large workspaces** — `openez status` and `openez reindex` on a 92K-chunk workspace (e.g. Zed) went from >8 minutes (100% CPU, never completing) to ~0.15s (status) and ~25s (reindex). Two root causes fixed:
  - **FTS repair scan on every DB open** — `initializeWorkspaceSchema` ran an O(n²) `LEFT JOIN chunks_fts` (chunk_id is UNINDEXED in FTS5) plus an orphan-cleanup `DELETE ... NOT IN` on every open, even when FTS was fully in sync. Now skips the expensive repair when a count + shape check confirms FTS is in sync, and only runs the full repair when counts diverge or orphaned rows are detected.
  - **FTS trigger storm during full reindex** — `resetIndexArtifacts` deleted 92K chunks with FTS triggers active, firing 92K triggered `DELETE FROM chunks_fts WHERE chunk_id = old.id` (each a full FTS shadow-table scan). Now drops FTS triggers and the FTS table before deleting chunks, then recreates an empty FTS table for the reindex to populate via `bulkInsertFts`.

## [1.3.0] - 2026-08-15

### Added

- **Ruby indexing** — tree-sitter WASM symbol extraction for classes, modules, methods, singleton methods, named lambdas, `class << self` nesting, and `require_relative` import edges.
- **Ruby and frontend language scanning** — `.rb`, `.rake`, `.gemspec`, CoffeeScript, Slim, CSS, SCSS, Sass, Less, and Haml files are now indexed; unsupported languages use fallback chunking.

### Fixed

- **Ruby graph extraction** — preserves calls inside ordinary assignments, qualifies `self` calls in class bodies, keeps regex fallback nesting correct, and aligns method export metadata with the AST parser.

## [1.2.0] - 2026-08-11

### Added

- **Lease-based indexing ownership** — indexing claims a 60-second lease with 15-second heartbeat. If the lease expires (e.g. process crash), another process can take over. Completion and failure writes are fenced by owner token — a stale owner cannot overwrite the status set by a newer owner.
- **Graph build warnings in MCP** — `code_query` response includes a `warnings` array when graph expansion fails, so callers see FTS-only results instead of silently missing graph expansion.
- **Web UI: Reindex button** — workspace detail page now has a "Reindex workspace" button with loading state and error display, triggering a full rebuild via `startIndexRun(workspaceId, "full")`.
- **Web UI: Build & Open Graph** — workspace detail page shows "Build & Open Graph" button when graph data is empty, or "Open Graph" when graph exists. Graph is built lazily on first access via `ensureGraphReady`.
- **Web UI: Local embedding model picker** — settings page now supports selecting local embedding model preset (`jina-code-static-256`) with server-side validation against `LOCAL_EMBEDDING_MODELS` catalog. Provider dropdown includes "OpenEZ local" option alongside OpenAI and Ollama.

### Fixed

- **MCP `code_context` validation** — removed misplaced `nodeId`/`label` guard that threw on every `code_context` call (schema requires `symbolOrPath`).
- **MCP truncation pairing** — `fitToTokenBudget` now drops whole result entries instead of emptying inner source arrays (`callers`, `callees`, `relatedChunks`, `sources`, `files`), keeping context and structured sources paired under token truncation.
- **Retrieval preflight** — `vectorSearch` checks `hasLegacyEmbeddings()` and active-model vector existence before calling `provider.embed`, avoiding wasted API calls for workspaces with legacy TEXT or no embeddings.
- **Optional tokenizer dependency** — `@huggingface/tokenizers` is now a dynamic import in `local-embedding.ts`, making embeddings truly optional. The static import forced the dependency on all core package consumers.
- **Lease-fenced index completion/failure** — `completeIndexing` and `failIndexing` check `index_build_owner` in the WHERE clause, mirroring graph build fencing. A stale lease holder can no longer overwrite the status set by a newer owner.
- **Authoritative schema initialization** — web server delegates registry and workspace schema creation to `@openez-graph/db` (`getRegistryDdl`, `getFullWorkspaceDdl`, `migrateRegistrySchema`), eliminating duplicated DDL and missing migrations (registry_meta, graph invalidation backfill).
- **Browser tokenizer boundary** — local embedding model catalog exposed via settings API (`localModels: string[]`) instead of direct `@openez-graph/core` import, preventing `@huggingface/tokenizers` from entering the Vite client bundle.
- **Strict TypeScript gates** — explicit type parameters on all `queryOptions` calls; test fetch mocks use `as unknown as typeof fetch` double cast.
- **Docs reconciliation** — corrected stale reindex docs (full reindex replaces chunks and removes vectors), documented `code_context` limit contract (50/workspace, max 200, token-budgeted), corrected watcher debounce from 250ms to 2s, documented MCP auto-sync as opt-in via `OPENEZ_MCP_WATCH=1`, documented `openez setup` AGENTS.md/CLAUDE.md instruction file mutation.

## [1.1.0] - 2026-08-10

### Added

- **`openez embed` command** — standalone embedding step separated from indexing. Run `openez embed [path]` after `openez index` to create vectors. Supports `--force` to rebuild vectors for the active provider/model.
- **Local embedding provider (`local`)** — zero-config in-process embedding using `jina-code-static-256` (256d static token embeddings). Downloads model files from HuggingFace on first use with SHA256 checksum verification and atomic writes. No Ollama or OpenAI required.
- **`embedding.local_model` config key** — configurable local model preset via `openez config set embedding.local_model jina-code-static-256`.
- **Lazy graph build lifecycle** — graph construction deferred to the first query or another approved CLI command, with invalidation tracking on reindex.
- **Nested TypeScript symbol discovery** — `oxc-parser` now registers named nested functions and arrow functions assigned to variables as first-class graph symbols.
- **Graph invalidation generations** — persisted invalidation markers ensure stale graph edges are rebuilt after incremental reindex.

### Changed

- **Indexing no longer creates embeddings** — `openez index` writes chunks, FTS, and graph only. Use `openez embed` for vectors. Retrieval falls back to FTS + graph when embeddings are absent.
- **BLOB cosine search is the supported vector path** — legacy TEXT embeddings detected and skipped; run `openez reindex` then `openez embed --force` to rebuild as BLOB vectors (reindex alone does not write vectors).
- **FTS metadata normalization** — Unicode-aware text composition for FTS indexing preserves complete chunk content.
- **Token strategy scoped** — `fastTokenCounter` (chars/4) for indexing, `exactTokenCounter` (GPT BPE) for retrieval budgeting, with concurrency-safe lazy loading.
- **Parser cache** — parsed document results cached per-file to avoid redundant AST walks during incremental reindex.

### Fixed

- **FTS Unicode normalization** — chunk content with multi-byte characters no longer truncated in FTS index.
- **FTS metadata JSON parsing** — guarded against malformed metadata causing indexing failures.
- **Stale FTS version rebuild ordering** — FTS triggers correctly restored after bulk write phase.
- **Graph build produced 0 symbol nodes** — `oxc-parser` native binding resolution fixed in bundled CLI.
- **Registry `graph_status` not updated** — registry now reflects actual node/edge counts after graph build.
- **RAG flow correctness** — second-round review blockers resolved in retrieval pipeline.

### Contributors

- **Asta Nguyen** — [@asta-nguyen](https://github.com/asta-nguyen)

## [1.0.3] - 2026-08-08

### Fixed

- **Registry `graph_status` not updated after graph build** — `_buildGraphInternal` built the graph correctly but never updated the registry's `graph_status`/`node_count`/`edge_count`, so the web UI showed 0 nodes and 0 edges even though the workspace DB had the data. Now updates the registry after a successful build.

### Contributors

- **Asta Nguyen** — [@asta-nguyen](https://github.com/asta-nguyen)
- **JoeJoe** — [@JoeJoeflyn](https://github.com/JoeJoeflyn)

## [1.0.2] - 2026-08-08

### Fixed

- **Graph build produced 0 symbol nodes and 0 edges** — `oxc-parser` (NAPI-RS native binding) was not declared in CLI `dependencies` and was not listed in tsup `external`, so `require("oxc-parser")` failed silently in the bundled CLI, falling back to line-based chunking with 0 symbols. Added `oxc-parser` to `dependencies` and `oxc-parser` + `@oxc-parser/binding-*` to tsup `external` so the native binding resolves from `node_modules` at runtime.
- **Registry `graph_status` not updated after graph build** — `_buildGraphInternal` built the graph correctly but never updated the registry's `graph_status`/`node_count`/`edge_count`, so the web UI showed 0 nodes and 0 edges even though the workspace DB had the data. Now updates the registry after a successful build.

### Contributors

- **Asta Nguyen** — [@asta-nguyen](https://github.com/asta-nguyen)
- **JoeJoe** — [@JoeJoeflyn](https://github.com/JoeJoeflyn)

## [1.0.1] - 2026-08-08

### Changed

- README.md and apps/cli/README.md updated to document Bun runtime and [oxc-parser](https://oxc.rs) migration

## [1.0.0] - 2026-08-08

### Changed

- CLI runtime changed from Node.js 20+ to [Bun](https://bun.sh) 1.1+ — `bun:sqlite` is now the only SQLite driver, removing the `better-sqlite3` fallback and runtime detection layer
- CLI shebang changed from `#!/usr/bin/env node` to `#!/usr/bin/env bun`
- `engines` field in `apps/cli/package.json` changed from `node >=20` to `bun >=1.1.0`

### Removed

- `better-sqlite3` dependency and `drizzle-orm/better-sqlite3` driver path
- `drizzle-driver.ts` (runtime driver selection module)
- `adaptBetterSqlite3()` adapter in `database-loader.ts` (60-line Proxy wrapper)

### Fixed

- npm-installed CLI no longer crashes with `Cannot find module 'bun:sqlite'` — the CLI now requires Bun and uses it as the runtime

## [0.12.0] - 2026-08-06

### Added

- `openez remove` CLI command with confirmation prompt, indexed-data summary, and `--yes`/`--id` options
- `remove_workspace` MCP tool with `confirm: true` guard and watcher cleanup
- Pin/unpin toggle on workspaces page with in-flight disable and error display
- Delete confirmation dialog with ARIA dialog semantics (role, aria-modal, aria-labelledby), focus trap, Escape-to-close, and focus restore
- `pin_order` monotonic column for deterministic pinned-workspace ordering regardless of wall-clock resolution
- Delete dialog surfaces partial-failure warnings (data dir not removed) instead of silently closing
- Indexed doc/chunk counts shown in CLI remove confirmation screen

### Changed

- Workspace removal now closes the native DB handle before deleting `.openez`, preventing EBUSY on Windows
- Removal order changed: close DB → delete data dir → unregister, so failed cleanup stays retryable
- `pathExists` in remove-workspace only catches ENOENT; other stat errors are reported as warnings
- MCP `remove_workspace` resolves relative paths with `path.resolve` for consistency with CLI and other MCP tools
- Pin/delete action buttons are now siblings of the workspace link instead of nested inside it (valid HTML)
- Web server delete handler closes cached workspace DB handle before removal
- Race-safe registry column migration (try/catch + re-check on ALTER TABLE)
- Registry DB cache cleared on initialization failure

### Fixed

- `closeWorkspaceDb` now calls `.close()` on the native better-sqlite3 handle instead of only dropping the cache entry
- Delete mutation throws on `{ success: false }` responses, preventing dialog close on server-side failure
- Pin mutation throws on `{ success: false }` responses, preventing silent failure
- Delete handler returns HTTP 500 on catch instead of implicit 200
- Pin handler validates request body with safe `.catch()` for malformed JSON
- Dialog text overflow with long workspace paths (break-all on code, break-words on paragraphs)
- MCP auto-sync watcher closed when its workspace is removed, preventing stale reindex attempts

## [0.11.1] - 2026-08-06

### Fixed

- Writing phase performance bottleneck: symbol, import, and wikilink node upserts batched per file instead of N individual queries
- Embedding provider and model now logged at indexing startup for visibility
- Progress logs added for post-writing phases (embedding batches, FTS rebuild, call edge resolution)

## [0.11.0] - 2026-08-06

### Added

- Tree-sitter AST parsing for Python, Go, and Rust via `web-tree-sitter` (WASM) with regex fallback
- `CodeParser` interface and parser-registry pattern — pluggable parser dispatch via `getParserForPath()` + `parseDocument()`
- Six parser implementations: `TsMorphParser`, `TreeSitterParser`, `MarkdownParser`, `ConfigParser`, `FallbackParser`, and `parser-registry` dispatcher
- `language` and `parser` fields on symbol graph node metadata
- `confidence` field on call edge metadata (`medium` for ts-morph, `low` for tree-sitter/regex)
- 27 new tests (14 parser-registry + 13 tree-sitter parser)

### Changed

- `chunkDocument()` in `index-workspace.ts` reduced from ~150 lines of per-language branching to a 12-line delegate to `parseDocument()`
- Python/Go/Rust indexing upgraded from regex-only to tree-sitter AST with automatic regex fallback
- CLI bundles `web-tree-sitter` WASM grammars for Python, Go, and Rust

### Fixed

- Call edges now track originating parser for confidence attribution

## [0.10.0] - 2026-08-05

### Fixed

- MCP stdio corruption: retrieval diagnostics now write to `stderr` instead of `stdout`, preserving JSON-RPC framing for `code_query` calls
- `lint-staged` downgraded from v17 to v16.4.0 for Node.js 20 compatibility (v17 requires Node >=22.22.1)
- Master key race condition: atomic exclusive file creation (`O_CREAT|O_EXCL`) prevents concurrent processes from generating different keys
- Master key malformed-file handling: invalid key content now throws an explicit error instead of silently overwriting the file
- Master key file permissions: existing key files are now `chmod`-ed to `0o600` on read if permissions are too open
- Embedding dedup: chunks skipped by `input_hash` match now receive a copied embedding row so they appear in vector search results
- Embedding dedup legacy cleanup: `ROW_NUMBER()` ordering (newest, non-null `input_hash` first) replaces `MIN(id)` to preserve the most useful embedding
- Composite index `(provider, model, input_hash)` added to speed up embedding dedup lookups on large workspaces
- `vectorSearch` now wraps `getEmbeddingProvider()` in the same `try` block so initialization failures fall back to FTS instead of aborting `codeQuery`
- Web API `PUT /api/settings/embedding` validates `embedding.provider` against `none`, `openai`, `ollama` (returns 400 for invalid values)
- Web API clearing a setting (empty value) now deletes the DB override instead of skipping it, restoring env/default fallback
- CLI `config get <key>` resolves the effective DB-plus-environment value and prints `not set` when absent
- CLI sensitive-key masking uses `isSensitiveKey()` consistently across all `config` commands
- Settings UI syncs external config to form state via `useEffect` instead of setState-during-render; form updates after save refetch
- Settings UI resets the "Saved!" indicator when any field is edited after a successful save
- RRF `identity()` function computed once per entry instead of twice (get + set)
- Benchmark test isolated from the user's real registry DB via temp `AI_MEMORY_REGISTRY_DB_PATH`
- Benchmark stats workspace path resolved from registry instead of `cwd` to match `codeQuery`
- `withRetry` dead code replaced with a type-safe unreachable return

### Changed

- README storage section updated from three to four local artifacts (added `master.key`)

## [0.9.0] - 2026-08-02

### Added

- MCP server version and Git build identity in the protocol handshake
- Token budgets for `code_query`, `code_context`, `graph_neighbors`, and `memory_recall`, with compact graph/context responses
- Live `code_query` token telemetry on the dashboard and benchmark page
- MCP contract tests for response budgets, multi-workspace attribution, graph context, and startup indexing

### Changed

- Multi-workspace retrieval now applies one global serialized-response budget and attributes delivered tokens exactly across workspaces
- CLI npm package now exposes the bundled entry point and installs only `better-sqlite3` at runtime

### Fixed

- Empty workspaces no longer re-index on every MCP server restart
- Very small token budgets are rejected instead of returning an oversized response
- Token-savings telemetry now uses selected full-file tokens minus the actual serialized response size

## [0.8.0] - 2026-08-02

### Added

- Memory management UI at `/memories` with list, search, detail view, and create dialog
- Memory API routes: `GET /api/memories` (list + search), `GET /api/memories/:id`, `POST /api/memories`, `DELETE /api/memories/:id`
- Recent memories section on the dashboard now populated from the workspace database
- Memories navigation link in the sidebar with prefetch on hover
- `resolveActiveWorkspace` helper to select the first workspace with a valid root path for memory operations
- Integration tests for hybrid retrieval ranking and registry operations

### Fixed

- Changelog page stuck loading — `findChangelogPath` now walks up from `serverDir` and `cwd` to locate `CHANGELOG.md` in the monorepo root
- Memory endpoints no longer fail when the first registered workspace has a stale root path

## [0.7.0] - 2026-08-01

### Added

- Web dashboard changelog page (`/changelog`) with structured rendering of release notes from `CHANGELOG.md`
- API endpoint `GET /api/changelog` serving the repo changelog
- Changelog link in CLI README for npm package page
- Release workflow instructions in `AGENTS.md` for cross-agent support (Codex, OpenCode, Claude Code)
- Agent skill at `.agents/skills/release-cli/SKILL.md` for automated release workflow
- `memory_recall` MCP tool for retrieving active technical decisions and learned notes written by `memory_write`

### Changed

- Renamed the public `memory_query` MCP tool to `code_query`; the old name remains a deprecated, hidden compatibility alias
- Code retrieval now fuses both FTS and vector results, and `code_context` supports result/token budgets

## [0.6.1] - 2026-08-01

### Added

- Syntax-highlighted context blocks in the web Query page (`prism-react-renderer`), with per-source file metadata (path, line range, score) and line numbers
- Markdown context blocks now render fenced code blocks with their own language highlighting (e.g. ` ```bash ` gets real bash highlighting)

### Fixed

- Dark boxes obscuring markdown inline code in context blocks (stripped token `backgroundColor` from the nightOwl theme)

## [0.6.0] - 2026-08-01

Remediation release — index/graph correctness, data protection, and web flow fixes.

### Security

- Web API and CLI dashboard now bind to loopback (`127.0.0.1`) by default (FIX-01)

### Fixed

- Full reindex no longer wipes memories, query logs, and run history — only rebuildable index artifacts are reset (FIX-02)
- Incremental indexing preserves inbound graph edges (calls/imports) to symbols in changed files; symbol and file node identities are now stable across re-parses (FIX-03)
- Graph edges are deduplicated by `(from, to, type)` with a unique SQLite index and `ON CONFLICT DO NOTHING` inserts (FIX-04)
- Web index endpoint (`POST /api/workspaces/:id/index`) now runs real indexing synchronously instead of returning a stub (FIX-05)
- Incremental indexing skips reading files whose `mtimeMs`/`sizeBytes` are unchanged; content-hash verification catches stat-only changes (FIX-06)
- Regenerated stale route tree referencing the deleted `/jobs` route; removed the CI lint no-op (`turbo run lint` with zero lint tasks) (FIX-08)

### Removed

- Jobs page and related API endpoints

## [0.5.1] - 2026-07-31

### Fixed

- Blazing-fast indexing for large codebases (batch transactions, optimized write mode)
- Error handling and validation for import path extraction
- CLI npm packaging

[1.4.0]: https://github.com/asta-nguyen/openez-graph/compare/v1.3.1...v1.4.0
[1.3.1]: https://github.com/asta-nguyen/openez-graph/compare/v1.3.0...v1.3.1
[1.2.0]: https://github.com/asta-nguyen/openez-graph/compare/v1.1.0...v1.2.0
[1.3.0]: https://github.com/asta-nguyen/openez-graph/compare/v1.2.0...v1.3.0
[1.1.0]: https://github.com/asta-nguyen/openez-graph/compare/v1.0.3...v1.1.0
[1.0.3]: https://github.com/asta-nguyen/openez-graph/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/asta-nguyen/openez-graph/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/asta-nguyen/openez-graph/compare/v1.0.0...v1.0.1
[0.12.0]: https://github.com/asta-nguyen/openez-graph/compare/v0.11.1...v0.12.0
[0.11.1]: https://github.com/asta-nguyen/openez-graph/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/asta-nguyen/openez-graph/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/asta-nguyen/openez-graph/compare/fbcad4f...HEAD
[0.9.1]: https://github.com/asta-nguyen/openez-graph/compare/fbcad4f...HEAD
[0.9.0]: https://github.com/asta-nguyen/openez-graph/compare/fbcad4f...HEAD
[0.8.0]: https://github.com/asta-nguyen/openez-graph/compare/a7ce4df...849060b
[0.7.0]: https://github.com/asta-nguyen/openez-graph/compare/9b7cc78...a7ce4df
[0.6.1]: https://github.com/asta-nguyen/openez-graph/compare/405f7e8...9b7cc78
[0.6.0]: https://github.com/asta-nguyen/openez-graph/compare/5ff0f5c...405f7e8
[0.5.1]: https://github.com/asta-nguyen/openez-graph/releases/tag/v0.5.1
