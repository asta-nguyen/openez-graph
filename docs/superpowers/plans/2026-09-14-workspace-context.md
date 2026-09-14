# Workspace Context Session Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic, token-budgeted `workspace_context` MCP tool that returns workspace/index identity, root agent instructions, Git activity, and newest active memories at session start.

**Architecture:** A new core snapshot function reads one already-resolved workspace through Node filesystem/Git APIs and the existing SQLite repository. The MCP layer reuses the existing multi-workspace resolver, isolates per-workspace failures, and extends the current final response fitter with workspace-context-specific reduction priority.

**Tech Stack:** TypeScript, Bun test runner, SQLite/WAL repository, Node `fs`/`child_process`, Zod, MCP SDK.

**Approved design:** [`docs/superpowers/specs/2026-09-14-workspace-context-design.md`](../specs/2026-09-14-workspace-context-design.md)

## Global Constraints

- Default response budget is exactly `800` tokens; accepted `maxTokens` is an integer from `128` through `100_000`.
- Support exactly one of `workspaceIds`, `workspaceId`, `paths`, or `path`; no selector uses the existing default workspace resolution.
- Use no LLM, embedding call, graph build, indexing pass, external API, cache, new dependency, or SQLite schema migration.
- Read only regular root `AGENTS.md` and `CLAUDE.md` files, in that order; skip symlinks with a warning.
- Git commands use fixed argument arrays with the registered root as `cwd`; Git failure is non-fatal and must not expose command output.
- Active memories are newest first, exclude superseded rows, and are limited to ten before response fitting.
- Final serialized JSON, including metrics, never exceeds `maxTokens`.

## File Map

| File                                          | Responsibility                                                                   |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| `packages/db/src/sqlite/memory-repository.ts` | Query newest active memory rows without changing storage                         |
| `packages/db/src/sqlite/types.ts`             | Add the repository method contract                                               |
| `packages/core/src/workspace-context.ts`      | Build one deterministic workspace snapshot                                       |
| `packages/core/src/index.ts`                  | Export the new core entry point and types                                        |
| `apps/mcp/src/mcp-core.ts`                    | Validate/register/handle `workspace_context` and enforce final budget            |
| `tests/workspace-db.test.ts`                  | Verify active-memory ordering, limit, and supersession                           |
| `tests/workspace-context.test.ts`             | Verify instruction, Git, memory, symlink, and non-Git core behavior              |
| `tests/mcp-tools.test.ts`                     | Verify public MCP scope, failure isolation, description, and token contract      |
| `README.md`                                   | Advertise session bootstrap in the root tool list                                |
| `apps/cli/README.md`                          | Advertise the MCP tool in packaged CLI documentation                             |
| `AGENTS.md`                                   | Make `workspace_context` the session-start rule and retain query-specific recall |

## Files Inspected, No Change

- `packages/db/src/sqlite/workspace-repository.ts` already spreads `createMemoryOps`; the new method appears automatically.
- `packages/db/src/sqlite/index.ts` already exports `RegistryWorkspace`, `StoredMemory`, and `WorkspaceRepository`.
- `packages/core/src/memory.ts` keeps query-specific `memoryWrite`/`memoryRecall` unchanged.
- `packages/core/src/diff-context.ts` remains the richer symbol-aware diff path; bootstrap uses only porcelain status.

---

### Task 1: List Active Memories in the Workspace Repository

**Files:**

- Modify: `packages/db/src/sqlite/types.ts:419-428`
- Modify: `packages/db/src/sqlite/memory-repository.ts:68-109`
- Test: `tests/workspace-db.test.ts` inside `describe("createWorkspaceRepository")`

**Interfaces:**

- Consumes: existing `StoredMemory`, `mapMemoryRow()`, and `memories.supersedes_id` semantics.
- Produces: `WorkspaceRepository.listActiveMemories(limit: number): Promise<StoredMemory[]>` for Task 2.

- [ ] **Step 1: Write the failing repository test**

Add this test to `tests/workspace-db.test.ts`:

```ts
it("lists newest active memories and excludes superseded rows", async () => {
  const repo = createWorkspaceRepository(tempRoot);
  const supersededId = await repo.insertMemory({
    title: "Old runtime",
    content: "Use Node",
    source: "agent",
  });
  const activeId = await repo.insertMemory({
    title: "Editor",
    content: "Use Vim",
    source: "user",
  });
  const replacementId = await repo.insertMemory({
    title: "Current runtime",
    content: "Use Bun",
    source: "agent",
    supersedesId: supersededId,
  });

  await repo.executeRaw("UPDATE memories SET updated_at = ? WHERE id = ?", [
    "2026-09-14T00:00:01.000Z",
    activeId,
  ]);
  await repo.executeRaw("UPDATE memories SET updated_at = ? WHERE id = ?", [
    "2026-09-14T00:00:02.000Z",
    replacementId,
  ]);

  const memories = await repo.listActiveMemories(2);

  expect(memories.map((memory) => memory.id)).toEqual([replacementId, activeId]);
  expect(memories.map((memory) => memory.id)).not.toContain(supersededId);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
pnpm exec vitest run tests/workspace-db.test.ts -t "lists newest active memories"
```

Expected: FAIL because `listActiveMemories` is not defined on `WorkspaceRepository`.

- [ ] **Step 3: Add the repository contract and implementation**

Add to the memory methods in `WorkspaceRepository` in
`packages/db/src/sqlite/types.ts`:

```ts
listActiveMemories(limit: number): Promise<StoredMemory[]>;
```

Add beside `searchMemories()` in
`packages/db/src/sqlite/memory-repository.ts`:

```ts
async listActiveMemories(limit: number): Promise<StoredMemory[]> {
  const rows = native
    .prepare(
      `SELECT m.*
       FROM memories m
       WHERE NOT EXISTS (SELECT 1 FROM memories newer WHERE newer.supersedes_id = m.id)
       ORDER BY m.updated_at DESC, m.created_at DESC
       LIMIT ?`,
    )
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map(mapMemoryRow);
},
```

- [ ] **Step 4: Run repository tests and typecheck**

Run:

```bash
pnpm exec vitest run tests/workspace-db.test.ts
pnpm --filter @openez-graph/db typecheck
```

Expected: both commands exit `0`; the new test proves ordering, limit, and supersession without a migration.

- [ ] **Step 5: Commit the repository slice**

```bash
git add packages/db/src/sqlite/types.ts packages/db/src/sqlite/memory-repository.ts tests/workspace-db.test.ts
git commit -m "feat(memory): list active workspace memories"
```

---

### Task 2: Build One Deterministic Workspace Snapshot

**Files:**

- Create: `packages/core/src/workspace-context.ts`
- Modify: `packages/core/src/index.ts:1-8`
- Create: `tests/workspace-context.test.ts`

**Interfaces:**

- Consumes: `RegistryWorkspace` and `WorkspaceRepository.listActiveMemories(limit)` from Task 1.
- Produces: `workspaceContext(workspace: RegistryWorkspace): Promise<WorkspaceContextSnapshot>` and the exported `WorkspaceContextSnapshot` type for Task 3.

- [ ] **Step 1: Write the failing core tests**

Create `tests/workspace-context.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { workspaceContext } from "../packages/core/src/workspace-context";
import {
  closeAllWorkspaceDbs,
  closeRegistryDb,
  createRegistryRepository,
  createWorkspaceRepository,
} from "../packages/db/src/sqlite";

let rootPath: string;
let registryRoot: string;

beforeEach(() => {
  rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "openez-context-"));
  registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-context-registry-"));
  process.env.AI_MEMORY_REGISTRY_DB_PATH = path.join(registryRoot, "registry.sqlite");
  closeRegistryDb();
  closeAllWorkspaceDbs();
});

afterEach(() => {
  closeAllWorkspaceDbs();
  closeRegistryDb();
  fs.rmSync(rootPath, { recursive: true, force: true });
  fs.rmSync(registryRoot, { recursive: true, force: true });
  delete process.env.AI_MEMORY_REGISTRY_DB_PATH;
});

async function createWorkspace() {
  return createRegistryRepository().createWorkspace({
    id: "context-workspace",
    name: "Context Workspace",
    rootPath,
  });
}

describe("workspaceContext", () => {
  it("returns instructions, Git activity, index metadata, and active memories", async () => {
    fs.writeFileSync(path.join(rootPath, "AGENTS.md"), "Use Bun and SQLite.\n");
    fs.writeFileSync(path.join(rootPath, "CLAUDE.md"), "Keep MCP thin.\n");
    execFileSync("git", ["init", "-b", "main"], { cwd: rootPath, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Tester"], { cwd: rootPath });
    execFileSync("git", ["config", "user.email", "tester@example.com"], { cwd: rootPath });
    fs.writeFileSync(path.join(rootPath, "tracked.ts"), "export const value = 1;\n");
    execFileSync("git", ["add", "."], { cwd: rootPath });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: rootPath, stdio: "ignore" });
    fs.writeFileSync(path.join(rootPath, "tracked.ts"), "export const value = 2;\n");
    fs.writeFileSync(path.join(rootPath, "staged.ts"), "export const staged = true;\n");
    execFileSync("git", ["add", "staged.ts"], { cwd: rootPath });

    const workspace = await createWorkspace();
    const repo = createWorkspaceRepository(rootPath);
    const oldId = await repo.insertMemory({
      title: "Old runtime",
      content: "Use Node",
      source: "agent",
    });
    await repo.insertMemory({
      title: "Current runtime",
      content: "Use Bun",
      tags: "runtime,bun",
      source: "agent",
      supersedesId: oldId,
    });

    const result = await workspaceContext(workspace);

    expect(result.instructions.map((item) => item.path)).toEqual(["AGENTS.md", "CLAUDE.md"]);
    expect(result.activity.branch).toBe("main");
    expect(result.activity.changedFiles).toEqual(
      expect.arrayContaining([
        { path: "staged.ts", status: "A " },
        { path: "tracked.ts", status: " M" },
      ]),
    );
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]).toMatchObject({
      title: "Current runtime",
      tags: ["runtime", "bun"],
    });
    expect(result.index).toMatchObject({
      status: workspace.status,
      indexingStatus: workspace.indexingStatus,
      documentCount: 0,
      chunkCount: 0,
    });
  });

  it("reports detached HEAD and preserves rename and untracked paths", async () => {
    execFileSync("git", ["init", "-b", "main"], { cwd: rootPath, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Tester"], { cwd: rootPath });
    execFileSync("git", ["config", "user.email", "tester@example.com"], { cwd: rootPath });
    fs.writeFileSync(path.join(rootPath, "old name.ts"), "export const value = 1;\n");
    execFileSync("git", ["add", "."], { cwd: rootPath });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: rootPath, stdio: "ignore" });
    execFileSync("git", ["checkout", "--detach"], { cwd: rootPath, stdio: "ignore" });
    execFileSync("git", ["mv", "old name.ts", "new name.ts"], { cwd: rootPath });
    fs.writeFileSync(path.join(rootPath, "untracked name.ts"), "export {};\n");

    const result = await workspaceContext(await createWorkspace());

    expect(result.activity.branch).toBeUndefined();
    expect(result.activity.detachedHead).toMatch(/^[0-9a-f]+$/);
    expect(result.activity.changedFiles).toEqual(
      expect.arrayContaining([
        { path: "new name.ts", status: "R " },
        { path: "untracked name.ts", status: "??" },
      ]),
    );
  });

  it("skips symlinked instructions and degrades gracefully outside Git", async () => {
    const outside = path.join(registryRoot, "outside.md");
    fs.writeFileSync(outside, "do not read\n");
    fs.symlinkSync(outside, path.join(rootPath, "AGENTS.md"));

    const result = await workspaceContext(await createWorkspace());

    expect(result.instructions).toEqual([]);
    expect(result.activity).toEqual({ changedFiles: [] });
    expect(result.warnings).toEqual([
      "Skipped symlinked instruction file: AGENTS.md",
      "Git context unavailable at the registered workspace root.",
    ]);
  });
});
```

- [ ] **Step 2: Run the core tests to verify they fail**

Run:

```bash
pnpm exec vitest run tests/workspace-context.test.ts
```

Expected: FAIL because `packages/core/src/workspace-context.ts` does not exist.

- [ ] **Step 3: Define the snapshot types and Git status parser**

Create `packages/core/src/workspace-context.ts` with these public types and helpers:

```ts
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { createWorkspaceRepository, type RegistryWorkspace } from "@openez-graph/db";

const execFileAsync = promisify(execFile);
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

export interface WorkspaceContextSnapshot {
  index: {
    status: RegistryWorkspace["status"];
    indexingStatus: RegistryWorkspace["indexingStatus"];
    lastIndexedAt?: string;
    documentCount: number;
    chunkCount: number;
  };
  instructions: Array<{
    path: (typeof INSTRUCTION_FILES)[number];
    content: string;
  }>;
  activity: {
    branch?: string;
    detachedHead?: string;
    changedFiles: Array<{ path: string; status: string }>;
  };
  memories: Array<{
    id: string;
    title: string;
    content: string;
    tags: string[];
    source: string;
    updatedAt: string;
  }>;
  warnings?: string[];
}

async function runGit(rootPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: rootPath,
    encoding: "utf8",
  });
  return String(stdout);
}

function parseGitStatus(output: string): Array<{ path: string; status: string }> {
  const records = output.split("\0");
  const files: Array<{ path: string; status: string }> = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const status = record.slice(0, 2);
    files.push({ path: record.slice(3), status });
    if (status.includes("R") || status.includes("C")) index += 1;
  }
  return files;
}
```

- [ ] **Step 4: Implement instruction, Git, and memory collection**

Append the core function:

```ts
export async function workspaceContext(
  workspace: RegistryWorkspace,
): Promise<WorkspaceContextSnapshot> {
  const warnings: string[] = [];
  const instructions: WorkspaceContextSnapshot["instructions"] = [];

  for (const fileName of INSTRUCTION_FILES) {
    const instructionPath = path.join(workspace.rootPath, fileName);
    try {
      const stat = await fs.lstat(instructionPath);
      if (stat.isSymbolicLink()) {
        warnings.push(`Skipped symlinked instruction file: ${fileName}`);
      } else if (stat.isFile()) {
        instructions.push({ path: fileName, content: await fs.readFile(instructionPath, "utf8") });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  const activity: WorkspaceContextSnapshot["activity"] = { changedFiles: [] };
  try {
    const [branchOutput, statusOutput] = await Promise.all([
      runGit(workspace.rootPath, ["branch", "--show-current"]),
      runGit(workspace.rootPath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    ]);
    const branch = branchOutput.trim();
    if (branch) activity.branch = branch;
    else
      activity.detachedHead = (
        await runGit(workspace.rootPath, ["rev-parse", "--short", "HEAD"])
      ).trim();
    activity.changedFiles = parseGitStatus(statusOutput);
  } catch {
    warnings.push("Git context unavailable at the registered workspace root.");
  }

  const memories = (await createWorkspaceRepository(workspace.rootPath).listActiveMemories(10)).map(
    (memory) => ({
      id: memory.id,
      title: memory.title,
      content: memory.content,
      tags: memory.tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
      source: memory.source,
      updatedAt: memory.updatedAt,
    }),
  );

  return {
    index: {
      status: workspace.status,
      indexingStatus: workspace.indexingStatus,
      ...(workspace.lastIndexedAt ? { lastIndexedAt: workspace.lastIndexedAt } : {}),
      documentCount: workspace.documentCount,
      chunkCount: workspace.chunkCount,
    },
    instructions,
    activity,
    memories,
    ...(warnings.length ? { warnings } : {}),
  };
}
```

Export it from `packages/core/src/index.ts`:

```ts
export * from "./workspace-context";
```

- [ ] **Step 5: Run core tests and typecheck**

Run:

```bash
pnpm exec vitest run tests/workspace-context.test.ts
pnpm --filter @openez-graph/core typecheck
```

Expected: both commands exit `0`; tests prove regular-file-only instructions, NUL-safe status parsing, detached HEAD, active memories, and non-Git fallback.

- [ ] **Step 6: Commit the core slice**

```bash
git add packages/core/src/workspace-context.ts packages/core/src/index.ts tests/workspace-context.test.ts
git commit -m "feat(core): build workspace context snapshot"
```

---

### Task 3: Expose a Multi-Workspace, Token-Budgeted MCP Tool

**Files:**

- Modify: `apps/mcp/src/mcp-core.ts:10-130,133-269,285-426,528-1030`
- Modify: `tests/mcp-tools.test.ts:85-405`

**Interfaces:**

- Consumes: `workspaceContext(RegistryWorkspace)` from Task 2 and the existing `createWorkspaceResolver()`/`jsonResponse()` path.
- Produces: public MCP tool `workspace_context` with default budget `800`, minimum `128`, maximum `100_000`, and `{ workspaces, metrics }` output.

- [ ] **Step 1: Write failing MCP contract tests**

Add tests inside `describe("MCP agent contracts")` in `tests/mcp-tools.test.ts`:

```ts
it("advertises workspace_context as a session-start read tool", async () => {
  const { client, server } = await connectClient(tempRoot);
  try {
    const tool = (await client.listTools()).tools.find((item) => item.name === "workspace_context");
    expect(tool?.description).toContain("session start");
    expect(
      (tool?.inputSchema as { properties?: Record<string, unknown> }).properties,
    ).toHaveProperty("workspaceIds");
    expect(
      (tool?.inputSchema as { properties?: { maxTokens?: Record<string, unknown> } }).properties
        ?.maxTokens,
    ).toMatchObject({ type: "integer", minimum: 128, maximum: 100_000 });
  } finally {
    await client.close();
    await server.close();
  }
});

it("returns default and explicit multi-workspace context", async () => {
  const first = await createIndexedWorkspace("context-first", tempRoot);
  fs.writeFileSync(path.join(tempRoot, "AGENTS.md"), "Use the first workspace.\n");
  fs.writeFileSync(
    path.join(tempRoot, ".openez", "workspace.json"),
    JSON.stringify({
      workspaceId: first.id,
      rootPath: tempRoot,
      name: first.name,
      updatedAt: "2026-09-14T00:00:00.000Z",
    }),
  );
  const nestedPath = path.join(tempRoot, "src", "nested");
  fs.mkdirSync(nestedPath, { recursive: true });
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-context-second-"));
  try {
    const second = await createIndexedWorkspace("context-second", secondRoot);
    const { client, server } = await connectClient(nestedPath);
    try {
      const defaultBody = toolJson(
        await client.callTool({ name: "workspace_context", arguments: {} }),
      ) as {
        workspaces: Array<{ workspaceId: string }>;
        metrics: { tokenBudget: number };
      };
      expect(defaultBody.workspaces.map((item) => item.workspaceId)).toEqual([first.id]);
      expect(defaultBody.metrics.tokenBudget).toBe(800);

      const multiBody = toolJson(
        await client.callTool({
          name: "workspace_context",
          arguments: { workspaceIds: [first.id, second.id], maxTokens: 2_000 },
        }),
      ) as { workspaces: Array<{ workspaceId: string }> };
      expect(multiBody.workspaces.map((item) => item.workspaceId)).toEqual([first.id, second.id]);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    closeAllWorkspaceDbs();
    fs.rmSync(secondRoot, { recursive: true, force: true });
  }
});

it("keeps successful workspace context when a sibling snapshot fails", async () => {
  const good = await createIndexedWorkspace("context-good", tempRoot);
  const brokenRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-context-broken-"));
  const broken = await createRegistryRepository().createWorkspace({
    id: "context-broken",
    name: "context-broken",
    rootPath: brokenRoot,
  });
  closeAllWorkspaceDbs();
  fs.rmSync(brokenRoot, { recursive: true, force: true });
  fs.writeFileSync(brokenRoot, "not a directory\n");
  try {
    const { client, server } = await connectClient(tempRoot);
    try {
      const body = toolJson(
        await client.callTool({
          name: "workspace_context",
          arguments: { workspaceIds: [good.id, broken.id], maxTokens: 2_000 },
        }),
      ) as { workspaces: Array<{ workspaceId: string; context?: unknown; error?: string }> };
      expect(body.workspaces.find((item) => item.workspaceId === good.id)?.context).toBeTruthy();
      expect(body.workspaces.find((item) => item.workspaceId === broken.id)?.error).toBeTruthy();
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    fs.rmSync(brokenRoot, { force: true });
  }
});

it("fits workspace_context to maxTokens before dropping core identity", async () => {
  await createIndexedWorkspace("context-budget", tempRoot);
  fs.writeFileSync(path.join(tempRoot, "AGENTS.md"), "Primary instruction.\n");
  fs.writeFileSync(path.join(tempRoot, "CLAUDE.md"), "Secondary instruction. ".repeat(200));
  const repo = createWorkspaceRepository(tempRoot);
  await repo.insertMemory({
    title: "Decision",
    content: "Keep SQLite local-first.",
    source: "agent",
  });

  const { client, server } = await connectClient(tempRoot);
  try {
    const text = textResult(
      await client.callTool({
        name: "workspace_context",
        arguments: { maxTokens: 300 },
      }),
    );
    const body = JSON.parse(text) as {
      workspaces: Array<{
        workspaceId: string;
        context?: { instructions: Array<{ path: string }>; memories: unknown[]; activity: unknown };
      }>;
      metrics: { tokenBudget: number; responseTokens: number; truncated: boolean };
    };

    expect(countTokens(text)).toBeLessThanOrEqual(300);
    expect(body.metrics).toMatchObject({
      tokenBudget: 300,
      responseTokens: countTokens(text),
      truncated: true,
    });
    expect(body.workspaces[0]?.workspaceId).toBe("context-budget");
    expect(body.workspaces[0]?.context?.instructions.map((item) => item.path)).toEqual([
      "AGENTS.md",
    ]);
    expect(body.workspaces[0]?.context?.memories).toHaveLength(1);
    expect(body.workspaces[0]?.context?.activity).toBeTruthy();
  } finally {
    await client.close();
    await server.close();
  }
});
```

- [ ] **Step 2: Run the MCP tests to verify they fail**

Run:

```bash
pnpm exec vitest run tests/mcp-tools.test.ts
```

Expected: FAIL because `workspace_context` is not advertised or handled.

- [ ] **Step 3: Add the schema, full workspace type, and tool declaration**

In `apps/mcp/src/mcp-core.ts`, update the two existing imports to:

```ts
import {
  analyzeDiffContext,
  codeContext,
  codeQuery,
  countTokens,
  graphNeighbors,
  isValidGitRef,
  memoryRecall,
  memoryWrite,
  truncateToTokenLimit,
  workspaceContext,
} from "@openez-graph/core";
import {
  createRegistryRepository,
  createWorkspaceRepository,
  findLocalWorkspaceConfig,
  removeWorkspace,
  type RegistryWorkspace,
} from "@openez-graph/db";
```

Replace the local reduced workspace type:

```ts
type WorkspaceLike = RegistryWorkspace;
```

Add the input schema near other read schemas:

```ts
const workspaceContextSchema = z.object({
  workspaceIds: z.array(z.string()).optional(),
  workspaceId: z.string().optional(),
  paths: z.array(z.string()).optional(),
  path: z.string().optional(),
  maxTokens: z.number().int().min(128).max(100_000).optional(),
});
```

Add this `ListTools` entry after `list_workspaces`:

```ts
{
  name: "workspace_context",
  description:
    "Load deterministic workspace instructions, Git activity, index state, and active memories at session start. Supports one or many workspaces.",
  inputSchema: {
    type: "object",
    properties: {
      workspaceIds: { type: "array", items: { type: "string" } },
      workspaceId: { type: "string" },
      paths: { type: "array", items: { type: "string" } },
      path: { type: "string" },
      maxTokens: {
        type: "integer",
        minimum: 128,
        maximum: 100_000,
        description: "Maximum tokens for the complete serialized response",
      },
    },
    required: [],
  },
},
```

- [ ] **Step 4: Extend token fitting with workspace-context reduction priority**

Inside `fitToTokenBudget()`, after setting `metrics.truncated = true` and before
the existing generic array/string loop, detect context entries and reduce only
their optional payloads in approved order:

```ts
const contextEntries = Array.isArray(value.workspaces)
  ? value.workspaces.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const context = (entry as { context?: unknown }).context;
      return context && typeof context === "object" ? [context as Record<string, unknown>] : [];
    })
  : [];

if (contextEntries.length > 0) {
  const overBudget = () => serializedTokens() > maxTokens;

  while (overBudget()) {
    const context = contextEntries.find(
      (entry) => Array.isArray(entry.instructions) && entry.instructions.length > 1,
    );
    if (!context) break;
    (context.instructions as unknown[]).pop();
  }

  while (overBudget()) {
    const instruction = contextEntries
      .flatMap((entry) => (Array.isArray(entry.instructions) ? entry.instructions : []))
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .filter((item) => typeof item.content === "string" && item.content.length > 0)
      .sort((left, right) => String(right.content).length - String(left.content).length)[0];
    if (!instruction) break;
    const content = String(instruction.content);
    const overflow = serializedTokens() - maxTokens;
    instruction.content = truncateToTokenLimit(
      content,
      Math.max(0, countTokens(content) - overflow - 8),
    );
    if (instruction.content === content) break;
  }

  for (const key of ["memories", "changedFiles"] as const) {
    while (overBudget()) {
      const arrays = contextEntries.flatMap((entry) => {
        const target =
          key === "changedFiles"
            ? (entry.activity as Record<string, unknown> | undefined)?.changedFiles
            : entry.memories;
        return Array.isArray(target) && target.length > 0 ? [target] : [];
      });
      if (arrays.length === 0) break;
      arrays
        .sort(
          (left, right) =>
            JSON.stringify(right[right.length - 1]).length -
            JSON.stringify(left[left.length - 1]).length,
        )[0]!
        .pop();
    }
  }

  updateMetrics();
  if (!overBudget()) return value;
}
```

At the start of the existing `visit()` object branch, before iterating
`Object.entries(current)`, protect a retained success entry and its context from
generic truncation. The generic loop may still drop trailing top-level
workspace entries before the existing last-resort fallback:

```ts
if (
  contextEntries.length > 0 &&
  (contextEntries.includes(current as Record<string, unknown>) ||
    Object.prototype.hasOwnProperty.call(current, "context"))
) {
  return;
}
```

If dedicated compaction still cannot fit, execution continues to the existing
`workspaces` last-resort fallback at lines 375-419. That fallback retains the
first workspace identity or error and metrics.

- [ ] **Step 5: Add the MCP handler with per-workspace failure isolation**

Add this switch case after `list_workspaces`:

```ts
case "workspace_context": {
  const input = workspaceContextSchema.parse(request.params.arguments ?? {});
  const workspaces = await resolver.resolveReadWorkspaces(input);
  const settled = await Promise.allSettled(workspaces.map((workspace) => workspaceContext(workspace)));
  const entries = settled.map((result, index) => {
    const workspace = workspaces[index]!;
    const identity = {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      rootPath: workspace.rootPath,
    };
    return result.status === "fulfilled"
      ? { ...identity, context: result.value }
      : {
          ...identity,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        };
  });
  return jsonResponse({ workspaces: entries }, input.maxTokens ?? 800);
}
```

- [ ] **Step 6: Run focused MCP tests**

Run:

```bash
pnpm exec vitest run tests/mcp-tools.test.ts
```

Expected: all MCP tests pass, including existing `memory_recall`, `code_query`,
`code_context`, and `diff_context` contracts.

- [ ] **Step 7: Run MCP and core typechecks**

Run:

```bash
pnpm --filter @openez-graph/core typecheck
pnpm --filter @openez-graph/mcp typecheck
```

Expected: both commands exit `0` with the new exported types and handler.

- [ ] **Step 8: Commit the MCP slice**

```bash
git add apps/mcp/src/mcp-core.ts tests/mcp-tools.test.ts
git commit -m "feat(mcp): add workspace context bootstrap"
```

---

### Task 4: Document the Session-Start Workflow and Run Release Gates

**Files:**

- Modify: `README.md:45-59`
- Modify: `apps/cli/README.md:102-116`
- Modify: `AGENTS.md:104-110,122-136`

**Interfaces:**

- Consumes: the public `workspace_context` contract from Task 3.
- Produces: consistent agent guidance and user-facing tool inventories; no runtime API.

- [ ] **Step 1: Update the root and CLI README tool tables**

Insert this row after `list_workspaces` in both tool tables:

```md
| `workspace_context` | Load token-budgeted instructions, Git activity, index state, and active memories at session start |
```

Keep the existing statement that read tools support one or many workspaces.

- [ ] **Step 2: Update AGENTS session-start and MCP expectations**

Replace the session-start memory rule with:

```md
- **ALWAYS** use `workspace_context` at the start of a session to load workspace instructions, Git activity, index state, and active memories.
- Use `memory_recall` for query-specific follow-up on previously stored architectural decisions and agent notes.
```

Add `workspace_context` to the configured-tool sentence under Setup. Update the
multi-workspace expectation to:

```md
- `workspace_context`, `code_query`, `code_context`, `graph_neighbors`, and `memory_recall` should support one or many workspaces
```

- [ ] **Step 3: Run formatting and focused verification**

Run:

```bash
pnpm format:check
pnpm exec vitest run tests/workspace-db.test.ts tests/workspace-context.test.ts tests/mcp-tools.test.ts
pnpm typecheck
```

Expected: formatting is clean, all focused tests pass, and every package typechecks.

- [ ] **Step 4: Run the full regression suite**

Run:

```bash
pnpm test
```

Expected: the full repository test suite exits `0` with no regression in indexing, retrieval, graph, diff, memory, CLI, or web behavior.

- [ ] **Step 5: Verify the final diff and commit documentation**

Run:

```bash
git diff --check
git status --short
```

Expected before commit: only `README.md`, `apps/cli/README.md`, and `AGENTS.md`
remain uncommitted from this task.

```bash
git add README.md apps/cli/README.md AGENTS.md
git commit -m "docs: add workspace context workflow"
```

Expected after commit: `git status --short` prints nothing.
