import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { analyzeDiffContext, parseGitDiffHunks } from "../packages/core/src/diff-context";
import { createRegistryRepository } from "../packages/db/src/sqlite";
import { indexWorkspace } from "../packages/indexer/src";

describe("diff-context analyzer", () => {
  let tmpDir: string;
  let workspaceRoot: string;
  const origRegistryDbPath = process.env.AI_MEMORY_REGISTRY_DB_PATH;

  beforeEach(() => {
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
  });
});
