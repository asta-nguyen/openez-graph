# Anti-Slop Integration, Dependency Cleanup & AGENTS.md Implementation Plan

> **Goal:** Vendor and configure the anti-slop Oxlint plugin, set up pre-commit & verify scripts, remove redundant dependencies, and update `AGENTS.md` with strict anti-slop, dependency hygiene, and autoincrement ID guidelines.

**Branch:** `feat/anti-slop` (stacked on `feat/autoincrement-primary-keys`)

---

### Task 1: Clean Up Redundant Dependencies

- [ ] Remove `dependencies` block from root `package.json` (`server-only`, `@radix-ui/*`).
- [ ] Ensure `@openez-graph/ui` contains all needed `@radix-ui` dependencies (`@radix-ui/react-dialog`, `@radix-ui/react-separator`, `@radix-ui/react-slot`, `@radix-ui/react-tooltip`).
- [ ] Remove unused `"drizzle-orm"` from `packages/core/package.json`.
- [ ] Run `pnpm install` and verify `pnpm-lock.yaml`.

### Task 2: Configure Anti-Slop Oxlint Plugin & Scripts

- [ ] Ensure `tools/oxlint/anti-slop/` is populated with all rule definitions and entry point `index.ts`.
- [ ] Configure `oxlint.config.ts` with all 15 anti-slop rules, ignore patterns, and test overrides.
- [ ] Add `"lint": "oxlint"` and `"lint:fix": "oxlint --fix"` to root `package.json` `scripts`.
- [ ] Update `lint-staged` in root `package.json` to run `oxlint` on staged TypeScript/JavaScript files.

### Task 3: Modernize AGENTS.md

- [ ] Add **Code Quality & Anti-Slop Standards** section:
  - Rejecting low-evidence TypeScript patterns and unbacked type bluffing.
  - Prohibiting chained type assertions (`as unknown as T`).
  - Requiring `// SAFETY: <invariant>` justification comments before any type assertion.
  - Prohibiting empty catch blocks (`try {} catch {}`) without logging or handling.
  - Avoiding `no-widen-then-assert` and broad dictionary types (`Record<string, unknown>`).
  - Avoiding module mocking in domain code.
- [ ] Update **Storage & ID Model** section:
  - Document SQLite `INTEGER PRIMARY KEY AUTOINCREMENT` as strictly canonical for all entities.
  - Forbid `crypto.randomUUID()` for primary keys or foreign keys.
  - Document automated non-destructive schema migration for legacy `TEXT` data (`memories`, `query_logs`).
- [ ] Update **Dependency Hygiene** section:
  - Avoid redundant or deprecated dependencies (`server-only`, `better-sqlite3`, unused ORM dependencies in core).
  - Respect monorepo workspace boundaries.
- [ ] Update **Verification & Pre-Commit** section:
  - Document `pnpm lint` (`oxlint`) and `lint-staged` expectations.

### Task 4: Verification & Git State

- [ ] Run `bun test` across monorepo $\to$ 264 passed.
- [ ] Run `pnpm typecheck` across all packages $\to$ 8/8 clean.
- [ ] Run `pnpm build:web && pnpm build:cli` $\to$ clean bundle.
- [ ] Smoke test CLI binary (`bun apps/cli/dist/cli.cjs --version` and `--help`).
- [ ] Create 1 clean commit on `feat/anti-slop`.
- [ ] Keep changes local on `feat/anti-slop` without pushing to remote (waiting for user review).
