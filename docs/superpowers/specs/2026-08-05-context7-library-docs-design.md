# Context7 Library Docs Integration — Design

**Date:** 2026-08-05
**Status:** Approved (brainstormed 2026-08-05)
**Scope:** Add external library documentation lookup to OpenEZ via Context7, exposed as a new MCP tool `library_docs`.

## Goal

Let coding agents using OpenEZ fetch up-to-date third-party library documentation (React, Next.js, Tailwind, etc.) when the local code index does not cover the library. Today `code_query` / `code_context` only retrieve from indexed SQLite workspaces; there is no path to external docs. Context7 (upstash/context7) provides exactly this — a curated, versioned library docs service exposed over MCP.

## Non-goals

- Searching source code of external GitHub repos (Context7 does not do this).
- General web search / Stack Overflow snippets.
- Indexing external docs into the local FTS/vector index (rejected — blurs the local-vs-external boundary and creates stale-doc hazards).
- Auto-falling back to Context7 inside `code_query` (rejected — mixes local and remote behavior, surprises users with network calls).
- Web UI for external docs in v1 (MCP/CLI only; a future dashboard panel can read the cache table).

## Decisions

| Decision               | Choice                                           | Rationale                                                                                                                                         |
| ---------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| External content scope | Library docs only                                | Context7's core strength; matches user intent                                                                                                     |
| MCP surface            | New dedicated `library_docs` tool                | Cleanest separation; agent decides when to use it; aligns with OpenEZ's explicit-scope philosophy                                                 |
| Caching                | SQLite cache with TTL                            | Local-first, offline-friendly, reusable across queries; avoids burning Context7 quota                                                             |
| Cache location         | Global registry DB (`~/.openez/registry.sqlite`) | Library docs are universal, not per-workspace; avoids duplicating the same docs across workspaces; matches AGENTS.md's global/per-workspace split |
| Context7 transport     | Local stdio subprocess (`@upstash/context7-mcp`) | No egress to context7.com beyond the docs fetch itself; explicit lifecycle                                                                        |
| Feature gating         | Opt-in via `openez setup context7`               | No surprise subprocess/network behavior for existing users; matches the `openez setup <agent>` pattern                                            |
| Subprocess lifecycle   | Lazy spawn, persistent                           | Fast subsequent calls; one process to manage; respawn-on-exit is transparent to callers                                                           |

## Architecture

A new **external-docs subsystem** sits alongside the existing engine/runtime/UI split, not inside the code index:

```
┌─────────────────────────────────────────────────────────────┐
│ apps/mcp/src/mcp-core.ts                                    │
│   registers new tool: library_docs                          │
│         │                                                   │
│         ▼                                                   │
│ packages/core/src/external-docs/  (NEW package-internal)    │
│   ├─ context7-client.ts   MCP stdio client to child process │
│   ├─ docs-cache.ts        SQLite TTL cache (registry DB)    │
│   └─ library-docs.ts      orchestration: cache→fetch→store  │
│         │                                                   │
│         ▼                                                   │
│ @upstash/context7-mcp  (spawned lazily as child process)    │
└─────────────────────────────────────────────────────────────┘
```

**Key boundary:** `code_query` / `code_context` / `graph_neighbors` stay **pure local**. They never touch Context7 and never read from the docs cache. Only `library_docs` reads/writes the external docs cache. This honors AGENTS.md's "reinforce the engine/runtime/UI separation" — external docs are a sibling subsystem, not folded into the code index.

**Why a subdirectory under `packages/core` (not a new package):** it shares `createRegistryRepository` from `@openez-graph/db` and `countTokens` / `truncateToTokenLimit` from core. A new package would force a circular dep or duplicate those utils. A focused subdirectory keeps it testable in isolation while reusing shared infra.

## MCP tool surface

One new tool, `library_docs`, registered alongside the existing seven in `mcp-core.ts`:

```ts
const libraryDocsSchema = z.object({
  library: z.string().trim().min(1), // e.g. "react", "next.js", "/facebook/react"
  topic: z.string().trim().optional(), // e.g. "useEffect cleanup", "app router params"
  version: z.string().trim().optional(), // e.g. "5", "15.2", "latest" (default "latest")
  maxTokens: z.number().int().min(32).max(100_000).optional(),
  noCache: z.boolean().optional(), // bypass cache for this call
});
```

**Tool description (what the agent sees):**

> Fetch up-to-date documentation for a third-party library (React, Next.js, Tailwind, etc.) via Context7. Use when the user asks about a library that is not in the local code index, or when local `code_query` returns nothing relevant. Returns token-budgeted doc chunks. Cached locally with TTL — repeated calls are instant and work offline.

**Behavior:**

1. Validate input. If `context7.enabled` is false in registry config → return a short error explaining how to enable (`openez setup context7`), **not** a crash.
2. Check cache (`library_docs_cache` table) for a fresh hit (within TTL). If hit and `noCache` is not set → return cached chunks, truncated to `maxTokens`.
3. On miss / `noCache`: ensure the context7-mcp subprocess is alive (lazy spawn). Call `resolve-library-id` with `library` (and `topic` if provided) → get library ID. Then call `get-library-docs` with the resolved ID + `topic` + tokens limit.
4. Store the returned markdown chunks in the cache with the resolved library ID, version, topic, and `fetchedAt`.
5. Return chunks truncated to `maxTokens` (default from `brain.config.ts` retrieval defaults), with metadata: `{ library, version, topic, source: "context7" | "cache", fetchedAt, tokensReturned }`.

**No workspace scope param** — library docs are global, not per-workspace. This is deliberate and matches the global cache decision.

**Tool registration when disabled:** `library_docs` is **always registered** in `ListToolsRequestSchema` so agents discover it, but calling it when `context7.enabled === false` returns a content error:

> "Context7 integration is disabled. Run `openez setup context7` to enable library documentation lookups."

This is better than hiding the tool entirely — the agent learns the capability exists and can tell the user how to enable it, rather than silently missing a feature.

## Data model & cache

New tables in the **global registry DB** (`~/.openez/registry.sqlite`), added by a migration in `packages/db`:

```sql
CREATE TABLE IF NOT EXISTS library_docs_cache (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id       TEXT NOT NULL,          -- Context7's resolved library ID (e.g. "/facebook/react")
  library_name     TEXT NOT NULL,          -- original query term, for debugging/UI
  version          TEXT NOT NULL,          -- "latest" or pinned
  topic            TEXT,                   -- NULL = general docs
  content          TEXT NOT NULL,          -- raw markdown returned by get-library-docs
  content_hash     TEXT NOT NULL,          -- sha256(content), for change detection
  tokens           INTEGER NOT NULL,       -- precomputed token count of content
  fetched_at       INTEGER NOT NULL,       -- unix ms
  expires_at       INTEGER NOT NULL,       -- fetched_at + TTL
  hit_count        INTEGER NOT NULL DEFAULT 0,
  last_accessed_at INTEGER NOT NULL,       -- updated on cache hit
  UNIQUE(library_id, version, topic)
);

CREATE INDEX IF NOT EXISTS idx_library_docs_expires ON library_docs_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_library_docs_lookup ON library_docs_cache(library_id, version, topic);

CREATE TABLE IF NOT EXISTS library_docs_name_map (
  query_name   TEXT NOT NULL,
  library_id   TEXT NOT NULL,
  resolved_at  INTEGER NOT NULL,
  PRIMARY KEY (query_name, library_id)
);
```

**Cache key:** `(library_id, version, topic)`. `library_id` is Context7's resolved ID (stable across calls for the same library), not the user's free-text query — so "react", "React", "/facebook/react" all resolve to one cache row after `resolve-library-id` normalizes them.

**Name→ID map** (`library_docs_name_map`): avoids a `resolve-library-id` round-trip on every cache-hit call. If the mapping is wrong (Context7 re-resolves a name to a different ID), the cache miss on the new ID triggers a fresh resolve and overwrites the mapping. Self-healing.

**TTL:** 7 days default, configurable via `openez config set context7.cacheTtlDays <n>`. Stored in the existing registry config table. 7 days is the Context7 community default and balances freshness vs. quota.

**Lookup flow** in `docs-cache.ts`:

```ts
getDocs({ libraryId, version, topic, now }): { content, tokens, stale: boolean } | null
//  SELECT ... WHERE library_id=? AND version=? AND topic IS ? (NULL-aware)
//  if expires_at > now  → fresh hit, bump hit_count + last_accessed_at, return { stale: false }
//  if expires_at <= now → stale hit, return { stale: true } (caller decides whether to refetch)
//  else null
```

**Store flow:**

```ts
storeDocs({ libraryId, libraryName, version, topic, content, tokens, ttlMs });
//  UPSERT on (library_id, version, topic). Recompute content_hash. If hash unchanged
//  and a row already exists, just bump fetched_at + expires_at (no content rewrite).
```

**Eviction:** lazy, on read. A background sweep is YAGNI for v1 — the table will stay small (library docs, not code). If it ever grows, a future `openez cache prune` command can delete `expires_at < now - 30d` rows. Not building that now.

**No FTS index on this table** — `library_docs` does exact-key lookup, not search. Adding FTS would re-introduce the "blur local vs external" problem we explicitly rejected.

## Context7 subprocess client

`packages/core/src/external-docs/context7-client.ts` — a thin MCP stdio client that spawns and talks to `@upstash/context7-mcp`.

**Spawn** (lazy, persistent, per MCP server process):

```ts
class Context7Client {
  private child: ChildProcess | null = null;
  private client: Client | null = null;     // @modelcontextprotocol/sdk/client
  private startPromise: Promise<void> | null = null;

  async ensureStarted(): Promise<void> {
    if (this.child && this.child.exitCode === null) return;      // alive
    if (this.startPromise) return this.startPromise;             // already starting
    this.startPromise = this.start();
    try { await this.startPromise; } finally { this.startPromise = null; }
  }

  private async start(): Promise<void> {
    const bin = await resolveContext7Bin();   // see "binary resolution" below
    this.child = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CONTEXT7_API_KEY: ... } });
    this.child.on("exit", () => { this.child = null; this.client = null; });
    this.client = new Client({ name: "openez", version: "0.10.0" }, { capabilities: {} });
    await this.client.connect(new StdioClientTransport(this.child));
  }
}
```

**Binary resolution** (`resolveContext7Bin`):

1. Check registry config `context7.binPath` — if set, use it.
2. Else resolve `@upstash/context7-mcp` from the OpenEZ CLI's own `node_modules` (bundled as a dep of `apps/cli`).
3. Else throw a clear error pointing to `openez setup context7`.

**Two MCP calls exposed:**

```ts
async resolveLibraryId(query: string): Promise<{ id: string; name: string } | null>
//   calls context7's "resolve-library-id" tool with { libraryName: query }

async getLibraryDocs(input: {
  libraryId: string;
  topic?: string;
  tokens?: number;
}): Promise<{ content: string; tokens: number } | null>
//   calls context7's "get-library-docs" tool with { context7CompatibleLibraryID, topic, tokens }
```

**Lifecycle:**

- One `Context7Client` instance held in the MCP server module scope (singleton, like the existing `catchupState` map in `mcp-core.ts`).
- Spawned on first `library_docs` call, kept alive for the MCP server's lifetime.
- If the child dies unexpectedly, the next `ensureStarted()` respawns it transparently — callers don't need to know.
- No explicit teardown; the child dies with the parent MCP server process. (Adding graceful shutdown is YAGNI for a stdio MCP server that exits when stdio closes.)

**Concurrency:** `ensureStarted()` is guarded by `startPromise` so concurrent first calls don't double-spawn. Subsequent calls reuse the live client — MCP supports pipelined requests over the same stdio transport.

**API key:** read from registry config `context7.apiKey` (set by `openez setup context7`), passed to the child via `CONTEXT7_API_KEY` env var. Never logged.

## Setup & config

A new CLI command and config keys, mirroring the existing `openez setup <agent>` pattern.

**New command:**

```bash
openez setup context7 [path]
```

What it does (interactive, like `setup codex`):

1. Check if `@upstash/context7-mcp` is installed in the CLI's `node_modules`. If not, prompt: "Install @upstash/context7-mcp now? (y/n)". On yes → install (global or local — match whatever `setup codex` does for MCP server binaries).
2. Prompt for Context7 API key (free tier from context7.com). Store in registry config as `context7.apiKey`. Never echo it back.
3. Set `context7.enabled = true`, `context7.cacheTtlDays = 7`, `context7.binPath` = resolved path (or leave null to auto-resolve).
4. Print: "Context7 enabled. Restart your agent to pick up the new `library_docs` tool."

**New config keys** (in the existing registry config table, surfaced by `openez config get/set/list`):

| Key                     | Default | Purpose                                                                                                                 |
| ----------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| `context7.enabled`      | `false` | Gate the `library_docs` tool. When false, the tool is still registered but returns a clear "not enabled" error on call. |
| `context7.apiKey`       | (none)  | Context7 API key, passed to child as `CONTEXT7_API_KEY`.                                                                |
| `context7.binPath`      | `null`  | Optional explicit path to the context7-mcp binary. Null = auto-resolve from node_modules.                               |
| `context7.cacheTtlDays` | `7`     | Cache TTL in days.                                                                                                      |

**No changes to `setup codex`/`claude`/etc.** — Context7 is independent of which coding agent you use. A user can run `openez setup codex` and `openez setup context7` separately.

## Orchestration & error handling

`packages/core/src/external-docs/library-docs.ts` — the glue the MCP tool calls:

```ts
export async function libraryDocs(input: {
  library: string;
  topic?: string;
  version?: string;
  maxTokens?: number;
  noCache?: boolean;
}): Promise<LibraryDocsResult> {
  const settings = await getContext7Settings(); // from registry config
  if (!settings.enabled) {
    throw new Context7DisabledError(
      "Context7 integration is disabled. Run `openez setup context7` to enable.",
    );
  }

  const version = input.version ?? "latest";
  const ttlMs = settings.cacheTtlDays * 86_400_000;
  const now = Date.now();

  // 1. Cache lookup via name→ID map (unless noCache)
  if (!input.noCache) {
    const cached = await docsCache.findAnyByQuery({
      query: input.library,
      topic: input.topic,
      version,
    });
    if (cached && !cached.stale) {
      return formatResult(cached, { source: "cache", maxTokens: input.maxTokens });
    }
  }

  // 2. Resolve library ID via Context7
  await context7Client.ensureStarted();
  const resolved = await context7Client.resolveLibraryId(input.library);
  if (!resolved) {
    return emptyResult({
      library: input.library,
      hint: `No library found for '${input.library}'. Try the npm package name or a GitHub path like '/facebook/react'.`,
    });
  }

  // 3. Cache lookup by resolved ID (covers the case where name differs but ID matches)
  if (!input.noCache) {
    const cached = await docsCache.getDocs({
      libraryId: resolved.id,
      version,
      topic: input.topic,
      now,
    });
    if (cached && !cached.stale) {
      await docsCache.recordNameMapping(input.library, resolved.id);
      return formatResult(cached, { source: "cache", maxTokens: input.maxTokens });
    }
  }

  // 4. Fetch from Context7
  try {
    const fetched = await context7Client.getLibraryDocs({
      libraryId: resolved.id,
      topic: input.topic,
      tokens: input.maxTokens ?? defaultMaxTokens,
    });
    if (!fetched) {
      return emptyResult({ library: input.library });
    }

    // 5. Store in cache
    await docsCache.storeDocs({
      libraryId: resolved.id,
      libraryName: resolved.name,
      version,
      topic: input.topic,
      content: fetched.content,
      tokens: fetched.tokens,
      ttlMs,
    });
    await docsCache.recordNameMapping(input.library, resolved.id);

    return formatResult(fetched, {
      source: "context7",
      maxTokens: input.maxTokens,
      fetchedAt: now,
    });
  } catch (err) {
    // 6. Network/fetch failure → fall back to stale cache if any
    const stale = await docsCache.getDocs({
      libraryId: resolved.id,
      version,
      topic: input.topic,
      now,
    });
    if (stale) {
      return formatResult(stale, {
        source: "cache-stale",
        maxTokens: input.maxTokens,
        warning: "Context7 fetch failed; returning cached (possibly outdated) docs.",
      });
    }
    throw err; // surfaced by mcp-core's existing try/catch
  }
}
```

**Error categories and how they surface** (all routed through `mcp-core.ts`'s existing tool-call try/catch, which returns `{ content: [{ type: "text", text: ... }], isError: true }`):

| Failure                       | Behavior                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| `context7.enabled = false`    | `Context7DisabledError` → message tells user to run `openez setup context7`                    |
| Subprocess won't start        | Error message names `openez setup context7`                                                    |
| `resolve-library-id` no match | Empty result + hint (not an error)                                                             |
| `get-library-docs` empty      | Empty result (not an error)                                                                    |
| Network/fetch error           | Stale cache if available, else error                                                           |
| Cache DB error                | Treat as cache miss, continue to fetch (don't fail the whole call because the cache is broken) |

## File-by-file change map

**New files:**

| Path                                                  | Purpose                                           |
| ----------------------------------------------------- | ------------------------------------------------- |
| `packages/core/src/external-docs/context7-client.ts`  | MCP stdio client to context7-mcp subprocess       |
| `packages/core/src/external-docs/docs-cache.ts`       | SQLite TTL cache + name→ID map (registry DB)      |
| `packages/core/src/external-docs/library-docs.ts`     | Orchestration: cache → resolve → fetch → store    |
| `packages/core/src/external-docs/index.ts`            | Re-exports `libraryDocs`, `Context7DisabledError` |
| `packages/core/src/__tests__/context7-client.test.ts` | Subprocess client tests                           |
| `packages/core/src/__tests__/docs-cache.test.ts`      | Cache tests (in-memory SQLite)                    |
| `packages/core/src/__tests__/library-docs.test.ts`    | Orchestration tests (mocked deps)                 |
| `tests/context7.test.ts`                              | End-to-end with a stub Context7 MCP server        |
| `apps/cli/src/commands/setup-context7.ts`             | `openez setup context7` command                   |

**Modified files:**

| Path                                          | Change                                                                           |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| `packages/core/src/index.ts`                  | Re-export `libraryDocs`, `Context7DisabledError` from `external-docs/`           |
| `packages/db/src/migrations/`                 | New migration adding `library_docs_cache` + `library_docs_name_map` tables       |
| `packages/db/src/registry.ts` (or equivalent) | Add `libraryDocsCache` + `libraryDocsNameMap` repository methods                 |
| `apps/mcp/src/mcp-core.ts`                    | Register `library_docs` tool (schema + handler), hold `Context7Client` singleton |
| `apps/cli/src/commands/setup.ts` (or router)  | Wire `setup context7` subcommand to `setup-context7.ts`                          |
| `apps/cli/package.json`                       | Add `@upstash/context7-mcp` as optionalDependencies (or document manual install) |
| `AGENTS.md`                                   | Document `library_docs` tool + `openez setup context7` in MCP tools table        |
| `README.md`                                   | Add `library_docs` to MCP tools table + setup command to CLI section             |
| `CHANGELOG.md`                                | New `### Added` entry under next version                                         |
| `brain.config.ts`                             | Add `externalDocs.maxTokens` default (e.g. 8000) to retrieval defaults           |

**Not touched** (deliberately):

- `code_query` / `code_context` / `graph_neighbors` — stay pure local.
- Per-workspace DBs — cache is global only.
- `packages/indexer` — external docs are not indexed into FTS/vector.
- Web UI — `library_docs` is MCP/CLI-only for v1. A future "external docs" dashboard panel can read the cache table, but that's out of scope here.

**Dependency choice for `@upstash/context7-mcp`:** verify how Context7 ships its MCP server (npm package name, bin entry) before finalizing — this affects whether it's a `dependencies` or `optionalDependencies` entry and how `resolveContext7Bin` works. Confirm during implementation, not in the spec.

## Verification plan

**1. Unit tests (must pass):**

```bash
pnpm --filter @openez-graph/core test   # context7-client, docs-cache, library-docs
```

Covers: subprocess lifecycle, cache hit/miss/stale/upsert, name-mapping self-heal, disabled-state error, no-match hint, fetch-fail→stale fallback.

**2. DB migration test:**

A test that creates a fresh registry DB, runs the migration, and asserts both new tables + indexes exist with the right columns. Prevents "works on my DB" drift.

**3. Build gates (per AGENTS.md release workflow):**

```bash
pnpm build:web
pnpm build:cli
node apps/cli/dist/cli.cjs --version    # still prints
node apps/cli/dist/cli.cjs --help       # lists new `setup context7`
```

**4. CLI smoke test (temp dir):**

```bash
tmp=$(mktemp -d) && cd "$tmp"
node /path/to/openez.cjs setup context7 --api-key test-key --non-interactive
node /path/to/openez.cjs config get context7.enabled   # → true
node /path/to/openez.cjs config list | grep context7   # → 4 keys
```

**5. MCP end-to-end (stub Context7):**

`tests/context7.test.ts` spawns a stub MCP server that mimics `resolve-library-id` + `get-library-docs`, starts the OpenEZ MCP server pointing at the stub, and asserts:

- First `library_docs` call → `source: "context7"`, content present, cache row written.
- Second call (same library) → `source: "cache"`, no subprocess round-trip (assert stub not called).
- Call with `noCache: true` → `source: "context7"` again.
- Call after disabling `context7.enabled` → returns disabled error.
- Kill stub mid-call → next call falls back to stale cache with warning.

**6. Real Context7 smoke (manual, not in CI):**

One manual check against the real `@upstash/context7-mcp` — fetch React docs, confirm content is real markdown. Documented as a manual verification step, not automated (depends on network + API key).

**7. No regressions:**

```bash
pnpm test    # full suite, including existing retrieval tests
```

Confirm `code_query` / `code_context` behavior is unchanged — they must not touch the new tables or the subprocess.
