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
