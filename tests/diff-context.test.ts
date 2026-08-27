import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  analyzeDiffContext,
  isValidGitRef,
  parseGitDiffHunks,
} from "../packages/core/src/diff-context";
import { closeRegistryDb, createRegistryRepository } from "../packages/db/src/sqlite";
import { ensureGraphReady, indexWorkspace } from "../packages/indexer/src";
import { parseDocument } from "../packages/indexer/src/parsers";

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

  test("uses staged symbol content when unstaged edits change the same symbol", async () => {
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

    // Stage a rename, then make a different unstaged rename in the same hunk.
    fs.writeFileSync(
      utilsPath,
      `export function stagedTax(amount: number): number {
  return amount * 0.15;
}

export function formatCurrency(amount: number): string {
  return "$" + amount.toFixed(2);
}
`,
    );
    execSync("git add src/utils.ts", { cwd: workspaceRoot, stdio: "ignore" });

    // The working tree must not replace the staged symbol in --staged output.
    fs.writeFileSync(
      utilsPath,
      `// Unstaged header comment 1
// Unstaged header comment 2
// Unstaged header comment 3
// Unstaged header comment 4

export function workingTreeTax(amount: number): number {
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

    const report = await analyzeDiffContext(workspaceRoot, { staged: true, parseBlob });

    expect(report.totalFilesChanged).toBe(1);
    expect(report.files[0].affectedSymbols.length).toBeGreaterThan(0);
    expect(report.files[0].affectedSymbols[0].name).toBe("stagedTax");
  });

  test("keeps staged hunk ranges in index coordinates despite unstaged hunks", async () => {
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

    const report = await analyzeDiffContext(workspaceRoot, { staged: true, parseBlob });

    expect(report.files[0].changedLineRanges).toEqual([{ start: 10, end: 16 }]);
    expect(report.files[0].affectedSymbols.map((symbol) => symbol.name)).toEqual(["target"]);
  });

  test("does not include working-tree graph context for staged symbols", async () => {
    const srcDir = path.join(workspaceRoot, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const targetPath = path.join(srcDir, "target.ts");

    fs.writeFileSync(
      path.join(srcDir, "helper.ts"),
      "export function helper(): number { return 1; }\n",
    );
    fs.writeFileSync(targetPath, "export function target(): number { return 1; }\n");
    execSync("git add .", { cwd: workspaceRoot, stdio: "ignore" });
    execSync("git commit -m 'Initial commit'", { cwd: workspaceRoot, stdio: "ignore" });

    fs.writeFileSync(targetPath, "export function target(): number { return 2; }\n");
    execSync("git add src/target.ts", { cwd: workspaceRoot, stdio: "ignore" });
    fs.writeFileSync(
      targetPath,
      `import { helper } from "./helper";
export function target(): number { return helper(); }
`,
    );

    const registry = createRegistryRepository();
    const ws = await registry.ensureWorkspace({
      rootPath: workspaceRoot,
      name: "staged-graph-test",
    });
    await indexWorkspace({ workspaceId: ws.id, rootPath: workspaceRoot, mode: "full" });
    await ensureGraphReady(ws.id);

    const report = await analyzeDiffContext(workspaceRoot, { staged: true, parseBlob });

    expect(report.files[0].imports).toBeUndefined();
    expect(report.files[0].affectedSymbols[0].callees).toEqual([]);
  });

  // Helper: wrap the indexer's parseDocument into the BlobParser shape that
  // analyzeDiffContext accepts. Parses source content in memory without writing
  // anything to the workspace DB.
  async function parseBlob(input: { relativePath: string; content: string }): Promise<
    Array<{
      name: string;
      symbolType: string;
      exported: boolean;
      startLine: number;
      endLine: number;
      parentSymbol?: string;
    }>
  > {
    const parsed = await parseDocument({
      relativePath: input.relativePath,
      absolutePath: input.relativePath,
      content: input.content,
      targetTokens: 800,
      overlapTokens: 100,
    });
    return parsed.definedSymbols.map((s) => ({
      name: s.name,
      symbolType: s.symbolType,
      exported: s.exported,
      startLine: s.startLine ?? 1,
      endLine: s.endLine ?? s.startLine ?? 1,
      ...(s.receiver ? { parentSymbol: s.receiver } : {}),
    }));
  }

  test("marks an unchanged symbol shifted by an insertion as modified", async () => {
    const srcDir = path.join(workspaceRoot, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const targetPath = path.join(srcDir, "target.ts");
    fs.writeFileSync(
      targetPath,
      `const first = 1;
const second = 2;
const third = 3;
export function target(): number { return 2; }
`,
    );
    execSync("git add .", { cwd: workspaceRoot, stdio: "ignore" });
    execSync("git commit -m 'Initial commit'", { cwd: workspaceRoot, stdio: "ignore" });

    fs.writeFileSync(
      targetPath,
      `const first = 1;
// inserted
const second = 2;
const third = 3;
export function target(): number { return 2; }
`,
    );

    const registry = createRegistryRepository();
    const ws = await registry.ensureWorkspace({
      rootPath: workspaceRoot,
      name: "shifted-symbol-test",
    });
    await indexWorkspace({ workspaceId: ws.id, rootPath: workspaceRoot, mode: "full" });
    await ensureGraphReady(ws.id);

    const report = await analyzeDiffContext(workspaceRoot, { parseBlob });
    const target = report.files[0]?.affectedSymbols.find((symbol) => symbol.name === "target");

    expect(target?.changeType).toBe("modified");
  });

  test("returns deletedSymbols for a deleted file when parseBlob is provided", async () => {
    const srcDir = path.join(workspaceRoot, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const deletedPath = path.join(srcDir, "deleted.ts");
    fs.writeFileSync(
      deletedPath,
      `export function removedFunction(value: string): string {
  return value.trim();
}

export function alsoRemoved(): number {
  return 42;
}
`,
    );
    execSync("git add .", { cwd: workspaceRoot, stdio: "ignore" });
    execSync("git commit -m 'Initial commit'", { cwd: workspaceRoot, stdio: "ignore" });

    // Delete the file
    fs.unlinkSync(deletedPath);

    const registry = createRegistryRepository();
    const ws = await registry.ensureWorkspace({ rootPath: workspaceRoot, name: "deleted-test" });
    await indexWorkspace({ workspaceId: ws.id, rootPath: workspaceRoot, mode: "full" });
    await ensureGraphReady(ws.id);

    const report = await analyzeDiffContext(workspaceRoot, { parseBlob });

    expect(report.totalFilesChanged).toBe(1);
    expect(report.files[0].status).toBe("deleted");
    expect(report.files[0].deletedSymbols).toBeDefined();
    expect(report.files[0].deletedSymbols?.map((s) => s.name)).toEqual(
      expect.arrayContaining(["removedFunction", "alsoRemoved"]),
    );
    // No current affected symbols for a deleted file
    expect(report.files[0].affectedSymbols).toEqual([]);
  });

  test("returns oldSymbols for a historical ref diff when parseBlob is provided", async () => {
    const srcDir = path.join(workspaceRoot, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const targetPath = path.join(srcDir, "target.ts");
    fs.writeFileSync(
      targetPath,
      `export function originalFunction(value: string): string {
  return value.toLowerCase();
}
`,
    );
    execSync("git add .", { cwd: workspaceRoot, stdio: "ignore" });
    execSync("git commit -m 'Initial commit'", { cwd: workspaceRoot, stdio: "ignore" });

    // Modify the function (unstaged working-tree change, default diff is HEAD)
    fs.writeFileSync(
      targetPath,
      `export function renamedFunction(value: string): string {
  return value.toUpperCase();
}
`,
    );

    const registry = createRegistryRepository();
    const ws = await registry.ensureWorkspace({ rootPath: workspaceRoot, name: "historical-test" });
    await indexWorkspace({ workspaceId: ws.id, rootPath: workspaceRoot, mode: "full" });
    await ensureGraphReady(ws.id);

    const report = await analyzeDiffContext(workspaceRoot, { parseBlob });

    expect(report.totalFilesChanged).toBe(1);
    expect(report.files[0].status).toBe("modified");
    // oldSymbols from the HEAD blob (the old side of `git diff HEAD`)
    expect(report.files[0].oldSymbols).toBeDefined();
    expect(report.files[0].oldSymbols?.map((s) => s.name)).toContain("originalFunction");
    // Current affected symbols from the working tree
    expect(report.files[0].affectedSymbols.map((s) => s.name)).toContain("renamedFunction");
  });

  test("returns oldSymbols for a range ref (main..HEAD) when parseBlob is provided", async () => {
    const srcDir = path.join(workspaceRoot, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const targetPath = path.join(srcDir, "target.ts");

    // Commit 1: original function
    fs.writeFileSync(
      targetPath,
      `export function originalFunction(value: string): string {
  return value.toLowerCase();
}
`,
    );
    execSync("git add .", { cwd: workspaceRoot, stdio: "ignore" });
    execSync("git commit -m 'Initial commit'", { cwd: workspaceRoot, stdio: "ignore" });
    execSync("git branch main", { cwd: workspaceRoot, stdio: "ignore" });

    // Commit 2: renamed function on HEAD
    fs.writeFileSync(
      targetPath,
      `export function renamedFunction(value: string): string {
  return value.toUpperCase();
}
`,
    );
    execSync("git add .", { cwd: workspaceRoot, stdio: "ignore" });
    execSync("git commit -m 'Rename function'", { cwd: workspaceRoot, stdio: "ignore" });

    const registry = createRegistryRepository();
    const ws = await registry.ensureWorkspace({ rootPath: workspaceRoot, name: "range-ref-test" });
    await indexWorkspace({ workspaceId: ws.id, rootPath: workspaceRoot, mode: "full" });
    await ensureGraphReady(ws.id);

    // Range ref main..HEAD — old side should be main (the left side)
    const report = await analyzeDiffContext(workspaceRoot, {
      ref: "main..HEAD",
      parseBlob,
    });

    expect(report.totalFilesChanged).toBe(1);
    expect(report.files[0].status).toBe("modified");
    // oldSymbols must populate from the main blob (left side of range)
    expect(report.files[0].oldSymbols).toBeDefined();
    expect(report.files[0].oldSymbols?.map((s) => s.name)).toContain("originalFunction");
    // Current affected symbols from HEAD (right side of range)
    expect(report.files[0].affectedSymbols.map((s) => s.name)).toContain("renamedFunction");
  });

  test("returns oldSymbols for a three-dot range ref (main...HEAD) using merge-base", async () => {
    const srcDir = path.join(workspaceRoot, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const targetPath = path.join(srcDir, "target.ts");

    // Commit 1: original function on main
    fs.writeFileSync(
      targetPath,
      `export function originalFunction(value: string): string {
  return value.toLowerCase();
}
`,
    );
    execSync("git add .", { cwd: workspaceRoot, stdio: "ignore" });
    execSync("git commit -m 'Initial commit'", { cwd: workspaceRoot, stdio: "ignore" });
    execSync("git branch main", { cwd: workspaceRoot, stdio: "ignore" });

    // Commit 2: diverge on main — change the same file differently
    fs.writeFileSync(
      targetPath,
      `export function mainOnlyFunction(value: string): string {
  return value.trim();
}
`,
    );
    execSync("git add .", { cwd: workspaceRoot, stdio: "ignore" });
    execSync("git commit -m 'Change function on main'", { cwd: workspaceRoot, stdio: "ignore" });

    // Switch back to HEAD~1 and create a divergent commit
    execSync("git checkout HEAD~1", { cwd: workspaceRoot, stdio: "ignore" });
    fs.writeFileSync(
      targetPath,
      `export function renamedFunction(value: string): string {
  return value.toUpperCase();
}
`,
    );
    execSync("git add .", { cwd: workspaceRoot, stdio: "ignore" });
    execSync("git commit -m 'Rename function on HEAD branch'", {
      cwd: workspaceRoot,
      stdio: "ignore",
    });

    const registry = createRegistryRepository();
    const ws = await registry.ensureWorkspace({ rootPath: workspaceRoot, name: "three-dot-test" });
    await indexWorkspace({ workspaceId: ws.id, rootPath: workspaceRoot, mode: "full" });
    await ensureGraphReady(ws.id);

    // Three-dot range main...HEAD compares merge-base(main, HEAD) against HEAD.
    // merge-base is the initial commit, so oldSymbols should contain
    // originalFunction (from the merge-base blob), not mainOnlyFunction from
    // the left endpoint.
    const report = await analyzeDiffContext(workspaceRoot, {
      ref: "main...HEAD",
      parseBlob,
    });

    expect(report.totalFilesChanged).toBeGreaterThanOrEqual(1);
    const targetFile = report.files.find((f) => f.filePath === "src/target.ts");
    expect(targetFile).toBeDefined();
    expect(targetFile?.oldSymbols).toBeDefined();
    expect(targetFile?.oldSymbols?.map((s) => s.name)).toContain("originalFunction");
    expect(targetFile?.affectedSymbols.map((s) => s.name)).toContain("renamedFunction");
  });

  test("does not return oldSymbols when parseBlob is not provided", async () => {
    const srcDir = path.join(workspaceRoot, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const deletedPath = path.join(srcDir, "deleted.ts");
    fs.writeFileSync(
      deletedPath,
      `export function removedFunction(): number { return 42; }
`,
    );
    execSync("git add .", { cwd: workspaceRoot, stdio: "ignore" });
    execSync("git commit -m 'Initial commit'", { cwd: workspaceRoot, stdio: "ignore" });
    fs.unlinkSync(deletedPath);

    const registry = createRegistryRepository();
    const ws = await registry.ensureWorkspace({ rootPath: workspaceRoot, name: "no-parse-blob" });
    await indexWorkspace({ workspaceId: ws.id, rootPath: workspaceRoot, mode: "full" });

    const report = await analyzeDiffContext(workspaceRoot);

    expect(report.files[0].status).toBe("deleted");
    expect(report.files[0].deletedSymbols).toBeUndefined();
    expect(report.files[0].oldSymbols).toBeUndefined();
  });

  test("formats newly added symbols as added", async () => {
    const srcDir = path.join(workspaceRoot, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const addedPath = path.join(srcDir, "added.ts");
    fs.writeFileSync(path.join(srcDir, "existing.ts"), "export const existing = true;\n");
    execSync("git add .", { cwd: workspaceRoot, stdio: "ignore" });
    execSync("git commit -m 'Initial commit'", { cwd: workspaceRoot, stdio: "ignore" });

    fs.writeFileSync(addedPath, "export function addedSymbol(): void {}\n");
    execSync("git add src/added.ts", { cwd: workspaceRoot, stdio: "ignore" });

    const registry = createRegistryRepository();
    const ws = await registry.ensureWorkspace({ rootPath: workspaceRoot, name: "added-summary" });
    await indexWorkspace({ workspaceId: ws.id, rootPath: workspaceRoot, mode: "full" });

    const report = await analyzeDiffContext(workspaceRoot, { staged: true });

    expect(report.formattedSummary).toContain("addedSymbol [L1-L1] (added)");
  });

  test("does not warn when an added file has no historical blob", async () => {
    const srcDir = path.join(workspaceRoot, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const addedPath = path.join(srcDir, "added.ts");
    fs.writeFileSync(path.join(srcDir, "existing.ts"), "export const existing = true;\n");
    execSync("git add .", { cwd: workspaceRoot, stdio: "ignore" });
    execSync("git commit -m 'Initial commit'", { cwd: workspaceRoot, stdio: "ignore" });

    fs.writeFileSync(addedPath, "export function addedSymbol(): void {}\n");
    execSync("git add src/added.ts", { cwd: workspaceRoot, stdio: "ignore" });

    const registry = createRegistryRepository();
    const ws = await registry.ensureWorkspace({ rootPath: workspaceRoot, name: "added-history" });
    await indexWorkspace({ workspaceId: ws.id, rootPath: workspaceRoot, mode: "full" });

    const report = await analyzeDiffContext(workspaceRoot, { staged: true, parseBlob });

    expect(report.warnings).toBeUndefined();
    expect(report.files[0].warnings).toBeUndefined();
  });

  // ── P1: Git ref validation (option injection prevention) ──

  test("isValidGitRef rejects option-injection and malformed refs", () => {
    // Valid refs
    expect(isValidGitRef("HEAD")).toBe(true);
    expect(isValidGitRef("HEAD~1")).toBe(true);
    expect(isValidGitRef("HEAD^2")).toBe(true);
    expect(isValidGitRef("main")).toBe(true);
    expect(isValidGitRef("origin/main")).toBe(true);
    expect(isValidGitRef("feature/cli-diff")).toBe(true);
    expect(isValidGitRef("v1.2.3")).toBe(true);
    expect(isValidGitRef("main..HEAD")).toBe(true);
    expect(isValidGitRef("main...HEAD")).toBe(true);
    expect(isValidGitRef("HEAD@{1}")).toBe(true);

    // Option injection — refs starting with `-`
    expect(isValidGitRef("--output=/etc/passwd")).toBe(false);
    expect(isValidGitRef("--upload-pack=malicious")).toBe(false);
    expect(isValidGitRef("-o/etc/passwd")).toBe(false);
    expect(isValidGitRef("-")).toBe(false);

    // Null bytes and newlines
    expect(isValidGitRef("HEAD\0malicious")).toBe(false);
    expect(isValidGitRef("HEAD\nmalicious")).toBe(false);
    expect(isValidGitRef("HEAD\rmalicious")).toBe(false);

    // Empty / too long
    expect(isValidGitRef("")).toBe(false);
    expect(isValidGitRef("a".repeat(300))).toBe(false);

    // Shell metacharacters that have no place in a rev expression
    expect(isValidGitRef("HEAD; rm -rf /")).toBe(false);
    expect(isValidGitRef("HEAD && echo pwned")).toBe(false);
    expect(isValidGitRef("$(whoami)")).toBe(false);
    expect(isValidGitRef("HEAD`whoami`")).toBe(false);

    // Loose validation false positives (now tightened)
    expect(isValidGitRef("a..b..c")).toBe(false); // double range — git rejects
    expect(isValidGitRef("HEAD..")).toBe(false); // incomplete range
    expect(isValidGitRef("main...")).toBe(false); // incomplete range

    // Trailing `-` is valid in git branch names (e.g. feature-)
    expect(isValidGitRef("feature-")).toBe(true);
  });

  test("analyzeDiffContext rejects an invalid git ref before running git", async () => {
    const srcDir = path.join(workspaceRoot, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, "dummy.ts"), "export const x = 1;\n");
    execSync("git add .", { cwd: workspaceRoot, stdio: "ignore" });
    execSync("git commit -m 'Initial commit'", { cwd: workspaceRoot, stdio: "ignore" });

    await expect(analyzeDiffContext(workspaceRoot, { ref: "--output=/tmp/evil" })).rejects.toThrow(
      /invalid.*ref|ref.*invalid/i,
    );
  });

  // ── P1: Deletion-only hunks must still match affected symbols ──

  test("matches affected symbols for deletion-only hunks (+L,0)", () => {
    // A hunk where newCount=0 (pure deletion, no new lines at that position).
    // The parser must still emit a range so symbol intersection fires.
    const parsed = parseGitDiffHunks(`diff --git a/src/code.ts b/src/code.ts
index 1234567..89abcdef 100644
--- a/src/code.ts
+++ b/src/code.ts
@@ -10,4 +10,0 @@
-export function deletedFunc() {
-  return 42;
-}
-
`);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].status).toBe("modified");
    expect(parsed[0].oldRanges).toEqual([{ start: 10, end: 13 }]);
    // Deletion-only hunk: newStart=10, newCount=0 → point range at line 10
    expect(parsed[0].ranges).toEqual([{ start: 10, end: 10 }]);
  });

  test("does not fabricate ranges for deletion-only hunks on deleted files", () => {
    const parsed = parseGitDiffHunks(`diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
--- a/src/gone.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-export function gone() {
-  return true;
-}
`);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].status).toBe("deleted");
    expect(parsed[0].oldRanges).toEqual([{ start: 1, end: 3 }]);
    // Deleted files must not get fabricated current ranges
    expect(parsed[0].ranges).toEqual([]);
  });

  test("analyzes deletion-only diff hunks and reports affected symbols", async () => {
    const srcDir = path.join(workspaceRoot, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const codePath = path.join(srcDir, "code.ts");

    // Start with a function that has extra lines we will delete
    fs.writeFileSync(
      codePath,
      `export function target(): number {
  const a = 1;
  const b = 2;
  const c = 3;
  const d = 4;
  return a + b + c + d;
}
`,
    );
    execSync("git add .", { cwd: workspaceRoot, stdio: "ignore" });
    execSync("git commit -m 'Initial commit'", { cwd: workspaceRoot, stdio: "ignore" });

    // Delete lines b and c (pure deletion in the middle of the function)
    fs.writeFileSync(
      codePath,
      `export function target(): number {
  const a = 1;
  const d = 4;
  return a + d;
}
`,
    );

    const registry = createRegistryRepository();
    const ws = await registry.ensureWorkspace({ rootPath: workspaceRoot, name: "deletion-only" });
    await indexWorkspace({ workspaceId: ws.id, rootPath: workspaceRoot, mode: "full" });
    await ensureGraphReady(ws.id);

    const report = await analyzeDiffContext(workspaceRoot);

    expect(report.totalFilesChanged).toBe(1);
    expect(report.files[0].filePath).toBe("src/code.ts");
    // The target function must be detected as affected even though
    // the hunk may be deletion-only with no new lines at that position.
    expect(report.files[0].affectedSymbols.length).toBeGreaterThan(0);
    expect(report.files[0].affectedSymbols[0].name).toBe("target");
  });

  // ── Medium #2: graphNeighbors must not starve callers or callees ──

  test("reports both callers and callees when a symbol has many of each", async () => {
    const srcDir = path.join(workspaceRoot, "src");
    fs.mkdirSync(srcDir, { recursive: true });

    // helpers.ts defines 12 exported helper functions (callees)
    const helperDefs = Array.from(
      { length: 12 },
      (_, i) => `export function helper${i}(): number { return ${i}; }`,
    ).join("\n");
    fs.writeFileSync(path.join(srcDir, "helpers.ts"), helperDefs + "\n");

    // target.ts imports and calls all 12 helpers (callees)
    const imports = Array.from({ length: 12 }, (_, i) => `  helper${i}();`).join("\n");
    fs.writeFileSync(
      path.join(srcDir, "target.ts"),
      `import { ${Array.from({ length: 12 }, (_, i) => `helper${i}`).join(", ")} } from "./helpers";\nexport function target(): void {\n${imports}\n}\n`,
    );

    // 12 callers each call target
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(
        path.join(srcDir, `caller${i}.ts`),
        `import { target } from "./target";\nexport function caller${i}(): void { target(); }\n`,
      );
    }

    execSync("git add .", { cwd: workspaceRoot, stdio: "ignore" });
    execSync("git commit -m 'Initial commit'", { cwd: workspaceRoot, stdio: "ignore" });

    const registry = createRegistryRepository();
    const ws = await registry.ensureWorkspace({
      rootPath: workspaceRoot,
      name: "directional-test",
    });
    await indexWorkspace({ workspaceId: ws.id, rootPath: workspaceRoot, mode: "full" });
    await ensureGraphReady(ws.id);

    // Modify target so it shows up in the diff
    fs.writeFileSync(
      path.join(srcDir, "target.ts"),
      `import { ${Array.from({ length: 12 }, (_, i) => `helper${i}`).join(", ")} } from "./helpers";\nexport function target(): void {\n${imports}\n  // modified\n}\n`,
    );

    const report = await analyzeDiffContext(workspaceRoot, { limit: 5 });

    expect(report.files[0].affectedSymbols.length).toBeGreaterThan(0);
    const sym = report.files[0].affectedSymbols[0];
    expect(sym.name).toBe("target");
    // Both directions must have results — graphNeighbors must not starve
    // one direction by sharing a single edge limit across both.
    expect(sym.callers.length).toBeGreaterThan(0);
    expect(sym.callees.length).toBeGreaterThan(0);
  });

  // ── Low #3: totalSymbolsAffected must count deleted symbols ──

  test("totalSymbolsAffected counts deletedSymbols for deleted files", async () => {
    const srcDir = path.join(workspaceRoot, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const deletedPath = path.join(srcDir, "deleted.ts");
    fs.writeFileSync(
      deletedPath,
      `export function removedFunction(value: string): string {
  return value.trim();
}

export function alsoRemoved(): number {
  return 42;
}
`,
    );
    execSync("git add .", { cwd: workspaceRoot, stdio: "ignore" });
    execSync("git commit -m 'Initial commit'", { cwd: workspaceRoot, stdio: "ignore" });

    fs.unlinkSync(deletedPath);

    const registry = createRegistryRepository();
    const ws = await registry.ensureWorkspace({
      rootPath: workspaceRoot,
      name: "count-deleted-test",
    });
    await indexWorkspace({ workspaceId: ws.id, rootPath: workspaceRoot, mode: "full" });
    await ensureGraphReady(ws.id);

    const report = await analyzeDiffContext(workspaceRoot, { parseBlob });

    expect(report.files[0].status).toBe("deleted");
    expect(report.files[0].deletedSymbols?.length).toBe(2);
    // totalSymbolsAffected must include deleted symbols, not just affectedSymbols
    expect(report.totalSymbolsAffected).toBeGreaterThanOrEqual(2);
  });

  test("totalSymbolsAffected counts symbols removed within a modified file", async () => {
    const srcDir = path.join(workspaceRoot, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const codePath = path.join(srcDir, "code.ts");

    // Start with two functions
    fs.writeFileSync(
      codePath,
      `export function kept(): number {
  return 1;
}

export function removed(): number {
  return 2;
}
`,
    );
    execSync("git add .", { cwd: workspaceRoot, stdio: "ignore" });
    execSync("git commit -m 'Initial commit'", { cwd: workspaceRoot, stdio: "ignore" });

    // Remove the `removed` function entirely (modified file, not deleted file)
    fs.writeFileSync(
      codePath,
      `export function kept(): number {
  return 1;
}
`,
    );

    const registry = createRegistryRepository();
    const ws = await registry.ensureWorkspace({
      rootPath: workspaceRoot,
      name: "partial-count-test",
    });
    await indexWorkspace({ workspaceId: ws.id, rootPath: workspaceRoot, mode: "full" });
    await ensureGraphReady(ws.id);

    const report = await analyzeDiffContext(workspaceRoot, { parseBlob });

    expect(report.files[0].status).toBe("modified");
    // oldSymbols should contain the removed function with changeType "deleted"
    const removedOld = report.files[0].oldSymbols?.filter((s) => s.changeType === "deleted");
    expect(removedOld?.length).toBeGreaterThanOrEqual(1);
    expect(removedOld?.map((s) => s.name)).toContain("removed");
    // deletedSymbols should also contain the removed function — clients
    // should find all deleted symbols in one place regardless of file status
    expect(report.files[0].deletedSymbols?.length).toBeGreaterThanOrEqual(1);
    expect(report.files[0].deletedSymbols?.map((s) => s.name)).toContain("removed");
    // totalSymbolsAffected must count the removed-within-file symbol too
    expect(report.totalSymbolsAffected).toBeGreaterThanOrEqual(1);
  });
});
