# Anti-Slop Integration, Dependency Cleanup & AGENTS.md Standards Design

**Date:** 2026-08-18  
**Branch:** `feat/anti-slop` (stacked on `feat/autoincrement-primary-keys`)

---

## 1. Context & Objectives

1. **Anti-Slop Enforcement**: Vendor and integrate the [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) Oxlint plugin into the repository to reject low-evidence TypeScript patterns, chained type assertions, unbacked type bluffing, and empty catch blocks.
2. **Execution Timing**: Run `oxlint` both as part of development verification (`pnpm lint`) and pre-commit hooks (`lint-staged`).
3. **Dependency Cleanup**: Remove redundant/unused dependencies (`server-only` in root, `drizzle-orm` in `@openez-graph/core`, misplaced `@radix-ui/*` packages in workspace root).
4. **AGENTS.md Modernization**: Document the strict code quality rules, SQLite autoincrement integer PK/FK architecture, legacy memory preservation, and dependency hygiene guidelines in `AGENTS.md`.
5. **Review Gate**: Keep all changes local on `feat/anti-slop` without pushing to remote until user review.

---

## 2. Architecture & Components

### A. Vendored Oxlint Plugin (`tools/oxlint/anti-slop/`)

Vendored directly into `tools/oxlint/anti-slop/` for zero external runtime fragility:

- `anti-slop/no-chained-type-assertions`: Prohibits `x as unknown as T`.
- `anti-slop/no-widen-then-assert`: Prohibits losing type facts then asserting them back.
- `anti-slop/require-safety-comment-for-type-assertion`: Enforces explicit `// SAFETY: <invariant>` comments before any type cast.
- `anti-slop/no-unsafe-dictionary-type`: Prevents `Record<string, unknown>` escape hatches.
- `anti-slop/no-known-value-widening`: Prevents casting known literals to broad types.
- `anti-slop/no-runtime-typeof`: Flags redundant runtime `typeof` on statically typed variables.
- `anti-slop/no-module-mocking`: Encourages dependency injection.
- Rules for empty object spread, symbol names, parameter safety, and return types.

### B. Oxlint Configuration (`oxlint.config.ts`)

```ts
import { defineConfig } from "oxlint";

export default defineConfig({
  ignorePatterns: [
    ".agent/**",
    ".agents/**",
    ".claude/**",
    ".codex/**",
    ".continue/**",
    ".cursor/**",
    ".gemini/**",
    ".opencode/**",
    ".pi/**",
    ".roo/**",
    ".windsurf/**",
    "**/dist/**",
    "**/node_modules/**",
    "tools/oxlint/anti-slop/**",
  ],
  jsPlugins: [{ name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" }],
  rules: {
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
  },
  overrides: [
    {
      files: ["tests/**", "**/*.test.ts"],
      rules: {
        "anti-slop/require-safety-comment-for-type-assertion": "off",
        "anti-slop/no-chained-type-assertions": "off",
        "anti-slop/no-unsafe-dictionary-type": "off",
        "anti-slop/no-widen-then-assert": "off",
      },
    },
  ],
});
```

### C. Dependency Hygiene

- **Root `package.json`**: Remove `dependencies` block (`server-only`, `@radix-ui/*`). Add `oxlint` and `@oxlint/plugins` (1.78.0) to `devDependencies`. Add `oxlint` to `lint-staged`.
- **`packages/ui/package.json`**: Ensure required Radix primitives (`@radix-ui/react-dialog`, `@radix-ui/react-separator`, `@radix-ui/react-slot`, `@radix-ui/react-tooltip`) are explicitly scoped.
- **`packages/core/package.json`**: Remove unused `"drizzle-orm"`.

### D. AGENTS.md Updates

Add core sections:

1. **Code Quality & Anti-Slop Standards**:
   - No type laundering (`as unknown as T`).
   - `// SAFETY:` invariant comments required before type assertions.
   - No empty `catch` blocks — log, rethrow, or handle with typed error inspection.
   - Prefer domain models and schema parsing over `Record<string, unknown>`.
2. **Storage & ID Architecture**:
   - Monotonic integer primary keys (`INTEGER PRIMARY KEY AUTOINCREMENT`) exclusively.
   - Zero `crypto.randomUUID()` usage for database records.
   - SQLite `res.lastInsertRowid` rowid resolution.
   - Non-destructive legacy migration rules for `memories` and `query_logs`.
3. **Dependency Discipline**:
   - No dead/unused dependencies.
   - Monorepo workspace boundaries respected.

---

## 3. Verification Plan

- Monorepo unit & integration tests: `bun test` $\to$ 264 passed.
- Monorepo typecheck: `pnpm typecheck` $\to$ 8/8 passed.
- Production build: `pnpm build:web && pnpm build:cli` $\to$ clean.
- Git state: Single commit on `feat/anti-slop`, no push to remote.
