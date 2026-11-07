import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { autoIndexAndSync } from "../apps/mcp/src/mcp-core";
import {
  closeAllWorkspaceDbs,
  closeRegistryDb,
  createRegistryRepository,
} from "../packages/db/src/sqlite/index";

// MCP startup registers its cwd, and hosts launch it from anywhere ("/", ~/.codex, $HOME, temp
// dirs). Only a cwd inside a git repository is auto-registered, as the repo root.

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openez-autoreg-"));
  process.env.AI_MEMORY_REGISTRY_DB_PATH = path.join(tempDir, "registry.sqlite");
  closeRegistryDb();
});

afterEach(() => {
  closeAllWorkspaceDbs();
  closeRegistryDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.AI_MEMORY_REGISTRY_DB_PATH;
});

function makeDir(...parts: string[]) {
  const dir = path.join(tempDir, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const registered = async () =>
  (await createRegistryRepository().listWorkspaces()).map((w) => w.rootPath);

describe("MCP autoIndexAndSync registration", () => {
  it("registers nothing for a cwd outside any git repository", async () => {
    const cwd = makeDir("plain");
    await autoIndexAndSync(cwd);
    expect(await registered()).toEqual([]);
    expect(fs.existsSync(path.join(cwd, ".openez"))).toBe(false);
  });

  it("registers and indexes a git repo root", async () => {
    const repo = makeDir("repo");
    fs.mkdirSync(path.join(repo, ".git"));
    await autoIndexAndSync(repo);
    const [workspace] = await createRegistryRepository().listWorkspaces();
    expect(workspace.rootPath).toBe(fs.realpathSync.native(repo));
    expect(workspace.lastIndexedAt).toBeTruthy();
  });

  it("registers the repo root, not a subdirectory cwd", async () => {
    const repo = makeDir("repo");
    fs.mkdirSync(path.join(repo, ".git"));
    const sub = makeDir("repo", "apps", "cli");
    await autoIndexAndSync(sub);
    expect(await registered()).toEqual([fs.realpathSync.native(repo)]);
  });

  it("treats a .git file (linked worktree) as a repo root", async () => {
    const worktree = makeDir("wt");
    fs.writeFileSync(path.join(worktree, ".git"), "gitdir: /elsewhere/.git/worktrees/wt\n");
    await autoIndexAndSync(worktree);
    expect(await registered()).toEqual([fs.realpathSync.native(worktree)]);
  });

  it("does not auto-register a repo rooted at the home directory", async () => {
    const home = makeDir("home");
    fs.mkdirSync(path.join(home, ".git"));
    const cwd = makeDir("home", ".codex");
    // Bun fixes os.homedir() at process start, so run the startup code in a child with HOME set.
    const core = path.resolve(import.meta.dir, "../apps/mcp/src/mcp-core");
    const script = `import { autoIndexAndSync } from ${JSON.stringify(core)}; await autoIndexAndSync(${JSON.stringify(cwd)});`;
    const child = Bun.spawnSync([process.execPath, "-e", script], {
      env: { ...process.env, HOME: home },
    });
    expect(child.exitCode).toBe(0);
    expect(await registered()).toEqual([]);
  });

  it("still indexes a non-git directory that was registered explicitly", async () => {
    const cwd = makeDir("explicit");
    await createRegistryRepository().ensureWorkspace({ rootPath: cwd });
    await autoIndexAndSync(cwd);
    const [workspace] = await createRegistryRepository().listWorkspaces();
    expect(workspace.lastIndexedAt).toBeTruthy();
  });
});
