# Changelog

All notable changes to OpenEZ Graph are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.8.0]: https://github.com/asta-nguyen/openez-graph/compare/a7ce4df...849060b
[0.7.0]: https://github.com/asta-nguyen/openez-graph/compare/9b7cc78...a7ce4df
[0.6.1]: https://github.com/asta-nguyen/openez-graph/compare/405f7e8...9b7cc78
[0.6.0]: https://github.com/asta-nguyen/openez-graph/compare/5ff0f5c...405f7e8
[0.5.1]: https://github.com/asta-nguyen/openez-graph/releases/tag/v0.5.1
