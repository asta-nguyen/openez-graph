import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeRegistryDb, getRegistryDb } from "../packages/db/src/sqlite";
import { createNativeDatabase } from "../packages/db/src/sqlite/database-loader";

let registryRoot: string;

beforeEach(() => {
  registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-context7-schema-"));
  process.env.AI_MEMORY_REGISTRY_DB_PATH = path.join(registryRoot, "registry.sqlite");
  closeRegistryDb();
});

afterEach(() => {
  closeRegistryDb();
  fs.rmSync(registryRoot, { recursive: true, force: true });
  delete process.env.AI_MEMORY_REGISTRY_DB_PATH;
});

describe("library_docs schema", () => {
  it("creates library_docs_cache and library_docs_name_map tables", () => {
    // Trigger schema initialization by calling getRegistryDb
    getRegistryDb();

    const dbPath = process.env.AI_MEMORY_REGISTRY_DB_PATH!;
    const sqlite = createNativeDatabase(dbPath);

    const cacheTables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='library_docs_cache'")
      .get() as { name: string } | undefined;
    expect(cacheTables?.name).toBe("library_docs_cache");

    const mapTables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='library_docs_name_map'")
      .get() as { name: string } | undefined;
    expect(mapTables?.name).toBe("library_docs_name_map");

    const indexes = sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_library_docs_%'",
      )
      .all() as Array<{ name: string }>;
    expect(indexes.map((r) => r.name).sort()).toEqual([
      "idx_library_docs_expires",
      "idx_library_docs_lookup",
    ]);
  });
});
