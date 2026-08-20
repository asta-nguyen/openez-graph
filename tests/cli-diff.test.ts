import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  closeAllWorkspaceDbs,
  closeRegistryDb,
  createRegistryRepository,
} from "../packages/db/src/sqlite";
import { indexWorkspace } from "../packages/indexer/src";

describe("CLI diff", () => {
  let tempRoot: string;
  let workspaceRoot: string;
  const originalRegistryDbPath = process.env.AI_MEMORY_REGISTRY_DB_PATH;

  beforeEach(() => {
    closeRegistryDb();
    closeAllWorkspaceDbs();
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-cli-diff-"));
    process.env.AI_MEMORY_REGISTRY_DB_PATH = path.join(tempRoot, "registry.sqlite");
    workspaceRoot = path.join(tempRoot, "workspace");
    fs.mkdirSync(path.join(workspaceRoot, "src"), { recursive: true });
    execSync("git init", { cwd: workspaceRoot, stdio: "ignore" });
    execSync("git config user.name 'Tester'", { cwd: workspaceRoot, stdio: "ignore" });
    execSync("git config user.email 'tester@example.com'", { cwd: workspaceRoot, stdio: "ignore" });
  });

  afterEach(() => {
    closeAllWorkspaceDbs();
    closeRegistryDb();
    if (originalRegistryDbPath === undefined) delete process.env.AI_MEMORY_REGISTRY_DB_PATH;
    else process.env.AI_MEMORY_REGISTRY_DB_PATH = originalRegistryDbPath;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test("indexes changes and builds caller context before analyzing the diff", async () => {
    fs.writeFileSync(
      path.join(workspaceRoot, "src", "target.ts"),
      "export function target(value: string) { return value.toUpperCase(); }\n",
    );
    fs.writeFileSync(
      path.join(workspaceRoot, "src", "caller.ts"),
      "import { target } from './target';\nexport function caller() { return target('hello'); }\n",
    );
    execSync("git add . && git commit -m initial", { cwd: workspaceRoot, stdio: "ignore" });

    const workspace = await createRegistryRepository().ensureWorkspace({ rootPath: workspaceRoot });
    await indexWorkspace({ workspaceId: workspace.id, mode: "full" });

    fs.writeFileSync(
      path.join(workspaceRoot, "src", "target.ts"),
      "export function target(value: string) { return value.trim().toUpperCase(); }\n",
    );

    closeAllWorkspaceDbs();
    closeRegistryDb();
    const output = execFileSync(
      process.execPath,
      [path.resolve(import.meta.dir, "../apps/cli/src/cli.ts"), "diff", "--json"],
      { cwd: workspaceRoot, encoding: "utf8", env: process.env },
    );

    expect((JSON.parse(output) as { formattedSummary: string }).formattedSummary).toContain(
      "caller",
    );
  });
});
