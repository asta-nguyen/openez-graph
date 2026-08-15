import { describe, expect, test } from "bun:test";

import { parseGitDiffHunks } from "../packages/core/src/diff-context";

describe("diff-context analyzer", () => {
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
`;

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
});
