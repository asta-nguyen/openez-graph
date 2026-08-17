import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  closeRegistryDb,
  createRegistryRepository,
  createWorkspaceRepository,
} from "../packages/db/src/sqlite";
import { indexWorkspace } from "../packages/indexer/src";

describe("code_outline MCP & DB functionality", () => {
  let tmpDir: string;
  let workspaceRoot: string;
  const origRegistryDbPath = process.env.AI_MEMORY_REGISTRY_DB_PATH;

  beforeEach(() => {
    closeRegistryDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openez-outline-test-"));
    process.env.AI_MEMORY_REGISTRY_DB_PATH = path.join(tmpDir, "registry.sqlite");
    workspaceRoot = path.join(tmpDir, "sample-project");
    fs.mkdirSync(workspaceRoot, { recursive: true });
  });

  afterEach(() => {
    closeRegistryDb();
    if (origRegistryDbPath !== undefined) {
      process.env.AI_MEMORY_REGISTRY_DB_PATH = origRegistryDbPath;
    } else {
      delete process.env.AI_MEMORY_REGISTRY_DB_PATH;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("extracts TypeScript functions, classes, and exported symbols outline", async () => {
    const srcDir = path.join(workspaceRoot, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const tsFile = path.join(srcDir, "auth.ts");

    fs.writeFileSync(
      tsFile,
      `export interface AuthUser {
  id: string;
  email: string;
}

export class AuthService {
  async authenticate(token: string): Promise<boolean> {
    return token.length > 0;
  }

  private hashSecret(secret: string): string {
    return secret;
  }
}

export function verifySession(sessionId: string): boolean {
  return true;
}
`,
    );

    const registry = createRegistryRepository();
    const ws = await registry.ensureWorkspace({ rootPath: workspaceRoot, name: "outline-sample" });
    await indexWorkspace({ workspaceId: ws.id, rootPath: workspaceRoot, mode: "full" });

    const repo = createWorkspaceRepository(workspaceRoot);
    const outline = await repo.getFileOutline("src/auth.ts");

    expect(outline).not.toBeNull();
    expect(outline?.path).toBe("src/auth.ts");
    expect(outline?.language).toBe("typescript");
    expect(outline?.symbols.length).toBeGreaterThanOrEqual(2);

    const names = outline!.symbols.map((s) => s.name);
    expect(names).toContain("AuthService");
    expect(names).toContain("verifySession");
    expect(outline!.outlineText).toContain("AuthService");
    expect(outline!.outlineText).toContain("verifySession");
  });

  test("generates fallback section outline for Markdown files", async () => {
    const mdFile = path.join(workspaceRoot, "README.md");
    fs.writeFileSync(
      mdFile,
      `# Project Title

Introductory text here.

## Installation

Run pnpm install.

## Usage Guide

Example code here.
`,
    );

    const registry = createRegistryRepository();
    const ws = await registry.ensureWorkspace({ rootPath: workspaceRoot, name: "outline-md" });
    await indexWorkspace({ workspaceId: ws.id, rootPath: workspaceRoot, mode: "full" });

    const repo = createWorkspaceRepository(workspaceRoot);
    const outline = await repo.getFileOutline("README.md");

    expect(outline).not.toBeNull();
    expect(outline?.path).toBe("README.md");
    expect(outline?.symbols.length).toBeGreaterThan(0);
    expect(outline?.outlineText).toContain("README.md");
  });

  test("resolves outline when given leading dot-slash or absolute file path", async () => {
    const srcDir = path.join(workspaceRoot, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const tsFile = path.join(srcDir, "service.ts");
    fs.writeFileSync(tsFile, "export function executeService() { return true; }\n");

    const registry = createRegistryRepository();
    const ws = await registry.ensureWorkspace({ rootPath: workspaceRoot, name: "outline-paths" });
    await indexWorkspace({ workspaceId: ws.id, rootPath: workspaceRoot, mode: "full" });

    const repo = createWorkspaceRepository(workspaceRoot);
    const outlineDotSlash = await repo.getFileOutline("./src/service.ts");
    expect(outlineDotSlash).not.toBeNull();
    expect(outlineDotSlash?.symbols[0]?.name).toBe("executeService");

    const outlineAbsolute = await repo.getFileOutline(tsFile);
    expect(outlineAbsolute).not.toBeNull();
    expect(outlineAbsolute?.symbols[0]?.name).toBe("executeService");
  });

  test("returns null when file does not exist", async () => {
    const registry = createRegistryRepository();
    const ws = await registry.ensureWorkspace({
      rootPath: workspaceRoot,
      name: "outline-nonexistent",
    });
    await indexWorkspace({ workspaceId: ws.id, rootPath: workspaceRoot, mode: "full" });

    const repo = createWorkspaceRepository(workspaceRoot);
    const outline = await repo.getFileOutline("src/non-existent.ts");
    expect(outline).toBeNull();
  });

  test("disambiguates duplicate file basenames across directories", async () => {
    const pkgA = path.join(workspaceRoot, "packages/a");
    const pkgB = path.join(workspaceRoot, "packages/b");
    fs.mkdirSync(pkgA, { recursive: true });
    fs.mkdirSync(pkgB, { recursive: true });

    fs.writeFileSync(path.join(pkgA, "utils.ts"), "export function funcA() { return 'a'; }\n");
    fs.writeFileSync(path.join(pkgB, "utils.ts"), "export function funcB() { return 'b'; }\n");

    const registry = createRegistryRepository();
    const ws = await registry.ensureWorkspace({ rootPath: workspaceRoot, name: "outline-dups" });
    await indexWorkspace({ workspaceId: ws.id, rootPath: workspaceRoot, mode: "full" });

    const repo = createWorkspaceRepository(workspaceRoot);
    const outlineA = await repo.getFileOutline("packages/a/utils.ts");
    const outlineB = await repo.getFileOutline("packages/b/utils.ts");

    expect(outlineA?.path).toBe("packages/a/utils.ts");
    expect(outlineA?.symbols[0]?.name).toBe("funcA");

    expect(outlineB?.path).toBe("packages/b/utils.ts");
    expect(outlineB?.symbols[0]?.name).toBe("funcB");
  });

  test("handles Windows backslashes and prevents LIKE wildcard mismatches", async () => {
    const srcDir = path.join(workspaceRoot, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const tsFile = path.join(srcDir, "math.ts");
    fs.writeFileSync(tsFile, "export function add(a: number, b: number) { return a + b; }\n");

    const registry = createRegistryRepository();
    const ws = await registry.ensureWorkspace({ rootPath: workspaceRoot, name: "outline-win" });
    await indexWorkspace({ workspaceId: ws.id, rootPath: workspaceRoot, mode: "full" });

    const repo = createWorkspaceRepository(workspaceRoot);

    // Windows backslash path
    const outlineWin = await repo.getFileOutline("src\\math.ts");
    expect(outlineWin).not.toBeNull();
    expect(outlineWin?.symbols[0]?.name).toBe("add");

    // Suffix match with backslash
    const outlineWinSuffix = await repo.getFileOutline("math.ts");
    expect(outlineWinSuffix).not.toBeNull();
    expect(outlineWinSuffix?.symbols[0]?.name).toBe("add");

    // Wildcard query should not match nonexistent file
    const outlineWildcard = await repo.getFileOutline("m_th.ts");
    expect(outlineWildcard).toBeNull();
  });
});
