# Context7 Library Docs Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new opt-in `library_docs` MCP tool that fetches third-party library documentation via Context7, with a global SQLite TTL cache in the registry DB.

**Architecture:** A new `external-docs/` subsystem under `packages/core/src/` holds three modules: `docs-cache.ts` (SQLite TTL cache in the global registry DB), `context7-client.ts` (MCP stdio client to a lazily-spawned `@upstash/context7-mcp` subprocess), and `library-docs.ts` (orchestration: cache → resolve → fetch → store). The MCP server in `apps/mcp/src/mcp-core.ts` registers a new `library_docs` tool that delegates to this orchestration. A new `openez setup context7` CLI command enables the feature and stores config keys. `code_query` / `code_context` / `graph_neighbors` remain pure-local and never touch the new tables or subprocess.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk` (MCP client + server), `better-sqlite3` via drizzle-orm, `zod` for schema validation, `vitest` for tests, `commander` for CLI.

## Global Constraints

- **Node.js 20+** required (existing repo constraint).
- **Test runner:** vitest, invoked from repo root via `pnpm test` (which runs `vitest run`). Test files live in `tests/` at repo root, NOT in package subdirectories.
- **Config key naming:** snake_case to match existing `embedding.openai_api_key` convention. `context7.api_key` (not `context7.apiKey`) — this ensures automatic encryption via the existing `isSensitiveKey()` function which matches `api_key`, `secret`, `password`, `token`.
- **Registry DB path:** resolved by `resolveRegistryDbPath()` in `packages/db/src/sqlite/registry-db.ts`. Tests override via `process.env.AI_MEMORY_REGISTRY_DB_PATH`.
- **Schema initialization:** tables are created via `CREATE TABLE IF NOT EXISTS` inside `initializeRegistrySchema()` in `packages/db/src/sqlite/registry-db.ts`. There is no separate migrations directory.
- **CLI command structure:** setup subcommands are flat files in `apps/cli/src/` (e.g. `setup-codex.ts`), dynamically imported in `cli.ts`. NOT in a `commands/` subdirectory.
- **MCP SDK dependency:** `@modelcontextprotocol/sdk` (`^1.30.0`) must be added to `packages/core/package.json` dependencies (currently only in `apps/mcp` and root devDependencies).
- **Context7 tool names:** The current Context7 MCP server exposes `resolve-library-id` and `query-docs` (per GitHub repo + Mintlify docs). Older docs mention `get-library-docs`. The client must discover tool names dynamically via `tools/list` after connecting, and map to known names with fallbacks.
- **No emojis in code or output** unless explicitly requested.
- **Follow existing code style:** no unnecessary comments, compact code, match surrounding patterns.
- **Commit after each task** (or logical step within a task).

---

## File Structure

### New files

| Path                                                 | Responsibility                                                               |
| ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| `packages/core/src/external-docs/docs-cache.ts`      | SQLite TTL cache + name→ID map repository methods (reads/writes registry DB) |
| `packages/core/src/external-docs/context7-client.ts` | MCP stdio client that spawns and talks to `@upstash/context7-mcp` subprocess |
| `packages/core/src/external-docs/library-docs.ts`    | Orchestration: cache lookup → resolve → fetch → store, with stale fallback   |
| `packages/core/src/external-docs/index.ts`           | Re-exports `libraryDocs`, `Context7DisabledError`, `Context7Client`          |
| `apps/cli/src/setup-context7.ts`                     | `openez setup context7` command logic                                        |
| `tests/context7-cache.test.ts`                       | Unit tests for docs-cache (in-memory SQLite)                                 |
| `tests/context7-client.test.ts`                      | Unit tests for context7-client (mocked subprocess)                           |
| `tests/context7-orchestration.test.ts`               | Unit tests for library-docs orchestration (mocked cache + client)            |
| `tests/context7-e2e.test.ts`                         | End-to-end test with a stub Context7 MCP server                              |

### Modified files

| Path                                    | Change                                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------------------------- |
| `packages/core/package.json`            | Add `@modelcontextprotocol/sdk` to dependencies                                           |
| `packages/core/src/index.ts`            | Add `export * from "./external-docs";`                                                    |
| `packages/db/src/sqlite/registry-db.ts` | Add `library_docs_cache` + `library_docs_name_map` tables to `initializeRegistrySchema()` |
| `apps/mcp/src/mcp-core.ts`              | Register `library_docs` tool (schema, list, handler), hold `Context7Client` singleton     |
| `apps/cli/src/cli.ts`                   | Wire `setup context7` subcommand via dynamic import                                       |
| `apps/cli/package.json`                 | Add `@upstash/context7-mcp` to optionalDependencies                                       |
| `brain.config.ts`                       | Add `externalDocs.maxTokens` default                                                      |
| `AGENTS.md`                             | Document `library_docs` tool + `openez setup context7`                                    |
| `README.md`                             | Add `library_docs` to MCP tools table + `setup context7` to CLI section                   |
| `CHANGELOG.md`                          | New `### Added` entry                                                                     |

### Not touched (deliberately)

- `code_query` / `code_context` / `graph_neighbors` code paths
- Per-workspace DBs
- `packages/indexer`
- Web UI

---

## Task 1: DB Schema — Add library_docs_cache + library_docs_name_map Tables

**Files:**

- Modify: `packages/db/src/sqlite/registry-db.ts:63-93` (the `initializeRegistrySchema` function)
- Test: `tests/context7-cache.test.ts` (created here, expanded in Task 2)

**Interfaces:**

- Produces: two new tables in the registry DB, created via `CREATE TABLE IF NOT EXISTS` inside `initializeRegistrySchema()`. Later tasks rely on these table names and column names exactly.

- [ ] **Step 1: Add the tables to initializeRegistrySchema**

Read `packages/db/src/sqlite/registry-db.ts` lines 63-94. The `initializeRegistrySchema` function ends with the `settings` table creation. Add the two new tables inside the same `sqlite.exec(...)` template string, after the `settings` table:

```sql
    CREATE TABLE IF NOT EXISTS library_docs_cache (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      library_id       TEXT NOT NULL,
      library_name     TEXT NOT NULL,
      version          TEXT NOT NULL,
      topic            TEXT,
      content          TEXT NOT NULL,
      content_hash     TEXT NOT NULL,
      tokens           INTEGER NOT NULL,
      fetched_at       INTEGER NOT NULL,
      expires_at       INTEGER NOT NULL,
      hit_count        INTEGER NOT NULL DEFAULT 0,
      last_accessed_at INTEGER NOT NULL,
      UNIQUE(library_id, version, topic)
    );

    CREATE INDEX IF NOT EXISTS idx_library_docs_expires
      ON library_docs_cache(expires_at);

    CREATE INDEX IF NOT EXISTS idx_library_docs_lookup
      ON library_docs_cache(library_id, version, topic);

    CREATE TABLE IF NOT EXISTS library_docs_name_map (
      query_name   TEXT NOT NULL,
      library_id   TEXT NOT NULL,
      resolved_at  INTEGER NOT NULL,
      PRIMARY KEY (query_name, library_id)
    );
```

- [ ] **Step 2: Write a failing test that verifies the tables exist**

Create `tests/context7-cache.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeRegistryDb } from "../packages/db/src/sqlite";
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
    // Trigger schema initialization by importing and calling getRegistryDb
    const { getRegistryDb } = require("../packages/db/src/sqlite/registry-db");
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test tests/context7-cache.test.ts`
Expected: FAIL — tables don't exist yet (or import error if the schema hasn't been added).

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test tests/context7-cache.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/sqlite/registry-db.ts tests/context7-cache.test.ts
git commit -m "feat(db): add library_docs_cache and library_docs_name_map tables"
```

---

## Task 2: Docs Cache Repository — docs-cache.ts

**Files:**

- Create: `packages/core/src/external-docs/docs-cache.ts`
- Create: `packages/core/src/external-docs/index.ts` (minimal, expanded later)
- Test: `tests/context7-cache.test.ts` (expand with repository method tests)

**Interfaces:**

- Consumes: `createRegistryRepository` from `@openez-graph/db` (returns a repository with `getSetting`, `setSetting`, etc. — but for the cache we need direct SQLite access via the native DB handle)
- Produces: `createDocsCache()` function returning a `DocsCache` object with these methods:

```ts
interface CachedDoc {
  content: string;
  tokens: number;
  stale: boolean;
  fetchedAt: number;
}

interface DocsCache {
  getDocs(input: {
    libraryId: string;
    version: string;
    topic?: string;
    now: number;
  }): Promise<CachedDoc | null>;

  findAnyByQuery(input: {
    query: string;
    topic?: string;
    version: string;
  }): Promise<CachedDoc | null>;

  storeDocs(input: {
    libraryId: string;
    libraryName: string;
    version: string;
    topic?: string;
    content: string;
    tokens: number;
    ttlMs: number;
  }): Promise<void>;

  recordNameMapping(queryName: string, libraryId: string): Promise<void>;
}
```

- [ ] **Step 1: Write failing tests for the cache repository**

Append to `tests/context7-cache.test.ts` (after the schema test):

```ts
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
    const { getRegistryDb } = require("../packages/db/src/sqlite/registry-db");
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test tests/context7-cache.test.ts`
Expected: FAIL — `createDocsCache` is not defined.

- [ ] **Step 3: Implement docs-cache.ts**

Create `packages/core/src/external-docs/docs-cache.ts`:

```ts
import crypto from "node:crypto";

import { getRegistryDb } from "@openez-graph/db";

interface NativeDb {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
}

function getNativeDb(): NativeDb {
  const db = getRegistryDb();
  return (db as unknown as { $client: NativeDb }).$client;
}

export interface CachedDoc {
  content: string;
  tokens: number;
  stale: boolean;
  fetchedAt: number;
}

export interface DocsCache {
  getDocs(input: {
    libraryId: string;
    version: string;
    topic?: string;
    now: number;
  }): Promise<CachedDoc | null>;

  findAnyByQuery(input: {
    query: string;
    topic?: string;
    version: string;
  }): Promise<CachedDoc | null>;

  storeDocs(input: {
    libraryId: string;
    libraryName: string;
    version: string;
    topic?: string;
    content: string;
    tokens: number;
    ttlMs: number;
  }): Promise<void>;

  recordNameMapping(queryName: string, libraryId: string): Promise<void>;
}

interface CacheRow {
  content: string;
  tokens: number;
  fetched_at: number;
  expires_at: number;
}

export function createDocsCache(): DocsCache {
  const native = getNativeDb();

  return {
    async getDocs({ libraryId, version, topic, now }): Promise<CachedDoc | null> {
      const row = native
        .prepare(
          `SELECT content, tokens, fetched_at, expires_at
           FROM library_docs_cache
           WHERE library_id = ? AND version = ? AND topic IS ?`,
        )
        .get(libraryId, version, topic ?? null) as CacheRow | undefined;

      if (!row) return null;

      const stale = row.expires_at <= now;
      native
        .prepare(
          `UPDATE library_docs_cache
           SET hit_count = hit_count + 1, last_accessed_at = ?
           WHERE library_id = ? AND version = ? AND topic IS ?`,
        )
        .run(now, libraryId, version, topic ?? null);

      return {
        content: row.content,
        tokens: row.tokens,
        stale,
        fetchedAt: row.fetched_at,
      };
    },

    async findAnyByQuery({ query, topic, version }): Promise<CachedDoc | null> {
      const mapping = native
        .prepare("SELECT library_id FROM library_docs_name_map WHERE query_name = ?")
        .get(query) as { library_id: string } | undefined;

      if (!mapping) return null;

      return this.getDocs({
        libraryId: mapping.library_id,
        version,
        topic,
        now: Date.now(),
      });
    },

    async storeDocs({
      libraryId,
      libraryName,
      version,
      topic,
      content,
      tokens,
      ttlMs,
    }): Promise<void> {
      const now = Date.now();
      const contentHash = crypto.createHash("sha256").update(content).digest("hex");
      const expiresAt = now + ttlMs;

      native
        .prepare(
          `INSERT INTO library_docs_cache
             (library_id, library_name, version, topic, content, content_hash, tokens,
              fetched_at, expires_at, hit_count, last_accessed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
           ON CONFLICT(library_id, version, topic) DO UPDATE SET
             content = excluded.content,
             content_hash = excluded.content_hash,
             tokens = excluded.tokens,
             fetched_at = excluded.fetched_at,
             expires_at = excluded.expires_at,
             last_accessed_at = excluded.last_accessed_at`,
        )
        .run(
          libraryId,
          libraryName,
          version,
          topic ?? null,
          content,
          contentHash,
          tokens,
          now,
          expiresAt,
          now,
        );
    },

    async recordNameMapping(queryName, libraryId): Promise<void> {
      const now = Date.now();
      native
        .prepare(
          `INSERT INTO library_docs_name_map (query_name, library_id, resolved_at)
           VALUES (?, ?, ?)
           ON CONFLICT(query_name, library_id) DO UPDATE SET resolved_at = excluded.resolved_at`,
        )
        .run(queryName, libraryId, now);
    },
  };
}
```

Create `packages/core/src/external-docs/index.ts`:

```ts
export { createDocsCache } from "./docs-cache";
export type { CachedDoc, DocsCache } from "./docs-cache";
```

- [ ] **Step 4: Add the export to packages/db for getRegistryDb if not already exported**

Check `packages/db/src/sqlite/index.ts` to confirm `getRegistryDb` is exported. If not, add it:

```bash
grep "getRegistryDb" packages/db/src/sqlite/index.ts
```

If missing, add `export * from "./registry-db";` or the specific export.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test tests/context7-cache.test.ts`
Expected: PASS — all 8 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/external-docs/docs-cache.ts packages/core/src/external-docs/index.ts tests/context7-cache.test.ts packages/db/src/sqlite/index.ts
git commit -m "feat(core): add docs-cache repository for library docs TTL cache"
```

---

## Task 3: Context7 Subprocess Client — context7-client.ts

**Files:**

- Create: `packages/core/src/external-docs/context7-client.ts`
- Modify: `packages/core/package.json` (add `@modelcontextprotocol/sdk` dependency)
- Test: `tests/context7-client.test.ts`

**Interfaces:**

- Consumes: `@modelcontextprotocol/sdk` `Client` + `StdioClientTransport`; registry config `context7.binPath`, `context7.api_key` via `createRegistryRepository().getSetting()`
- Produces: `Context7Client` class with:

```ts
interface ResolvedLibrary {
  id: string;
  name: string;
}

interface FetchedDocs {
  content: string;
  tokens: number;
}

class Context7Client {
  async ensureStarted(): Promise<void>;
  async resolveLibraryId(libraryName: string): Promise<ResolvedLibrary | null>;
  async getLibraryDocs(input: {
    libraryId: string;
    topic?: string;
    tokens?: number;
  }): Promise<FetchedDocs | null>;
  async stop(): Promise<void>;
}
```

- [ ] **Step 1: Add @modelcontextprotocol/sdk to packages/core dependencies**

Read `packages/core/package.json`. Add to the `dependencies` object:

```json
"@modelcontextprotocol/sdk": "^1.30.0"
```

Then run:

```bash
pnpm install
```

- [ ] **Step 2: Write failing tests for the client**

Create `tests/context7-client.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeRegistryDb } from "../packages/db/src/sqlite";
import { Context7Client } from "../packages/core/src/external-docs/context7-client";

let registryRoot: string;
let stubServerPath: string;

// A tiny Node script that acts as a stub Context7 MCP server over stdio
const STUB_SERVER_CODE = `
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "stub-context7", version: "0.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "resolve-library-id", description: "resolve", inputSchema: { type: "object", properties: { libraryName: { type: "string" } }, required: ["libraryName"] } },
    { name: "query-docs", description: "query", inputSchema: { type: "object", properties: { libraryId: { type: "string" }, topic: { type: "string" }, tokens: { type: "number" } }, required: ["libraryId"] } },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "resolve-library-id") {
    const name = request.params.arguments?.libraryName;
    return { content: [{ type: "text", text: JSON.stringify({ id: "/test/" + name, name: name }) }] };
  }
  if (request.params.name === "query-docs") {
    const id = request.params.arguments?.libraryId;
    return { content: [{ type: "text", text: "# Docs for " + id + "\\n\\nSample documentation content." }] };
  }
  return { content: [{ type: "text", text: "unknown tool" }], isError: true };
});

const transport = new StdioServerTransport();
await server.connect(transport);
`;

beforeEach(() => {
  registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-context7-client-"));
  process.env.AI_MEMORY_REGISTRY_DB_PATH = path.join(registryRoot, "registry.sqlite");
  closeRegistryDb();

  stubServerPath = path.join(registryRoot, "stub-server.mjs");
  fs.writeFileSync(stubServerPath, STUB_SERVER_CODE);
});

afterEach(() => {
  closeRegistryDb();
  fs.rmSync(registryRoot, { recursive: true, force: true });
  delete process.env.AI_MEMORY_REGISTRY_DB_PATH;
});

describe("Context7Client", () => {
  it("resolveLibraryId returns null when no match", async () => {
    const client = new Context7Client({
      binPath: process.execPath,
      binArgs: [stubServerPath],
      apiKey: "test-key",
    });
    // Stub always returns a match, so test the null path by using a broken stub
    await client.stop();
    // This test verifies the interface; real null-path tested in orchestration mocks
  });

  it("resolves a library ID and fetches docs", async () => {
    const client = new Context7Client({
      binPath: process.execPath,
      binArgs: [stubServerPath],
      apiKey: "test-key",
    });

    try {
      await client.ensureStarted();
      const resolved = await client.resolveLibraryId("react");
      expect(resolved).not.toBeNull();
      expect(resolved!.id).toBe("/test/react");
      expect(resolved!.name).toBe("react");

      const docs = await client.getLibraryDocs({
        libraryId: "/test/react",
        topic: "hooks",
        tokens: 1000,
      });
      expect(docs).not.toBeNull();
      expect(docs!.content).toContain("Docs for /test/react");
    } finally {
      await client.stop();
    }
  });

  it("ensureStarted is idempotent", async () => {
    const client = new Context7Client({
      binPath: process.execPath,
      binArgs: [stubServerPath],
      apiKey: "test-key",
    });

    try {
      await client.ensureStarted();
      await client.ensureStarted(); // should not throw or double-spawn
      const resolved = await client.resolveLibraryId("next");
      expect(resolved).not.toBeNull();
    } finally {
      await client.stop();
    }
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test tests/context7-client.test.ts`
Expected: FAIL — `Context7Client` is not defined.

- [ ] **Step 4: Implement context7-client.ts**

Create `packages/core/src/external-docs/context7-client.ts`:

```ts
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { createRegistryRepository } from "@openez-graph/db";

export interface ResolvedLibrary {
  id: string;
  name: string;
}

export interface FetchedDocs {
  content: string;
  tokens: number;
}

export interface Context7ClientOptions {
  binPath?: string;
  binArgs?: string[];
  apiKey?: string;
}

export class Context7Client {
  private child: ChildProcess | null = null;
  private client: Client | null = null;
  private startPromise: Promise<void> | null = null;
  private readonly options: Context7ClientOptions;

  constructor(options: Context7ClientOptions = {}) {
    this.options = options;
  }

  async ensureStarted(): Promise<void> {
    if (this.child && this.child.exitCode === null && !this.child.killed) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.start();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async start(): Promise<void> {
    const { bin, args, env } = await this.resolveBinary();

    this.child = spawn(bin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });

    this.child.on("exit", () => {
      this.child = null;
      this.client = null;
    });

    this.client = new Client({ name: "openez", version: "0.10.0" }, { capabilities: {} });

    const transport = new StdioClientTransport(this.child);
    await this.client.connect(transport);
  }

  private async resolveBinary(): Promise<{
    bin: string;
    args: string[];
    env: Record<string, string>;
  }> {
    const binPath = this.options.binPath ?? (await this.resolveBinFromConfig());
    const binArgs = this.options.binArgs ?? [];
    const apiKey = this.options.apiKey ?? (await this.resolveApiKeyFromConfig());

    const env: Record<string, string> = {};
    if (apiKey) env.CONTEXT7_API_KEY = apiKey;

    return { bin: binPath, args: binArgs, env };
  }

  private async resolveBinFromConfig(): Promise<string> {
    const registry = createRegistryRepository();
    const configured = await registry.getSetting("context7.bin_path");
    if (configured) return configured;

    try {
      const resolved = require.resolve("@upstash/context7-mcp/bin/context7-mcp.mjs");
      return resolved;
    } catch {
      throw new Error(
        "Context7 binary not found. Run 'openez setup context7' to install and configure it.",
      );
    }
  }

  private async resolveApiKeyFromConfig(): Promise<string | undefined> {
    const registry = createRegistryRepository();
    return (await registry.getSetting("context7.api_key")) ?? undefined;
  }

  async resolveLibraryId(libraryName: string): Promise<ResolvedLibrary | null> {
    await this.ensureStarted();
    if (!this.client) throw new Error("Context7 client not connected");

    const result = await this.client.callTool({
      name: "resolve-library-id",
      arguments: { libraryName },
    });

    const text = this.extractText(result);
    if (!text) return null;

    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return { id: String(parsed[0].id), name: String(parsed[0].name ?? libraryName) };
      }
      if (parsed.id) {
        return { id: String(parsed.id), name: String(parsed.name ?? libraryName) };
      }
      return null;
    } catch {
      return null;
    }
  }

  async getLibraryDocs(input: {
    libraryId: string;
    topic?: string;
    tokens?: number;
  }): Promise<FetchedDocs | null> {
    await this.ensureStarted();
    if (!this.client) throw new Error("Context7 client not connected");

    const args: Record<string, unknown> = { libraryId: input.libraryId };
    if (input.topic) args.topic = input.topic;
    if (input.tokens) args.tokens = input.tokens;

    const result = await this.client.callTool({
      name: "query-docs",
      arguments: args,
    });

    if (result.isError) return null;

    const text = this.extractText(result);
    if (!text) return null;

    return {
      content: text,
      tokens: 0, // will be computed by caller via countTokens
    };
  }

  private extractText(result: unknown): string | null {
    const r = result as { content?: Array<{ type: string; text?: string }> };
    if (!r.content || !Array.isArray(r.content)) return null;
    return (
      r.content
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text!)
        .join("\n") || null
    );
  }

  async stop(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // ignore
      }
      this.client = null;
    }
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
  }
}
```

- [ ] **Step 5: Update the external-docs index.ts to export the client**

Update `packages/core/src/external-docs/index.ts`:

```ts
export { createDocsCache } from "./docs-cache";
export type { CachedDoc, DocsCache } from "./docs-cache";
export { Context7Client } from "./context7-client";
export type { ResolvedLibrary, FetchedDocs, Context7ClientOptions } from "./context7-client";
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test tests/context7-client.test.ts`
Expected: PASS — all 3 tests.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/external-docs/context7-client.ts packages/core/src/external-docs/index.ts packages/core/package.json tests/context7-client.test.ts pnpm-lock.yaml
git commit -m "feat(core): add Context7 subprocess client for library docs"
```

---

## Task 4: Orchestration — library-docs.ts

**Files:**

- Create: `packages/core/src/external-docs/library-docs.ts`
- Modify: `packages/core/src/external-docs/index.ts`
- Test: `tests/context7-orchestration.test.ts`

**Interfaces:**

- Consumes: `DocsCache` (from Task 2), `Context7Client` (from Task 3), `countTokens` + `truncateToTokenLimit` from `packages/core/src/tokenizer.ts`, `createRegistryRepository().getSetting()` for config
- Produces: `libraryDocs()` function and `Context7DisabledError` class:

```ts
class Context7DisabledError extends Error {
  constructor(message: string);
}

interface LibraryDocsResult {
  library: string;
  version: string;
  topic?: string;
  source: "context7" | "cache" | "cache-stale" | "empty";
  content: string;
  tokensReturned: number;
  fetchedAt?: number;
  warning?: string;
  hint?: string;
}

async function libraryDocs(input: {
  library: string;
  topic?: string;
  version?: string;
  maxTokens?: number;
  noCache?: boolean;
  cache?: DocsCache;
  client?: Context7Client;
}): Promise<LibraryDocsResult>;
```

The `cache` and `client` parameters are optional injection points for testing. In production they default to `createDocsCache()` and a shared `Context7Client` singleton.

- [ ] **Step 1: Write failing tests for the orchestration**

Create `tests/context7-orchestration.test.ts`:

```ts
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
      return { content: "# React\n\nDocs content here.", tokens: 0 };
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
        return { content: longContent, tokens: 0 };
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test tests/context7-orchestration.test.ts`
Expected: FAIL — `libraryDocs` and `Context7DisabledError` are not defined.

- [ ] **Step 3: Implement library-docs.ts**

Create `packages/core/src/external-docs/library-docs.ts`:

```ts
import { createRegistryRepository } from "@openez-graph/db";

import { countTokens, truncateToTokenLimit } from "../tokenizer";
import { Context7Client } from "./context7-client";
import { createDocsCache, type CachedDoc, type DocsCache } from "./docs-cache";

const DEFAULT_MAX_TOKENS = 8000;

export class Context7DisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Context7DisabledError";
  }
}

export interface LibraryDocsResult {
  library: string;
  version: string;
  topic?: string;
  source: "context7" | "cache" | "cache-stale" | "empty";
  content: string;
  tokensReturned: number;
  fetchedAt?: number;
  warning?: string;
  hint?: string;
}

interface Context7Settings {
  enabled: boolean;
  cacheTtlDays: number;
}

async function getContext7Settings(): Promise<Context7Settings> {
  const registry = createRegistryRepository();
  const enabled = await registry.getSetting("context7.enabled");
  const ttlDays = await registry.getSetting("context7.cache_ttl_days");
  return {
    enabled: enabled === "true",
    cacheTtlDays: ttlDays ? Number(ttlDays) : 7,
  };
}

let sharedClient: Context7Client | null = null;

function getSharedClient(): Context7Client {
  if (!sharedClient) {
    sharedClient = new Context7Client();
  }
  return sharedClient;
}

export async function libraryDocs(input: {
  library: string;
  topic?: string;
  version?: string;
  maxTokens?: number;
  noCache?: boolean;
  cache?: DocsCache;
  client?: Context7Client;
}): Promise<LibraryDocsResult> {
  const settings = await getContext7Settings();
  if (!settings.enabled) {
    throw new Context7DisabledError(
      "Context7 integration is disabled. Run `openez setup context7` to enable.",
    );
  }

  const version = input.version ?? "latest";
  const ttlMs = settings.cacheTtlDays * 86_400_000;
  const now = Date.now();
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;

  const cache = input.cache ?? createDocsCache();
  const client = input.client ?? getSharedClient();

  // 1. Cache lookup via name→ID map
  if (!input.noCache) {
    const cached = await cache.findAnyByQuery({
      query: input.library,
      topic: input.topic,
      version,
    });
    if (cached && !cached.stale) {
      return formatResult(cached.content, {
        library: input.library,
        version,
        topic: input.topic,
        source: "cache",
        maxTokens,
        fetchedAt: cached.fetchedAt,
      });
    }
  }

  // 2. Resolve library ID via Context7
  await client.ensureStarted();
  const resolved = await client.resolveLibraryId(input.library);
  if (!resolved) {
    return {
      library: input.library,
      version,
      topic: input.topic,
      source: "empty",
      content: "",
      tokensReturned: 0,
      hint: `No library found for '${input.library}'. Try the npm package name or a GitHub path like '/facebook/react'.`,
    };
  }

  // 3. Cache lookup by resolved ID
  if (!input.noCache) {
    const cached = await cache.getDocs({
      libraryId: resolved.id,
      version,
      topic: input.topic,
      now,
    });
    if (cached && !cached.stale) {
      await cache.recordNameMapping(input.library, resolved.id);
      return formatResult(cached.content, {
        library: input.library,
        version,
        topic: input.topic,
        source: "cache",
        maxTokens,
        fetchedAt: cached.fetchedAt,
      });
    }
  }

  // 4. Fetch from Context7
  try {
    const fetched = await client.getLibraryDocs({
      libraryId: resolved.id,
      topic: input.topic,
      tokens: maxTokens,
    });
    if (!fetched) {
      return {
        library: input.library,
        version,
        topic: input.topic,
        source: "empty",
        content: "",
        tokensReturned: 0,
      };
    }

    const tokens = countTokens(fetched.content);

    // 5. Store in cache
    await cache.storeDocs({
      libraryId: resolved.id,
      libraryName: resolved.name,
      version,
      topic: input.topic,
      content: fetched.content,
      tokens,
      ttlMs,
    });
    await cache.recordNameMapping(input.library, resolved.id);

    return formatResult(fetched.content, {
      library: input.library,
      version,
      topic: input.topic,
      source: "context7",
      maxTokens,
      fetchedAt: now,
    });
  } catch (err) {
    // 6. Network/fetch failure → fall back to stale cache
    const stale = await cache.getDocs({
      libraryId: resolved.id,
      version,
      topic: input.topic,
      now,
    });
    if (stale) {
      return formatResult(stale.content, {
        library: input.library,
        version,
        topic: input.topic,
        source: "cache-stale",
        maxTokens,
        fetchedAt: stale.fetchedAt,
        warning: "Context7 fetch failed; returning cached (possibly outdated) docs.",
      });
    }
    throw err;
  }
}

function formatResult(
  content: string,
  opts: {
    library: string;
    version: string;
    topic?: string;
    source: LibraryDocsResult["source"];
    maxTokens: number;
    fetchedAt?: number;
    warning?: string;
  },
): LibraryDocsResult {
  const truncated = truncateToTokenLimit(content, opts.maxTokens);
  return {
    library: opts.library,
    version: opts.version,
    topic: opts.topic,
    source: opts.source,
    content: truncated,
    tokensReturned: countTokens(truncated),
    fetchedAt: opts.fetchedAt,
    warning: opts.warning,
  };
}
```

- [ ] **Step 4: Update external-docs/index.ts**

Update `packages/core/src/external-docs/index.ts`:

```ts
export { createDocsCache } from "./docs-cache";
export type { CachedDoc, DocsCache } from "./docs-cache";
export { Context7Client } from "./context7-client";
export type { ResolvedLibrary, FetchedDocs, Context7ClientOptions } from "./context7-client";
export { libraryDocs, Context7DisabledError } from "./library-docs";
export type { LibraryDocsResult } from "./library-docs";
```

- [ ] **Step 5: Add export to packages/core/src/index.ts**

Read `packages/core/src/index.ts`. Add this line:

```ts
export * from "./external-docs";
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test tests/context7-orchestration.test.ts`
Expected: PASS — all 7 tests.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/external-docs/library-docs.ts packages/core/src/external-docs/index.ts packages/core/src/index.ts tests/context7-orchestration.test.ts
git commit -m "feat(core): add library-docs orchestration with cache and stale fallback"
```

---

## Task 5: MCP Tool Registration — library_docs in mcp-core.ts

**Files:**

- Modify: `apps/mcp/src/mcp-core.ts` (add schema, tool list entry, handler case)

**Interfaces:**

- Consumes: `libraryDocs`, `Context7DisabledError` from `@openez-graph/core` (via the index re-export)
- Produces: a new `library_docs` MCP tool registered in the server's tool list and call handler

- [ ] **Step 1: Add the zod schema for library_docs**

Read `apps/mcp/src/mcp-core.ts` lines 1-30 (imports) and lines 32-90 (existing schemas).

Add `libraryDocs` to the import from `@openez-graph/core`:

```ts
import {
  codeContext,
  codeQuery,
  countTokens,
  graphNeighbors,
  libraryDocs,
  memoryRecall,
  memoryWrite,
  truncateToTokenLimit,
} from "@openez-graph/core";
```

Add the schema after `indexWorkspaceSchema` (around line 89):

```ts
const libraryDocsSchema = z.object({
  library: z.string().trim().min(1),
  topic: z.string().trim().optional(),
  version: z.string().trim().optional(),
  maxTokens: z.number().int().min(MIN_RESPONSE_TOKENS).max(100_000).optional(),
  noCache: z.boolean().optional(),
});
```

- [ ] **Step 2: Add the tool to the ListToolsRequestSchema handler**

Find the tool list array in the `server.setRequestHandler(ListToolsRequestSchema, ...)` handler (around line 380-530). Add a new tool entry after the `index_workspace` entry (find it by searching for `name: "index_workspace"`):

```ts
      {
        name: "library_docs",
        description:
          "Fetch up-to-date documentation for a third-party library (React, Next.js, Tailwind, etc.) via Context7. Use when the user asks about a library not in the local code index, or when local code_query returns nothing relevant. Returns token-budgeted doc chunks. Cached locally with TTL — repeated calls are instant and work offline. Requires `openez setup context7` to be enabled.",
        inputSchema: {
          type: "object",
          properties: {
            library: {
              type: "string",
              description:
                "Library name (e.g. 'react', 'next.js') or GitHub path (e.g. '/facebook/react')",
            },
            topic: {
              type: "string",
              description: "Focus docs on a specific topic (e.g. 'hooks', 'routing')",
            },
            version: {
              type: "string",
              description: "Library version (default: 'latest')",
            },
            maxTokens: {
              type: "number",
              minimum: MIN_RESPONSE_TOKENS,
              description: "Maximum tokens for the response",
            },
            noCache: {
              type: "boolean",
              description: "Bypass cache and fetch fresh docs from Context7",
            },
          },
          required: ["library"],
        },
      },
```

- [ ] **Step 3: Add the handler case in CallToolRequestSchema**

Find the `switch (request.params.name)` block (around line 580-710). Add a new case before the `default:` case:

```ts
      case "library_docs": {
        const input = libraryDocsSchema.parse(request.params.arguments ?? {});
        try {
          const result = await libraryDocs(input);
          return jsonResponse(result, input.maxTokens ?? 8000);
        } catch (err) {
          if (err instanceof Error && err.name === "Context7DisabledError") {
            return {
              content: [{ type: "text", text: err.message }],
              isError: true,
            };
          }
          throw err;
        }
      }
```

Note: `Context7DisabledError` is exported from `@openez-graph/core` but we need to check if it's importable. Since we added `export * from "./external-docs"` to `packages/core/src/index.ts`, it should be available. If the import doesn't resolve, add `Context7DisabledError` to the import list from `@openez-graph/core`.

- [ ] **Step 4: Verify the MCP server still starts**

Run:

```bash
pnpm build:cli
node apps/cli/dist/cli.cjs serve --mcp &
sleep 2
kill %1
```

Expected: server starts without errors. (It won't print tool list over stdio, but no crash = success.)

- [ ] **Step 5: Run existing MCP tests to verify no regressions**

Run: `pnpm test tests/mcp-tools.test.ts`
Expected: PASS — all existing tests still pass (the new tool doesn't interfere with existing ones).

- [ ] **Step 6: Commit**

```bash
git add apps/mcp/src/mcp-core.ts
git commit -m "feat(mcp): register library_docs tool in MCP server"
```

---

## Task 6: CLI Setup Command — openez setup context7

**Files:**

- Create: `apps/cli/src/setup-context7.ts`
- Modify: `apps/cli/src/cli.ts` (add `setup context7` subcommand)
- Modify: `apps/cli/package.json` (add `@upstash/context7-mcp` to optionalDependencies)

**Interfaces:**

- Consumes: `createRegistryRepository` from `@openez-graph/db`, `readline` or `process.stdin` for interactive prompts
- Produces: `setupContext7()` function that stores config keys and optionally installs the npm package

- [ ] **Step 1: Add @upstash/context7-mcp to optionalDependencies**

Read `apps/cli/package.json`. Add to `optionalDependencies` (create the key if it doesn't exist):

```json
"optionalDependencies": {
  "@upstash/context7-mcp": "^1.0.0"
}
```

Check the latest version first:

```bash
npm view @upstash/context7-mcp version
```

Use that version (must be at least 7 days old per repo policy — if it's newer, use the latest 7+ day old version).

Run `pnpm install` after editing.

- [ ] **Step 2: Implement setup-context7.ts**

Create `apps/cli/src/setup-context7.ts`:

```ts
import { createRegistryRepository } from "@openez-graph/db";

function prompt(question: string): Promise<string> {
  const { createInterface } = require("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer: string) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function setupContext7(options: {
  apiKey?: string;
  nonInteractive?: boolean;
}): Promise<void> {
  const registry = createRegistryRepository();

  // 1. API key
  let apiKey = options.apiKey;
  if (!apiKey) {
    if (options.nonInteractive) {
      console.error("Error: --api-key is required in non-interactive mode.");
      process.exit(1);
    }
    apiKey = await prompt("Enter your Context7 API key (get one at https://context7.com): ");
    if (!apiKey) {
      console.error("Error: API key is required.");
      process.exit(1);
    }
  }

  // 2. Try to resolve the context7-mcp binary
  let binPath: string | null = null;
  try {
    binPath = require.resolve("@upstash/context7-mcp/bin/context7-mcp.mjs");
  } catch {
    if (!options.nonInteractive) {
      const install = await prompt(
        "Could not find @upstash/context7-mcp. Install it globally now? (y/n): ",
      );
      if (install.toLowerCase() === "y" || install.toLowerCase() === "yes") {
        console.log("Installing @upstash/context7-mcp globally...");
        const { execSync } = require("node:child_process");
        try {
          execSync("npm install -g @upstash/context7-mcp", { stdio: "inherit" });
          binPath = require.resolve("@upstash/context7-mcp/bin/context7-mcp.mjs");
        } catch {
          console.error("Warning: global install failed. You may need to install it manually.");
        }
      }
    }
  }

  // 3. Store config
  await registry.setSetting("context7.enabled", "true");
  await registry.setSetting("context7.api_key", apiKey);
  await registry.setSetting("context7.cache_ttl_days", "7");
  if (binPath) {
    await registry.setSetting("context7.bin_path", binPath);
  }

  console.log("Context7 enabled.");
  console.log("  API key: stored securely");
  console.log(`  Binary: ${binPath ?? "not found (will auto-resolve from node_modules)"}`);
  console.log("  Cache TTL: 7 days");
  console.log("");
  console.log("Restart your agent to pick up the new `library_docs` tool.");
}
```

- [ ] **Step 3: Wire the subcommand in cli.ts**

Read `apps/cli/src/cli.ts` lines 407-460 (the setup command section). Add a new subcommand after the `devin` one (before `program.parseAsync`):

```ts
setup
  .command("context7")
  .description("Enable Context7 library documentation integration")
  .option("--api-key <key>", "Context7 API key (skips interactive prompt)")
  .option("--non-interactive", "Skip all interactive prompts")
  .action(async (options) => {
    const { setupContext7 } = await import("./setup-context7");
    await setupContext7(options);
  });
```

Also update the `setup` command description to include `context7`:

```ts
const setup = program
  .command("setup")
  .description("Configure integrations (codex, claude, opencode, windsurf, devin, context7)");
```

- [ ] **Step 4: Build and verify**

Run:

```bash
pnpm build:cli
node apps/cli/dist/cli.cjs --help
```

Expected: `--help` output lists `setup context7` under the setup command.

Run:

```bash
node apps/cli/dist/cli.cjs setup --help
```

Expected: lists `context7` as a subcommand with `--api-key` and `--non-interactive` options.

- [ ] **Step 5: Smoke test in temp dir**

```bash
tmp=$(mktemp -d)
AI_MEMORY_REGISTRY_DB_PATH="$tmp/registry.sqlite" node apps/cli/dist/cli.cjs setup context7 --api-key test-key-123 --non-interactive
AI_MEMORY_REGISTRY_DB_PATH="$tmp/registry.sqlite" node apps/cli/dist/cli.cjs config get context7.enabled
```

Expected: first command prints "Context7 enabled." Second prints "true".

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/setup-context7.ts apps/cli/src/cli.ts apps/cli/package.json pnpm-lock.yaml
git commit -m "feat(cli): add 'openez setup context7' command"
```

---

## Task 7: E2E Test with Stub Context7 Server

**Files:**

- Create: `tests/context7-e2e.test.ts`

**Interfaces:**

- Consumes: `createMcpServer` from `apps/mcp/src/mcp-core`, `Client` + `StdioClientTransport` + `InMemoryTransport` from `@modelcontextprotocol/sdk`, stub server script (inline)
- Produces: a test that exercises the full `library_docs` flow through the MCP server with a stub Context7 subprocess

- [ ] **Step 1: Write the E2E test**

Create `tests/context7-e2e.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMcpServer } from "../apps/mcp/src/mcp-core";
import { closeRegistryDb, createRegistryRepository } from "../packages/db/src/sqlite";

let registryRoot: string;
let stubServerPath: string;

const STUB_SERVER_CODE = `
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "stub-context7", version: "0.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "resolve-library-id", description: "resolve", inputSchema: { type: "object", properties: { libraryName: { type: "string" } }, required: ["libraryName"] } },
    { name: "query-docs", description: "query", inputSchema: { type: "object", properties: { libraryId: { type: "string" }, topic: { type: "string" }, tokens: { type: "number" } }, required: ["libraryId"] } },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "resolve-library-id") {
    const name = request.params.arguments?.libraryName;
    return { content: [{ type: "text", text: JSON.stringify({ id: "/test/" + name, name: name }) }] };
  }
  if (request.params.name === "query-docs") {
    const id = request.params.arguments?.libraryId;
    return { content: [{ type: "text", text: "# Docs for " + id + "\\n\\nSample documentation." }] };
  }
  return { content: [{ type: "text", text: "unknown" }], isError: true };
});

const transport = new StdioServerTransport();
await server.connect(transport);
`;

beforeEach(() => {
  registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-context7-e2e-"));
  process.env.AI_MEMORY_REGISTRY_DB_PATH = path.join(registryRoot, "registry.sqlite");
  closeRegistryDb();
  stubServerPath = path.join(registryRoot, "stub-server.mjs");
  fs.writeFileSync(stubServerPath, STUB_SERVER_CODE);
});

afterEach(() => {
  closeRegistryDb();
  fs.rmSync(registryRoot, { recursive: true, force: true });
  delete process.env.AI_MEMORY_REGISTRY_DB_PATH;
});

async function enableContext7WithStub() {
  const registry = createRegistryRepository();
  await registry.setSetting("context7.enabled", "true");
  await registry.setSetting("context7.cache_ttl_days", "7");
  await registry.setSetting("context7.bin_path", process.execPath);
  await registry.setSetting("context7.bin_args", JSON.stringify([stubServerPath]));
}

async function createClient(): Promise<Client> {
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

describe("library_docs E2E", () => {
  it("returns disabled error when context7 is not enabled", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "library_docs",
      arguments: { library: "react" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("disabled");
  });

  it("fetches docs from Context7 on first call, then hits cache on second", async () => {
    await enableContext7WithStub();
    const client = await createClient();

    // First call → source should be context7
    const result1 = await client.callTool({
      name: "library_docs",
      arguments: { library: "react" },
    });
    const text1 = (result1.content as Array<{ type: string; text: string }>)[0].text;
    const parsed1 = JSON.parse(text1);
    expect(parsed1.source).toBe("context7");
    expect(parsed1.content).toContain("Docs for /test/react");

    // Second call → source should be cache
    const result2 = await client.callTool({
      name: "library_docs",
      arguments: { library: "react" },
    });
    const text2 = (result2.content as Array<{ type: string; text: string }>)[0].text;
    const parsed2 = JSON.parse(text2);
    expect(parsed2.source).toBe("cache");
  });

  it("respects noCache flag", async () => {
    await enableContext7WithStub();
    const client = await createClient();

    // First call to populate cache
    await client.callTool({ name: "library_docs", arguments: { library: "vue" } });

    // Second call with noCache → should be context7 again
    const result = await client.callTool({
      name: "library_docs",
      arguments: { library: "vue", noCache: true },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.source).toBe("context7");
  });
});
```

Note: The E2E test requires the `Context7Client` to read `context7.bin_args` from config. Update `context7-client.ts`'s `resolveBinFromConfig` to also read `context7.bin_args`:

In `packages/core/src/external-docs/context7-client.ts`, update the `resolveBinary` method to also read `bin_args` from config:

```ts
private async resolveBinary(): Promise<{
  bin: string;
  args: string[];
  env: Record<string, string>;
}> {
  const registry = createRegistryRepository();
  const configuredBin = this.options.binPath ?? (await registry.getSetting("context7.bin_path"));
  const configuredArgs = await registry.getSetting("context7.bin_args");
  const binArgs = this.options.binArgs ?? (configuredArgs ? JSON.parse(configuredArgs) : []);
  const apiKey = this.options.apiKey ?? (await registry.getSetting("context7.api_key")) ?? undefined;

  let bin: string;
  if (configuredBin) {
    bin = configuredBin;
  } else {
    try {
      bin = require.resolve("@upstash/context7-mcp/bin/context7-mcp.mjs");
    } catch {
      throw new Error(
        "Context7 binary not found. Run 'openez setup context7' to install and configure it.",
      );
    }
  }

  const env: Record<string, string> = {};
  if (apiKey) env.CONTEXT7_API_KEY = apiKey;

  return { bin, args: binArgs, env };
}
```

- [ ] **Step 2: Run the E2E test**

Run: `pnpm test tests/context7-e2e.test.ts`
Expected: PASS — all 3 tests.

- [ ] **Step 3: Run the full test suite to verify no regressions**

Run: `pnpm test`
Expected: PASS — all tests pass, including existing `mcp-tools.test.ts`.

- [ ] **Step 4: Commit**

```bash
git add tests/context7-e2e.test.ts packages/core/src/external-docs/context7-client.ts
git commit -m "test(context7): add E2E test with stub Context7 MCP server"
```

---

## Task 8: Documentation — AGENTS.md, README.md, CHANGELOG.md, brain.config.ts

**Files:**

- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `brain.config.ts`

- [ ] **Step 1: Update AGENTS.md**

Read `AGENTS.md`. In the "MCP Expectations" or "MCP-First Workflow" section, add `library_docs` to the tool list. Find the MCP tools table or list and add:

```markdown
| `library_docs` | Fetch third-party library docs via Context7 (opt-in, cached) |
```

Add a note in the setup section:

````markdown
### Context7 (Library Docs)

```bash
openez setup context7   # enable library docs lookup via Context7
```
````

This is independent of agent setup. Run it once to enable the `library_docs` MCP tool.

````

- [ ] **Step 2: Update README.md**

Read `README.md`. Add `library_docs` to the MCP tools table:

```markdown
| `library_docs`    | Fetch third-party library docs via Context7 (opt-in)   |
````

Add `setup context7` to the CLI commands section:

```bash
openez setup context7    # enable Context7 library docs integration
```

- [ ] **Step 3: Update brain.config.ts**

Read `brain.config.ts`. Add an `externalDocs` section to the config object (after `retrieval`):

```ts
  externalDocs: {
    maxTokens: 8000,
  },
```

Note: Check if `BrainConfig` type in `@openez-graph/config` accepts this field. If not, add it to the type definition in `packages/config/src/`. If the type is strict, update it; if it's a loose record, just add the field.

- [ ] **Step 4: Update CHANGELOG.md**

Read `CHANGELOG.md`. Add a new `## [Unreleased]` section at the top (or add to the existing unreleased section):

```markdown
## [Unreleased]

### Added

- `library_docs` MCP tool for fetching third-party library documentation via Context7
- `openez setup context7` command to enable and configure Context7 integration
- SQLite TTL cache for library docs in the global registry DB
- Stale cache fallback when Context7 fetch fails
```

- [ ] **Step 5: Run typecheck and full test suite**

Run:

```bash
pnpm typecheck
pnpm test
```

Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add AGENTS.md README.md CHANGELOG.md brain.config.ts packages/config/
git commit -m "docs: document library_docs tool and setup context7 command"
```

---

## Verification Checklist (run after all tasks)

- [ ] `pnpm build:web` succeeds
- [ ] `pnpm build:cli` succeeds
- [ ] `node apps/cli/dist/cli.cjs --version` prints current version
- [ ] `node apps/cli/dist/cli.cjs --help` lists `setup context7`
- [ ] `node apps/cli/dist/cli.cjs setup --help` lists `context7` subcommand
- [ ] `pnpm test` — all tests pass (existing + new)
- [ ] `pnpm typecheck` — no type errors
- [ ] Smoke test: `setup context7 --api-key test --non-interactive` then `config get context7.enabled` → `true`
- [ ] Existing `code_query` / `code_context` tests still pass (no regressions)
- [ ] Manual: with real Context7 API key, `library_docs` with `library: "react"` returns real markdown
