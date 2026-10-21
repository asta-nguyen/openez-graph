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
import { rmTempDir } from "./helpers/temp-cleanup";
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
    rmTempDir(tmpDir);
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
    rmTempDir(registryRoot);
    rmTempDir(workspaceRoot);
    delete process.env.AI_MEMORY_REGISTRY_DB_PATH;
    delete process.env.EMBEDDING_PROVIDER;
    resetNativeParserCache();
  });

  test("second graph build reuses fallback-v5 cache and performs zero fallback parses", async () => {
    // Only assert fallback-v5 behavior when the native extension is unavailable.
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

    // Overwrite the cached parse result with a fallback-v5 tag, simulating a
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
      parserVersion: "fallback-v5",
    });

    const cachedBefore = repo.getParsedDocument(doc!.id);
    expect(cachedBefore?.parserVersion).toBe("fallback-v5");
    const parsedAtFirst = cachedBefore!.parsedAt;
    const symbolsBefore = cachedBefore!.symbols;

    // First graph build: cache hit (fallback-v5 matches expected version) —
    // no re-parse, so parsed_at must not advance.
    await buildGraphGeneration(workspace.id, workspaceRoot, 1, 1);
    const cachedAfterFirst = repo.getParsedDocument(doc!.id);
    expect(cachedAfterFirst?.parserVersion).toBe("fallback-v5");
    expect(cachedAfterFirst!.parsedAt).toBe(parsedAtFirst);
    expect(cachedAfterFirst!.symbols).toBe(symbolsBefore);

    // Second graph build: still a cache hit — zero fallback parses.
    await buildGraphGeneration(workspace.id, workspaceRoot, 2, 2);
    const cachedAfterSecond = repo.getParsedDocument(doc!.id);
    expect(cachedAfterSecond?.parserVersion).toBe("fallback-v5");
    expect(cachedAfterSecond!.parsedAt).toBe(parsedAtFirst);
    expect(cachedAfterSecond!.symbols).toBe(symbolsBefore);
  });
});

describe("parsed_documents module-binding payload", () => {
  let registryRoot: string;
  let workspaceRoot: string;

  beforeEach(() => {
    registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-bindings-reg-"));
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-bindings-ws-"));
    process.env.AI_MEMORY_REGISTRY_DB_PATH = path.join(registryRoot, "registry.sqlite");
    process.env.EMBEDDING_PROVIDER = "none";
    closeRegistryDb();
    closeAllWorkspaceDbs();
    resetNativeParserCache();
  });

  afterEach(() => {
    closeAllWorkspaceDbs();
    closeRegistryDb();
    rmTempDir(registryRoot);
    rmTempDir(workspaceRoot);
    delete process.env.AI_MEMORY_REGISTRY_DB_PATH;
    delete process.env.EMBEDDING_PROVIDER;
    resetNativeParserCache();
  });

  test("oxc-v5 rows carry module bindings and stale oxc-v2 rows reparse", async () => {
    fs.writeFileSync(path.join(workspaceRoot, "dep.js"), "export function depFn() { return 1; }\n");
    fs.writeFileSync(
      path.join(workspaceRoot, "main.js"),
      [
        'import { depFn } from "./dep.js";',
        "export function run() { depFn(); }",
        'export function local() { const { depFn: localDep } = require("./dep.js"); localDep(); }',
      ].join("\n"),
    );

    const workspace = await createRegistryRepository().ensureWorkspace({
      rootPath: workspaceRoot,
    });
    await indexWorkspace({ workspaceId: workspace.id });

    const repo = createWorkspaceRepository(workspaceRoot);
    const doc = await repo.getDocumentByPath("main.js");
    expect(doc).not.toBeNull();

    const cached = repo.getParsedDocument(doc!.id);
    expect(cached?.parserVersion).toBe("oxc-v5");
    const payload = JSON.parse(cached!.imports!);
    expect(Array.isArray(payload)).toBe(false);
    expect(payload.paths).toEqual(["./dep.js"]);
    expect(payload.importBindings).toContainEqual({
      local: "depFn",
      module: "./dep.js",
      imported: "depFn",
    });
    // Function-local require bindings keep their scope range through the
    // cache round-trip.
    expect(payload.importBindings).toContainEqual({
      local: "localDep",
      module: "./dep.js",
      imported: "depFn",
      scopeStart: expect.any(Number),
      scopeEnd: expect.any(Number),
    });
    // Call records keep their byte offset.
    const calls = JSON.parse(cached!.calls!);
    expect(calls).toContainEqual({
      callerName: "local",
      calleeName: "localDep",
      start: expect.any(Number),
    });

    // Simulate a stale pre-change row: old version must reparse under the
    // bumped parser version during graph construction.
    repo.insertParsedDocument({
      documentId: doc!.id,
      contentHash: doc!.contentHash,
      symbols: "[]",
      imports: "[]",
      calls: "[]",
      calledIdentifiers: "[]",
      parserVersion: "oxc-v2",
    });
    expect(repo.getParsedDocument(doc!.id)?.parserVersion).toBe("oxc-v2");

    await buildGraphGeneration(workspace.id, workspaceRoot, 1, 1);
    const reparsed = repo.getParsedDocument(doc!.id);
    expect(reparsed?.parserVersion).toBe("oxc-v5");
    expect(JSON.parse(reparsed!.imports!).importBindings).toContainEqual({
      local: "depFn",
      module: "./dep.js",
      imported: "depFn",
    });
  });
});

describe("Rust shadowedLocal marker round-trip", () => {
  let registryRoot: string;
  let workspaceRoot: string;

  const RUST_SRC = [
    "fn helper() {}",
    "fn caller() {",
    "    let helper = || ();",
    "    helper();",
    "}",
    "fn other() { helper(); }",
    "",
  ].join("\n");

  async function indexRustWorkspace() {
    fs.mkdirSync(path.join(workspaceRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, "src", "main.rs"), RUST_SRC);
    const workspace = await createRegistryRepository().ensureWorkspace({
      rootPath: workspaceRoot,
    });
    await indexWorkspace({ workspaceId: workspace.id });
    return { workspace, repo: createWorkspaceRepository(workspaceRoot) };
  }

  beforeEach(() => {
    registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-rust-marker-reg-"));
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-rust-marker-ws-"));
    process.env.AI_MEMORY_REGISTRY_DB_PATH = path.join(registryRoot, "registry.sqlite");
    process.env.EMBEDDING_PROVIDER = "none";
    closeRegistryDb();
    closeAllWorkspaceDbs();
    resetNativeParserCache();
  });

  afterEach(() => {
    closeAllWorkspaceDbs();
    closeRegistryDb();
    rmTempDir(registryRoot);
    rmTempDir(workspaceRoot);
    delete process.env.AI_MEMORY_REGISTRY_DB_PATH;
    delete process.env.EMBEDDING_PROVIDER;
    delete process.env.OPENEZ_NATIVE;
    resetNativeParserCache();
  });

  test("native rows store the marker, cache hits keep it, stale rows reparse", async () => {
    resetNativeParserCache();
    if (!resolveNativeParser()) return; // native extension unavailable

    const { workspace, repo } = await indexRustWorkspace();
    const doc = await repo.getDocumentByPath("src/main.rs");
    expect(doc).not.toBeNull();

    const cached = repo.getParsedDocument(doc!.id);
    expect(cached?.parserVersion).toBe("native-v5");
    const calls = JSON.parse(cached!.calls!);
    expect(calls).toContainEqual({
      callerName: "caller",
      calleeName: "helper",
      shadowedLocal: true,
    });
    expect(calls).toContainEqual({
      callerName: "other",
      calleeName: "helper",
    });

    // Cache hit: a graph build must not reparse, and the shadowed call
    // produces no edge while the unshadowed one does.
    const parsedAt = cached!.parsedAt;
    await buildGraphGeneration(workspace.id, workspaceRoot, 1, 1);
    const afterFirst = repo.getParsedDocument(doc!.id);
    expect(afterFirst!.parsedAt).toBe(parsedAt);
    expect(JSON.parse(afterFirst!.calls!)).toEqual(calls);

    const edges = await repo.queryRaw(
      `SELECT sf.label AS caller, st.label AS callee
         FROM graph_edges e
         JOIN graph_nodes sf ON sf.id = e.from_node_id
         JOIN graph_nodes st ON st.id = e.to_node_id
        WHERE e.type = 'calls'`,
    );
    expect(edges).toContainEqual({ caller: "other", callee: "helper" });
    expect(edges).not.toContainEqual({ caller: "caller", callee: "helper" });

    // A prior-version row must reparse under the bumped parser tag.
    repo.insertParsedDocument({
      documentId: doc!.id,
      contentHash: doc!.contentHash,
      symbols: "[]",
      imports: "[]",
      calls: "[]",
      calledIdentifiers: "[]",
      parserVersion: "native-v4",
    });
    await buildGraphGeneration(workspace.id, workspaceRoot, 2, 2);
    const reparsed = repo.getParsedDocument(doc!.id);
    expect(reparsed?.parserVersion).toBe("native-v5");
    expect(JSON.parse(reparsed!.calls!)).toContainEqual({
      callerName: "caller",
      calleeName: "helper",
      shadowedLocal: true,
    });
  });

  test("fallback rows store the marker under fallback-v5", async () => {
    process.env.OPENEZ_NATIVE = "0";
    resetNativeParserCache();

    const { repo } = await indexRustWorkspace();
    const doc = await repo.getDocumentByPath("src/main.rs");
    expect(doc).not.toBeNull();

    const cached = repo.getParsedDocument(doc!.id);
    expect(cached?.parserVersion).toBe("fallback-v5");
    expect(JSON.parse(cached!.calls!)).toContainEqual({
      callerName: "caller",
      calleeName: "helper",
      shadowedLocal: true,
    });
  });
});
