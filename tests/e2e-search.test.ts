import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createRegistryRepository, createWorkspaceRepository, closeAllWorkspaceDbs, closeRegistryDb } from "../packages/db/src/sqlite/index";
import { memoryQuery } from "../packages/core/src/retrieval";

let tempRoot: string;
let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openez-e2e-"));
  process.env.AI_MEMORY_REGISTRY_DB_PATH = path.join(tempDir, "registry.sqlite");
  closeRegistryDb();
  closeAllWorkspaceDbs();

  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-e2e-ws-"));
  fs.mkdirSync(path.join(tempRoot, "src"), { recursive: true });
});

afterEach(() => {
  closeAllWorkspaceDbs();
  closeRegistryDb();
  fs.rmSync(tempRoot, { recursive: true, force: true });
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.AI_MEMORY_REGISTRY_DB_PATH;
});

async function setupWorkspaceWithContent() {
  const registry = createRegistryRepository();
  const workspace = await registry.createWorkspace({
    id: "test-e2e",
    name: "test-e2e",
    rootPath: tempRoot,
  });

  fs.writeFileSync(
    path.join(tempRoot, "src", "auth.ts"),
    `export function authenticate(user: string, password: string): boolean {
  // Check credentials against the database
  return user === "admin" && password === "secret";
}

export function logout(token: string): void {
  // Invalidate the session token
  console.log("User logged out");
}
`
  );

  fs.writeFileSync(
    path.join(tempRoot, "README.md"),
    `# Authentication Module

This module handles user authentication and session management.

## Login Flow

The login flow uses the authenticate function to verify credentials.
`
  );

  const repo = createWorkspaceRepository(tempRoot);

  // Insert documents and chunks manually
  const authDocId = await repo.insertDocument({
    path: "src/auth.ts",
    absolutePath: path.join(tempRoot, "src/auth.ts"),
    kind: "code",
    language: "typescript",
    contentHash: "h1",
    sizeBytes: 200,
    mtimeMs: Date.now(),
  });

  await repo.insertChunks([
    {
      documentId: authDocId,
      chunkIndex: 0,
      heading: null,
      content: "export function authenticate(user: string, password: string): boolean { return user === 'admin'; }",
      tokenCount: 20,
      contentHash: "c1",
      metadata: JSON.stringify({ kind: "code", startLine: 1, endLine: 3 }),
    },
    {
      documentId: authDocId,
      chunkIndex: 1,
      heading: null,
      content: "export function logout(token: string): void { console.log('User logged out'); }",
      tokenCount: 15,
      contentHash: "c2",
      metadata: JSON.stringify({ kind: "code", startLine: 5, endLine: 8 }),
    },
  ]);

  const readmeDocId = await repo.insertDocument({
    path: "README.md",
    absolutePath: path.join(tempRoot, "README.md"),
    kind: "markdown",
    language: "markdown",
    contentHash: "h2",
    sizeBytes: 150,
    mtimeMs: Date.now(),
  });

  await repo.insertChunks([
    {
      documentId: readmeDocId,
      chunkIndex: 0,
      heading: "Authentication Module",
      content: "This module handles user authentication and session management.",
      tokenCount: 12,
      contentHash: "c3",
      metadata: JSON.stringify({ kind: "markdown", startLine: 1, endLine: 3 }),
    },
  ]);

  await registry.updateWorkspace("test-e2e", {
    status: "indexed",
    indexingStatus: "completed",
    documentCount: 2,
    chunkCount: 3,
  });

  return workspace;
}

describe("end-to-end search pipeline", () => {
  it("FTS5 finds chunks by keyword", async () => {
    await setupWorkspaceWithContent();
    const repo = createWorkspaceRepository(tempRoot);

    const results = await repo.fullTextSearch("authenticate", 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.content.includes("authenticate"))).toBe(true);
    // Scores should be meaningful (not all 0.1)
    expect(results[0]?.score).not.toBe(0.1);
  });

  it("FTS5 ranks relevant results higher", async () => {
    await setupWorkspaceWithContent();
    const repo = createWorkspaceRepository(tempRoot);

    const results = await repo.fullTextSearch("authentication", 10);
    expect(results.length).toBeGreaterThan(0);
    // The README chunk about "authentication" should rank well
    const readmeResult = results.find((r) => r.path === "README.md");
    expect(readmeResult).toBeDefined();
  });

  it("FTS5 handles multi-word queries", async () => {
    await setupWorkspaceWithContent();
    const repo = createWorkspaceRepository(tempRoot);

    const results = await repo.fullTextSearch("user login", 10);
    expect(results.length).toBeGreaterThan(0);
  });

  it("memoryQuery returns ranked results with sources", async () => {
    await setupWorkspaceWithContent();

    const result = await memoryQuery({
      workspaceId: "test-e2e",
      query: "authenticate user",
      limit: 5,
    });

    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.answerContext).toContain("authenticate");
    // Sources should have path and score
    expect(result.sources[0]?.path).toBeTruthy();
    expect(result.sources[0]?.score).toBeGreaterThan(0);
  });

  it("memoryQuery returns empty for no matches", async () => {
    await setupWorkspaceWithContent();

    const result = await memoryQuery({
      workspaceId: "test-e2e",
      query: "zzznomatchxyz",
      limit: 5,
    });

    expect(result.sources).toHaveLength(0);
    expect(result.answerContext).toBe("");
  });
});
