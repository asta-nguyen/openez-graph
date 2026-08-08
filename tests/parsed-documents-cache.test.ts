import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { closeAllWorkspaceDbs, createWorkspaceRepository } from "../packages/db/src/sqlite";

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
      parserVersion: "ts-morph-v1",
    });

    const cached = repo.getParsedDocument(docId);
    expect(cached).not.toBeNull();
    expect(cached!.contentHash).toBe("hash-v1");
    expect(cached!.symbols).not.toBeNull();
    expect(JSON.parse(cached!.symbols!)).toEqual([
      { name: "foo", symbolType: "function", type: "function", exported: true },
    ]);
    expect(cached!.parserVersion).toBe("ts-morph-v1");
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
      parserVersion: "ts-morph-v1",
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
      parserVersion: "ts-morph-v1",
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
      parserVersion: "ts-morph-v1",
    });

    expect(repo.getParsedDocument(docId)).not.toBeNull();
    await repo.deleteDocument(docId);
    expect(repo.getParsedDocument(docId)).toBeNull();
  });
});
