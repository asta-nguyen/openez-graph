import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createRegistryRepository, createWorkspaceRepository } from "../packages/db/src/sqlite";
import { indexWorkspace } from "../packages/indexer/src";

describe("symbol_definition MCP & DB functionality", () => {
  let tmpDir: string;
  let workspaceRoot: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openez-symbol-test-"));
    workspaceRoot = path.join(tmpDir, "sample-project");
    fs.mkdirSync(workspaceRoot, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("resolves exact function definitions with line ranges and export status", async () => {
    const srcDir = path.join(workspaceRoot, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const tsFile = path.join(srcDir, "token.ts");

    fs.writeFileSync(
      tsFile,
      `export function generateToken(userId: string): string {
  return "token-" + userId;
}

export function verifyToken(token: string): boolean {
  return token.startsWith("token-");
}
`,
    );

    const registry = createRegistryRepository();
    const ws = await registry.ensureWorkspace({ rootPath: workspaceRoot, name: "symbol-sample" });
    await indexWorkspace({ workspaceId: ws.id, rootPath: workspaceRoot, mode: "full" });

    const repo = createWorkspaceRepository(workspaceRoot);
    const matches = await repo.getSymbolDefinitions("generateToken");

    expect(matches.length).toBe(1);
    expect(matches[0].name).toBe("generateToken");
    expect(matches[0].filePath).toBe("src/token.ts");
    expect(matches[0].startLine).toBe(1);
    expect(matches[0].exported).toBe(true);
  });

  test("returns empty array for non-existent symbol", async () => {
    const registry = createRegistryRepository();
    const ws = await registry.ensureWorkspace({ rootPath: workspaceRoot, name: "symbol-empty" });
    await indexWorkspace({ workspaceId: ws.id, rootPath: workspaceRoot, mode: "full" });

    const repo = createWorkspaceRepository(workspaceRoot);
    const matches = await repo.getSymbolDefinitions("nonExistentFunction");
    expect(matches).toEqual([]);
  });
});
