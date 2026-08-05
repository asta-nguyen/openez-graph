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

import { createDocsCache } from "../packages/core/src/external-docs/docs-cache";

describe("docs-cache", () => {
  it("returns null on cache miss", async () => {
    const cache = createDocsCache();
    const result = await cache.getDocs({
      libraryId: "/facebook/react",
      version: "latest",
      topic: undefined,
      now: Date.now(),
    });
    expect(result).toBeNull();
  });

  it("stores and retrieves docs on cache hit", async () => {
    const cache = createDocsCache();
    const now = Date.now();
    await cache.storeDocs({
      libraryId: "/facebook/react",
      libraryName: "react",
      version: "latest",
      topic: undefined,
      content: "# React Docs\nUseful content.",
      tokens: 10,
      ttlMs: 7 * 86_400_000,
    });

    const result = await cache.getDocs({
      libraryId: "/facebook/react",
      version: "latest",
      topic: undefined,
      now,
    });
    expect(result).not.toBeNull();
    expect(result!.content).toBe("# React Docs\nUseful content.");
    expect(result!.tokens).toBe(10);
    expect(result!.stale).toBe(false);
  });

  it("returns stale=true when TTL has expired", async () => {
    const cache = createDocsCache();
    const pastTime = Date.now() - 10 * 86_400_000; // 10 days ago

    // Store with a short TTL that already expired
    await cache.storeDocs({
      libraryId: "/vercel/next.js",
      libraryName: "next.js",
      version: "latest",
      topic: "routing",
      content: "old docs",
      tokens: 5,
      ttlMs: 86_400_000, // 1 day TTL
    });

    // Manually backdate the row to simulate old fetch
    const db = getRegistryDb();
    const native = (
      db as unknown as { $client: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }
    ).$client;
    native
      .prepare("UPDATE library_docs_cache SET fetched_at = ?, expires_at = ? WHERE library_id = ?")
      .run(pastTime, pastTime + 86_400_000, "/vercel/next.js");

    const result = await cache.getDocs({
      libraryId: "/vercel/next.js",
      version: "latest",
      topic: "routing",
      now: Date.now(),
    });
    expect(result).not.toBeNull();
    expect(result!.stale).toBe(true);
  });

  it("upserts on store when (libraryId, version, topic) already exists", async () => {
    const cache = createDocsCache();
    await cache.storeDocs({
      libraryId: "/facebook/react",
      libraryName: "react",
      version: "latest",
      topic: undefined,
      content: "v1 content",
      tokens: 5,
      ttlMs: 7 * 86_400_000,
    });
    await cache.storeDocs({
      libraryId: "/facebook/react",
      libraryName: "react",
      version: "latest",
      topic: undefined,
      content: "v2 content",
      tokens: 8,
      ttlMs: 7 * 86_400_000,
    });

    const result = await cache.getDocs({
      libraryId: "/facebook/react",
      version: "latest",
      topic: undefined,
      now: Date.now(),
    });
    expect(result!.content).toBe("v2 content");
    expect(result!.tokens).toBe(8);
  });

  it("findAnyByQuery uses name mapping to find cached docs", async () => {
    const cache = createDocsCache();
    await cache.storeDocs({
      libraryId: "/facebook/react",
      libraryName: "react",
      version: "latest",
      topic: undefined,
      content: "react docs",
      tokens: 5,
      ttlMs: 7 * 86_400_000,
    });
    await cache.recordNameMapping("react", "/facebook/react");

    const result = await cache.findAnyByQuery({
      query: "react",
      topic: undefined,
      version: "latest",
    });
    expect(result).not.toBeNull();
    expect(result!.content).toBe("react docs");
  });

  it("findAnyByQuery returns null when no name mapping exists", async () => {
    const cache = createDocsCache();
    const result = await cache.findAnyByQuery({
      query: "unknown-lib",
      topic: undefined,
      version: "latest",
    });
    expect(result).toBeNull();
  });

  it("handles NULL topic correctly in getDocs", async () => {
    const cache = createDocsCache();
    await cache.storeDocs({
      libraryId: "/test/lib",
      libraryName: "test",
      version: "latest",
      topic: undefined,
      content: "no topic",
      tokens: 3,
      ttlMs: 7 * 86_400_000,
    });

    const result = await cache.getDocs({
      libraryId: "/test/lib",
      version: "latest",
      topic: undefined,
      now: Date.now(),
    });
    expect(result).not.toBeNull();
    expect(result!.content).toBe("no topic");
  });
});
