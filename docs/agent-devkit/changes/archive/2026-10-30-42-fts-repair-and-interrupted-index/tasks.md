# FTS repair cost and interrupted-index recovery tasks

## Design

[FTS repair cost and interrupted-index recovery](design.md)

## Global Constraints

- No step of the FTS repair may scan `chunks_fts` once per chunk; the repair is set-based and leaves exactly one FTS row per chunk.
- `chunk_id` stays `UNINDEXED`; the FTS5 schema does not change.
- `busy_timeout` is 30,000 ms and is set before the first statement on both the workspace and registry connections opened by `packages/db`.
- The registry repository maps an expired or NULL index lease with `indexing_status = running` to `indexingStatus: "failed"` and `status: "error"` on read only; the stored row is not modified and `tryClaimIndexing` is unchanged.
- A completed index run leaves no FTS row for a replaced chunk: the stale-row delete runs inside the write transaction, after the new chunks are inserted and before the new FTS rows are.
- Inside the write transaction the trigger recreation must not start its own transaction (`restoreFtsTriggersOnly({ withinTransaction: true })`); SQLite rejects a nested `BEGIN`.
- The write pragmas (`journal_mode`, `synchronous`) stay outside the transaction.
- No CLI, MCP or web route changes; `apps/web` is not changed; `RegistryWorkspace.indexingStatus` gains no new value.
- If peak WAL during an index of a workspace of 20k or more chunks exceeds 3 times the pre-change peak, stop and return to design.

## Impact map

Entry: apps/cli/src/cli.ts (`openez status`, `openez index`) → packages/db/src/sqlite/workspace-db.ts::getWorkspaceDb; apps/mcp/src/server.ts opens the same databases; `list_workspaces` (apps/mcp/src/mcp-core.ts) and `removeWorkspace` (packages/db/src/sqlite/remove-workspace.ts) read the registry through `createRegistryRepository`
Flow: any command → getWorkspaceDb → getWorkspaceDbRaw → initializeWorkspaceSchema (FTS sync check → repair on mismatch at :210-227 → restoreFtsTriggerDefinitions). Index: packages/indexer/src/index-workspace.ts::indexWorkspace → registry.tryClaimIndexing + heartbeat → incremental deletes of removed files (:667-672, triggers still up) → repo.setOptimizedWriteMode(true) + repo.dropFtsTriggers (:810-811) → repo.transaction (:818; resetChangedFileArtifacts → deleteChunksByDocument without FTS cleanup, insertChunks) → repo.bulkInsertFts (:980) → repo.restoreFtsTriggersOnly (:991, runs `BEGIN IMMEDIATE`) → completeIndexRun / registry.completeIndexing; on error `catch` → repo.restoreFtsTriggers (:1035)
State changes: per-workspace `.openez/index.sqlite` (`chunks_fts` rows, the three FTS triggers, `index_runs`) and `~/.openez/registry.sqlite` (`workspaces` lease columns, read-only for this change)
External effects: none found beyond local SQLite files
Change candidates: packages/db/src/sqlite/fts-repository.ts, packages/db/src/sqlite/types.ts, packages/db/src/sqlite/workspace-db.ts, packages/db/src/sqlite/registry-db.ts, packages/db/src/sqlite/registry-repository.ts, packages/indexer/src/index-workspace.ts, tests/workspace-db.test.ts, tests/registry.test.ts, tests/index-workspace.test.ts, tests/remove-workspace.test.ts
Verification: bun test (files named per task), pnpm typecheck, pnpm build:cli, one-off 20k-chunk replay of `openez status` and WAL/index-time measurement on a disposable workspace
Verified at: cfbfcfa03e4c52a862edcc83fe99645018853c7b

## Tasks

### Task 1 — Set-based, convergent FTS repair

Files: packages/db/src/sqlite/fts-repository.ts::restoreFtsTriggers (and new exported `repairChunksFts` and `deleteStaleFtsRows` in the same file); packages/db/src/sqlite/workspace-db.ts::initializeWorkspaceSchema (repair branch at :210-227); tests/workspace-db.test.ts beside the cases at :251 and :283
Interfaces: Produces `repairChunksFts(native)` used by `initializeWorkspaceSchema` and by `restoreFtsTriggers`, and `deleteStaleFtsRows(native)`, its first step, which Task 3 exposes on the repository. The sync check (`ftsShape`) is unchanged and is the only trigger for the repair on open.
Change: Replace both `LEFT JOIN chunks_fts ... IS NULL` repairs with the shared routine. `deleteStaleFtsRows` deletes FTS rows whose `chunk_id` is NULL or matches no chunk; then duplicates are reduced to the lowest `rowid`; then rows are inserted for chunks with none. The selection of missing chunks must exclude NULL `chunk_id` values from the FTS side so a NULL cannot hide every chunk. Delete first, insert second.
Verify: Write these cases first. Cases (1) to (3) must fail on `cfbfcfa` and then pass; case (4) is a regression guard that already passes on `cfbfcfa` and must keep passing: (1) 6,000 chunks, one FTS row deleted, open → FTS has 6,000 rows, one per chunk id, elapsed under 1 s (5.8 s on `cfbfcfa` for this tiny-chunk fixture; the margin under the first 5 s limit was only 15 percent); (2) 500 chunks, one FTS row duplicated and a different one deleted so `count(*)` equals the chunk count, open twice → after the first open distinct FTS ids equal count equal 500, and the second open leaves `max(rowid)` unchanged and takes under 0.5 s; (3) FTS rows for deleted chunks and a row with NULL `chunk_id` → both removed, missing chunks still inserted; (4) a database with zero chunks opens without error. Existing cases at :251 and :283 still pass. Then the one-off replay: a disposable 20k-chunk workspace with one FTS row removed, `openez status` under 10 s.
Progress: done
Result: bun test tests/workspace-db.test.ts — all new cases pass (first three failed on `cfbfcfa`, zero-chunk guard passed there; case (1) limit tightened to 1 s after review). Replay on a disposable 24,000-chunk workspace of about 2 KB chunks, one file changed then reindexed, then opened in a fresh process: 326 s on `cfbfcfa`, 62 ms after. Codex's tiny-chunk replay with one FTS row removed: `openez status` 0.18 s.

### Task 2 — Busy timeout on workspace and registry connections

Files: packages/db/src/sqlite/workspace-db.ts::getWorkspaceDbRaw; packages/db/src/sqlite/registry-db.ts::getRegistryDbRaw; tests/workspace-db.test.ts; tests/registry.test.ts
Interfaces: Independent of Task 1. Consumes nothing; every later open in the process inherits the timeout. `apps/web/src/server/sqlite.ts::openSqlite` is a separate opener and is not changed (see Decision Log).
Change: Set `busy_timeout` to 30,000 ms as the first pragma on each connection, before `page_size` and `journal_mode = WAL`.
Verify: For each database, a child `bun` process takes a write lock with `BEGIN IMMEDIATE` and releases it after about 500 ms; the parent opens the same database during that window. Expected: the open succeeds after waiting at least 400 ms and does not throw. Confirm it throws `SQLITE_BUSY` at once on `cfbfcfa`.
Progress: done
Result: bun test tests/workspace-db.test.ts tests/registry.test.ts — 42 pass, including both 500 ms child-lock waits.

### Task 3 — Write the index atomically and without stale FTS rows

Files: packages/indexer/src/index-workspace.ts::indexWorkspace (:807-:1040); packages/db/src/sqlite/fts-repository.ts (repository `deleteStaleFtsRows`, `restoreFtsTriggersOnly` option); packages/db/src/sqlite/types.ts::WorkspaceRepository (:464-:481); packages/db/src/sqlite/workspace-repository.ts::transaction (:213, read only); tests/index-workspace.test.ts; tests/workspace-db.test.ts; one child-process helper script under tests/ for the kill case
Interfaces: Depends on Task 1, because it exposes Task 1's `deleteStaleFtsRows` and because the `catch` safety net calls the repaired `restoreFtsTriggers`. Adds `deleteStaleFtsRows(): void` and an optional `{ withinTransaction?: boolean }` argument to `restoreFtsTriggersOnly` on `WorkspaceRepository`; other signatures are unchanged.
Change: When `parseTasks.length > 0`, run this order inside one `repo.transaction`: (1) `dropFtsTriggers`, before `resetChangedFileArtifacts` deletes the old chunks; (2) the existing document, chunk and parsed-document writes; (3) `deleteStaleFtsRows`, after `insertChunks`, which removes the FTS rows of the replaced chunks; (4) `bulkInsertFts`, still wrapped by `_ftsBuildingWorkspaces`; (5) `restoreFtsTriggersOnly({ withinTransaction: true })`. `setOptimizedWriteMode(true)` stays before the transaction; `setMeta("chunking_fingerprint")`, `completeIndexRun` and the registry completion stay after the commit. A no-op index (nothing to parse) still touches no triggers or write pragmas. In the `catch`, restore the write pragmas whenever `setOptimizedWriteMode(true)` ran and keep calling `restoreFtsTriggers` as a safety net; after a rollback it finds triggers and FTS already consistent and does one set-based pass. The bulk-write flags in `indexWorkspace` are reworked to match; the externally visible order above is the requirement. First confirm that `transaction` runs `BEGIN`/`COMMIT` on the same native connection as the trigger DDL (`createFtsOps(native, ...)` and `transaction` both use the one `native` in `createWorkspaceRepository`), and that no other caller of `restoreFtsTriggersOnly` changes behavior without the argument.
Verify: Write first. Cases (1), (2), (4) and the `withinTransaction` half of (5) must fail on `cfbfcfa` and then pass; case (3) and the rollback half of (5) are guards that already pass on `cfbfcfa` and must keep passing: (1) index a small fixture, change files, then make `bulkInsertFts` throw → chunks equal the first run's, `chunks_fts` count equals distinct ids equals chunk count, exactly three FTS triggers exist, and the next open takes under 0.5 s; (2) same fixture in a child process that SIGKILLs itself from inside the FTS-insert step → the same four assertions after reopening; (3) the existing no-op index test still shows triggers and pragmas untouched; (4) index two files, change one, index again → chunks, `chunks_fts` rows and distinct ids are equal, 0 FTS rows without a chunk, three triggers, and the next open leaves `max(rowid)` unchanged and takes under 0.5 s (on `cfbfcfa` this shows `chunks = 3`, `chunks_fts = 4`, 1 orphan); (5) in tests/workspace-db.test.ts, inside `repo.transaction` drop the triggers, insert a chunk, then throw → afterwards three triggers exist and the chunk is absent; and `restoreFtsTriggersOnly({ withinTransaction: true })` inside `repo.transaction` does not throw and leaves three triggers after commit. Then, on the 20k-chunk disposable workspace before and after: measure peak `index.sqlite-wal` size and full index time; stop if the peak exceeds 3 times the pre-change value; and time an incremental index of one changed file, which must stay under 10 s.
Progress: done
Result: bun test tests/index-workspace.test.ts tests/workspace-db.test.ts tests/registry.test.ts tests/remove-workspace.test.ts — 83 pass, 0 fail, three repeated runs; the failure, SIGKILL and changed-file cases failed on `cfbfcfa` first. Reviewer measurement on a disposable 24,000-chunk workspace of about 2 KB chunks (`cfbfcfa` → now): peak `index.sqlite-wal` on a full index 60.7 → 151.7 MB (2.50x, under the 3x limit with little headroom); full index 2.6 → 2.4 s; incremental one-file index 232 → 233 ms (limit 10 s), its peak WAL 11.8 → 2.7 MB. Codex's tiny-chunk fixture showed only 1.36x and is not representative.

### Task 4 — Report an expired index lease as failed

Files: packages/db/src/sqlite/registry-repository.ts::mapWorkspaceRow; tests/registry.test.ts; tests/remove-workspace.test.ts (packages/db/src/sqlite/remove-workspace.ts is read only)
Interfaces: Independent of Tasks 1 to 3. Produces the existing `failed`/`error` values for `RegistryWorkspace`, read by `apps/cli/src/cli.ts:341-342`, `list_workspaces` and `removeWorkspace`. The web server reads the table itself and is not affected.
Change: In `mapWorkspaceRow`, when `indexing_status` is `running` and `index_lease_expires_at` is NULL or earlier than now, return `indexingStatus: "failed"`, `status: "error"`, and `lastError` equal to the stored text if non-empty, otherwise "Index lease expired; the previous index run was interrupted." Do not write to the database.
Verify: Seed `running` rows with `tryClaimIndexing(id, token, leaseExpiresAt)`. Cases in tests/registry.test.ts: (1) `running` with a lease one minute in the past → `failed`, `error`, lastError contains "lease expired"; (2) `running` with a lease one minute ahead → unchanged `running`; (3) `running` with a NULL lease → `failed`; (4) the stored row is byte-for-byte unchanged after the read; (5) `tryClaimIndexing` still succeeds on the expired lease. Case in tests/remove-workspace.test.ts: (6) `removeWorkspace` on a `running` workspace with a live lease returns the "appears to be indexing" warning, and with an expired lease returns no such warning. Confirm (1), (3) and the expired half of (6) fail on `cfbfcfa`.
Progress: done
Result: bun test tests/registry.test.ts tests/remove-workspace.test.ts — 27 pass, including expired/NULL leases, unchanged stored rows, and removal warnings.

## Files inspected, no change

- packages/db/src/sqlite/database-loader.ts — `createNativeDatabase` only adds a `pragma` shim; the timeout is set by callers.
- apps/cli/src/cli.ts — `status` prints `workspace.indexingStatus` at :341-342; it needs no change once the registry maps the value.
- packages/indexer/src/index-workspace.ts:1087 — the `_ftsBuildingWorkspaces` wait helper (`waitForFts`, consumed by apps/mcp/src/mcp-core.ts:871); kept as is.
- packages/db/src/sqlite/registry-repository.ts::tryClaimIndexing — already accepts an expired lease; behavior kept.
- packages/db/src/sqlite/chunk-repository.ts::deleteChunksByDocument and workspace-repository.ts:63 — `DELETE FROM chunks WHERE document_id = ?` with no FTS cleanup; the cause of the stale FTS rows while triggers are down, fixed in the indexer, not here.
- apps/web/src/server/sqlite.ts (`mapWorkspace` :264, `openSqlite` :136, `getRegistryWorkspace` :289) — reads `indexing_status` raw and opens connections without `busy_timeout`; out of scope, see Decision Log.
- packages/db/src/sqlite/remove-workspace.ts:46 — warns on `indexingStatus === "running"` from the mapped workspace; covered by Task 4 case (6).
- apps/mcp/src/mcp-core.ts (`list_workspaces`, ~:860) — returns `registry.listWorkspaces()`, so it gets the mapping with no change.

## Approval Gate

Status: approved

## Decision Log

2026-10-30 — Plan written for later work at the user's request ("create the issue and plan in that project, fix later"); implementation is not authorized. Proposed values awaiting approval: `busy_timeout` 30,000 ms, 6,000-chunk and 20k-chunk test sizes, the 5 s / 10 s time limits, and the 3 times WAL limit. Approval state: pending.

2026-10-31 — Plan reviewed against `cfbfcfa` and the live install (read-only); three defects fixed in place, no task was started or reset. (1) Task 3 moved `restoreFtsTriggersOnly` into the transaction, but it runs `BEGIN IMMEDIATE`, which SQLite rejects inside the indexer's `BEGIN`; it now takes `{ withinTransaction: true }`. (2) A completed incremental index also leaves stale FTS rows (`chunks = 3`, `chunks_fts = 4`), so Task 3 now deletes them inside the transaction and `design.md` gains that behavior and the `deleteStaleFtsRows` repository method. (3) The claim that the web UI shows the mapped status was false (`apps/web/src/server/sqlite.ts` bypasses `mapWorkspaceRow`); the claim is removed and `removeWorkspace` is named instead. Minor: repair-branch line references corrected to :210-227; Task 4 gains the `removeWorkspace` warning case. Live evidence added to `design.md` (`wy-ask-api` stuck `running` with a lease expired since 2026-10-30T08:28:52Z while its FTS is now in sync; `work-11` stuck since 2026-10-09; `database is locked` in two registry rows; four `serve --mcp` processes from two builds). Proposed value awaiting approval: the 10 s limit for an incremental one-file index on the 20k-chunk workspace. Decision awaiting the user: the web server stays out of scope (alternative: one more task that applies the lease mapping in `apps/web/src/server/sqlite.ts::mapWorkspace` and a `busy_timeout` in `openSqlite`, verified through `GET /api/workspaces/:id/index` in tests/web-index-endpoint.test.ts). New behavior and interface additions keep the gate pending. Approval state: pending.

2026-10-31 — Approved by the user's instruction to implement, given after `design.md` and `tasks.md` were presented ("mày dùng luna 6 max của codex để code, mày quản lí output cuối cùng thôi, review lại code khi codex xong"). The two open questions were not answered separately, so the proposed defaults stand: the web server stays out of scope and the incremental one-file limit is 10 s. Coding is delegated to Codex (`gpt-6-luna`, reasoning effort `max`); Claude runs the baseline and reviews the final diff. Approval state: approved.

2026-10-31 — First Codex run stopped before editing: Task 1 case (4) (zero chunks opens without error) passes on `cfbfcfa`, so "every case fails first" was wrong. Verify wording in Tasks 1 and 3 now marks the guard cases that already pass on `cfbfcfa`. No scope, behavior, interface, schema or risk change; the gate stays approved.
