import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { analyzeDiffContext, parseGitDiffHunks } from "../packages/core/src/diff-context";
import { closeRegistryDb, createRegistryRepository } from "../packages/db/src/sqlite";
import { ensureGraphReady, indexWorkspace } from "../packages/indexer/src";

describe("diff-context analyzer", () => {
  let tmpDir: string;
  let workspaceRoot: string;
  const origRegistryDbPath = process.env.AI_MEMORY_REGISTRY_DB_PATH;

  beforeEach(() => {
    closeRegistryDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openez-diff-test-"));
    process.env.AI_MEMORY_REGISTRY_DB_PATH = path.join(tmpDir, "registry.sqlite");
    workspaceRoot = path.join(tmpDir, "sample-project");
    fs.mkdirSync(workspaceRoot, { recursive: true });

    execSync("git init", { cwd: workspaceRoot, stdio: "ignore" });
    execSync("git config user.name 'Tester'", { cwd: workspaceRoot, stdio: "ignore" });
    execSync("git config user.email 'tester@example.com'", {
      cwd: workspaceRoot,
      stdio: "ignore",
    });
  });

  afterEach(() => {
    closeRegistryDb();
    if (origRegistryDbPath !== undefined) {
      process.env.AI_MEMORY_REGISTRY_DB_PATH = origRegistryDbPath;
    } else {
      delete process.env.AI_MEMORY_REGISTRY_DB_PATH;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("parses unified git diff hunks and line ranges correctly", () => {
    const rawDiff = `diff --git a/src/user.ts b/src/user.ts
index 1234567..89abcdef 100644
--- a/src/user.ts
+++ b/src/user.ts
@@ -10,5 +12,8 @@ export function oldFunc() {
+export function newFunc() {
+  return true;
+}
diff --git a/src/auth.ts b/src/auth.ts
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/src/auth.ts
@@ -0,0 +1,15 @@
+export function authenticate() {}
+`;

    const parsed = parseGitDiffHunks(rawDiff);

    expect(parsed.length).toBe(2);
    expect(parsed[0].filePath).toBe("src/user.ts");
    expect(parsed[0].status).toBe("modified");
    expect(parsed[0].ranges.length).toBe(1);
    expect(parsed[0].ranges[0].start).toBe(12);
    expect(parsed[0].ranges[0].end).toBe(19);

    expect(parsed[1].filePath).toBe("src/auth.ts");
    expect(parsed[1].status).toBe("added");
    expect(parsed[1].ranges[0].start).toBe(1);
    expect(parsed[1].ranges[0].end).toBe(15);
  });

  test("retains old and working-tree ranges for insertions", () => {
    const parsed = parseGitDiffHunks(`diff --git a/src/added.ts b/src/added.ts
new file mode 100644
--- /dev/null
+++ b/src/added.ts
@@ -0,0 +1,2 @@
+export const added = true;
+`);

    expect(parsed).toEqual([
      {
        filePath: "src/added.ts",
        status: "added",
        ranges: [{ start: 1, end: 2 }],
        oldRanges: [],
      },
    ]);
  });

  test("retains deleted-file metadata without current line ranges", () => {
    const parsed = parseGitDiffHunks(`diff --git a/src/deleted.ts b/src/deleted.ts
deleted file mode 100644
--- a/src/deleted.ts
+++ /dev/null
@@ -3,2 +0,0 @@
-export const removed = true;
-`);

    expect(parsed).toEqual([
      {
        filePath: "src/deleted.ts",
        oldPath: "src/deleted.ts",
        status: "deleted",
        ranges: [],
        oldRanges: [{ start: 3, end: 4 }],
      },
    ]);
  });

  test("parses rename metadata using old and new paths", () => {
    const parsed = parseGitDiffHunks(`diff --git a/src/old-name.ts b/src/new-name.ts
similarity index 100%
rename from src/old-name.ts
rename to src/new-name.ts
`);

    expect(parsed).toEqual([
      {
        filePath: "src/new-name.ts",
        oldPath: "src/old-name.ts",
        status: "modified",
        ranges: [],
        oldRanges: [],
      },
    ]);
  });

  test("keeps binary and mode-only files without fabricated hunks", () => {
    const parsed = parseGitDiffHunks(`diff --git a/assets/logo.png b/assets/logo.png
index 1111111..2222222 100644
Binary files a/assets/logo.png and b/assets/logo.png differ
diff --git a/scripts/run.sh b/scripts/run.sh
old mode 100644
new mode 100755
`);

    expect(parsed).toEqual([
      {
        filePath: "assets/logo.png",
        oldPath: "assets/logo.png",
        status: "modified",
        ranges: [],
        oldRanges: [],
      },
      {
        filePath: "scripts/run.sh",
        oldPath: "scripts/run.sh",
        status: "modified",
        ranges: [],
        oldRanges: [],
      },
    ]);
  });

  test("returns no files for an empty diff", () => {
    expect(parseGitDiffHunks("")).toEqual([]);
  });

  test("analyzes workspace git diff and identifies affected symbols and callers", async () => {
    const srcDir = path.join(workspaceRoot, "src");
    fs.mkdirSync(srcDir, { recursive: true });

    const utilsPath = path.join(srcDir, "utils.ts");
    const servicePath = path.join(srcDir, "service.ts");

    fs.writeFileSync(
      utilsPath,
      `export function calculateTax(amount: number): number {
  return amount * 0.1;
}
`,
    );

    fs.writeFileSync(
      servicePath,
      `import { calculateTax } from "./utils";

export function checkout(amount: number): number {
  return calculateTax(amount) + amount;
}
`,
    );

    execSync("git add .", { cwd: workspaceRoot, stdio: "ignore" });
    execSync("git commit -m 'Initial commit'", { cwd: workspaceRoot, stdio: "ignore" });

    const registry = createRegistryRepository();
    const ws = await registry.ensureWorkspace({ rootPath: workspaceRoot, name: "diff-test" });
    await indexWorkspace({ workspaceId: ws.id, rootPath: workspaceRoot, mode: "full" });
    await ensureGraphReady(ws.id);

    // Modify calculateTax in utils.ts
    fs.writeFileSync(
      utilsPath,
      `export function calculateTax(amount: number): number {
  // Updated tax rate
  const rate = 0.15;
  return amount * rate;
}
`,
    );

    const report = await analyzeDiffContext(workspaceRoot);

    expect(report.totalFilesChanged).toBe(1);
    expect(report.files[0].filePath).toBe("src/utils.ts");
    expect(report.files[0].affectedSymbols.length).toBeGreaterThan(0);
    expect(report.files[0].affectedSymbols[0].name).toBe("calculateTax");
    expect(report.formattedSummary).toContain("calculateTax");
    expect(report.formattedSummary).toContain("checkout");
  });

  test("uses HEAD by default, --staged for staged changes, and rejects mixed scopes", async () => {
    const srcDir = path.join(workspaceRoot, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const stagedPath = path.join(srcDir, "staged.ts");
    const unstagedPath = path.join(srcDir, "unstaged.ts");

    fs.writeFileSync(stagedPath, "export const staged = 'before';\n");
    fs.writeFileSync(unstagedPath, "export const unstaged = 'before';\n");
    execSync("git add .", { cwd: workspaceRoot, stdio: "ignore" });
    execSync("git commit -m 'Initial commit'", { cwd: workspaceRoot, stdio: "ignore" });

    fs.writeFileSync(stagedPath, "export const staged = 'after';\n");
    execSync("git add src/staged.ts", { cwd: workspaceRoot, stdio: "ignore" });
    fs.writeFileSync(unstagedPath, "export const unstaged = 'after';\n");

    const defaultReport = await analyzeDiffContext(workspaceRoot);
    const stagedReport = await analyzeDiffContext(workspaceRoot, { staged: true });

    expect(defaultReport.files.map((file) => file.filePath).sort()).toEqual([
      "src/staged.ts",
      "src/unstaged.ts",
    ]);
    expect(stagedReport.files.map((file) => file.filePath)).toEqual(["src/staged.ts"]);
    await expect(analyzeDiffContext(workspaceRoot, { ref: "HEAD", staged: true })).rejects.toThrow(
      "Cannot combine a git ref with staged changes",
    );
  });

  test("correctly maps symbols when staged and unstaged edits coexist in the same file", async () => {
    const srcDir = path.join(workspaceRoot, "src");
    fs.mkdirSync(srcDir, { recursive: true });

    const utilsPath = path.join(srcDir, "utils.ts");
    fs.writeFileSync(
      utilsPath,
      `export function calculateTax(amount: number): number {
  return amount * 0.1;
}

export function formatCurrency(amount: number): string {
  return "$" + amount.toFixed(2);
}
`,
    );

    execSync("git add .", { cwd: workspaceRoot, stdio: "ignore" });
    execSync("git commit -m 'Initial commit'", { cwd: workspaceRoot, stdio: "ignore" });

    // Staged change modifying calculateTax
    fs.writeFileSync(
      utilsPath,
      `export function calculateTax(amount: number): number {
  return amount * 0.15;
}

export function formatCurrency(amount: number): string {
  return "$" + amount.toFixed(2);
}
`,
    );
    execSync("git add src/utils.ts", { cwd: workspaceRoot, stdio: "ignore" });

    // Unstaged change adding lines at the top (shifting line numbers)
    fs.writeFileSync(
      utilsPath,
      `// Unstaged header comment 1
// Unstaged header comment 2
// Unstaged header comment 3
// Unstaged header comment 4

export function calculateTax(amount: number): number {
  return amount * 0.15;
}

export function formatCurrency(amount: number): string {
  return "$" + amount.toFixed(2);
}
`,
    );

    const registry = createRegistryRepository();
    const ws = await registry.ensureWorkspace({ rootPath: workspaceRoot, name: "staged-test" });
    await indexWorkspace({ workspaceId: ws.id, rootPath: workspaceRoot, mode: "full" });

    const report = await analyzeDiffContext(workspaceRoot, { staged: true });

    expect(report.totalFilesChanged).toBe(1);
    expect(report.files[0].affectedSymbols.length).toBeGreaterThan(0);
    expect(report.files[0].affectedSymbols[0].name).toBe("calculateTax");
  });

  test("maps a staged hunk through separate unstaged hunks in working-tree coordinates", async () => {
    const srcDir = path.join(workspaceRoot, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const utilsPath = path.join(srcDir, "utils.ts");

    fs.writeFileSync(
      utilsPath,
      `// 1
// 2
// 3
// 4
// 5
// 6
// 7
// 8
// 9

export function target(): number {
  const one = 1;
  const two = 2;
  const three = 3;
  const four = 4;
  return one + two + three + four;
}

// spacer 1
// spacer 2
// spacer 3

export function after(): string {
  return "before";
}
`,
    );
    execSync("git add .", { cwd: workspaceRoot, stdio: "ignore" });
    execSync("git commit -m 'Initial commit'", { cwd: workspaceRoot, stdio: "ignore" });

    fs.writeFileSync(
      utilsPath,
      `// 1
// 2
// 3
// 4
// 5
// 6
// 7
// 8
// 9

export function target(): number {
  const one = 1;
  const two = 20;
  const three = 3;
  const four = 4;
  return one + two + three + four;
}

// spacer 1
// spacer 2
// spacer 3

export function after(): string {
  return "before";
}
`,
    );
    execSync("git add src/utils.ts", { cwd: workspaceRoot, stdio: "ignore" });

    fs.writeFileSync(
      utilsPath,
      `// one
// two
// three
// four
// five
// six
// 1
// 2
// 3
// 4
// 5
// 6
// 7
// 8
// 9

export function target(): number {
  const one = 1;
  const two = 20;
  const three = 3;
  const four = 4;
  return one + two + three + four;
}

// spacer 1
// spacer 2
// spacer 3

export function after(): string {
  return "after";
}
`,
    );

    const registry = createRegistryRepository();
    const ws = await registry.ensureWorkspace({ rootPath: workspaceRoot, name: "multi-hunk-test" });
    await indexWorkspace({ workspaceId: ws.id, rootPath: workspaceRoot, mode: "full" });

    const report = await analyzeDiffContext(workspaceRoot, { staged: true });

    expect(report.files[0].changedLineRanges).toEqual([{ start: 16, end: 22 }]);
    expect(report.files[0].affectedSymbols.map((symbol) => symbol.name)).toEqual(["target"]);
  });
});
