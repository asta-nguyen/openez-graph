# FTS repair cost and interrupted-index recovery

## Goal

Opening a workspace database must stay cheap when `chunks_fts` has drifted from `chunks`, a drift must not persist once repaired, no index run (interrupted or completed) may create drift, concurrent opens must wait instead of failing at once, and `openez status` must not show a dead index as running. Tracked in [issue #42](https://github.com/asta-nguyen/openez-graph/issues/42).

Evidence behind the goal, measured on 2026-10-30 against `cfbfcfa`: a 25k-chunk workspace took 10 min 52 s to open once; with the real `initializeWorkspaceSchema` and one FTS row missing, a 2,500-chunk copy took 2.24 s and a 5,000-chunk copy 14.43 s (0.01 s and 0.02 s in sync); a duplicated FTS row kept every open at about 2 s on a 2,500-chunk copy because the database never converged.

Evidence from the live install, read-only on 2026-10-31 (`sqlite3 -readonly`, nothing opened through openez, nothing modified):

- Workspace `wy-ask-api` (25,211 chunks, the 25k workspace above) is registered as `indexing_status = running` with `index_lease_expires_at = 2026-10-30T08:28:52.972Z`, no owner, about 21 hours before the reading. Its `.openez/workspace.json` was written at 15:27 local time on 2026-10-30, so the index process died within a minute of starting. The row is still `running`.
- The same workspace's database is healthy now: `chunks = chunks_fts = distinct chunk_id = 25,211`, 0 orphan FTS rows, 3 FTS triggers. The repair has already converged once, so the original cause of its drift cannot be read from the current state.
- Workspace `work-11` is `running` since a lease that expired on 2026-10-09.
- Registry rows `baseline-treatment2` and `run1` carry `last_error = "database is locked"`, which is what a connection without `busy_timeout` reports.
- Four `serve --mcp` processes are alive from two builds (the global npm install and `apps/cli/dist` of this repo); each opens the same workspace databases.
- The drift source that does not need an interruption is reproduced on `cfbfcfa`: index two files, change one, index again → `chunks = 3`, `chunks_fts = 4`, 1 orphan FTS row. A successful incremental index of a changed file leaves a stale FTS row, so the next open repairs it.

## Scope

In scope:

- The FTS repair that runs on open (`packages/db/src/sqlite/workspace-db.ts::initializeWorkspaceSchema`, repair branch at lines 210-227) and the same repair in `packages/db/src/sqlite/fts-repository.ts::restoreFtsTriggers`, which the indexer's `catch` also calls.
- The write ordering of FTS triggers, chunks and FTS rows in `packages/indexer/src/index-workspace.ts::indexWorkspace`, including removal of the FTS rows of the chunks it replaces.
- A busy timeout on the workspace database and the registry database connections opened by `packages/db`.
- How the registry repository reports an index whose lease has expired.

Out of scope:

- The FTS5 schema. `chunk_id` stays `UNINDEXED`.
- Dropping and recreating the three FTS triggers on every open. This still takes the write lock; only the busy timeout softens it.
- `index_runs` rows already stuck in `running`, and the graph build lease and `graph_status`.
- The lease length (60 s) and heartbeat interval (15 s), the CLI and MCP command surface.
- The web server (`apps/web/src/server/sqlite.ts`). It reads `workspaces` rows with its own `mapWorkspace` and opens its own connections in `openSqlite` (no `busy_timeout`), so it neither gets the expired-lease mapping nor the busy timeout from this change. The web UI keeps showing `running` for an expired lease. See Decision Log in `tasks.md`.
- The per-chunk `chunks_fts_delete` trigger cost when an incremental index deletes whole files (those deletes run before the triggers are dropped and still scan `chunks_fts` once per chunk). No stale row results from it, only time.

## Behavior

1. **Repair on open is set-based and convergent.** When the existing sync check fails, one shared routine in `fts-repository.ts` runs from both call sites. Afterwards `chunks_fts` holds exactly one row per chunk: rows whose `chunk_id` is NULL or matches no chunk are deleted, duplicate rows for one `chunk_id` are reduced to the lowest `rowid`, and rows are inserted for chunks that have none. No step may scan `chunks_fts` once per chunk. A database repaired this way passes the sync check on the next open and takes the fast path.
2. **The indexer writes atomically and leaves no stale FTS rows.** In the write phase, dropping the FTS triggers, writing documents and chunks, deleting the FTS rows whose chunk no longer exists, inserting the FTS rows of the new chunks, and recreating the triggers all happen in one SQLite transaction. A thrown error or a killed process leaves the previous index and a matching FTS table, with the triggers present, because SQLite rolls back DDL and rows together. A completed run leaves one FTS row per chunk and no row for a replaced chunk, so the next open takes the fast path. The `catch` keeps calling `restoreFtsTriggers` as a safety net for failures after the commit. A no-op index still touches no triggers or write pragmas, as today. The write pragmas (`journal_mode`, `synchronous`) stay outside the transaction because SQLite ignores them inside one.
3. **Opens wait for the write lock.** Both the workspace and registry connections set `busy_timeout` to 30,000 ms, before their first statement (including `journal_mode = WAL`). A connection that still cannot get the lock after 30 s fails with the existing `SQLITE_BUSY` error.
4. **An expired lease is not "running".** When the registry repository reads a workspace row whose `indexing_status` is `running` and whose `index_lease_expires_at` is NULL or earlier than now, it reports `indexingStatus: "failed"` and `status: "error"`. `lastError` keeps its stored text if non-empty, otherwise it reads "Index lease expired; the previous index run was interrupted." The stored row is not modified, and `tryClaimIndexing` keeps accepting an expired lease.

## Edge cases

- One FTS row missing among 6,000 or more chunks: repaired in seconds, FTS ends with one row per chunk (Task 1).
- A duplicated `chunk_id` together with a missing one, so that `count(*)` equals the chunk count: the first open repairs, the second open does no FTS write (Task 1).
- FTS rows whose chunk is gone, and rows with a NULL `chunk_id`: deleted. A NULL must not make the missing-row selection return nothing (Task 1).
- A workspace with zero chunks: opens without error or repair (Task 1).
- Chunks without a document cannot exist: `chunks.document_id` is `NOT NULL` with `ON DELETE CASCADE` and `foreign_keys = ON` is set on open. The repair ignores them and no task covers them.
- A second process opens while the first holds the write lock for about 500 ms: the second waits and succeeds, on both the workspace and registry databases (Task 2).
- An incremental index replaces the chunks of a changed file (triggers are down while it deletes the old chunks): after the run no FTS row refers to a replaced chunk, FTS has one row per chunk, and the next open takes the fast path. Reproduced on `cfbfcfa` as `chunks = 3`, `chunks_fts = 4` (Task 3).
- The indexer throws, or is killed with SIGKILL, at the FTS-insert step: chunks equal the previous run's, FTS is in sync, three triggers exist, and the next open takes the fast path (Task 3).
- The trigger DDL runs inside the write transaction: recreating the triggers must not open a second transaction. Today `restoreFtsTriggersOnly` runs `BEGIN IMMEDIATE`, which fails inside the indexer's `BEGIN` with "cannot start a transaction within a transaction" (Task 3).
- The stale-row delete adds one pass over `chunks_fts` to every index run that writes files. On the 20k-chunk workspace an incremental index of one changed file must stay under 10 s (Task 3).
- A one-transaction write grows the WAL more than today's. If peak WAL on a workspace of 20k or more chunks exceeds 3 times the pre-change peak, stop and return to design; the alternative is to keep today's ordering and add SIGINT and SIGTERM handlers in `apps/cli` and `apps/mcp` that restore the triggers (Task 3).
- A running index whose event loop is blocked for more than 60 s stops refreshing its lease and reads as failed from another process. This matches `tryClaimIndexing`, which would let another process claim it, so it is not a regression (Task 4).
- A `running` row with a NULL lease reads as failed; a `running` row with a future lease is unchanged (Task 4).
- `removeWorkspace` warns "appears to be indexing" from the registry status. With the mapping, an expired lease no longer produces that warning, and a live lease still does (Task 4).

## Interfaces

- No CLI command, option, MCP tool schema or web route changes.
- `RegistryWorkspace.indexingStatus` already includes `failed`; no new value is added. Because the mapping is in the registry repository read path (`mapWorkspaceRow`), `openez status`, the MCP `list_workspaces` tool and `removeWorkspace` show an expired lease as failed. The web server does not go through that path (see Out of scope).
- `WorkspaceRepository` (`packages/db/src/sqlite/types.ts`):
  - `restoreFtsTriggersOnly` gains an optional `{ withinTransaction?: boolean }` argument and passes it to `restoreFtsTriggerDefinitions`; existing no-argument calls behave as today.
  - New `deleteStaleFtsRows(): void` deletes the FTS rows whose `chunk_id` is NULL or matches no chunk. `repairChunksFts` uses the same function for its first step.
  - `dropFtsTriggers`, `bulkInsertFts`, `restoreFtsTriggers` and `transaction` keep their signatures; only their call order in `indexWorkspace` changes. The `_ftsBuildingWorkspaces` flag around the FTS insert keeps its current meaning and consumer (`waitForFts`).
- `restoreFtsTriggers` keeps its signature and now delegates to the shared repair routine.

## Verification

- Before the first source edit, run and record `bun test tests/workspace-db.test.ts tests/fts-retrieval.test.ts tests/registry.test.ts tests/embedding-migration.test.ts tests/index-workspace.test.ts tests/remove-workspace.test.ts` and `pnpm typecheck`.
- Each task writes its failing test first (named cases in `tasks.md`), shows it fails on `cfbfcfa`, then makes it pass. Guard cases that already pass on `cfbfcfa` are marked as such in `tasks.md` and must keep passing.
- One-off replay, not a permanent runner: on a disposable workspace of at least 20k chunks with exactly one FTS row removed, `openez status` must finish in under 10 s. The pre-change measurement was 10 min 52 s on 25k chunks. Never point it at a user's normal workspace database, and never open a live workspace such as `wy-ask-api` with openez to reproduce: opening is what runs the repair.
- After Task 3, measure peak `index.sqlite-wal` size and index time (full, and incremental with one changed file) on that workspace before and after, and apply the 3 times WAL limit and the 10 s incremental limit above.
- Finish with `bun test`, `pnpm typecheck` and `pnpm build:cli`.

## Related context

None.
