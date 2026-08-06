# Workspace Remove & Pin — Design

Date: 2026-08-06
Status: Approved (brainstorming complete)

## Problem

1. Workspaces indexed by mistake ("junk workspaces") cannot be removed today. CLI has no
   remove command, MCP has no remove tool, UI has no delete button. The only existing piece,
   `DELETE /api/workspaces/:id`, deletes the registry row but leaves `<root>/.openez/` (the
   per-workspace DB and `workspace.json`) behind on disk.
2. The workspace list has no way to keep important workspaces on top.

## Goals

- Remove a workspace from the registry **and** delete `<root>/.openez/` if it exists,
  from all three layers: CLI, MCP, UI.
- Pin/unpin workspaces from the UI; list sorts pinned-first.

## Non-goals

- No `--keep-data` / unregister-only mode (decision: always full cleanup).
- No removal of the `.openez/` entry in the project's `.gitignore` (harmless, user file).
- No delete/pin on the workspace detail page (list page only).
- No blocking when a workspace is actively indexing/watching — warn only.
- No migration framework; follow the existing guarded `ALTER TABLE` pattern.

## Architecture

One shared core function in `packages/db`; CLI, MCP, and the web server route all call it.
Pin state lives in the global registry DB (`~/.openez/registry.sqlite`).

Note: the registry schema is currently defined in two places — `packages/db` (drizzle
schema + `initializeRegistrySchema`, used by CLI/MCP) and `apps/web/src/server/sqlite.ts`
(used by the web server). Both open the same DB file. Schema changes must be applied to both.

## Feature 1: Remove Workspace

### Shared core — `packages/db/src/sqlite/remove-workspace.ts` (new)

```ts
export interface RemoveWorkspaceReport {
  workspaceId: string;
  rootPath: string;
  unregistered: boolean; // registry row deleted
  dataDirRemoved: boolean; // <rootPath>/.openez existed and was deleted
  dataDirPath: string;
  warnings: string[];
}

export async function removeWorkspace(selector: {
  id?: string;
  rootPath?: string;
}): Promise<RemoveWorkspaceReport | null>; // null = workspace not found
```

Logic:

1. Resolve workspace via `createRegistryRepository()`: `getWorkspace(id)` when `id` given,
   else `getWorkspaceByPath(path.resolve(rootPath))`. Not found → return `null`.
2. If `indexingStatus` indicates an in-flight run, push a warning (do not block — the
   status may be stale, which is exactly the junk-workspace case).
3. `repo.deleteWorkspace(id)`.
4. `fs.rm(getLocalWorkspaceDir(rootPath), { recursive: true, force: true })`.
   - Project dir missing from disk → still unregistered; `dataDirRemoved: false` + warning.
   - `rm` fails (permissions) → registry deletion stands; error message goes into `warnings`.
5. Return the report.

### CLI — `openez remove [path]` (`apps/cli/src/cli.ts`)

- `[path]` defaults to cwd; `--id <workspaceId>` wins when both are given;
  `-y` / `--yes` skips confirmation.
- Prints a summary (name, id, rootPath, docs/chunks), asks `y/N`.
  Non-TTY without `--yes` → error (safe default).
- Prints the report (`✓ Unregistered …`, `✓ Deleted <root>/.openez`, warnings prefixed `!`).
- Workspace not found → exit 1.

### MCP — `remove_workspace` tool (`apps/mcp/src/mcp-core.ts`)

- inputSchema mirrors existing tools: `{ workspaceId?, path?, confirm: boolean }`.
  **`confirm` is required**; `confirm !== true` → refusal message telling the agent to get
  user approval and re-call with `confirm: true`.
- Returns the report as JSON text; not-found → "workspace not found" message.
- Update the tool list in `AGENTS.md` (Code Search Rules → Setup).

### Web API — upgrade `DELETE /api/workspaces/:id` (`apps/web/src/server/index.ts`)

- Replace `deleteRegistryWorkspace(id)` with shared `removeWorkspace({ id })`.
- Response `{ success: true, report }` (keeps `success` so the existing client type
  `{ success: boolean; error?: string }` stays valid). Not found → 404.
- Delete the now-unused `deleteRegistryWorkspace` from `apps/web/src/server/sqlite.ts`.

### UI — delete button (`apps/web/src/routes/workspaces/index.tsx`)

- Trash button on each workspace card (`stopPropagation` — the card is a `<Link>`).
- Confirm dialog: "Delete workspace X? The registry entry and `<root>/.openez` will be
  permanently deleted. Project source code is not touched."
- Confirm → `api.deleteWorkspace(id)` mutation → invalidate `workspacesQueryOptions`.

## Feature 2: Pin Workspace

### Data model

- New nullable column **`pinned_at TEXT`** on `workspaces` (registry DB).
  `NULL` = not pinned; timestamp = when pinned. Toggle = set/clear; ordering within the
  pinned group falls out of the timestamp (most recently pinned first).
- Apply in three places:
  1. `packages/db/src/sqlite/schema.ts` (drizzle table definition).
  2. `packages/db/src/sqlite/registry-db.ts` — add to `CREATE TABLE` + guarded
     `ALTER TABLE workspaces ADD COLUMN pinned_at TEXT` for existing DBs.
  3. `apps/web/src/server/sqlite.ts` — same `CREATE TABLE` + guarded `ALTER TABLE`.
- Add `pinnedAt` to `RegistryWorkspace` (packages/db), `WebRegistryWorkspace` (web server),
  and the frontend `WorkspaceListItem` type.

### Repository / server methods

- `packages/db`: `setPinned(id, pinned: boolean)` on `RegistryRepository`
  (sets `pinned_at` to now or NULL).
- Web server: `setRegistryWorkspacePinned(id, pinned)` in `apps/web/src/server/sqlite.ts`.

### Sort (all layers consistent)

```sql
ORDER BY (pinned_at IS NULL), pinned_at DESC, created_at DESC
```

Apply in `listWorkspaces` (packages/db — feeds CLI `openez list` and MCP `list_workspaces`)
and `listRegistryWorkspaces` (web server). UI renders server order as-is.

### API & UI

- **`PATCH /api/workspaces/:id/pin`** body `{ pinned: boolean }` (idempotent toggle).
- Card: pin toggle button (lucide `Pin` / `PinOff`) next to the delete button; pinned cards
  show a persistent pin indicator. Click → mutation → invalidate list query.
- `pinnedAt` exposed via the API response and MCP `list_workspaces`; CLI `openez list`
  shows a `📌` marker.

## Error handling

| Case                                  | Behavior                                                |
| ------------------------------------- | ------------------------------------------------------- |
| Workspace not found                   | CLI exit 1 / MCP "not found" text / API 404             |
| Project dir already deleted from disk | Unregister succeeds + warning (the junk-workspace case) |
| `rm <root>/.openez` fails             | Registry deletion stands; error in `warnings`           |
| Workspace actively indexing/watching  | Warning, not blocked                                    |
| MCP `confirm` missing/false           | Refusal with re-call instructions                       |
| Pin target not found                  | API 404                                                 |

## Testing

Unit tests (vitest, tmp dirs, following `tests/registry.test.ts`):

- `removeWorkspace` by id, by path, missing project dir (unregistered + warning),
  unknown workspace → `null`.
- `setPinned` set/clear; sort order: pin A then B → B, A, rest; unpin B → A, rest.

Manual smoke:

- `openez init /tmp/x && openez remove /tmp/x -y` → `openez list` empty, `/tmp/x/.openez` gone.
- MCP `remove_workspace` without `confirm` → refused; with `confirm: true` → report.
- UI: delete button removes card; pin two workspaces → order matches `openez list`.

## File touch list

- `packages/db/src/sqlite/remove-workspace.ts` (new)
- `packages/db/src/sqlite/schema.ts`, `registry-db.ts`, `types.ts`, `repository.ts`, index exports
- `apps/cli/src/cli.ts`
- `apps/mcp/src/mcp-core.ts`
- `apps/web/src/server/index.ts`, `apps/web/src/server/sqlite.ts`
- `apps/web/src/lib/api.ts`, `apps/web/src/routes/workspaces/index.tsx`, frontend types
- `tests/registry.test.ts` (or new `tests/remove-workspace.test.ts`)
- `AGENTS.md` (MCP tool list)
