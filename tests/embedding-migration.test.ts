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

  test("migrates TEXT embedding column to BLOB", () => {
    // Initialize full schema (creates BLOB embeddings by default)
    const db = createNativeDatabase(dbPath);
    initializeWorkspaceSchema(db);

    // Simulate an old DB by dropping the BLOB embeddings table and recreating
    // it with a TEXT embedding column (the pre-migration schema).
    db.exec("DROP TABLE embeddings");
    db.exec(`CREATE TABLE embeddings (
      id TEXT PRIMARY KEY,
      chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      embedding TEXT NOT NULL,
      input_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);

    // Insert old-style JSON embedding
    db.prepare(
      "INSERT INTO embeddings (id, chunk_id, provider, model, dimensions, embedding) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("emb-1", "chunk-1", "ollama", "bge-m3", 3, "[0.1, 0.2, 0.3]");

    // Run migration (initializeWorkspaceSchema calls migrateEmbeddingToBlob)
    initializeWorkspaceSchema(db);

    // Verify column is now BLOB
    const info = db.prepare("PRAGMA table_info(embeddings)").all() as Array<{
      name: string;
      type: string;
    }>;
    const embCol = info.find((c) => c.name === "embedding");
    expect(embCol!.type.toUpperCase()).toBe("BLOB");

    // Verify old data was dropped (migration drops all TEXT embeddings)
    const count = db.prepare("SELECT count(*) as c FROM embeddings").get() as { c: number };
    expect(count.c).toBe(0);
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
