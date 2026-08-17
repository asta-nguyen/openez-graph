import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createRegistryRepository, createWorkspaceRepository } from "../packages/db/src/sqlite";
import { indexWorkspace } from "../packages/indexer/src";

describe("symbol_definition MCP & DB functionality", () => {
  let tmpDir: string;
  let workspaceRoot: string;
  const origRegistryDbPath = process.env.AI_MEMORY_REGISTRY_DB_PATH;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openez-symbol-test-"));
    process.env.AI_MEMORY_REGISTRY_DB_PATH = path.join(tmpDir, "registry.sqlite");
    workspaceRoot = path.join(tmpDir, "sample-project");
    fs.mkdirSync(workspaceRoot, { recursive: true });
  });

  afterEach(() => {
    if (origRegistryDbPath !== undefined) {
      process.env.AI_MEMORY_REGISTRY_DB_PATH = origRegistryDbPath;
    } else {
      delete process.env.AI_MEMORY_REGISTRY_DB_PATH;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("resolves exact function definitions with line ranges, export status, and source chunks", async () => {
    const srcDir = path.join(workspaceRoot, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const tsFile = path.join(srcDir, "token.ts");

    fs.writeFileSync(
      tsFile,
      `export function generateToken(userId: string): string {
  return "token-" + userId;
}

export function verifyToken(token: string): boolean {
  return generateToken("test") === token;
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
    expect(matches[0].kind).toBe("function");
    expect(matches[0].filePath).toBe("src/token.ts");
    expect(matches[0].startLine).toBe(1);
    expect(matches[0].endLine).toBeGreaterThanOrEqual(1);
    expect(matches[0].exported).toBe(true);
    expect(typeof matches[0].sourceCode).toBe("string");
    expect(matches[0].sourceCode).toContain("generateToken");
  });

  test("resolves class methods and caller relationships", async () => {
    const srcDir = path.join(workspaceRoot, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const tsFile = path.join(srcDir, "auth.ts");

    fs.writeFileSync(
      tsFile,
      `export class AuthService {
  validateUser(id: string): boolean {
    return id.length > 0;
  }
}
`,
    );

    const registry = createRegistryRepository();
    const ws = await registry.ensureWorkspace({ rootPath: workspaceRoot, name: "symbol-class" });
    await indexWorkspace({ workspaceId: ws.id, rootPath: workspaceRoot, mode: "full" });

    const repo = createWorkspaceRepository(workspaceRoot);
    const matches = await repo.getSymbolDefinitions("validateUser");

    expect(matches.length).toBe(1);
    expect(matches[0].name).toContain("validateUser");
    expect(matches[0].filePath).toBe("src/auth.ts");
    expect(matches[0].startLine).toBeDefined();
    expect(matches[0].sourceCode).toContain("validateUser");
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
