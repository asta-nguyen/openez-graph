<!-- GSD:project-start source:PROJECT.md -->

## Project

**OpenEZ Graph — Web UI Completion**

OpenEZ Graph is a local-first code intelligence system: a SQLite-backed indexing and retrieval engine with per-workspace databases, a CLI and MCP server for agent access, and a web management UI. This milestone focuses on completing and fixing the web UI — it is currently half-wired, with APIs that have no buttons, pages pinned to the wrong workspace, and several tables/tools (memories, query logs, chunks, symbols) that have no UI surface at all.

**Core Value:** The web UI must be a complete, correct management surface for OpenEZ — every workspace the registry knows about is selectable everywhere, every API that exists is wired to a UI action, and every table the engine writes is inspectable. A developer managing multiple workspaces should never see the wrong one silently.

### Constraints

- **Tech stack**: Must use existing stack — TanStack Router, Hono, shadcn/Radix, Three.js. No new UI framework.
- **Storage**: SQLite-first. No new Postgres or Redis dependencies for UI features.
- **Architecture**: Web app is the management layer, not the system center. UI features consume existing APIs; avoid duplicating engine logic in the web server.
- **Real-time**: SSE for indexing status (one-way stream). No WebSocket infrastructure.
- **Memories**: View-only in UI. The `memory_write` MCP tool remains the only write path.
- **Compatibility**: Must work with the existing multi-workspace registry model — no pinning to a single workspace.

<!-- GSD:project-end -->

<!-- GSD:stack-start source:codebase/STACK.md -->

## Technology Stack

## Languages

- TypeScript 5.8 - All application and package code (monorepo source in `apps/*` and `packages/*`)
- SQL - SQLite schema definitions (`packages/db/src/sqlite/workspace-db.ts`, `packages/db/src/sqlite/registry-db.ts`) and Drizzle migrations (`drizzle/0000_reset_schema.sql`)
- TOML - Codex config generation (`apps/cli/src/setup-codex.ts` via `smol-toml`)
- CSS - Tailwind v4 styling (`packages/ui/src/styles.css`, `apps/web/src/app/globals.css`)

## Runtime

- Node.js 24.x (implied by `@types/node` `^24.0.0` in root `package.json`)
- tsx for TypeScript execution without build step (CLI, MCP server, worker, web API)
- Browser runtime for web app (Vite dev server) and landing page (Next.js)
- pnpm 10.10.0 (declared in `package.json` `packageManager` field)
- Workspace protocol via `pnpm-workspace.yaml` (packages: `apps/*`, `packages/*`, `landing/`)
- Lockfile: `pnpm-lock.yaml` present

## Frameworks

- Hono 4.7.x - Web API server (`apps/web/src/server/index.ts`)
- Vite 6.3.x - Web app dev server and bundler (`apps/web/vite.config.ts`)
- TanStack Router 1.120.x - Client-side routing (`apps/web/src/routes/`)
- TanStack Query 5.75.x - Data fetching (`apps/web`)
- React 19.x - UI library for web app and UI package (`apps/web`, `packages/ui`)
- Next.js 16.2.9 - Landing page framework (`landing/`)
- Commander 14.x - CLI argument parsing (`apps/cli/src/cli.ts`, `apps/worker/src/cli.ts`)
- Model Context Protocol SDK 1.29.x - MCP server (`apps/mcp/src/mcp-core.ts`, `apps/cli/src/mcp-bridge.ts`)
- Vitest 3.2.x - Unit test runner (root `package.json`, `test` script)
- Turbo 2.x - Monorepo task orchestration (`turbo.json`: typecheck, lint, build)
- TypeScript 5.8.x - Type checking (`tsconfig.base.json`, per-package `tsconfig.json`)
- concurrently 9.x - Parallel dev processes (root `start` script, web `dev:all`)
- Drizzle Kit 0.30.x - Database migration generation (`drizzle.config.ts`)

## Key Dependencies

- better-sqlite3 12.10.x - Primary SQLite driver, WAL mode, native addon (`packages/db/src/sqlite/database-loader.ts`, `packages/db/src/sqlite/registry-db.ts`, `packages/db/src/sqlite/workspace-db.ts`)
- drizzle-orm 0.44.x - ORM for both SQLite (default) and PostgreSQL (optional) (`packages/db/src/client.ts`, `packages/db/src/sqlite/`)
- ts-morph 25.x - TypeScript/JavaScript AST parsing for rich code indexing (`packages/indexer/src/code.ts`)
- @modelcontextprotocol/sdk 1.29.x - MCP server protocol implementation (`apps/mcp/src/mcp-core.ts`)
- zod 3.25.x - Schema validation for env config and MCP tool inputs (`packages/config/src/env.ts`, `apps/mcp/src/mcp-core.ts`)
- bullmq 5.56.x - Background job queue (optional, worker path) (`packages/queue/src/index.ts`, `apps/worker/src/index.ts`)
- ioredis 5.5.x - Redis client for BullMQ (`packages/queue/src/index.ts`)
- pg 8.14.x - PostgreSQL client (optional, non-default) (`packages/db/src/client.ts`)
- openai 5.0.x - OpenAI embeddings API client (optional) (`packages/core/src/embeddings.ts`)
- ollama 0.5.x - Ollama local embeddings client (optional) (`packages/core/src/embeddings.ts`)
- chokidar 4.0.x - File watcher for incremental re-indexing (`apps/cli/src/cli.ts`)
- fast-glob 3.3.x - File scanning for indexer (`packages/indexer/src/scanner.ts`)
- unified/remark-parse/remark-gfm - Markdown parsing pipeline (`packages/indexer/src/markdown.ts`)
- three 0.184.x - 3D graph visualization (`apps/web`, `landing/`)
- Tailwind CSS 4.1.x - Utility-first styling (`packages/ui`, `apps/web`, `landing/`)
- shadcn/ui (new-york style) - Component system (`components.json`, `packages/ui/src/components/`)
- Radix UI - Primitives for dialogs, tooltips, slots, separators (`packages/ui`, root `package.json`)
- lucide-react 0.511.x - Icon library (`packages/ui`, `apps/web`, `landing/`)

## Configuration

- `.env.example` - Documents optional env vars (all optional, SQLite is default)
- Env loading via dotenv with workspace-root traversal (`packages/config/src/env.ts`)
- Zod-validated env schema (`packages/config/src/env.ts`): `DATABASE_URL`, `EMBEDDING_PROVIDER`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_EMBEDDING_MODEL`, `OLLAMA_BASE_URL`, `OLLAMA_EMBEDDING_MODEL`, `MINIMAX_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `REDIS_URL`, `AI_MEMORY_REGISTRY_DB_PATH`
- Project config via `brain.config.ts/js/mjs` (optional, searched up from cwd) (`packages/config/src/load-brain-config.ts`)
- `tsconfig.base.json` - Shared TS config (ES2022, Bundler resolution, strict, path aliases for all workspace packages)
- `turbo.json` - Task pipeline (typecheck, lint, build with `^` dependencies)
- `apps/web/vite.config.ts` - Vite config with TanStack Router plugin, React plugin, `/api` proxy to port 3001
- `drizzle.config.ts` - Drizzle Kit config (PostgreSQL dialect, schema at `packages/db/src/schema.ts`, output `./drizzle`)
- `components.json` - shadcn/ui config (new-york style, zinc base color, aliases to `packages/ui/src/`)
- `landing/next.config.ts` - Next.js config with `outputFileTracingRoot`

## Platform Requirements

- macOS/Linux/Windows (any platform with Node.js 24.x)
- Native compilation for `better-sqlite3` (requires build tools: `python3`, `make`, C++ compiler)
- Docker optional for PostgreSQL (`pgvector/pgvector:pg16`) and Redis (`redis:7-alpine`) via `docker-compose.yml`
- pnpm 10.10.0 required
- Local-first: runs on user's Node.js installation, no server deployment required for default path
- Landing page: deployed as Next.js app (production URL `https://openez.astalife.co` per `landing/src/lib/url.ts`)
- Web management UI: local dev only (Vite on port 3000, API on port 3001)
- Optional: PostgreSQL with pgvector for non-default storage, Redis for background queue

<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->

## Conventions

## Naming Patterns

- kebab-case for all source files (`index-workspace.ts`, `load-brain-config.ts`, `mcp-bridge.ts`, `setup-codex.ts`)
- React components: kebab-case `.tsx` (`packages/ui/src/components/button.tsx`, `code-block.tsx`)
- Route files follow TanStack Router file-based convention (`apps/web/src/routes/workspaces/$workspaceId.tsx`, `__root.tsx`)
- `index.ts` for barrel exports at each package's `src/` root
- Test files: `*.test.ts` (only `tests/chunking.test.ts` exists at repo root)
- camelCase for all functions (`indexMarkdown`, `memoryQuery`, `createRegistryRepository`)
- No special prefix for async functions
- Handlers: `handleEventName` (`handleSubmit`, `handleValidatePath` in `apps/web/src/routes/workspaces/new.tsx`)
- Factory functions: `createX` returning object literals (`createRegistryRepository`, `createWorkspaceRepository`, `createWorkspaceResolver`, `createWorkspaceFileResolver`)
- camelCase for variables and parameters
- UPPER_SNAKE_CASE for module-level constants (`DEFAULT_INCLUDE_PATTERNS`, `WORKSPACE_DB_DIR_NAME`, `OLLAMA_EMBED_MAX_TOKENS`, `RESOLVABLE_SOURCE_EXTENSIONS`, `DEFAULT_INCLUDE_GLOBS`)
- No underscore prefix for private members; use TypeScript `private` keyword (see `OpenAIEmbeddingProvider` in `packages/core/src/embeddings.ts`)
- Interfaces: PascalCase, no `I` prefix (`RegistryWorkspace`, `WorkspaceRepository`, `IndexedChunk`, `EmbeddingProvider`)
- Type aliases: PascalCase (`BrainEnv`, `WorkspaceLike`)
- No enums; use string literal unions (`status: "pending" | "indexing" | "indexed" | "error"` in `packages/db/src/sqlite/types.ts`)
- `as const` for literal-typed arrays/objects (`RESOLVABLE_SOURCE_EXTENSIONS`)

## Code Style

- No Prettier/ESLint/Biome config present; style enforced by convention and `tsc`
- Double quotes for strings (consistent across all source)
- Semicolons required
- 2-space indentation
- Trailing commas in multi-line objects/arrays
- No enforced line length; long SQL/template strings are kept on one line
- No linter configured
- `turbo run lint` task defined in `turbo.json` but no per-package lint script exists
- Type safety enforced via `tsc -p tsconfig.json` (`typecheck` script in every package)
- `strict: true`, `target: "ES2022"`, `module: "ESNext"`, `moduleResolution: "Bundler"` (`tsconfig.base.json`)
- `isolatedModules: true`, `noEmit: true`, `allowJs: false`
- ESM throughout (`"type": "module"` in every `package.json`)
- `import type` for type-only imports
- `satisfices` operator for type-checked literals (`scanner.ts`)
- Web app overrides: `target: "ES2020"`, `jsx: "react-jsx"`, `paths: { "@/*": ["./src/*"] }` (`apps/web/tsconfig.json`)

## Import Organization

- Blank line between each group
- Alphabetical within groups is common but not strict
- `@openez-graph/config`, `@openez-graph/db`, `@openez-graph/core`, `@openez-graph/indexer`, `@openez-graph/queue`, `@openez-graph/ui`, `@openez-graph/ui/*` (defined in `tsconfig.base.json`)
- `@/*` maps to `apps/web/src/*` (web app only)
- Workspace deps declared as `"workspace:*"` in `package.json`

## Error Handling

- Throw `Error` with descriptive template-literal messages; no custom error classes
- Catch at boundaries: CLI top-level (`program.parseAsync(...).catch(...)` in `apps/cli/src/cli.ts`), MCP server start (`apps/mcp/src/server.ts`), Hono route handlers (`apps/web/src/server/index.ts`)
- Async functions use `try/catch`; no `.catch()` chains except top-level process handlers
- Normalize errors: `error instanceof Error ? error.message : String(error)` (used in `index-workspace.ts`, `apps/web/src/server/index.ts`)
- Throw on missing workspace, invalid input, invariant violations (`throw new Error("Workspace '${id}' not found")` in `packages/core/src/retrieval.ts`, `packages/core/src/graph.ts`)
- Return `null` for optional lookups (`getWorkspace` returns `RegistryWorkspace | null`)
- Hono handlers return JSON error shapes `{ ok: false, error: message }` or `{ success: false, error }` instead of throwing to the client
- Non-fatal failures logged and skipped (embeddings in `index-workspace.ts` catches and returns `0`)

## Logging

- `console.log` / `console.error` only; no pino/winston/custom logger
- No structured logging; messages are human-readable strings
- `console.error` for failures and diagnostics (`apps/web/src/server/index.ts`, `index-workspace.ts`)
- `console.log` for CLI user output and JSON summaries (`apps/cli/src/cli.ts` prints `JSON.stringify(summary, null, 2)`)
- `console.error(error)` at process exit boundaries
- No log levels; no logging in pure library packages (`core`, `db`, `config`)

## Comments

- Section dividers using box-drawing: `// ── Document Operations ──` (`packages/db/src/sqlite/repository.ts`, `apps/cli/src/cli.ts`)
- Minimal inline comments; code is expected to be self-explanatory
- No TODO/FIXME/HACK comments in source (only in vendored `dist/` bundles)
- Not used in source code
- Public API surface is documented via TypeScript types and interface definitions (`packages/db/src/sqlite/types.ts`)
- Not present; use git history for tracking

## Function Design

- Functions range from small helpers to long orchestrators (`indexWorkspace` in `index-workspace.ts` is ~300 lines)
- Extract helpers for reusable logic (`splitLargeChunk`, `safeParseJson`, `mapWorkspaceRow`, `normalizeRootPath`)
- Object parameter pattern for public APIs: `function memoryQuery(input: { workspaceId, query, limit?, ... })`
- Destructure in signature for simple cases
- Options objects for 3+ params (`indexWorkspace`, `scanWorkspaceFiles`, `createAndStartMcpServer`)
- Explicit returns; `Promise<T>` for async
- Early returns for guard clauses (`if (!workspace) throw ...`, `if (seedIds.length === 0) return []`)
- Factory functions return typed object literals conforming to interfaces

## Module Design

- Named exports only; no default exports except React components (`Button` in `packages/ui/src/components/button.tsx`)
- Factory functions exported directly (`export function createRegistryRepository()`)
- Types co-exported with `export type { ... }` and `export interface`
- `src/index.ts` re-exports public API via `export * from "./module"` (`packages/core/src/index.ts`, `packages/config/src/index.ts`, `packages/db/src/index.ts`)
- Internal helpers not exported from barrel (kept private to package)
- `packages/db` exposes subpath exports: `"."` and `"./sqlite"` (`packages/db/package.json`)
- `packages/ui` exposes `"."`, `"./styles.css"`, `"./components/*"`, `"./lib/*"`
- Avoid circular deps by importing from specific files when needed (`packages/core/src/retrieval.ts` imports `./rrf`, `./tokenizer` directly)
- Repository pattern: factory returns object literal implementing an interface (`createRegistryRepository`, `createWorkspaceRepository` in `packages/db/src/sqlite/repository.ts`)
- Provider pattern with strategy selection (`getEmbeddingProvider` in `packages/core/src/embeddings.ts`)
- Zod schemas for runtime validation of env (`packages/config/src/env.ts`) and MCP tool args (`apps/mcp/src/mcp-core.ts`)
- Drizzle ORM + raw SQL with `?` placeholders; `safeParseJson` helper for JSON columns

<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->

## Architecture

## Pattern Overview

- Multi-app pnpm monorepo (CLI, MCP server, web dashboard, background worker) sharing internal packages
- SQLite-first storage: a global registry DB plus one per-workspace DB, both in WAL mode
- Engine/runtime/UI separation: `packages/core` (engine), `packages/db` + `packages/indexer` (runtime), `apps/web` (management UI)
- CLI and MCP are the primary workflows; the web app is an operational/inspection layer, not the system center
- Queue/worker (BullMQ/Redis) is compatibility-only, not the default runtime path
- Embeddings are optional and disabled by default; retrieval defaults to FTS + graph expansion

## Layers

- Purpose: Provide user-facing entry points — CLI commands, MCP tool surface, web API + UI, background worker
- Contains: Commander command definitions, MCP request handlers, Hono API routes, TanStack Router pages, BullMQ worker process
- Location: `apps/cli/src/cli.ts`, `apps/mcp/src/mcp-core.ts`, `apps/web/src/server/index.ts`, `apps/web/src/routes/`, `apps/worker/src/index.ts`
- Depends on: `packages/core`, `packages/db`, `packages/indexer`, `packages/config`, `packages/queue`, `packages/ui`
- Used by: End users (CLI), MCP clients (Codex/Claude/OpenCode), browser (web), operators (worker)
- Purpose: Retrieval, graph traversal, memory persistence, tokenization, ranking, and optional embeddings
- Contains: `memoryQuery`, `codeContext`, `graphNeighbors`, `memoryWrite`, `reciprocalRankFusion`, `countTokens`, embedding providers
- Location: `packages/core/src/retrieval.ts`, `packages/core/src/graph.ts`, `packages/core/src/memory.ts`, `packages/core/src/rrf.ts`, `packages/core/src/tokenizer.ts`, `packages/core/src/embeddings.ts`
- Depends on: `packages/db` (registry + workspace repositories), `packages/config` (settings)
- Used by: MCP server, web API server, worker CLI (benchmark)
- Purpose: Persist workspace metadata and indexed artifacts; scan, parse, chunk, and graph-build file content
- Contains: SQLite registry/workspace DB loaders, repository factories, schema definitions, file scanner, language parsers, chunkers, graph construction
- Location: `packages/db/src/sqlite/repository.ts`, `packages/db/src/sqlite/registry-db.ts`, `packages/db/src/sqlite/workspace-db.ts`, `packages/indexer/src/index-workspace.ts`, `packages/indexer/src/code.ts`, `packages/indexer/src/languages.ts`, `packages/indexer/src/markdown.ts`
- Depends on: `packages/config` (settings), `packages/core` (tokenizer, embeddings), `better-sqlite3`, `drizzle-orm`, `ts-morph`, `fast-glob`
- Used by: Engine layer (repositories), CLI (indexing), MCP (index_workspace tool), web server (direct SQLite reads), worker
- Purpose: Environment loading, brain.config.* parsing, default chunking/retrieval settings
- Contains: Zod env schema, config file discovery/evaluator, default settings
- Location: `packages/config/src/env.ts`, `packages/config/src/load-brain-config.ts`, `packages/config/src/types.ts`
- Depends on: `dotenv`, `zod`
- Used by: Engine, runtime, and entry layers
- Purpose: Reusable shadcn/Radix-based React components for the web app
- Contains: Button, Card, Table, Sidebar, Tooltip, Sheet, Skeleton, etc.
- Location: `packages/ui/src/components/`, `packages/ui/src/components/ui/`
- Depends on: `radix-ui`, `class-variance-authority`, `tailwind-merge`
- Used by: `apps/web`
- Purpose: BullMQ job queue abstraction for background indexing (not the default path)
- Contains: Redis connection, queue/job status serialization, cancellation
- Location: `packages/queue/src/index.ts`
- Depends on: `bullmq`, `ioredis`, `packages/config`
- Used by: `apps/worker` (and partially by web UI jobs surface)

## Data Flow

- File-based SQLite: global registry at `~/.openez/registry.sqlite`, per-workspace at `<root>/.openez/index.sqlite`
- In-process DB connection caching: `registryDb` singleton (`packages/db/src/sqlite/registry-db.ts`), `dbCache` Map keyed by rootPath (`packages/db/src/sqlite/workspace-db.ts`)
- Project-local hint: `<root>/.openez/workspace.json` (not committed, auto-gitignored)
- No persistent in-memory state across processes; each CLI/MCP/worker invocation is independent
- Web server maintains its own separate SQLite connection pool (`apps/web/src/server/sqlite.ts`) independent of `packages/db`

## Key Abstractions

- Purpose: Data access boundary over SQLite — workspace CRUD, document/chunk/graph/memory persistence, FTS, graph traversal
- Examples: `createRegistryRepository()` → `RegistryRepository`, `createWorkspaceRepository(rootPath)` → `WorkspaceRepository`
- Pattern: Factory function returning typed interface; defined in `packages/db/src/sqlite/types.ts`, implemented in `packages/db/src/sqlite/repository.ts`
- Note: Uses Drizzle ORM for some queries but falls back to raw `native.prepare()` SQL for most operations
- Purpose: Resolve workspace scope from MCP/CLI input — explicit ID, path, or default discovery
- Examples: `createWorkspaceResolver()` in `apps/mcp/src/mcp-core.ts`
- Pattern: Closure-based factory with `resolveReadWorkspaces` (multi-workspace) and `resolveWriteWorkspace` (single)
- Default resolution chain: `.openez/workspace.json` → registry path match → single-workspace fallback → ambiguity error
- Purpose: Scan → parse → chunk → graph-build → embed, per workspace
- Examples: `indexWorkspace()` in `packages/indexer/src/index-workspace.ts`
- Pattern: Orchestrator function with progress callbacks; dispatches to language-specific parsers via `chunkDocument()`
- Incremental via content hash + mtime skip; full mode via `repo.resetAll()`
- Purpose: Extract symbols, imports, chunks, and call identifiers from source files
- Examples: `indexCode()` (ts-morph, TS/JS), `parsePython()`, `parseGo()`, `parseRust()`, `indexMarkdown()`, `indexConfig()`
- Pattern: Function returning `IndexedCodeResult` or chunk arrays; regex-based for Python/Go/Rust, AST-based for TS/JS
- Location: `packages/indexer/src/code.ts`, `packages/indexer/src/languages.ts`, `packages/indexer/src/markdown.ts`
- Purpose: Rank and fuse multi-source context for a query
- Examples: `memoryQuery()` in `packages/core/src/retrieval.ts`
- Pattern: FTS + optional vector search → RRF fusion → graph expansion → second RRF → token-budget selection
- Purpose: Optional vector embeddings for semantic search
- Examples: `OpenAIEmbeddingProvider`, `OllamaEmbeddingProvider`, `getEmbeddingProvider()` factory
- Pattern: Strategy pattern; `null` when `EMBEDDING_PROVIDER=none` (default)
- Location: `packages/core/src/embeddings.ts`
- Purpose: Expose engine operations as MCP tools over stdio transport
- Examples: `list_workspaces`, `memory_query`, `code_context`, `graph_neighbors`, `memory_write`, `index_workspace`
- Pattern: Zod schema validation → resolver → core function → JSON response; defined in `apps/mcp/src/mcp-core.ts`

## Entry Points

- Location: `apps/cli/src/cli.ts` (main: `./src/cli.ts`)
- Triggers: `pnpm openez <command>` (via `tsx`)
- Responsibilities: Register Commander commands (init, index, reindex, watch, status, list, serve, setup), parse args, call registry/indexer, print JSON, exit
- Location: `apps/mcp/src/server.ts` (standalone), `apps/cli/src/mcp-bridge.ts` (via CLI `serve --mcp`)
- Triggers: `pnpm mcp` or `openez serve --mcp`
- Responsibilities: Parse `--path` arg, call `createAndStartMcpServer()`, register tool schemas + handlers, connect stdio transport
- Location: `apps/web/src/main.tsx`
- Triggers: `pnpm dev:web` (Vite dev server)
- Responsibilities: Mount React root, configure QueryClient (1h staleTime), create TanStack Router with queryClient context
- Location: `apps/web/src/server/index.ts`
- Triggers: `pnpm dev:api` (tsx) or `pnpm dev:all` (concurrent)
- Responsibilities: Hono app with CORS, REST routes (`/api/dashboard`, `/api/workspaces`, `/api/documents`, `/api/jobs`, `/api/query`, `/api/settings/env`), direct SQLite reads via `apps/web/src/server/sqlite.ts`
- Location: `apps/worker/src/index.ts` (BullMQ worker), `apps/worker/src/cli.ts` (legacy CLI with benchmark)
- Triggers: `pnpm worker` (requires Redis)
- Responsibilities: Consume `index-workspace` queue, call `indexWorkspace()` with progress reporting
- Location: `apps/cli/src/setup-codex.ts`, `apps/cli/src/setup-claude.ts`, `apps/cli/src/setup-opencode.ts`
- Triggers: `openez setup codex|claude|opencode [path]`
- Responsibilities: Write/update MCP server entry in agent config files (`~/.codex/config.toml`, `~/.claude/settings.json`, `~/.config/opencode/opencode.json`)

## Error Handling

- CLI: `program.parseAsync().catch((error) => { console.error(error); process.exit(1); })` at `apps/cli/src/cli.ts:272`
- CLI commands: `process.exit(1)` on validation failures (path missing, not a directory)
- MCP: Zod `.parse()` throws on invalid tool args; resolver throws on workspace not found / ambiguity; errors bubble to MCP SDK
- Indexer: try/catch around indexing loop — on failure, `completeIndexRun` with `status: "failed"` + `errorMessage`, registry updated to `status: "error"`, error re-thrown
- Web API: try/catch per route, returns `{ ok: false, error: message }` or fallback empty JSON; dashboard returns `databaseAvailable: false` on DB error
- Embeddings: failure caught and logged, returns 0 (non-fatal — indexing continues without embeddings)
- Repository: `safeParseJson()` helper with fallback for malformed JSON metadata

## Cross-Cutting Concerns

- `console.log` for normal output (JSON summaries, status messages)
- `console.error` for errors and warnings (embedding failures, catch blocks)
- No structured logger; output is human-readable text or JSON
- Zod schemas at MCP tool boundary (`apps/mcp/src/mcp-core.ts`: `memoryQuerySchema`, `codeContextSchema`, etc.)
- Zod env schema in `packages/config/src/env.ts` (`envSchema` with defaults)
- Manual validation in CLI commands (path existence, directory checks)
- TypeScript interfaces for repository contracts (`packages/db/src/sqlite/types.ts`)
- Environment: `.env` auto-discovered upward from package dir (`packages/config/src/env.ts`); `AI_MEMORY_REGISTRY_DB_PATH` overrides registry location
- Brain config: `brain.config.{mjs,js,ts}` discovered upward; evaluated via `new Function()` sandbox; defaults from `getDefaultSettings()` (`packages/config/src/types.ts`)
- Defaults: chunking `targetTokens: 512`, `overlapTokens: 50`; retrieval `finalLimit: 10`, `maxContextTokens: 4000`
- Registry DB: module-level singleton (`registryDb` in `packages/db/src/sqlite/registry-db.ts`), WAL + foreign keys enabled
- Workspace DBs: `Map<string, DrizzleDB>` cache keyed by rootPath (`packages/db/src/sqlite/workspace-db.ts`), WAL + foreign keys
- Web server: separate connection pool (`apps/web/src/server/sqlite.ts`) — does NOT use `packages/db` repositories
- Native addon resolution: `packages/db/src/sqlite/database-loader.ts` resolves `better-sqlite3` native binding
- Canonical key: `workspaceId` (slugified from name, de-duplicated with suffixes)
- Path normalization: `normalizeRootPath()` trims trailing slashes
- Local hint: `findLocalWorkspaceConfig()` walks upward from cwd looking for `.openez/workspace.json`
- Auto-gitignore: `writeLocalWorkspaceConfig()` ensures `.openez/` is in workspace `.gitignore`
- `fast-glob` with default include (code + config + markdown extensions) and exclude patterns
- `.gitignore` patterns loaded and merged (`packages/indexer/src/scanner.ts`)
- Workspace `includeGlobs`/`excludeGlobs` override defaults

<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->

## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->

## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:

- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->

## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
