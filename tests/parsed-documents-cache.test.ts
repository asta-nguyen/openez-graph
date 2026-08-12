import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  closeAllWorkspaceDbs,
  closeRegistryDb,
  createRegistryRepository,
  createWorkspaceRepository,
} from "../packages/db/src/sqlite";
import {
  buildGraphGeneration,
  indexWorkspace,
  resetNativeParserCache,
  resolveNativeParser,
} from "../packages/indexer/src/index-workspace";

describe("parsed_documents cache", () => {
  let tmpDir: string;
  let repo: ReturnType<typeof createWorkspaceRepository>;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openez-cache-test-"));
    repo = createWorkspaceRepository(tmpDir);
    // Insert a document to have a valid document_id
    await repo.insertDocument({
      path: "src/foo.ts",
      absolutePath: path.join(tmpDir, "src/foo.ts"),
      kind: "code",
      language: "typescript",
      contentHash: "hash-v1",
      sizeBytes: 100,
      mtimeMs: Date.now(),
    });
  });

  afterEach(() => {
    closeAllWorkspaceDbs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("insert and get parsed document", async () => {
    const docs = await repo.listDocuments();
    const docId = docs[0].id;

    repo.insertParsedDocument({
      documentId: docId,
      contentHash: "hash-v1",
      symbols: JSON.stringify([
        { name: "foo", symbolType: "function", type: "function", exported: true },
      ]),
      imports: JSON.stringify(["./bar"]),
      calls: JSON.stringify([{ callerName: "foo", calleeName: "bar" }]),
      calledIdentifiers: JSON.stringify(["bar"]),
      parserVersion: "oxc-v2",
    });

    const cached = repo.getParsedDocument(docId);
    expect(cached).not.toBeNull();
    expect(cached!.contentHash).toBe("hash-v1");
    expect(cached!.symbols).not.toBeNull();
    expect(JSON.parse(cached!.symbols!)).toEqual([
      { name: "foo", symbolType: "function", type: "function", exported: true },
    ]);
    expect(cached!.parserVersion).toBe("oxc-v2");
    expect(cached!.calledIdentifiers).not.toBeNull();
  });

  test("getParsedDocument returns null for missing document", () => {
    const cached = repo.getParsedDocument("nonexistent-id");
    expect(cached).toBeNull();
  });

  test("insertParsedDocument is idempotent (REPLACE)", async () => {
    const docs = await repo.listDocuments();
    const docId = docs[0].id;

    repo.insertParsedDocument({
      documentId: docId,
      contentHash: "hash-v1",
      symbols: "[]",
      imports: "[]",
      calls: "[]",
      calledIdentifiers: "[]",
      parserVersion: "oxc-v2",
    });

    // Insert again with different data
    repo.insertParsedDocument({
      documentId: docId,
      contentHash: "hash-v2",
      symbols: JSON.stringify([
        { name: "bar", symbolType: "class", type: "class", exported: false },
      ]),
      imports: "[]",
      calls: "[]",
      calledIdentifiers: "[]",
      parserVersion: "oxc-v2",
    });

    const cached = repo.getParsedDocument(docId);
    expect(cached!.contentHash).toBe("hash-v2");
    expect(JSON.parse(cached!.symbols!)).toEqual([
      { name: "bar", symbolType: "class", type: "class", exported: false },
    ]);
  });

  test("CASCADE delete when document is deleted", async () => {
    const docs = await repo.listDocuments();
    const docId = docs[0].id;

    repo.insertParsedDocument({
      documentId: docId,
      contentHash: "hash-v1",
      symbols: "[]",
      imports: "[]",
      calls: "[]",
      calledIdentifiers: "[]",
      parserVersion: "oxc-v2",
    });

    expect(repo.getParsedDocument(docId)).not.toBeNull();
    await repo.deleteDocument(docId);
    expect(repo.getParsedDocument(docId)).toBeNull();
  });
});

describe("parsed_documents fallback cache (native parser unavailable)", () => {
  let registryRoot: string;
  let workspaceRoot: string;

  beforeEach(() => {
    registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-fallback-cache-reg-"));
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-fallback-cache-ws-"));
    process.env.AI_MEMORY_REGISTRY_DB_PATH = path.join(registryRoot, "registry.sqlite");
    process.env.EMBEDDING_PROVIDER = "none";
    closeRegistryDb();
    closeAllWorkspaceDbs();
    // Clear the memoized native-parser capability so the test observes the
    // current environment.
    resetNativeParserCache();
  });

  afterEach(() => {
    closeAllWorkspaceDbs();
    closeRegistryDb();
    fs.rmSync(registryRoot, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    delete process.env.AI_MEMORY_REGISTRY_DB_PATH;
    delete process.env.EMBEDDING_PROVIDER;
    resetNativeParserCache();
  });

  test("second graph build reuses fallback-v1 cache and performs zero fallback parses", async () => {
    // Only assert fallback-v1 behavior when the native extension is unavailable.
    resetNativeParserCache();
    if (resolveNativeParser()) return;

    fs.mkdirSync(path.join(workspaceRoot, "src"), { recursive: true });
    const pyPath = path.join(workspaceRoot, "src", "app.py");
    fs.writeFileSync(pyPath, "def add(a, b):\n    return a + b\n");

    const workspace = await createRegistryRepository().ensureWorkspace({ rootPath: workspaceRoot });
    await indexWorkspace({ workspaceId: workspace.id });

    const repo = createWorkspaceRepository(workspaceRoot);
    const doc = await repo.getDocumentByPath("src/app.py");
    expect(doc).not.toBeNull();

    // Overwrite the cached parse result with a fallback-v1 tag, simulating a
    // prior build that parsed via the fallback parser (the version
    // buildGraphGeneration expects when native is unavailable).
    repo.insertParsedDocument({
      documentId: doc!.id,
      contentHash: doc!.contentHash,
      symbols: JSON.stringify([
        { name: "add", symbolType: "function", type: "function", exported: true },
      ]),
      imports: "[]",
      calls: "[]",
      calledIdentifiers: "[]",
      parserVersion: "fallback-v1",
    });

    const cachedBefore = repo.getParsedDocument(doc!.id);
    expect(cachedBefore?.parserVersion).toBe("fallback-v1");
    const parsedAtFirst = cachedBefore!.parsedAt;
    const symbolsBefore = cachedBefore!.symbols;

    // First graph build: cache hit (fallback-v1 matches expected version) —
    // no re-parse, so parsed_at must not advance.
    await buildGraphGeneration(workspace.id, workspaceRoot, 1, 1);
    const cachedAfterFirst = repo.getParsedDocument(doc!.id);
    expect(cachedAfterFirst?.parserVersion).toBe("fallback-v1");
    expect(cachedAfterFirst!.parsedAt).toBe(parsedAtFirst);
    expect(cachedAfterFirst!.symbols).toBe(symbolsBefore);

    // Second graph build: still a cache hit — zero fallback parses.
    await buildGraphGeneration(workspace.id, workspaceRoot, 2, 2);
    const cachedAfterSecond = repo.getParsedDocument(doc!.id);
    expect(cachedAfterSecond?.parserVersion).toBe("fallback-v1");
    expect(cachedAfterSecond!.parsedAt).toBe(parsedAtFirst);
    expect(cachedAfterSecond!.symbols).toBe(symbolsBefore);
  });
});
