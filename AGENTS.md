# AGENTS.md

This file provides project-specific guidance for agents working in this repository.

## Project Overview

OpenEZ Graph is a local-first code intelligence system with:

- a CodeGraph-style indexing and retrieval engine
- a SQLite runtime with workspace registry and per-workspace databases
- a management UI
- MCP access over the same indexed runtime

Treat the repo as SQLite-first, multi-workspace, and CLI/MCP-first, with the web app as a management layer rather than the center of the system.

## Storage Model

Use SQLite in WAL mode as the default storage model.

- global registry DB under `~/.openez/`
- per-workspace DB under `<root>/.openez/`
- project-local workspace hint under `<root>/.openez/workspace.json`

Do not assume Postgres, `pgvector`, Redis, or BullMQ are part of the default path.

## Workspace Bootstrap

`openez init <path>` and `openez index <path>` should keep `<path>/.openez/workspace.json` up to date.

That file is a local hint for agents and MCP resolution. It is not a committed project artifact and should remain ignored by Git.

Expected shape:

```json
{
  "workspaceId": "openez",
  "rootPath": "/abs/path/to/project",
  "name": "openez",
  "updatedAt": "2026-05-24T14:00:38.958Z"
}
```

## Commands

The intended command shape is:

```bash
openez init [path]          register workspace and run initial index (--no-index to skip)
openez index [path]
openez reindex [path]
openez watch [path]
openez status [path]
openez diff [ref]
openez list
openez remove [path]        remove workspace from registry and delete its .openez data dir (--id, -y; alias: rm)
openez serve --mcp
openez setup codex
```

Do not bias new work toward `--workspace`, `main-project`, or pinned single-workspace assumptions.

`openez diff` scopes are:

```bash
openez diff          # tracked staged + unstaged changes
git diff HEAD        # equivalent Git default: tracked staged + unstaged changes
openez diff --staged # staged changes only
openez diff HEAD~1   # diff against the supplied Git ref
```

For the `diff_context` MCP tool, `path`/`paths` select registered workspace
roots, not changed files. Untracked files are not included in this Git-diff
phase. The response is always `{ workspaces: [...] }`, even for a single
workspace or a top-level validation error. `maxTokens` bounds the response;
`formattedSummary` is dropped before structured symbols/files. Each entry in
the `workspaces` array is either a success `{ workspaceId, workspaceName, report }`
or an error `{ error, workspaceId?, workspaceName?, ref?, staged? }`. Top-level
errors (ref + staged, invalid ref, unregistered workspace) omit `workspaceId`
and `workspaceName` since no workspace was resolved.

## MCP-First Workflow

For questions about a codebase that has been indexed:

1. Use MCP tools before reading files directly.
2. Start with `code_query` for broad code/documentation questions.
3. Use `code_outline` for a cheap AST-level outline of a single file (functions, classes, exports with line numbers) before reading the full file.
4. Use `code_context` for symbol- or file-specific follow-up.
5. Use `graph_neighbors` when relationship inspection is needed.
6. Use `memory_recall` for previously stored technical decisions and agent notes.
7. Only fall back to direct file reads when MCP results are insufficient or need verification.

When no explicit workspace scope is provided, MCP should default by reading `.openez/workspace.json` from the current project or one of its parent directories.

For cross-workspace questions, pass explicit multi-workspace scope:

- `workspaceIds`
- or `paths`

## Code Search Rules (MANDATORY)

These rules apply to ALL agents working in this repository. Violating them wastes tokens and context window.

### When to use OpenEZ MCP tools

- **ALWAYS** use `code_query` instead of `grep`/`ripgrep`/`find` when searching for code by concept, function name, or behavior. `code_query` returns ranked, token-budgeted chunks — not entire files.
- **ALWAYS** use `code_outline` before reading a full file when you only need its structure (functions, classes, methods, exports with line numbers).
- **ALWAYS** use `code_context` when you need to understand what calls/imports a specific symbol or file.
- **ALWAYS** use `memory_recall` at the start of a session to load prior architectural decisions.
- **ALWAYS** use `memory_write` when the user makes an architectural decision or you discover a non-obvious technical constraint.

### When NOT to use OpenEZ

- You know the **exact file path** and need to read/edit it — use `read_file` directly.
- The codebase has **not been indexed** (`openez index` not run) — `code_query` will return empty.
- You need to **modify** code, not search for it — OpenEZ is read-only retrieval.

### Token savings tracking

Every `code_query` call logs `tokens_returned`, `tokens_saved`, and `files_scanned` to the `query_logs` table. The dashboard at `/` shows aggregate token savings. Use this data to verify that OpenEZ is reducing context window usage.

### Setup

```bash
openez setup codex    # or claude, opencode, windsurf
```

This configures MCP server access. After setup, the agent automatically sees `code_query`, `code_outline`, `code_context`, `graph_neighbors`, `memory_write`, `memory_recall`, `index_workspace`, `remove_workspace`, and `list_workspaces` as available tools. `remove_workspace` is destructive (deletes the registry entry and `<root>/.openez/`) and requires `confirm: true`.

## MCP Expectations

MCP should be multi-workspace aware.

- `code_query`, `code_context`, `graph_neighbors`, and `memory_recall` should support one or many workspaces
- `code_outline`, `memory_write`, `index_workspace`, and `remove_workspace` remain single-workspace operations
- `list_workspaces` should expose the registered workspace inventory
- `workspaceId` is the canonical internal key

## Indexing Expectations

- TS/JS: richest indexing path via oxc-parser (Rust-based, 13x faster than Babel). Extracts top-level functions, nested functions, class declarations, and class methods as first-class graph symbols.
- JavaScript call edges resolve through static module bindings instead of a global name lookup: ESM default/named/aliased/namespace imports and re-exports, and static CommonJS `require`/`exports` forms (`exports.name`, `module.exports.name`, object-literal `module.exports` whose property maps to one local declaration). A call resolves only to a unique exported symbol in the bound workspace module — external packages, computed/dynamic requires, and unresolved or ambiguous exports produce no call edge. The 30-symbol and 20-call graph caps are removed for JavaScript only.
- TypeScript/TSX call edges use the same binding-based resolution with TypeScript-aware module lookup: relative specifiers, `paths` mappings and `baseUrl` from the nearest workspace `tsconfig.json` (one relative `extends` hop, JSONC tolerated), and `.js`→`.ts/.tsx/.d.ts` extension substitution. `import type`/`export type` specifiers never produce `calls` edges (they still join file-level `imports` edges), a local parameter or variable shadows an imported name, and TS callers may resolve exports in any TS/JS module — while JS/JSX callers still drop targets outside `javascript`/`jsx`. The 30-symbol and 20-call graph caps are removed for TypeScript as well.
- Binding metadata rides in the `parsed_documents.imports` JSON payload under `oxc-v5`; a parser-version mismatch triggers reparse during graph construction, so run `openez reindex <path>` after upgrading to rebuild stale rows and graph artifacts (a no-op `openez index` is not sufficient).
- Python/Go/Rust/Ruby: tree-sitter AST symbol extraction with optional Rust-native parsing (`native-v5` rows) and WASM/regex fallback (`fallback-v5` rows). Ruby: `class << self` context-only nesting, `self.foo` qualified to the enclosing class/module, constant receivers (`Invoice.build`, `Billing::Invoice.build`) recorded as `Scope::method`, ordinary receivers (`other.tax`, `@client.get`, `user&.name`) and dynamic calls (`send`, `public_send`, `method_missing`, `eval`, `const_get`, `respond_to?`) produce no edge. Call edges are scope-aware and unique-only: bare calls resolve to the caller's own class/module (reopened classes across files included) then top-level methods, `::`-qualified callees walk the caller's lexical scopes; ambiguous labels resolve to nothing. `require_relative` resolves literal `.rb` paths only — a same-stem `.md` never captures the edge. No Ruby symbol/call graph caps. Inherited, mixin, and dynamic dispatch are not resolved.
- Python: call edges resolve through static bindings, never a global name lookup. `import m`, `import m.n as a`, `from m import n`, and relative `from .`/`from ..` forms bind names to workspace modules resolved through source roots (workspace root plus each non-package ancestor of the importer; a root holding both `a.py` and `a/__init__.py` is ambiguous). Bare calls walk enclosing function scopes (class scopes skipped), then module scope, then a unique import binding; `pkg.f()`/`m.n()` walk dotted paths from a bound root; `self`/`cls` resolve to methods on the enclosing class; `Class.f()` resolves only for statically bound classes. Named re-exports are followed up to three modules deep with a cycle guard; star imports never expand. Function-local imports apply only inside their scope and conflict with any other binding of the same name. Local shadowing (params, assignments, loop/`with`/`except`/walrus targets, nested defs) drops the call, as do unresolved, external, or ambiguous targets. Python files are exempt from the 30-symbol/20-call graph limits. Run `openez reindex <path>` after upgrading so `native-v5`/`fallback-v5` rows rebuild.
- Go: package-level functions, methods, types, consts, and vars (including grouped declarations) are symbols. Calls resolve only to unique in-workspace targets via `go.mod` module paths and declared package names — `pkg.F()` binds through the file's import mapping, bare `f()` resolves inside the caller's own package only, and receiver-qualified `Type::method` names keep the same-file lookup. Unresolved, ambiguous, unexported, and shadowed calls produce no edge; shadowing is function-granular (receivers, params, results, `:=`/`var`/`const`). Files under `vendor/` are text-indexed but excluded from the graph, and Go files are exempt from the 30-symbol/20-call graph limits. Run `openez reindex <path>` after upgrading so `native-v5`/`fallback-v5` rows rebuild.
- Rust: call edges resolve through crate module paths instead of a global name lookup, so same-named functions in unrelated modules never link. Crates are discovered from each file's nearest `Cargo.toml` (roots: `src/lib.rs`, `src/main.rs`, `src/bin/*.rs`, `src/bin/*/main.rs`); modules follow Rust's file rules (`mod x;` → `x.rs` or `x/mod.rs`, both-or-neither unresolved; inline `mod` blocks stay file-local). Callee paths keep qualifiers and turbofish is stripped (`parse::<u8>` → `parse`). `crate`/`self`/repeated `super` paths, child-module paths, explicit `use` bindings (groups, `self`, `as`, `pub use` re-export forwarding up to three hops), and the crate's own package-library name resolve to a unique in-crate symbol; `Type::f`, `Self::f`, and `self.m()` resolve for statically known types. External crates, glob imports, unknown receivers (`x.m()`, chained calls), shadowed locals (params, `let`/`for`/`if let`/`match`/closure bindings), and ambiguous or unresolved paths produce no edge. Rust files are exempt from the 30-symbol/20-call graph limits. Run `openez reindex <path>` after upgrading so `native-v5`/`fallback-v5` rows rebuild.
- CoffeeScript/Slim/CSS/SCSS/SASS/LESS/Haml: scanner inclusion + fallback chunking only (no symbol extraction).
- YAML/JSON/TOML: structure-aware chunking
- Markdown: section-oriented chunking

Retrieval defaults to FTS + graph expansion. Embeddings are optional and should not be assumed to exist.

## Working Guidance

- Prefer changes that reinforce the engine/runtime/UI separation.
- Avoid introducing new hard dependencies on Postgres or Redis for the default path.
- Avoid assuming the web app is the center of the system.
- Prefer local-first, low-setup operational choices.
- When validating agent behavior, test MCP-first flows in a fresh session after `openez setup codex`.

## Release Workflow

When the user asks to "release", "publish", "deploy cli", or "bump version", follow this tight loop — every step has a checkable gate before moving on.

### 1. Determine the version bump

Read `apps/cli/package.json` for the current version. Classify changes since last release:

- **Patch**: UI fixes, doc updates, minor bug fixes, no new features.
- **Minor**: New features, significant fixes (security, data integrity), new routes/pages.
- **Major**: Breaking changes to CLI commands, MCP tool signatures, or DB schema.

Default to **minor** when multiple fixes ship together. Ask the user if unsure.

### 2. Bump version

Edit `apps/cli/package.json` — update the `"version"` field only.

### 3. Update CHANGELOG.md

Add a new `## [X.Y.Z] - YYYY-MM-DD` section at the top of `CHANGELOG.md` using [Keep a Changelog](https://keepachangelog.com/) groups:

- `### Added` — new features, routes, UI pages
- `### Changed` — changes to existing functionality
- `### Removed` — deleted features, removed endpoints
- `### Fixed` — bug fixes, security patches
- `### Security` — security-relevant fixes

Each entry is one bullet. Add a compare link at the bottom.

### 4. Fetch native binaries

The CLI ships the three CI-built `.node` binaries in `dist/native/`. They are
not committed to Git — download them from GitHub Actions before building:

```bash
# Use the successful native.yml run for the release commit. If that commit has
# no run (native.yml is path-filtered), fall back to the run for the last
# commit that touched packages/native/ — its binaries are identical.
NATIVE_SHA=$(git log -1 --format=%H origin/main -- packages/native)
RUN_ID=$(gh run list --workflow native.yml --commit "$NATIVE_SHA" --status success --limit 1 --json databaseId -q '.[0].databaseId')

gh run download "$RUN_ID" -n native-linux-x64-gnu -D packages/native
gh run download "$RUN_ID" -n native-darwin-arm64 -D packages/native
gh run download "$RUN_ID" -n native-win32-x64-msvc -D packages/native
```

Then require exactly these three files and no other `index.*.node` in
`packages/native/`:

```bash
ls packages/native/index.linux-x64-gnu.node \
   packages/native/index.darwin-arm64.node \
   packages/native/index.win32-x64-msvc.node
ls packages/native/index.*.node | wc -l   # must print 3
```

Fewer than three binaries is a stop condition — do not publish unless the user
explicitly accepts a reduced platform list.

### 5. Build and verify

Run from monorepo root, in order:

```bash
pnpm build:web    # rebuild frontend (CLI bundles it)
pnpm build:cli    # build CLI with tsup
bun apps/cli/dist/cli.cjs --version   # must print the new version
bun apps/cli/dist/cli.cjs --help      # must list all commands
ls apps/cli/dist/native/              # must contain index.js + the three index.*.node files
```

Then smoke test in a temp dir: `init` + `status` must succeed.

### 6. Publish to npm

```bash
cd apps/cli && npm publish --access public
```

If npm requires OTP (2FA), tell the user to run with `--otp=<6-digit-code>`.

### 7. Commit and push

```bash
git add apps/cli/package.json CHANGELOG.md
git commit -m "chore(cli): release v<VERSION>"
git push
```

### Pitfalls

- Always run `pnpm build:web` before `pnpm build:cli` — CLI bundles stale frontend otherwise.
- Fetch the `native.yml` artifacts before `pnpm build:cli` — a build without `packages/native/*.node` succeeds but ships no native acceleration on any platform.
- Check `--version` output before publishing — npm rejects re-publishing the same version.
- Always commit `package.json` and `CHANGELOG.md` together to avoid changelog drift.

## Agent Workflow

Use `.agents/skills/using-devkit/SKILL.md` as the workflow entry point, then read the selected skill before acting. The installed skills are:

- `brainstorm-feature`, `context-handoff`, `document-wiki`, `estimate-feature`, `implement-task`
- `lean-audit`, `plan-feature`, `read-codebase-context`, `review-and-verify`
- `setup-codebase`, `setup-openez`, `systematic-debugging`, `using-devkit`

The project-specific `.agents/skills/release-cli/SKILL.md` remains available.
