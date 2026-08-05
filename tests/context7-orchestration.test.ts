import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeRegistryDb, createRegistryRepository } from "../packages/db/src/sqlite";
import {
  Context7DisabledError,
  libraryDocs,
  type DocsCache,
  type Context7Client,
  type ResolvedLibrary,
  type FetchedDocs,
} from "../packages/core/src/external-docs";

let registryRoot: string;

beforeEach(() => {
  registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-context7-orch-"));
  process.env.AI_MEMORY_REGISTRY_DB_PATH = path.join(registryRoot, "registry.sqlite");
  closeRegistryDb();
});

afterEach(() => {
  closeRegistryDb();
  fs.rmSync(registryRoot, { recursive: true, force: true });
  delete process.env.AI_MEMORY_REGISTRY_DB_PATH;
});

function makeMockCache(overrides: Partial<DocsCache> = {}): DocsCache {
  return {
    async getDocs() {
      return null;
    },
    async findAnyByQuery() {
      return null;
    },
    async storeDocs() {},
    async recordNameMapping() {},
    async isNegativeCached() {
      return false;
    },
    ...overrides,
  };
}

function makeMockClient(overrides: Partial<Context7Client> = {}): Context7Client {
  return {
    async ensureStarted() {},
    async resolveLibraryId(): Promise<ResolvedLibrary | null> {
      return { id: "/facebook/react", name: "react" };
    },
    async getLibraryDocs(): Promise<FetchedDocs | null> {
      return { content: "# React\n\nDocs content here." };
    },
    async stop() {},
    ...overrides,
  } as unknown as Context7Client;
}

async function enableContext7() {
  const registry = createRegistryRepository();
  await registry.setSetting("context7.enabled", "true");
  await registry.setSetting("context7.cache_ttl_days", "7");
}

describe("libraryDocs", () => {
  it("throws Context7DisabledError when not enabled", async () => {
    await expect(
      libraryDocs({ library: "react", cache: makeMockCache(), client: makeMockClient() }),
    ).rejects.toThrow(Context7DisabledError);
  });

  it("fetches from Context7 on cache miss and stores result", async () => {
    await enableContext7();
    let stored = false;
    let mapped = false;
    const cache = makeMockCache({
      async storeDocs() {
        stored = true;
      },
      async recordNameMapping() {
        mapped = true;
      },
    });
    const client = makeMockClient();

    const result = await libraryDocs({ library: "react", cache, client });
    expect(result.source).toBe("context7");
    expect(result.content).toContain("React");
    expect(stored).toBe(true);
    expect(mapped).toBe(true);
  });

  it("returns from cache on hit without calling Context7", async () => {
    await enableContext7();
    let resolveCalled = false;
    const cache = makeMockCache({
      async findAnyByQuery() {
        return {
          content: "cached content",
          tokens: 5,
          stale: false,
          fetchedAt: Date.now() - 1000,
        };
      },
    });
    const client = makeMockClient({
      async resolveLibraryId() {
        resolveCalled = true;
        return null;
      },
    });

    const result = await libraryDocs({ library: "react", cache, client });
    expect(result.source).toBe("cache");
    expect(result.content).toBe("cached content");
    expect(resolveCalled).toBe(false);
  });

  it("returns empty result with hint when library not found", async () => {
    await enableContext7();
    const cache = makeMockCache();
    const client = makeMockClient({
      async resolveLibraryId() {
        return null;
      },
    });

    const result = await libraryDocs({ library: "nonexistent-lib", cache, client });
    expect(result.source).toBe("empty");
    expect(result.hint).toContain("No library found");
  });

  it("caches negative resolution and skips Context7 on subsequent calls", async () => {
    await enableContext7();
    let resolveCalled = 0;
    let negativeMapped = false;
    const cache = makeMockCache({
      async isNegativeCached() {
        return true;
      },
      async recordNameMapping() {
        negativeMapped = true;
      },
    });
    const client = makeMockClient({
      async resolveLibraryId() {
        resolveCalled++;
        return null;
      },
    });

    const result = await libraryDocs({ library: "bad-lib", cache, client });
    expect(result.source).toBe("empty");
    expect(result.hint).toContain("(cached)");
    expect(resolveCalled).toBe(0); // Context7 was never contacted
  });

  it("stores negative cache entry when library is not found", async () => {
    await enableContext7();
    let mappedName: string | null = null;
    let mappedId: string | null = null;
    const cache = makeMockCache({
      async recordNameMapping(queryName, libraryId) {
        mappedName = queryName;
        mappedId = libraryId;
      },
    });
    const client = makeMockClient({
      async resolveLibraryId() {
        return null;
      },
    });

    const result = await libraryDocs({ library: "no-such-lib", cache, client });
    expect(result.source).toBe("empty");
    expect(mappedName).toBe("no-such-lib");
    expect(mappedId).toBe(""); // sentinel for negative cache
  });

  it("falls back to stale cache on fetch error", async () => {
    await enableContext7();
    const cache = makeMockCache({
      async getDocs() {
        return {
          content: "stale content",
          tokens: 3,
          stale: true,
          fetchedAt: Date.now() - 10 * 86_400_000,
        };
      },
    });
    const client = makeMockClient({
      async getLibraryDocs() {
        throw new Error("network failure");
      },
    });

    const result = await libraryDocs({ library: "react", cache, client });
    expect(result.source).toBe("cache-stale");
    expect(result.content).toBe("stale content");
    expect(result.warning).toContain("Context7 fetch failed");
  });

  it("respects noCache flag and always fetches from Context7", async () => {
    await enableContext7();
    let cacheHit = false;
    const cache = makeMockCache({
      async findAnyByQuery() {
        cacheHit = true;
        return null;
      },
      async getDocs() {
        cacheHit = true;
        return null;
      },
    });
    const client = makeMockClient();

    const result = await libraryDocs({ library: "react", cache, client, noCache: true });
    expect(result.source).toBe("context7");
    expect(cacheHit).toBe(false);
  });

  it("truncates content to maxTokens", async () => {
    await enableContext7();
    const longContent = "word ".repeat(5000);
    const cache = makeMockCache();
    const client = makeMockClient({
      async getLibraryDocs() {
        return { content: longContent };
      },
    });

    const result = await libraryDocs({
      library: "react",
      cache,
      client,
      maxTokens: 100,
    });
    expect(result.tokensReturned).toBeLessThanOrEqual(100);
  });
});
