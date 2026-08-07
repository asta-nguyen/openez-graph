# Migrate to Bun-Native Test Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace vitest with `bun test` and remove all `better-sqlite3` fallback code so the codebase runs exclusively on `bun:sqlite`.

**Architecture:** Swap the test runner from vitest (Node-based, requires `bun:sqlite` alias/mock) to Bun's native test runner (`bun:test`). Then remove the 3 fallback layers: `database-loader.ts` adapter, `apps/web/src/server/sqlite.ts` try/catch, and `vitest.config.ts` alias. Finally drop `better-sqlite3` from all package.json files.

**Tech Stack:** Bun 1.3+, `bun:test`, `bun:sqlite`, `mock.module()`, `spyOn()`

## Global Constraints

- Bun version: 1.3.14+ (already installed)
- All 19 test files must pass under `bun test`
- No `better-sqlite3` dependency may remain after migration
- No `vitest` dependency may remain after migration
- `bun:sqlite` is the only SQLite driver
- `package.json` `"test"` script must be `bun test`
- Production code must still typecheck (`pnpm typecheck` must pass — note: typecheck runs under Node/tsc, so `bun:sqlite` imports need `@ts-expect-error` or a type shim)
- Pre-commit hooks (lint-staged + prettier) must still run

---

## File Structure

| File                                        | Action | Responsibility                                                                 |
| ------------------------------------------- | ------ | ------------------------------------------------------------------------------ |
| `tests/*.test.ts` (19 files)                | Modify | Swap `from "vitest"` → `from "bun:test"`                                       |
| `tests/hybrid-retrieval.test.ts`            | Modify | `vi.mock` → `mock.module`, `vi.fn` → `mock`                                    |
| `tests/index-workspace.test.ts`             | Modify | `vi.spyOn` → `spyOn`, `mockClear`/`mockRestore` API                            |
| `vitest.config.ts`                          | Delete | No longer needed                                                               |
| `tests/__mocks__/bun-sqlite.ts`             | Delete | No longer needed                                                               |
| `packages/db/src/sqlite/database-loader.ts` | Modify | Remove `better-sqlite3` fallback + adapter                                     |
| `apps/web/src/server/sqlite.ts`             | Modify | Remove `better-sqlite3` fallback                                               |
| `apps/cli/tsup.config.ts`                   | Modify | Remove `better-sqlite3` from external                                          |
| `package.json`                              | Modify | Remove `vitest`, `better-sqlite3`, `@types/better-sqlite3`; change test script |
| `apps/cli/package.json`                     | Modify | Remove `better-sqlite3`, `@types/better-sqlite3`                               |
| `packages/db/src/sqlite/types.ts`           | Check  | May need `bun:sqlite` type reference                                           |

---

### Task 1: Migrate Simple Test Files (17 files, no mock/spy)

**Files:**

- Modify: `tests/chunking.test.ts`
- Modify: `tests/config-indexer.test.ts`
- Modify: `tests/e2e-search.test.ts`
- Modify: `tests/embed-benchmark.test.ts`
- Modify: `tests/go-rust-indexer.test.ts`
- Modify: `tests/mcp-tools.test.ts`
- Modify: `tests/oxc-parser.test.ts`
- Modify: `tests/parser-registry.test.ts`
- Modify: `tests/python-indexer.test.ts`
- Modify: `tests/registry.test.ts`
- Modify: `tests/remove-workspace.test.ts`
- Modify: `tests/retrieval-eval.test.ts`
- Modify: `tests/tree-sitter-parser.test.ts`
- Modify: `tests/vector-search.test.ts`
- Modify: `tests/web-index-endpoint.test.ts`
- Modify: `tests/web-workspaces-endpoint.test.ts`
- Modify: `tests/workspace-db.test.ts`

**Interfaces:**

- Consumes: `bun:test` API (`describe`, `it/test`, `expect`, `beforeEach`, `afterEach`, `beforeAll`, `afterAll`, `it.skipIf`)
- Produces: Test files that import from `bun:test` instead of `vitest`

- [ ] **Step 1: Swap imports in all 17 simple test files**

Each file has one of these import patterns at line 1 (or line 3/5/6/7):

```ts
// Pattern A (no lifecycle hooks):
import { describe, expect, it } from "vitest";

// Pattern B (with beforeEach/afterEach):
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Pattern C (with beforeAll/afterAll):
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Pattern D (with it.skipIf):
import { describe, expect, it } from "vitest";
// ... later: it.skipIf(condition)("name", fn)
```

Replace `"vitest"` with `"bun:test"` in all 17 files. The named imports stay identical — `bun:test` exports the same names.

Files and their current import line:

| File                                      | Import names                                  |
| ----------------------------------------- | --------------------------------------------- |
| `tests/chunking.test.ts:1`                | `describe, expect, it`                        |
| `tests/config-indexer.test.ts:1`          | `describe, expect, it`                        |
| `tests/e2e-search.test.ts:1`              | `afterEach, beforeEach, describe, expect, it` |
| `tests/embed-benchmark.test.ts:1`         | `afterAll, beforeAll, describe, expect, it`   |
| `tests/go-rust-indexer.test.ts:1`         | `describe, expect, it`                        |
| `tests/mcp-tools.test.ts:7`               | `afterEach, beforeEach, describe, expect, it` |
| `tests/oxc-parser.test.ts:1`              | `describe, expect, it`                        |
| `tests/parser-registry.test.ts:1`         | `describe, expect, it`                        |
| `tests/python-indexer.test.ts:3`          | `describe, expect, it`                        |
| `tests/registry.test.ts:1`                | `afterEach, beforeEach, describe, expect, it` |
| `tests/remove-workspace.test.ts:1`        | `afterEach, beforeEach, describe, expect, it` |
| `tests/retrieval-eval.test.ts:1`          | `describe, expect, it`                        |
| `tests/tree-sitter-parser.test.ts:1`      | `describe, expect, it`                        |
| `tests/vector-search.test.ts:5`           | `afterEach, describe, expect, it`             |
| `tests/web-index-endpoint.test.ts:5`      | `afterAll, beforeAll, describe, expect, it`   |
| `tests/web-workspaces-endpoint.test.ts:5` | `afterEach, beforeEach, describe, expect, it` |
| `tests/workspace-db.test.ts:1`            | `afterEach, beforeEach, describe, expect, it` |

For each file, change only the import source string:

```ts
// Before
import { describe, expect, it } from "vitest";
// After
import { describe, expect, it } from "bun:test";
```

- [ ] **Step 2: Run the 17 migrated files to verify they pass**

Run: `bun test tests/chunking.test.ts tests/config-indexer.test.ts tests/e2e-search.test.ts tests/go-rust-indexer.test.ts tests/oxc-parser.test.ts tests/parser-registry.test.ts tests/python-indexer.test.ts tests/registry.test.ts tests/remove-workspace.test.ts tests/retrieval-eval.test.ts tests/tree-sitter-parser.test.ts tests/workspace-db.test.ts tests/web-index-endpoint.test.ts tests/web-workspaces-endpoint.test.ts tests/mcp-tools.test.ts`

Expected: All pass. `embed-benchmark.test.ts` and `vector-search.test.ts` use env-conditioned skips — verify they skip correctly.

Note: Some tests may fail at this point because `vitest.config.ts` still aliases `bun:sqlite` to a mock stub, and `bun test` does not use vitest config. This is expected — the `database-loader.ts` fallback will handle `bun:sqlite` natively under Bun. If any test fails due to module resolution, note it for Task 3.

- [ ] **Step 3: Commit**

```bash
git add tests/chunking.test.ts tests/config-indexer.test.ts tests/e2e-search.test.ts tests/embed-benchmark.test.ts tests/go-rust-indexer.test.ts tests/mcp-tools.test.ts tests/oxc-parser.test.ts tests/parser-registry.test.ts tests/python-indexer.test.ts tests/registry.test.ts tests/remove-workspace.test.ts tests/retrieval-eval.test.ts tests/tree-sitter-parser.test.ts tests/vector-search.test.ts tests/web-index-endpoint.test.ts tests/web-workspaces-endpoint.test.ts tests/workspace-db.test.ts
git commit -m "test: swap vitest imports to bun:test in 17 simple test files"
```

---

### Task 2: Migrate Test Files with Mock/Spy (2 files)

**Files:**

- Modify: `tests/hybrid-retrieval.test.ts`
- Modify: `tests/index-workspace.test.ts`

**Interfaces:**

- Consumes: `bun:test` `mock`, `mock.module`, `spyOn`
- Produces: Test files using `bun:test` mock API

- [ ] **Step 1: Migrate `tests/hybrid-retrieval.test.ts`**

Current code (lines 1-18):

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testEmbeddingProvider = {
  provider: "ollama" as const,
  model: "test-model",
  embed: vi.fn(async () => [[1, 0]]),
};

vi.mock("../packages/core/src/embeddings", async () => {
  const actual = await vi.importActual<typeof import("../packages/core/src/embeddings")>(
    "../packages/core/src/embeddings",
  );
  return { ...actual, getEmbeddingProvider: async () => testEmbeddingProvider };
});
```

Replace with:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

const testEmbeddingProvider = {
  provider: "ollama" as const,
  model: "test-model",
  embed: mock(async () => [[1, 0]]),
};

mock.module("../packages/core/src/embeddings", () => {
  return {
    getEmbeddingProvider: async () => testEmbeddingProvider,
    embeddingStorageModel: (provider: { provider: string; model: string }) =>
      `${provider.provider}/${provider.model}`,
  };
});
```

Key changes:

- `vi` → `mock` (named import from `bun:test`)
- `vi.fn(...)` → `mock(...)`
- `vi.mock(path, async () => {...})` → `mock.module(path, () => {...})` (callback is sync, returns object directly)
- `vi.importActual` is not needed — we explicitly return the functions we need from the mock. The test only uses `embeddingStorageModel` and `getEmbeddingProvider` from this module, so we provide both.

Check what `embeddingStorageModel` actually does to ensure the mock is correct:

```bash
grep -n "export function embeddingStorageModel" packages/core/src/embeddings.ts
```

Read the function and replicate its behavior in the mock. If it's complex, import the real function and spread it:

```ts
import { embeddingStorageModel as realEmbeddingStorageModel } from "../packages/core/src/embeddings";

mock.module("../packages/core/src/embeddings", () => ({
  embeddingStorageModel: realEmbeddingStorageModel,
  getEmbeddingProvider: async () => testEmbeddingProvider,
}));
```

Note: `mock.module` must be called before any `import` that resolves the mocked module. The `import { embeddingStorageModel }` on line 20 will use the mock. Place the `mock.module` call before that import. Bun hoists `mock.module` calls like vitest hoists `vi.mock`, so the order in source doesn't matter — but keep it clean by placing it before the import.

- [ ] **Step 2: Migrate `tests/index-workspace.test.ts`**

Current code (lines 6, 279-292):

```ts
// Line 6:
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Lines 279-292:
const readSpy = vi.spyOn(fsPromises, "readFile");
const sourceWasRead = () =>
  readSpy.mock.calls.some(
    ([filePath]) => fs.realpathSync(String(filePath)) === fs.realpathSync(sourcePath),
  );
expect((await indexWorkspace({ workspaceId: workspace.id })).filesUpdated).toBe(0);
expect(sourceWasRead()).toBe(true);
// ...
readSpy.mockClear();
// ...
readSpy.mockRestore();
```

Replace with:

```ts
// Line 6:
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";

// Lines 279-292:
const readSpy = spyOn(fsPromises, "readFile");
const sourceWasRead = () =>
  readSpy.mock.calls.some(
    ([filePath]) => fs.realpathSync(String(filePath)) === fs.realpathSync(sourcePath),
  );
expect((await indexWorkspace({ workspaceId: workspace.id })).filesUpdated).toBe(0);
expect(sourceWasRead()).toBe(true);
// ...
readSpy.mockClear();
// ...
readSpy.mockRestore();
```

Key changes:

- `vi` → `spyOn` (named import from `bun:test`)
- `vi.spyOn(obj, method)` → `spyOn(obj, method)`
- `readSpy.mock.calls` — same API in `bun:test`
- `readSpy.mockClear()` — same API in `bun:test`
- `readSpy.mockRestore()` — same API in `bun:test`

- [ ] **Step 3: Run the 2 migrated files**

Run: `bun test tests/hybrid-retrieval.test.ts tests/index-workspace.test.ts`

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add tests/hybrid-retrieval.test.ts tests/index-workspace.test.ts
git commit -m "test: migrate vi.mock/vi.spyOn to bun:test mock.module/spyOn"
```

---

### Task 3: Delete vitest.config.ts and bun-sqlite mock stub

**Files:**

- Delete: `vitest.config.ts`
- Delete: `tests/__mocks__/bun-sqlite.ts`

**Interfaces:**

- Consumes: nothing
- Produces: clean repo with no vitest config or mock stub

- [ ] **Step 1: Delete vitest.config.ts**

```bash
git rm vitest.config.ts
```

This file contained:

- `bun:sqlite` → `tests/__mocks__/bun-sqlite.ts` alias
- `server.deps.inline` for drizzle-orm, @openez-graph/db, @openez-graph/core

Neither is needed under `bun test` — Bun resolves `bun:sqlite` natively.

- [ ] **Step 2: Delete the mock stub**

```bash
git rm tests/__mocks__/bun-sqlite.ts
```

This was a no-op stub class that let modules load under Node/vitest. No longer needed.

- [ ] **Step 3: Run full test suite to verify nothing broke**

Run: `bun test`

Expected: All 19 test files pass (or skip for env-conditioned tests). If any test fails because it relied on the vitest config's `inline` setting, investigate — but this is unlikely since `bun test` resolves all modules natively.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: delete vitest.config.ts and bun-sqlite mock stub"
```

---

### Task 4: Remove better-sqlite3 fallback from database-loader.ts

**Files:**

- Modify: `packages/db/src/sqlite/database-loader.ts`

**Interfaces:**

- Consumes: `bun:sqlite` `Database` class
- Produces: `createNativeDatabase(dbPath)` that only uses `bun:sqlite`

- [ ] **Step 1: Simplify database-loader.ts to bun:sqlite only**

Current file (105 lines) has:

- `adaptBetterSqlite3()` function (lines 48-86) — adapter for better-sqlite3 API differences
- try/catch in `createNativeDatabase` (lines 91-97) — tries `bun:sqlite`, falls back to `better-sqlite3`
- `isBetterSqlite3` flag and conditional adapter wrapping (lines 90, 96, 99-101)

Replace the entire file with:

```ts
import module from "node:module";

declare const __non_webpack_require__: typeof require | undefined;

function getRequireUrl(): string {
  try {
    if (typeof import.meta !== "undefined" && import.meta.url) {
      return import.meta.url;
    }
  } catch {
    // import.meta not available (CJS)
  }
  return `file://${__filename}`;
}

const _require: typeof require =
  typeof __non_webpack_require__ === "function"
    ? __non_webpack_require__
    : module.createRequire(getRequireUrl());

interface NativeStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
  values(...params: unknown[]): unknown[];
  bind(...params: unknown[]): NativeStatement;
}

interface NativeDatabase {
  pragma(command: string): unknown;
  exec(sql: string): unknown;
  prepare(sql: string): NativeStatement;
  transaction<T>(fn: () => T): () => T;
  close(): void;
}

type NativeDatabaseConstructor = new (
  filename: string,
  options?: { nativeBinding?: string },
) => NativeDatabase;

export function createNativeDatabase(dbPath: string): NativeDatabase {
  const Database = _require("bun:sqlite").Database as NativeDatabaseConstructor;
  const db = new Database(dbPath, { create: true } as { nativeBinding?: string });
  // Add .pragma() shim — bun:sqlite doesn't have it natively
  (db as any).pragma = (cmd: string) => db.exec(`PRAGMA ${cmd}`);
  return db as unknown as NativeDatabase;
}
```

Key removals:

- `adaptBetterSqlite3()` function — deleted entirely
- `isBetterSqlite3` flag — deleted
- try/catch fallback — deleted, direct `bun:sqlite` require
- better-sqlite3-specific pragma workarounds (locking_mode, mmap_size skipping) — deleted

- [ ] **Step 2: Run tests to verify database-loader works**

Run: `bun test tests/workspace-db.test.ts tests/index-workspace.test.ts tests/e2e-search.test.ts`

Expected: All pass. These tests exercise `createNativeDatabase` via `createWorkspaceRepository`.

- [ ] **Step 3: Commit**

```bash
git add packages/db/src/sqlite/database-loader.ts
git commit -m "refactor(db): remove better-sqlite3 fallback from database-loader"
```

---

### Task 5: Remove better-sqlite3 fallback from apps/web/src/server/sqlite.ts

**Files:**

- Modify: `apps/web/src/server/sqlite.ts`

**Interfaces:**

- Consumes: `bun:sqlite` `Database` class
- Produces: Web server SQLite layer using only `bun:sqlite`

- [ ] **Step 1: Simplify sqlite.ts to bun:sqlite only**

Current code (lines 32-50):

```ts
// Try bun:sqlite first (production), fall back to better-sqlite3 (test/dev under Node).
let Database: new (filename: string, options?: any) => SqliteDb;
try {
  const { Database: BunDatabase } = require("bun:sqlite");
  // Wrap to add .pragma() shim — bun:sqlite doesn't have it natively
  Database = class extends BunDatabase {
    constructor(filename: string, options?: any) {
      super(filename, options);
      (this as any).pragma = (cmd: string) => this.exec(`PRAGMA ${cmd}`);
    }
  } as unknown as new (filename: string, options?: any) => SqliteDb;
} catch {
  const BetterSqlite = require("better-sqlite3");
  Database = class extends BetterSqlite {
    constructor(filename: string, options?: any) {
      super(filename, options);
    }
  } as unknown as new (filename: string, options?: any) => SqliteDb;
}
```

Replace with:

```ts
const { Database: BunDatabase } = require("bun:sqlite");
// Wrap to add .pragma() shim — bun:sqlite doesn't have it natively
const Database = class extends BunDatabase {
  constructor(filename: string, options?: any) {
    super(filename, options);
    (this as any).pragma = (cmd: string) => this.exec(`PRAGMA ${cmd}`);
  }
} as unknown as new (filename: string, options?: any) => SqliteDb;
```

Key removals:

- `let Database` with try/catch — replaced with direct `require("bun:sqlite")`
- `better-sqlite3` fallback branch — deleted entirely

- [ ] **Step 2: Run web endpoint tests**

Run: `bun test tests/web-index-endpoint.test.ts tests/web-workspaces-endpoint.test.ts`

Expected: All pass.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/server/sqlite.ts
git commit -m "refactor(web): remove better-sqlite3 fallback from web sqlite layer"
```

---

### Task 6: Remove better-sqlite3 from tsup config and package.json files

**Files:**

- Modify: `apps/cli/tsup.config.ts`
- Modify: `package.json`
- Modify: `apps/cli/package.json`

**Interfaces:**

- Consumes: nothing
- Produces: No `better-sqlite3` or `vitest` in any package.json

- [ ] **Step 1: Remove better-sqlite3 from tsup externals**

In `apps/cli/tsup.config.ts`, the `external` array (line 28-36) contains `"better-sqlite3"`. Remove it:

```ts
// Before
external: [
  "better-sqlite3",
  "bun:sqlite",
  "@openez-graph/native",
  // ...
],

// After
external: [
  "bun:sqlite",
  "@openez-graph/native",
  // ...
],
```

- [ ] **Step 2: Remove better-sqlite3 and vitest from root package.json**

In `package.json`:

1. Change test script (line 25):

```json
// Before
"test": "vitest run",
// After
"test": "bun test",
```

2. Remove from `devDependencies`:

- `"better-sqlite3": "^12.10.0"` (line 36)
- `"@types/better-sqlite3": "^7.6.13"` (line 32)
- `"vitest": "^3.2.0"` (line 44)

- [ ] **Step 3: Remove better-sqlite3 from apps/cli/package.json**

In `apps/cli/package.json`, remove from `dependencies`:

- `"better-sqlite3": "^12.10.0"` (line 51)

Remove from `devDependencies`:

- `"@types/better-sqlite3": "^7.6.13"` (line 66)

- [ ] **Step 4: Run pnpm install to update lockfile**

Run: `pnpm install`

Expected: Lockfile updates, `better-sqlite3` and `vitest` removed from `node_modules`.

- [ ] **Step 5: Run full test suite**

Run: `bun test`

Expected: All tests pass.

- [ ] **Step 6: Run typecheck**

Run: `pnpm typecheck`

Expected: May show errors for `bun:sqlite` module declaration under Node/tsc. If so, add a type declaration file or `@ts-expect-error`. The existing `database-loader.ts` uses `_require("bun:sqlite")` which may need a type declaration.

If typecheck fails with "Cannot find module 'bun:sqlite'":

- Add `// @ts-expect-error — bun:sqlite is a Bun built-in module` before the require call
- Or create `packages/db/src/sqlite/bun-sqlite.d.ts` with:

```ts
declare module "bun:sqlite" {
  export class Database {
    constructor(filename: string, options?: { create?: boolean });
    exec(sql: string): this;
    prepare(sql: string): {
      all(...params: unknown[]): unknown[];
      get(...params: unknown[]): unknown;
      run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
      values(...params: unknown[]): unknown[];
    };
    close(): void;
  }
}
```

- [ ] **Step 7: Commit**

```bash
git add apps/cli/tsup.config.ts package.json apps/cli/package.json pnpm-lock.yaml
git commit -m "chore: remove better-sqlite3 and vitest dependencies, switch to bun test"
```

---

### Task 7: Full Verification

**Files:**

- None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `bun test`

Expected: All tests pass, 0 failures. Env-conditioned skips (embed-benchmark) are acceptable.

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`

Expected: 0 errors (or only pre-existing errors unrelated to this migration).

- [ ] **Step 3: Run prettier check**

Run: `npx prettier --check "tests/**/*.test.ts" "packages/db/src/sqlite/database-loader.ts" "apps/web/src/server/sqlite.ts"`

Expected: All files pass formatting.

- [ ] **Step 4: Verify no better-sqlite3 or vitest references remain**

Run: `grep -rn "better-sqlite3\|vitest\|vi\.mock\|vi\.fn\|vi\.spyOn\|from \"vitest\"" packages/ tests/ apps/ --include="*.ts" --include="*.json" | grep -v node_modules | grep -v CHANGELOG | grep -v dist`

Expected: No matches (or only CHANGELOG.md references which are historical).

- [ ] **Step 5: Verify no bun-sqlite mock references remain**

Run: `grep -rn "bun-sqlite\|__mocks__" packages/ tests/ apps/ --include="*.ts" --include="*.json" | grep -v node_modules`

Expected: No matches.

- [ ] **Step 6: Build CLI to verify production build works**

Run: `pnpm build:cli`

Expected: Build succeeds. `bun:sqlite` is marked external in tsup config, so it won't be bundled.

- [ ] **Step 7: Final commit if any fixes were needed**

If Steps 1-6 required any fixes, commit them:

```bash
git add -A
git commit -m "fix: address verification issues from bun migration"
```

---

## Self-Review

### Spec coverage

- ✅ Swap vitest → bun:test in all 19 test files (Task 1 + Task 2)
- ✅ Migrate vi.mock → mock.module (Task 2)
- ✅ Migrate vi.spyOn → spyOn (Task 2)
- ✅ Delete vitest.config.ts (Task 3)
- ✅ Delete bun-sqlite mock stub (Task 3)
- ✅ Remove better-sqlite3 from database-loader.ts (Task 4)
- ✅ Remove better-sqlite3 from apps/web/sqlite.ts (Task 5)
- ✅ Remove better-sqlite3 from tsup config (Task 6)
- ✅ Remove better-sqlite3 + vitest from package.json files (Task 6)
- ✅ Change test script to `bun test` (Task 6)
- ✅ Full verification (Task 7)

### Placeholder scan

- No "TBD", "TODO", "implement later" found
- All code blocks contain actual implementation code
- All test commands are explicit

### Type consistency

- `createNativeDatabase(dbPath: string): NativeDatabase` — signature unchanged
- `mock.module(path, () => object)` — matches bun:test API
- `spyOn(obj, method)` — matches bun:test API
- `NativeDatabase` interface unchanged in database-loader.ts
