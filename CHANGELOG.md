# Changelog

## feat: fts-graph-retrieval

- Removed embeddings entirely; FTS5 + graph expansion is the retrieval engine, agent is the semantic layer
- Migrated CLI build from tsup to tsdown
- Removed unused Postgres client and loadEnv export

### Performance
- Added composite indexes on graph_nodes(type,label) and chunks(document_id,chunk_index)
- Fixed N+1 query in call-edge insertion with batch symbol lookup
- Fixed N+1 query in graphNeighbors with batch node fetch
- Added SQLite pragmas (synchronous=NORMAL, cache_size=64MB) to web + registry DBs
- Parallelized resolveDefaultWorkspace and indexing count queries
- Made insertQueryLog asynchronous
- Refactored graphExpand to use direct document_id JOINs

### Bug fixes
- Fixed resetDocumentArtifacts: edges weren't being deleted on reindex (ref_ids vs node UUIDs)

### Token reduction
- Removed JSON pretty-printing in MCP responses
- Removed score from formatContextBlock
- Removed reason field from QuerySource
- Merged callers/callees into single calls field in CodeContextResult

### Cleanup
- Removed redundant idx_workspaces_root_path index
- Removed unused deps: server-only, zod
- Removed stale graph_neighbors references from docs
- Removed unused LLM env vars from config schema and settings UI
