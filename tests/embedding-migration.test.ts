import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createNativeDatabase } from "../packages/db/src/sqlite/database-loader";
import { initializeWorkspaceSchema } from "../packages/db/src/sqlite/workspace-db";

describe("migrateEmbeddingToBlob", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openez-migration-test-"));
    dbPath = path.join(tmpDir, "test.db");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("preserves legacy TEXT embeddings and marks format for FTS-only fallback", () => {
    const db = createNativeDatabase(dbPath);
    initializeWorkspaceSchema(db);
    db.exec("DROP TABLE embeddings");
    db.exec(`CREATE TABLE embeddings (
      id TEXT PRIMARY KEY,
      chunk_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      embedding TEXT NOT NULL,
      input_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.prepare(
      "INSERT INTO embeddings (id, chunk_id, provider, model, dimensions, embedding) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("emb-1", "chunk-1", "ollama", "bge-m3", 3, "[0.1, 0.2, 0.3]");
    db.prepare(
      "INSERT INTO embeddings (id, chunk_id, provider, model, dimensions, embedding) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("emb-2", "chunk-1", "ollama", "bge-m3", 3, "[0.4, 0.5, 0.6]");

    // Opening the DB must NOT drop the table — legacy data is preserved.
    expect(() => initializeWorkspaceSchema(db)).not.toThrow();

    // Data is still there
    const count = db.prepare("SELECT count(*) as c FROM embeddings").get() as { c: number };
    expect(count.c).toBe(2);

    // Column is still TEXT (not auto-migrated)
    const info = db.prepare("PRAGMA table_info(embeddings)").all() as Array<{
      name: string;
      type: string;
    }>;
    const embCol = info.find((c) => c.name === "embedding");
    expect(embCol!.type.toUpperCase()).toBe("TEXT");

    // Legacy format marker is set so retrieval can skip vector search
    const meta = db.prepare("SELECT value FROM index_meta WHERE key = 'embedding_format'").get() as
      | { value: string }
      | undefined;
    expect(meta?.value).toBe("text");

    // Re-opening should not re-log or change anything
    initializeWorkspaceSchema(db);
    db.close();
  });

  test("resetIndexArtifacts recreates embeddings table as BLOB (reindex path)", () => {
    // Use a separate temp dir as workspace root (not the .db file path)
    const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-reset-test-"));
    const { createWorkspaceRepository } = require("../packages/db/src/sqlite/repository");
    const repo = createWorkspaceRepository(wsRoot);

    // Simulate legacy TEXT embeddings by dropping and recreating with TEXT
    const { createNativeDatabase } = require("../packages/db/src/sqlite/database-loader");
    const { initializeWorkspaceSchema } = require("../packages/db/src/sqlite/workspace-db");
    // Get the actual workspace DB path
    const wsDbPath = path.join(wsRoot, ".openez", "index.sqlite");
    const db = createNativeDatabase(wsDbPath);
    db.exec("DROP TABLE embeddings");
    db.exec(`CREATE TABLE embeddings (
      id TEXT PRIMARY KEY,
      chunk_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      embedding TEXT NOT NULL,
      input_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.prepare(
      "INSERT INTO embeddings (id, chunk_id, provider, model, dimensions, embedding) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("emb-1", "chunk-1", "ollama", "bge-m3", 3, "[0.1, 0.2, 0.3]");
    db.close();

    // reindex path: resetIndexArtifacts recreates the table as BLOB
    repo.setMeta("graph_build_epoch", "42");
    repo.resetIndexArtifacts();

    // Re-open to verify
    const db2 = createNativeDatabase(wsDbPath);
    const info = db2.prepare("PRAGMA table_info(embeddings)").all() as Array<{
      name: string;
      type: string;
    }>;
    const embCol = info.find((c) => c.name === "embedding");
    expect(embCol!.type.toUpperCase()).toBe("BLOB");

    // Legacy marker is cleared
    const meta = db2
      .prepare("SELECT value FROM index_meta WHERE key = 'embedding_format'")
      .get() as { value: string } | null;
    expect(meta).toBeNull();
    const graphEpoch = db2
      .prepare("SELECT value FROM index_meta WHERE key = 'graph_build_epoch'")
      .get() as { value: string } | null;
    expect(graphEpoch).toBeNull();

    // Old data is gone (table was recreated)
    const count = db2.prepare("SELECT count(*) as c FROM embeddings").get() as { c: number };
    expect(count.c).toBe(0);
    db2.close();
    fs.rmSync(wsRoot, { recursive: true, force: true });
  });

  test("does not re-migrate if already BLOB", () => {
    // Create DB with new BLOB schema (initializeWorkspaceSchema creates BLOB)
    const db = createNativeDatabase(dbPath);
    initializeWorkspaceSchema(db);

    // Insert BLOB embedding (foreign keys are off when using createNativeDatabase
    // directly, so a non-existent chunk_id is acceptable for this migration test)
    const blob = new Uint8Array(new Float32Array([0.1, 0.2, 0.3]).buffer);
    db.prepare(
      "INSERT INTO embeddings (id, chunk_id, provider, model, dimensions, embedding) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("emb-1", "chunk-1", "ollama", "bge-m3", 3, blob);

    // Run migration again (should be a no-op for BLOB columns)
    initializeWorkspaceSchema(db);

    // Verify data is preserved
    const count = db.prepare("SELECT count(*) as c FROM embeddings").get() as { c: number };
    expect(count.c).toBe(1);
  });
});
