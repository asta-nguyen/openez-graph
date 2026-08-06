# Workspace Remove & Pin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove junk workspaces (registry entry + `<root>/.openez/` data dir) from CLI, MCP, and UI; pin workspaces so they sort on top.

**Architecture:** One shared core `removeWorkspace()` in `packages/db` called by CLI, MCP, and the web server. Pin state is a nullable `pinned_at` column in the global registry DB; all list queries sort pinned-first.

**Tech Stack:** TypeScript, pnpm monorepo, better-sqlite3 (+ drizzle in packages/db), commander (CLI), @modelcontextprotocol/sdk + zod (MCP), Hono (web server), React + TanStack Query/Router (UI), vitest (tests).

**Spec:** `docs/superpowers/specs/2026-08-06-workspace-remove-pin-design.md`

## Global Constraints

- No new npm dependencies.
- Registry schema is defined in TWO places and both must change: `packages/db/src/sqlite/registry-db.ts` + `packages/db/src/sqlite/schema.ts` (CLI/MCP path) and `apps/web/src/server/sqlite.ts` (web server path). Existing DBs get guarded `ALTER TABLE` via `PRAGMA table_info` checks — no migration framework.
- Always full cleanup: removing a workspace always deletes `<root>/.openez/` when present. No `--keep-data` mode.
- Tests run from repo root: `pnpm vitest run tests/<file>.test.ts` (full suite: `pnpm test`).
- Test isolation uses `process.env.AI_MEMORY_REGISTRY_DB_PATH` pointing at a temp dir + `closeRegistryDb()` — NEVER run tests or smoke tests against the real `~/.openez/registry.sqlite`.
- macOS temp dirs: `os.tmpdir()` paths are symlinks (`/var/...` → `/private/var/...`). `createWorkspace` stores the realpath; assertions must tolerate that (don't assert exact stored rootPath against the symlinked path).
- Commit style: conventional commits, e.g. `feat(db): ...`. A pre-commit hook runs prettier on staged files — this is expected.
- Sort order everywhere: pinned first (newest `pinned_at` first), then `created_at` DESC.

---

### Task 1: Pin support in `packages/db` (schema, migration, `setPinned`, pinned-first sort)

**Files:**

- Modify: `packages/db/src/sqlite/schema.ts` (workspaces table, ~line 23)
- Modify: `packages/db/src/sqlite/registry-db.ts` (CREATE TABLE ~line 64-83, add migration)
- Modify: `packages/db/src/sqlite/types.ts` (`RegistryWorkspace` line 1-19, `RegistryRepository` line 37-78)
- Modify: `packages/db/src/sqlite/repository.ts` (`listWorkspaces` line 54-57, after `deleteWorkspace` ~line 215, `mapWorkspaceRow` line 271-291)
- Test: `tests/registry.test.ts` (append new describe block)

**Interfaces:**

- Consumes: nothing (first task).
- Produces:
  - `RegistryWorkspace.pinnedAt: string | undefined`
  - `RegistryRepository.setPinned(id: string, pinned: boolean): Promise<void>`
  - `listWorkspaces()` returns pinned-first ordering (used by CLI `list`, MCP `list_workspaces`, tests).

- [ ] **Step 1: Write the failing test**

Append to `tests/registry.test.ts`, after the existing `deleteWorkspace` test (inside the same `describe("createRegistryRepository")` block, before its closing `});`):

```ts
it("setPinned sets and clears pinnedAt", async () => {
  const repo = createRegistryRepository();
  await repo.createWorkspace({ id: "ws1", name: "ws1", rootPath: "/tmp/ws1" });

  await repo.setPinned("ws1", true);
  expect(typeof (await repo.getWorkspace("ws1"))?.pinnedAt).toBe("string");

  await repo.setPinned("ws1", false);
  expect((await repo.getWorkspace("ws1"))?.pinnedAt).toBeUndefined();
});

it("listWorkspaces sorts pinned first (newest pin on top)", async () => {
  const repo = createRegistryRepository();
  await repo.createWorkspace({ id: "a", name: "a", rootPath: "/tmp/a" });
  await repo.createWorkspace({ id: "b", name: "b", rootPath: "/tmp/b" });
  await repo.createWorkspace({ id: "c", name: "c", rootPath: "/tmp/c" });

  await repo.setPinned("a", true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await repo.setPinned("c", true);

  expect((await repo.listWorkspaces()).map((w) => w.id)).toEqual(["c", "a", "b"]);

  await repo.setPinned("c", false);
  expect((await repo.listWorkspaces()).map((w) => w.id)[0]).toBe("a");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/registry.test.ts`
Expected: FAIL — `repo.setPinned is not a function`.

- [ ] **Step 3: Implement pin support**

3a. `packages/db/src/sqlite/schema.ts` — in the `workspaces` table definition, add after `lastError: text("last_error"),`:

```ts
    pinnedAt: text("pinned_at"),
```

3b. `packages/db/src/sqlite/registry-db.ts` — in `initializeRegistrySchema`, add `pinned_at TEXT,` to the CREATE TABLE after `last_error TEXT,`:

```sql
      last_error TEXT,
      pinned_at TEXT,
```

Then add a migration function and call it at the end of `initializeRegistrySchema`:

```ts
function migrateRegistryColumns(sqlite: ReturnType<typeof createNativeDatabase>) {
  const columns = new Set(
    (sqlite.prepare("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  if (!columns.has("pinned_at")) {
    sqlite.exec("ALTER TABLE workspaces ADD COLUMN pinned_at TEXT");
  }
}
```

Call `migrateRegistryColumns(sqlite);` after the `sqlite.exec(...)` inside `initializeRegistrySchema`.

3c. `packages/db/src/sqlite/types.ts` — in `RegistryWorkspace`, add after `lastError: string | undefined;`:

```ts
pinnedAt: string | undefined;
```

In `RegistryRepository`, add after `deleteWorkspace(id: string): Promise<void>;`:

```ts
  setPinned(id: string, pinned: boolean): Promise<void>;
```

3d. `packages/db/src/sqlite/repository.ts` — three edits.

Edit `listWorkspaces`:

```ts
    async listWorkspaces(): Promise<RegistryWorkspace[]> {
      const rows = db.select().from(schema.workspaces).all();
      return rows.map(mapWorkspaceRow).sort(compareWorkspaces);
    },
```

Add `setPinned` immediately after the `deleteWorkspace` implementation:

```ts
    async setPinned(id: string, pinned: boolean): Promise<void> {
      native
        .prepare("UPDATE workspaces SET pinned_at = ? WHERE id = ?")
        .run(pinned ? new Date().toISOString() : null, id);
    },
```

In `mapWorkspaceRow`, add after `lastError: row.lastError ?? undefined,`:

```ts
    pinnedAt: row.pinnedAt ?? undefined,
```

Add the comparator at the bottom of the file, next to `mapWorkspaceRow`:

```ts
function compareWorkspaces(a: RegistryWorkspace, b: RegistryWorkspace): number {
  if (a.pinnedAt && !b.pinnedAt) return -1;
  if (!a.pinnedAt && b.pinnedAt) return 1;
  if (a.pinnedAt && b.pinnedAt && a.pinnedAt !== b.pinnedAt) {
    return b.pinnedAt.localeCompare(a.pinnedAt);
  }
  return b.createdAt.localeCompare(a.createdAt);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/registry.test.ts`
Expected: PASS (all tests, including the two new ones).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/sqlite/schema.ts packages/db/src/sqlite/registry-db.ts packages/db/src/sqlite/types.ts packages/db/src/sqlite/repository.ts tests/registry.test.ts
git commit -m "feat(db): add pinned_at to registry workspaces with pinned-first sorting"
```

---

### Task 2: `removeWorkspace` shared core in `packages/db`

**Files:**

- Create: `packages/db/src/sqlite/remove-workspace.ts`
- Modify: `packages/db/src/sqlite/index.ts` (exports)
- Test: `tests/remove-workspace.test.ts` (new)

**Interfaces:**

- Consumes: `createRegistryRepository()`, `repo.deleteWorkspace(id)`, `getLocalWorkspaceDir(rootPath)`, `closeWorkspaceDb(rootPath)` — all already exported within `packages/db`.
- Produces (exported from `@openez-graph/db`, consumed by Tasks 3, 4, 5):

```ts
export interface RemoveWorkspaceSelector {
  id?: string;
  rootPath?: string;
}

export interface RemoveWorkspaceReport {
  workspaceId: string;
  rootPath: string;
  unregistered: boolean;
  dataDirRemoved: boolean;
  dataDirPath: string;
  warnings: string[];
}

export async function removeWorkspace(
  selector: RemoveWorkspaceSelector,
): Promise<RemoveWorkspaceReport | null>; // null = workspace not found
```

- [ ] **Step 1: Write the failing test**

Create `tests/remove-workspace.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  closeRegistryDb,
  createRegistryRepository,
  removeWorkspace,
} from "../packages/db/src/sqlite/index";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openez-remove-test-"));
  process.env.AI_MEMORY_REGISTRY_DB_PATH = path.join(tempDir, "registry.sqlite");
  closeRegistryDb();
});

afterEach(() => {
  closeRegistryDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.AI_MEMORY_REGISTRY_DB_PATH;
});

async function seedWorkspace(id: string, rootPath: string) {
  fs.mkdirSync(path.join(rootPath, ".openez"), { recursive: true });
  fs.writeFileSync(path.join(rootPath, ".openez", "workspace.json"), "{}\n");
  fs.writeFileSync(path.join(rootPath, ".openez", "index.sqlite"), "stub");
  return createRegistryRepository().createWorkspace({ id, name: id, rootPath });
}

describe("removeWorkspace", () => {
  it("removes by id: registry row and .openez dir", async () => {
    const root = path.join(tempDir, "proj-a");
    await seedWorkspace("ws-a", root);

    const report = await removeWorkspace({ id: "ws-a" });

    expect(report).toMatchObject({
      workspaceId: "ws-a",
      unregistered: true,
      dataDirRemoved: true,
    });
    expect(report?.warnings).toEqual([]);
    expect(await createRegistryRepository().listWorkspaces()).toHaveLength(0);
    expect(fs.existsSync(path.join(root, ".openez"))).toBe(false);
  });

  it("removes by rootPath", async () => {
    const root = path.join(tempDir, "proj-b");
    await seedWorkspace("ws-b", root);

    const report = await removeWorkspace({ rootPath: root });

    expect(report?.workspaceId).toBe("ws-b");
    expect(fs.existsSync(path.join(root, ".openez"))).toBe(false);
    expect(await createRegistryRepository().listWorkspaces()).toHaveLength(0);
  });

  it("unregisters with a warning when the project dir is already gone", async () => {
    const root = path.join(tempDir, "proj-gone");
    await seedWorkspace("ws-gone", root);
    fs.rmSync(root, { recursive: true, force: true });

    const report = await removeWorkspace({ id: "ws-gone" });

    expect(report?.unregistered).toBe(true);
    expect(report?.dataDirRemoved).toBe(false);
    expect(report?.warnings.length).toBeGreaterThan(0);
    expect(await createRegistryRepository().listWorkspaces()).toHaveLength(0);
  });

  it("returns null for an unknown workspace", async () => {
    expect(await removeWorkspace({ id: "nope" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/remove-workspace.test.ts`
Expected: FAIL — `removeWorkspace` is not exported / module not found.

- [ ] **Step 3: Implement the core**

Create `packages/db/src/sqlite/remove-workspace.ts`:

```ts
import fs from "node:fs/promises";

import { getLocalWorkspaceDir } from "./local-workspace";
import { createRegistryRepository } from "./repository";
import { closeWorkspaceDb } from "./workspace-db";

export interface RemoveWorkspaceSelector {
  id?: string;
  rootPath?: string;
}

export interface RemoveWorkspaceReport {
  workspaceId: string;
  rootPath: string;
  unregistered: boolean;
  dataDirRemoved: boolean;
  dataDirPath: string;
  warnings: string[];
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

export async function removeWorkspace(
  selector: RemoveWorkspaceSelector,
): Promise<RemoveWorkspaceReport | null> {
  const repo = createRegistryRepository();
  const workspace = selector.id
    ? await repo.getWorkspace(selector.id)
    : selector.rootPath
      ? await repo.getWorkspaceByPath(selector.rootPath)
      : null;

  if (!workspace) return null;

  const warnings: string[] = [];
  if (workspace.indexingStatus === "running" || workspace.graphStatus === "running") {
    warnings.push(
      "Workspace appears to be indexing or building its graph; stop the process first to avoid stale writes.",
    );
  }

  await repo.deleteWorkspace(workspace.id);

  const dataDirPath = getLocalWorkspaceDir(workspace.rootPath);
  let dataDirRemoved = false;

  if (!(await pathExists(workspace.rootPath))) {
    warnings.push(`Workspace root path does not exist on disk: ${workspace.rootPath}`);
  } else {
    closeWorkspaceDb(workspace.rootPath);
    try {
      dataDirRemoved = await pathExists(dataDirPath);
      await fs.rm(dataDirPath, { recursive: true, force: true });
    } catch (err) {
      dataDirRemoved = false;
      warnings.push(
        `Failed to delete ${dataDirPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    workspaceId: workspace.id,
    rootPath: workspace.rootPath,
    unregistered: true,
    dataDirRemoved,
    dataDirPath,
    warnings,
  };
}
```

Add exports to `packages/db/src/sqlite/index.ts` (after the `local-workspace` export block):

```ts
export { removeWorkspace } from "./remove-workspace";
export type { RemoveWorkspaceReport, RemoveWorkspaceSelector } from "./remove-workspace";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/remove-workspace.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/sqlite/remove-workspace.ts packages/db/src/sqlite/index.ts tests/remove-workspace.test.ts
git commit -m "feat(db): add removeWorkspace with .openez data cleanup"
```

---

### Task 3: CLI — `openez remove` command + pin marker in `openez list`

**Files:**

- Modify: `apps/cli/src/cli.ts` (imports line 1-13, `list` command line 286-306, new `remove` command after it)

**Interfaces:**

- Consumes: `removeWorkspace({ id })`, `RemoveWorkspaceReport`, `getLocalWorkspaceDir(rootPath)` from `@openez-graph/db` (Task 2); `RegistryWorkspace.pinnedAt` (Task 1).
- Produces: CLI commands `openez remove [path] [--id <id>] [-y]` (alias `rm`); `openez list` shows `📌` for pinned workspaces.

- [ ] **Step 1: Update imports**

In `apps/cli/src/cli.ts`, add `readline` to the node imports and extend the `@openez-graph/db` import:

```ts
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
```

```ts
import {
  createRegistryRepository,
  createWorkspaceRepository,
  getLocalWorkspaceDir,
  isSensitiveKey,
  removeWorkspace,
  writeLocalWorkspaceConfig,
} from "@openez-graph/db";
```

- [ ] **Step 2: Add the pin marker to `openez list`**

Replace the loop body in the `list` command:

```ts
console.log("Registered workspaces:");
for (const workspace of workspaces) {
  const statusIcon =
    workspace.status === "indexed" ? "✓" : workspace.status === "error" ? "✗" : "○";
  const pinMarker = workspace.pinnedAt ? " 📌" : "";
  console.log(`  ${statusIcon}${pinMarker} ${workspace.name} (${workspace.id})`);
  console.log(`       ${workspace.rootPath}`);
}
```

- [ ] **Step 3: Add the `remove` command**

Insert after the `list` command block (before `// ── openez config ──`):

```ts
// ── openez remove [path] ──

function confirmDestructive(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${prompt} [y/N] `, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === "y" || normalized === "yes");
    });
  });
}

program
  .command("remove")
  .alias("rm")
  .description("Remove a workspace from the registry and delete its .openez data directory")
  .argument("[path]", "path to the workspace directory", process.cwd())
  .option("--id <workspaceId>", "workspace id (takes precedence over path)")
  .option("-y, --yes", "skip confirmation prompt")
  .action(async (targetPath, options) => {
    const registry = createRegistryRepository();
    const resolvedPath = path.resolve(targetPath);
    const workspace = options.id
      ? await registry.getWorkspace(options.id)
      : await registry.getWorkspaceByPath(resolvedPath);

    if (!workspace) {
      console.error(`Error: no registered workspace found for ${options.id ?? resolvedPath}`);
      process.exit(1);
    }

    const dataDir = getLocalWorkspaceDir(workspace.rootPath);
    console.log(`Workspace: ${workspace.name} (${workspace.id})`);
    console.log(`  Path:     ${workspace.rootPath}`);
    console.log(`  Data dir: ${dataDir}`);
    console.log(
      "This removes the registry entry and deletes the data directory. Source code is not touched.",
    );

    if (!options.yes) {
      const confirmed = await confirmDestructive("Proceed?");
      if (!confirmed) {
        console.log("Aborted.");
        return;
      }
    }

    const report = await removeWorkspace({ id: workspace.id });
    if (!report) {
      console.error(`Error: workspace '${workspace.id}' no longer exists in the registry.`);
      process.exit(1);
    }

    console.log(`✓ Unregistered workspace ${report.workspaceId}`);
    if (report.dataDirRemoved) {
      console.log(`✓ Deleted ${report.dataDirPath}`);
    }
    for (const warning of report.warnings) {
      console.log(`! ${warning}`);
    }
  });
```

- [ ] **Step 4: Build and smoke test against a throwaway registry**

```bash
pnpm build:cli
SMOKE_ROOT="$(mktemp -d)"
export AI_MEMORY_REGISTRY_DB_PATH="$SMOKE_ROOT/registry.sqlite"
PROJ="$SMOKE_ROOT/proj"
mkdir -p "$PROJ"
echo "export const x = 1;" > "$PROJ/index.ts"

node apps/cli/dist/cli.cjs init "$PROJ" --no-index
node apps/cli/dist/cli.cjs list                       # shows the workspace
node apps/cli/dist/cli.cjs remove "$PROJ" -y
node apps/cli/dist/cli.cjs list                       # "No workspaces registered."
ls "$PROJ/.openez" 2>&1 || echo ".openez gone"        # expect: No such file or directory
node apps/cli/dist/cli.cjs remove --id does-not-exist -y; echo "exit=$?"  # expect exit=1
unset AI_MEMORY_REGISTRY_DB_PATH
```

Expected: init registers, remove prints `✓ Unregistered` + `✓ Deleted ...`, list is empty, `.openez` deleted, unknown id exits 1.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/cli.ts
git commit -m "feat(cli): add openez remove command and pin marker in list"
```

---

### Task 4: MCP — `remove_workspace` tool

**Files:**

- Modify: `apps/mcp/src/mcp-core.ts` (db import line 23-27, zod schemas near line 85-89, tools list near line 503-514, handler near line 702-707)
- Modify: `AGENTS.md` (tool list in "Code Search Rules → Setup", "MCP Expectations")
- Test: `tests/mcp-tools.test.ts` (append describe block)

**Interfaces:**

- Consumes: `removeWorkspace({ id?, rootPath? })` → `RemoveWorkspaceReport | null` (Task 2); existing `jsonResponse`, zod patterns, `connectClient`/`createIndexedWorkspace` test helpers in `tests/mcp-tools.test.ts`.
- Produces: MCP tool `remove_workspace { workspaceId?, path?, confirm: boolean }` → JSON text of `RemoveWorkspaceReport`, or `{ error, hint }` refusal when `confirm !== true`.
- Note: deliberately does NOT use `resolver.resolveWriteWorkspace` — that helper falls back to the _default_ workspace when no selector is passed, which is dangerous for a destructive tool. This tool requires an explicit `workspaceId` or `path`.

- [ ] **Step 1: Write the failing test**

Append to the end of `tests/mcp-tools.test.ts`:

```ts
function toolJson(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

describe("remove_workspace", () => {
  it("refuses when confirm is not true", async () => {
    const rootPath = path.join(tempRoot, "victim");
    await createIndexedWorkspace("victim", rootPath);
    const { client } = await connectClient(tempRoot);

    const result = await client.callTool({
      name: "remove_workspace",
      arguments: { workspaceId: "victim" },
    });

    expect(String(toolJson(result).error)).toMatch(/confirm/i);
    expect(await createRegistryRepository().getWorkspace("victim")).not.toBeNull();
    expect(fs.existsSync(path.join(rootPath, ".openez"))).toBe(true);
  });

  it("removes registry entry and .openez dir when confirm is true", async () => {
    const rootPath = path.join(tempRoot, "victim2");
    await createIndexedWorkspace("victim2", rootPath);
    const { client } = await connectClient(tempRoot);

    const result = await client.callTool({
      name: "remove_workspace",
      arguments: { workspaceId: "victim2", confirm: true },
    });

    expect(toolJson(result)).toMatchObject({
      workspaceId: "victim2",
      unregistered: true,
      dataDirRemoved: true,
    });
    expect(await createRegistryRepository().getWorkspace("victim2")).toBeNull();
    expect(fs.existsSync(path.join(rootPath, ".openez"))).toBe(false);
  });

  it("errors without an explicit workspaceId or path", async () => {
    const { client } = await connectClient(tempRoot);

    const result = await client.callTool({
      name: "remove_workspace",
      arguments: { confirm: true },
    });

    expect(toolJson(result).error).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/mcp-tools.test.ts`
Expected: FAIL — `Unknown tool: remove_workspace`.

- [ ] **Step 3: Implement the tool**

3a. In `apps/mcp/src/mcp-core.ts`, extend the `@openez-graph/db` import:

```ts
import {
  createRegistryRepository,
  createWorkspaceRepository,
  findLocalWorkspaceConfig,
  removeWorkspace,
} from "@openez-graph/db";
```

3b. Add a zod schema next to `indexWorkspaceSchema`:

```ts
const removeWorkspaceSchema = z.object({
  workspaceId: z.string().optional(),
  path: z.string().optional(),
  confirm: z.boolean(),
});
```

3c. Register the tool in the `ListToolsRequestSchema` handler, after the `index_workspace` entry:

```ts
      {
        name: "remove_workspace",
        description:
          "Remove a workspace from the registry and delete its .openez data directory. Destructive and irreversible: call only with confirm: true after explicit user approval.",
        inputSchema: {
          type: "object",
          properties: {
            workspaceId: { type: "string" },
            path: { type: "string" },
            confirm: { type: "boolean" },
          },
          required: ["confirm"],
        },
      },
```

3d. Add the handler case after `case "index_workspace"` (before `default:`):

```ts
      case "remove_workspace": {
        const input = removeWorkspaceSchema.parse(request.params.arguments ?? {});
        if (input.confirm !== true) {
          return jsonResponse({
            error:
              "remove_workspace permanently deletes the registry entry and the workspace's .openez data directory.",
            hint: "Ask the user for approval, then call remove_workspace again with confirm: true.",
          });
        }
        if (input.workspaceId && input.path) {
          return jsonResponse({ error: "Pass either workspaceId or path, not both." });
        }
        if (!input.workspaceId && !input.path) {
          return jsonResponse({ error: "Pass an explicit workspaceId or path." });
        }
        const report = await removeWorkspace({ id: input.workspaceId, rootPath: input.path });
        if (!report) {
          return jsonResponse({
            error: "Workspace not found",
            workspaceId: input.workspaceId,
            path: input.path,
          });
        }
        return jsonResponse(report);
      }
```

3e. Update `AGENTS.md`. In the "Setup" section, change the tool enumeration to:

```markdown
This configures MCP server access. After setup, the agent automatically sees `code_query`, `code_context`, `graph_neighbors`, `memory_write`, `memory_recall`, `index_workspace`, `remove_workspace`, and `list_workspaces` as available tools. `remove_workspace` is destructive (deletes the registry entry and `<root>/.openez/`) and requires `confirm: true`.
```

And in "MCP Expectations", change the single-workspace bullet to:

```markdown
- `memory_write`, `index_workspace`, and `remove_workspace` remain single-workspace operations
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/mcp-tools.test.ts`
Expected: PASS (including the three new tests).

- [ ] **Step 5: Commit**

```bash
git add apps/mcp/src/mcp-core.ts tests/mcp-tools.test.ts AGENTS.md
git commit -m "feat(mcp): add remove_workspace tool with confirm guard"
```

---

### Task 5: Web server — pin column, pinned-first sort, upgraded DELETE, new PATCH /pin

**Files:**

- Modify: `apps/web/src/server/sqlite.ts` (`WebRegistryWorkspace` line 39-57, `initializeRegistrySchema` line 151-174, `mapWorkspace` line 346-366, `listRegistryWorkspaces` line 368-373, delete `deleteRegistryWorkspace` line 505-507, add `setRegistryWorkspacePinned` + `closeRegistryDb`)
- Modify: `apps/web/src/server/index.ts` (imports line 24-48, local `mapWorkspace` line 84-122, DELETE route line 318-327, new PATCH route)
- Test: `tests/web-workspaces-endpoint.test.ts` (new)

**Interfaces:**

- Consumes: `removeWorkspace({ id })` from `@openez-graph/db` (Task 2).
- Produces:
  - `WebRegistryWorkspace.pinnedAt?: string`; API list items gain `pinnedAt: string | null`
  - `setRegistryWorkspacePinned(id: string, pinned: boolean): void`
  - `closeRegistryDb(): void` (web server's own registry singleton — needed for test isolation)
  - `DELETE /api/workspaces/:id` → `{ success: true, report: RemoveWorkspaceReport }` or 404
  - `PATCH /api/workspaces/:id/pin` body `{ pinned: boolean }` → `{ success: true }`, 400 on bad body, 404 on unknown id

- [ ] **Step 1: Write the failing test**

Create `tests/web-workspaces-endpoint.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createWebServer } from "../apps/web/src/server/index";
import { closeRegistryDb as closeWebRegistryDb } from "../apps/web/src/server/sqlite";
import {
  closeAllWorkspaceDbs,
  closeRegistryDb,
  createRegistryRepository,
} from "../packages/db/src/sqlite";

let tempDir: string;
const app = createWebServer();

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openez-web-ws-"));
  process.env.AI_MEMORY_REGISTRY_DB_PATH = path.join(tempDir, "registry.sqlite");
  closeRegistryDb();
  closeWebRegistryDb();
  closeAllWorkspaceDbs();
});

afterEach(() => {
  closeAllWorkspaceDbs();
  closeWebRegistryDb();
  closeRegistryDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.AI_MEMORY_REGISTRY_DB_PATH;
});

describe("DELETE /api/workspaces/:id", () => {
  it("removes the registry row and the .openez directory", async () => {
    const root = path.join(tempDir, "victim");
    fs.mkdirSync(path.join(root, ".openez"), { recursive: true });
    fs.writeFileSync(path.join(root, ".openez", "workspace.json"), "{}\n");
    const ws = await createRegistryRepository().createWorkspace({
      id: "victim",
      name: "victim",
      rootPath: root,
    });

    const response = await app.request(`/api/workspaces/${ws.id}`, { method: "DELETE" });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      report: { workspaceId: "victim", unregistered: true, dataDirRemoved: true },
    });
    expect(await createRegistryRepository().getWorkspace("victim")).toBeNull();
    expect(fs.existsSync(path.join(root, ".openez"))).toBe(false);
  });

  it("returns 404 for an unknown workspace", async () => {
    const response = await app.request("/api/workspaces/nope", { method: "DELETE" });
    expect(response.status).toBe(404);
  });
});

describe("PATCH /api/workspaces/:id/pin", () => {
  it("pins and unpins; list returns pinned first", async () => {
    await createRegistryRepository().createWorkspace({ id: "a", name: "a", rootPath: "/tmp/a" });
    await createRegistryRepository().createWorkspace({ id: "b", name: "b", rootPath: "/tmp/b" });

    const pin = await app.request("/api/workspaces/a/pin", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: true }),
    });
    expect(pin.status).toBe(200);

    const listed = await (await app.request("/api/workspaces")).json();
    expect(listed.data[0].id).toBe("a");
    expect(listed.data[0].pinnedAt).toBeTruthy();
    expect(listed.data[1].pinnedAt).toBeNull();

    const unpin = await app.request("/api/workspaces/a/pin", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: false }),
    });
    expect(unpin.status).toBe(200);

    const relisted = await (await app.request("/api/workspaces")).json();
    expect(relisted.data[0].pinnedAt).toBeNull();
  });

  it("rejects a non-boolean pinned and an unknown id", async () => {
    await createRegistryRepository().createWorkspace({ id: "a", name: "a", rootPath: "/tmp/a" });

    const bad = await app.request("/api/workspaces/a/pin", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: "yes" }),
    });
    expect(bad.status).toBe(400);

    const missing = await app.request("/api/workspaces/nope/pin", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: true }),
    });
    expect(missing.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/web-workspaces-endpoint.test.ts`
Expected: FAIL — `closeRegistryDb` not exported from `apps/web/src/server/sqlite`; PATCH route does not exist; DELETE returns `{ success: true }` without `report`.

- [ ] **Step 3: Implement web server changes**

3a. `apps/web/src/server/sqlite.ts`:

- In `WebRegistryWorkspace`, add after `lastError?: string;`:

```ts
  pinnedAt?: string;
```

- In `initializeRegistrySchema`, add `pinned_at TEXT,` to the CREATE TABLE after `last_error TEXT,`, and call `migrateRegistryColumns(db);` after the `db.exec(...)` block. Add the function:

```ts
function migrateRegistryColumns(db: SqliteDb) {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );

  if (!columns.has("pinned_at")) {
    db.exec("ALTER TABLE workspaces ADD COLUMN pinned_at TEXT");
  }
}
```

- Add a close function next to `getRegistryDb`:

```ts
export function closeRegistryDb() {
  registryDb?.close();
  registryDb = null;
}
```

- In `mapWorkspace`, add after `lastError: row.last_error ? String(row.last_error) : undefined,`:

```ts
    pinnedAt: row.pinned_at ? String(row.pinned_at) : undefined,
```

- Change `listRegistryWorkspaces` ordering:

```ts
export function listRegistryWorkspaces(): WebRegistryWorkspace[] {
  const rows = getRegistryDb()
    .prepare(
      "SELECT * FROM workspaces ORDER BY (pinned_at IS NULL), pinned_at DESC, created_at DESC",
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map(mapWorkspace);
}
```

- Add the pin setter (next to `updateRegistryWorkspace`):

```ts
export function setRegistryWorkspacePinned(id: string, pinned: boolean) {
  getRegistryDb()
    .prepare("UPDATE workspaces SET pinned_at = ? WHERE id = ?")
    .run(pinned ? new Date().toISOString() : null, id);
}
```

- Delete the `deleteRegistryWorkspace` function entirely.

3b. `apps/web/src/server/index.ts`:

- In the `./sqlite` import block, remove `deleteRegistryWorkspace,` and add `setRegistryWorkspacePinned,` (keep alphabetical order).
- Extend the `@openez-graph/db` import:

```ts
import {
  createRegistryRepository,
  createWorkspaceRepository,
  removeWorkspace,
} from "@openez-graph/db";
```

- In the local `mapWorkspace` (line 84-122), add `pinnedAt?: string;` to the parameter type (after `lastError?: string;`) and add to the returned object after `lastError: ws.lastError ?? null,`:

```ts
    pinnedAt: ws.pinnedAt ?? null,
```

- Replace the DELETE route:

```ts
app.delete("/api/workspaces/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const report = await removeWorkspace({ id });
    if (!report) return c.json({ success: false, error: "Workspace not found" }, 404);
    return c.json({ success: true, report });
  } catch (err) {
    console.error("Failed to delete workspace:", err);
    return c.json({ success: false, error: "Failed to delete workspace" });
  }
});
```

- Add the PATCH route immediately after it:

```ts
app.patch("/api/workspaces/:id/pin", async (c) => {
  try {
    const id = c.req.param("id");
    const body = await c.req.json<{ pinned?: boolean }>();
    if (typeof body.pinned !== "boolean") {
      return c.json({ success: false, error: "pinned (boolean) is required" }, 400);
    }
    if (!getRegistryWorkspace(id)) {
      return c.json({ success: false, error: "Workspace not found" }, 404);
    }
    setRegistryWorkspacePinned(id, body.pinned);
    return c.json({ success: true });
  } catch (err) {
    console.error("Failed to pin workspace:", err);
    return c.json({ success: false, error: "Failed to pin workspace" });
  }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/web-workspaces-endpoint.test.ts`
Expected: PASS (4 tests). Also run `pnpm vitest run tests/web-index-endpoint.test.ts` to confirm the neighboring web suite still passes.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/sqlite.ts apps/web/src/server/index.ts tests/web-workspaces-endpoint.test.ts
git commit -m "feat(web): pin endpoint and full-cleanup workspace delete"
```

---

### Task 6: UI — pin toggle + delete dialog on `/workspaces`

**Files:**

- Modify: `apps/web/src/lib/api.ts` (`WorkspaceListItem` line 18-38, add `pinWorkspace` near line 195)
- Modify: `apps/web/src/routes/workspaces/index.tsx` (full page — add mutations, buttons, dialog)

**Interfaces:**

- Consumes: `PATCH /api/workspaces/:id/pin` and `DELETE /api/workspaces/:id` (Task 5); existing `api.deleteWorkspace(id)`, `workspacesQueryOptions`, dialog overlay pattern from `apps/web/src/routes/memories.tsx` (`MemoryDetailDialog`).
- Produces:
  - `WorkspaceListItem.pinnedAt: string | null`
  - `api.pinWorkspace(id: string, pinned: boolean): Promise<{ success: boolean; error?: string }>`
  - Workspaces list: pin toggle (solid `Pin` icon when pinned), trash button, `DeleteWorkspaceDialog`.

- [ ] **Step 1: Extend the API client**

In `apps/web/src/lib/api.ts`:

- In `WorkspaceListItem`, add after `updatedAt: string;`:

```ts
pinnedAt: string | null;
```

- Add after the `deleteWorkspace` entry:

```ts
  pinWorkspace: (id: string, pinned: boolean) =>
    request<{ success: boolean; error?: string }>(`/workspaces/${id}/pin`, {
      method: "PATCH",
      body: JSON.stringify({ pinned }),
    }),
```

- [ ] **Step 2: Update the workspaces page**

In `apps/web/src/routes/workspaces/index.tsx`:

2a. Update imports:

```ts
import { createFileRoute, Link, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type WorkspaceListItem } from "../../lib/api";
```

Add `Pin` and `Trash2` to the lucide import:

```ts
import { Plus, FolderOpen, Search, Layers, AlertTriangle, Pin, Trash2 } from "lucide-react";
```

2b. Inside `WorkspacesPage`, after the `useQuery(workspacesQueryOptions)` line, add:

```ts
const [workspaceToDelete, setWorkspaceToDelete] = useState<WorkspaceListItem | null>(null);

const pinMutation = useMutation({
  mutationFn: ({ id, pinned }: { id: string; pinned: boolean }) => api.pinWorkspace(id, pinned),
  onSuccess: () => queryClient.invalidateQueries({ queryKey: ["workspaces"] }),
});

const deleteMutation = useMutation({
  mutationFn: (id: string) => api.deleteWorkspace(id),
  onSuccess: () => {
    setWorkspaceToDelete(null);
    queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  },
});
```

2c. In the card markup, inside the `<div className="text-right text-sm">`, add the action buttons ABOVE the `<div className="flex gap-2 mb-1">` badges row (they must call `preventDefault` because the whole card is a `<Link>`):

```tsx
<div className="flex items-center justify-end gap-1 mb-1">
  <button
    title={workspace.pinnedAt ? "Unpin workspace" : "Pin workspace"}
    onClick={(e) => {
      e.preventDefault();
      e.stopPropagation();
      pinMutation.mutate({ id: workspace.id, pinned: !workspace.pinnedAt });
    }}
    className={
      workspace.pinnedAt
        ? "text-primary"
        : "text-muted-foreground hover:text-foreground transition-colors"
    }
  >
    <Pin className={`h-4 w-4 ${workspace.pinnedAt ? "fill-current" : ""}`} />
  </button>
  <button
    title="Delete workspace"
    onClick={(e) => {
      e.preventDefault();
      e.stopPropagation();
      setWorkspaceToDelete(workspace);
    }}
    className="text-muted-foreground hover:text-destructive transition-colors"
  >
    <Trash2 className="h-4 w-4" />
  </button>
</div>
```

2d. Render the dialog at the bottom of the page JSX, after `<Pagination ... />` inside the `<>...</>` fragment (or after the closing fragment, before the final `</div>`):

```tsx
{
  workspaceToDelete && (
    <DeleteWorkspaceDialog
      workspace={workspaceToDelete}
      onClose={() => setWorkspaceToDelete(null)}
      onConfirm={() => deleteMutation.mutate(workspaceToDelete.id)}
      deleting={deleteMutation.isPending}
    />
  );
}
```

2e. Add the dialog component at the end of the file (pattern copied from `MemoryDetailDialog` in `apps/web/src/routes/memories.tsx`):

```tsx
function DeleteWorkspaceDialog({
  workspace,
  onClose,
  onConfirm,
  deleting,
}: {
  workspace: WorkspaceListItem;
  onClose: () => void;
  onConfirm: () => void;
  deleting: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <Card className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <CardHeader>
          <CardTitle>Delete workspace</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-4">
            <p className="text-sm">
              Delete <span className="font-medium">{workspace.name}</span>? The registry entry and{" "}
              <code className="text-xs">{workspace.rootPath}/.openez</code> will be permanently
              deleted. Project source code is not touched.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={onClose} disabled={deleting}>
                Cancel
              </Button>
              <Button variant="destructive" size="sm" onClick={onConfirm} disabled={deleting}>
                <Trash2 className="h-4 w-4 mr-1" />
                {deleting ? "Deleting..." : "Delete"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck and build**

Run: `pnpm --filter @openez-graph/web typecheck && pnpm build:web`
Expected: no type errors; build succeeds.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/api.ts apps/web/src/routes/workspaces/index.tsx
git commit -m "feat(ui): pin toggle and delete dialog on workspaces page"
```

---

### Task 7: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Full test suite**

Run: `pnpm test`
Expected: all suites pass, including `tests/registry.test.ts`, `tests/remove-workspace.test.ts`, `tests/mcp-tools.test.ts`, `tests/web-workspaces-endpoint.test.ts`, and the pre-existing `tests/web-index-endpoint.test.ts`.

- [ ] **Step 2: Typecheck + builds**

Run: `pnpm typecheck && pnpm build:web && pnpm build:cli`
Expected: all green. Also verify the built CLI lists the new command:

```bash
node apps/cli/dist/cli.cjs --help | grep -E "remove|rm"
```

- [ ] **Step 3: Manual MCP smoke (optional but recommended)**

Restart your MCP session (`openez serve --mcp`) and confirm `remove_workspace` appears in the tool list, a call without `confirm` is refused, and a call with `confirm: true` on a junk workspace removes it and its `.openez` directory.
