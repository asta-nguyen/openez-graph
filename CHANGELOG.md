# Changelog

All notable changes to OpenEZ Graph are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.11.0]: https://github.com/asta-nguyen/openez-graph/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/asta-nguyen/openez-graph/compare/fbcad4f...HEAD
[0.9.1]: https://github.com/asta-nguyen/openez-graph/compare/fbcad4f...HEAD
[0.9.0]: https://github.com/asta-nguyen/openez-graph/compare/fbcad4f...HEAD
[0.8.0]: https://github.com/asta-nguyen/openez-graph/compare/a7ce4df...849060b
[0.7.0]: https://github.com/asta-nguyen/openez-graph/compare/9b7cc78...a7ce4df
[0.6.1]: https://github.com/asta-nguyen/openez-graph/compare/405f7e8...9b7cc78
[0.6.0]: https://github.com/asta-nguyen/openez-graph/compare/5ff0f5c...405f7e8
[0.5.1]: https://github.com/asta-nguyen/openez-graph/releases/tag/v0.5.1
