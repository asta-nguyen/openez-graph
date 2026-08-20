import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createMcpServer } from "../apps/mcp/src/mcp-core";
import { createRegistryRepository, createWorkspaceRepository } from "../packages/db/src/sqlite";
import { buildGraphGeneration, indexWorkspace } from "../packages/indexer/src";

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

  test("resolves exact function definitions with line ranges, export status, source chunks, and caller counts", async () => {
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
    await buildGraphGeneration(ws.id, workspaceRoot, 1, 1);

    const repo = createWorkspaceRepository(workspaceRoot);
    const matches = await repo.getSymbolDefinitions("generateToken");

    expect(matches.length).toBe(1);
    expect(matches[0].name).toBe("generateToken");
    expect(matches[0].kind).toBe("function");
    expect(matches[0].filePath).toBe("src/token.ts");
    expect(matches[0].startLine).toBe(1);
    expect(matches[0].endLine).toBeGreaterThanOrEqual(3);
    expect(matches[0].exported).toBe(true);
    expect(typeof matches[0].sourceCode).toBe("string");
    expect(matches[0].sourceCode).toContain("generateToken");
    expect(matches[0].callerCount).toBe(1);
    expect(matches[0].calleeCount).toBe(0);

    const verifyMatches = await repo.getSymbolDefinitions("verifyToken");
    expect(verifyMatches.length).toBe(1);
    expect(verifyMatches[0].callerCount).toBe(0);
    expect(verifyMatches[0].calleeCount).toBe(1);
  });

  test("resolves class methods with caller relationships across files", async () => {
    const srcDir = path.join(workspaceRoot, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const authFile = path.join(srcDir, "auth.ts");
    const appFile = path.join(srcDir, "app.ts");

    fs.writeFileSync(
      authFile,
      `export class AuthService {
  validateUser(id: string): boolean {
    return id.length > 0;
  }
}
`,
    );

    fs.writeFileSync(
      appFile,
      `import { AuthService } from "./auth";
export function login(id: string): boolean {
  const auth = new AuthService();
  return auth.validateUser(id);
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
    expect(matches[0].startLine).toBeGreaterThan(0);
    expect(matches[0].endLine).toBeGreaterThanOrEqual(matches[0].startLine!);
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

  test("executes symbol_definition via MCP server handler with name alias and token limits", async () => {
    const srcDir = path.join(workspaceRoot, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, "math.ts"),
      `export function add(a: number, b: number): number { return a + b; }\n`,
    );

    const registry = createRegistryRepository();
    const ws = await registry.ensureWorkspace({ rootPath: workspaceRoot, name: "symbol-mcp" });
    await indexWorkspace({ workspaceId: ws.id, rootPath: workspaceRoot, mode: "full" });

    const server = createMcpServer({ defaultPath: workspaceRoot });
    // Call tool via internal handler
    const response = await (server as any)._requestHandlers.get("tools/call")({
      method: "tools/call",
      params: {
        name: "symbol_definition",
        arguments: {
          name: "add",
          workspaceId: ws.id,
          maxTokens: 500,
        },
      },
    });

    expect(response.content).toBeDefined();
    expect(response.content[0].type).toBe("text");
    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.symbol).toBe("add");
    expect(parsed.matchCount).toBe(1);
    expect(parsed.matches[0].filePath).toBe("src/math.ts");
  });
});
