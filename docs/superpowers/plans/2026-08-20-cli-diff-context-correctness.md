# CLI Diff Context Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans (recommended) to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Make openez diff and MCP diff_context consistent and correct for staged, unstaged, and supported Git-reference changes without changing the SQLite schema.

**Architecture:** Keep Git parsing, hunk mapping, symbol intersection, and report generation in packages/core/src/diff-context.ts. Reuse the existing incremental indexer and graph lifecycle from packages/indexer for both CLI and MCP; do not duplicate MCP-only preparation logic in core. HEAD, INDEX, and WORKTREE are Git snapshots, not application versions or watch-mode states. Historical symbol mapping for arbitrary refs is a separate phase because it requires parsing Git blobs from the compared revision.

**Tech Stack:** TypeScript, Bun tests, Git CLI via execFileSync, SQLite workspace index, existing indexWorkspace() and ensureGraphReady() services.

## Global Constraints

- Preserve SQLite/WAL/index lease behavior; no database schema migration.
- Keep the PR focused on cli-diff-context; revert the unrelated Umami ID change in landing/src/app/layout.tsx.
- Reuse existing indexer, graph, token-budget, and workspace-resolution helpers.
- Default semantics are git diff HEAD for tracked staged + unstaged changes.
- --staged means git diff --staged; ref and --staged are mutually exclusive everywhere.
- Every non-trivial behavior gets a focused Bun test before the full repository gates.

## File responsibility matrix

| File                                                   | Responsibility                                                                          |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| packages/core/src/diff-context.ts                      | Git scope, hunk model, mapping, symbol intersection, graph context, report coordinates. |
| packages/core/src/index.ts                             | Public diff-context exports.                                                            |
| packages/indexer/src/index.ts                          | Export the existing graph-readiness service if CLI cannot import it yet.                |
| apps/cli/src/cli.ts                                    | Resolve workspace, incremental catch-up, graph readiness, analyzer invocation.          |
| apps/mcp/src/mcp-core.ts                               | MCP validation, stable bounded response, structured errors.                             |
| tests/diff-context.test.ts                             | Parser, scope, mapping, deletion, and graph-context tests.                              |
| tests/cli-diff.test.ts                                 | CLI end-to-end graph-readiness regression test.                                         |
| tests/mcp-tools.test.ts                                | MCP diff_context contract and round-trip tests.                                         |
| README.md, apps/cli/README.md, AGENTS.md, CHANGELOG.md | User-facing command/tool contract and release notes.                                    |
| landing/src/app/layout.tsx                             | Revert only the unrelated analytics ID change.                                          |

## Phase 1 — Merge blockers: Git scope and interface consistency

### Task 1: Define and test Git scope semantics

**Files:**

- Modify: packages/core/src/diff-context.ts:168-202
- Modify: apps/cli/src/cli.ts:351-376
- Modify: apps/mcp/src/mcp-core.ts:863-885
- Test: tests/diff-context.test.ts
- Test: tests/mcp-tools.test.ts

**Interfaces:**

- analyzeDiffContext(rootPath, { ref?, staged?, limit? }) rejects ref + staged.
- No options invokes git diff HEAD.
- staged: true invokes git diff --staged.
- MCP and CLI expose the same validation error.

- [ ] **Step 1: Add failing mixed-state tests.** Create a temporary repository with one staged edit and one unstaged edit. Assert the default report contains both files, the staged report contains only the staged file, and ref + staged fails.
- [ ] **Step 2: Run bun test tests/diff-context.test.ts tests/mcp-tools.test.ts; confirm the default mixed-state test fails because the current code invokes plain git diff.**
- [ ] **Step 3: Implement one core Git-argument decision table:**

```
if (options.ref && options.staged) {
  throw new Error("Cannot combine a git ref with staged changes");
}
if (options.staged) gitArgs.push("--staged");
else if (options.ref) gitArgs.push(options.ref);
else gitArgs.push("HEAD");
```

- [ ] **Step 4: Remove CLI-only divergence and make MCP return { error, ref, staged } through the existing jsonResponse() helper.**
- [ ] **Step 5: Run focused tests and commit:**

```
bun test tests/diff-context.test.ts tests/mcp-tools.test.ts
git add packages/core/src/diff-context.ts apps/cli/src/cli.ts apps/mcp/src/mcp-core.ts tests/diff-context.test.ts tests/mcp-tools.test.ts
git commit -m "fix(diff): make git scope semantics consistent"
```

### Task 2: Remove scope creep and document the contract

**Files:**

- Modify: landing/src/app/layout.tsx:98
- Modify: README.md
- Modify: apps/cli/README.md
- Modify: AGENTS.md
- Modify: CHANGELOG.md

- [ ] **Step 1:** Restore the Umami ID from origin/main; do not touch surrounding landing code.
- [ ] **Step 2:** Document:

```
openez diff          tracked staged + unstaged changes
openez diff --staged staged changes only
openez diff HEAD~1   diff against the supplied Git ref
```

- [ ] **Step 3:** Explain that MCP path/paths select registered workspace roots, not changed files. Explicitly document that untracked files are not included in this Git-diff phase.
- [ ] **Step 4:** Commit only the focused documentation/revert:

```
git add landing/src/app/layout.tsx README.md apps/cli/README.md AGENTS.md CHANGELOG.md
git commit -m "docs(diff): document scopes and workspace selectors"
```

## Phase 2 — Merge blockers: current-tree indexing and line mapping

### Task 3: Make CLI use the same index/graph preparation as MCP

**Files:**

- Modify: packages/indexer/src/index.ts
- Modify: apps/cli/src/cli.ts:370-376
- Create: tests/cli-diff.test.ts
- Modify: tests/diff-context.test.ts
- Modify: tests/mcp-tools.test.ts

**Interfaces:**

- CLI resolves one registered workspace ID, calls indexWorkspace({ workspaceId, mode: "incremental" }), calls existing ensureGraphReady(workspaceId), then calls analyzeDiffContext(rootPath, options).
- MCP keeps its catch-up throttling but uses the same analyzer and graph service.

- [ ] **Step 1:** Add a failing CLI integration test with target.ts and caller.ts; index once, modify target.ts, invoke the CLI path, and assert the report contains the caller without manually building the graph.
- [ ] **Step 2:** Run bun test tests/cli-diff.test.ts; confirm current CLI produces missing/empty graph context.
- [ ] **Step 3:** Export the existing ensureGraphReady from packages/indexer/src/index.ts only if it is not already public; do not import private MCP helpers.
- [ ] **Step 4:** Resolve the workspace using existing CLI registry rules, then add:

```
await indexWorkspace({ workspaceId: workspace.id, mode: "incremental" });
await ensureGraphReady(workspace.id);
const report = await analyzeDiffContext(workspace.rootPath, options);
```

- [ ] **Step 5:** Run and commit:

```
bun test tests/cli-diff.test.ts tests/diff-context.test.ts tests/mcp-tools.test.ts
git add packages/indexer/src/index.ts apps/cli/src/cli.ts tests/cli-diff.test.ts tests/diff-context.test.ts tests/mcp-tools.test.ts
git commit -m "fix(diff): prepare index and graph before CLI analysis"
```

### Task 4: Replace staged mapping with old/new-coordinate mapping

**Files:**

- Modify: packages/core/src/diff-context.ts:28-163
- Modify: tests/diff-context.test.ts

**Interfaces:**

- changedLineRanges always uses working-tree coordinates, matching parsed_documents.
- FileDiffHunks retains old-side ranges and oldPath when Git supplies them.
- Deleted files return file metadata without fabricated current symbol ranges.

- [ ] **Step 1:** Add failing tests for two unstaged hunks before/after one staged hunk; assert the same affected symbol and working-tree line range.
- [ ] **Step 2:** Add parser tests for insertion, deletion, rename metadata, binary/mode-only no-hunk files, and empty diff.
- [ ] **Step 3:** Implement an immutable, single-pass transform: apply deltas from earlier non-overlapping hunks in old-file coordinates; when a range overlaps a hunk, return the union in working-tree coordinates instead of shifting an already-shifted range again.
- [ ] **Step 4:** Run and commit:

```
bun test tests/diff-context.test.ts
git add packages/core/src/diff-context.ts tests/diff-context.test.ts
git commit -m "fix(diff): normalize staged hunk coordinates"
```

## Phase 3 — MCP contract and regression coverage

### Task 5: Make MCP output stable and bounded

**Files:**

- Modify: apps/mcp/src/mcp-core.ts:93-101,863-900
- Modify: packages/core/src/diff-context.ts
- Modify: tests/mcp-tools.test.ts
- Modify: README.md
- Modify: AGENTS.md

**Interfaces:**

- Add positive-integer maxTokens, reusing the existing token-fitting helper.
- Always return { workspaces: [{ workspaceId, workspaceName, report }] }, including one-workspace calls.
- path/paths descriptions identify workspace selectors.
- Git/index/graph failures return structured { error, workspaceId?, ref?, staged? }; never return an empty success report.

- [ ] **Step 1:** Add tests for single/multi-workspace shape, maxTokens, invalid path, invalid ref, and ref + staged.
- [ ] **Step 2:** Budget the serialized report with the existing token-fitting helper; omit/truncate formattedSummary before dropping structured symbols/files.
- [ ] **Step 3:** Normalize errors through jsonResponse() while preserving the actionable message.
- [ ] **Step 4:** Run and commit:

```
bun test tests/mcp-tools.test.ts
git add apps/mcp/src/mcp-core.ts packages/core/src/diff-context.ts tests/mcp-tools.test.ts README.md AGENTS.md
git commit -m "fix(mcp): stabilize and bound diff context responses"
```

## Phase 4 — Separate historical/deleted-symbol support

This phase is intentionally separate from the merge-safe fixes. It is not watch mode; it compares different Git snapshots and requires parsing source from the old snapshot.

### Task 6: Support deleted symbols and historical refs

**Files:**

- Modify: packages/core/src/diff-context.ts
- Modify: packages/core/src/index.ts
- Modify: tests/diff-context.test.ts
- Modify: README.md
- Modify: apps/cli/README.md

**Interfaces:**

- Load old source with git show revision:path.
- Parse old source through the existing language parser; never write historical blobs into the workspace DB.
- Add explicit oldSymbols/deletedSymbols fields; do not pretend deleted symbols exist in the current AST.
- Current graph edges are used for historical symbols only when a current graph node exists; document that a historical graph is not reconstructed.

- [ ] **Step 1:** Add failing tests for a deleted function and a historical rename; assert old-side symbol and line data.
- [ ] **Step 2:** Add a typed Git-blob loader using the existing safe argument-array execution and a structured warning for a missing blob.
- [ ] **Step 3:** Reuse the existing parser entrypoint for blob content.
- [ ] **Step 4:** Map old ranges to old symbols and new ranges to current symbols; mark symbols added, modified, or deleted.
- [ ] **Step 5:** Run bun test tests/diff-context.test.ts and document current-graph-only caller/callee semantics.

## Final verification gate

- [ ] Run focused tests:

```
bun test tests/diff-context.test.ts tests/cli-diff.test.ts tests/mcp-tools.test.ts
```

- [ ] Run repository gates:

```
bun test
pnpm typecheck
pnpm build:cli
```

- [ ] Smoke-test both CLI scopes:

```
bun apps/cli/dist/cli.cjs diff --json
bun apps/cli/dist/cli.cjs diff --staged --json
```

- [ ] Check the final diff:

```
git diff --check origin/main...HEAD
git status --short
```

Expected: all tests pass, no unrelated landing change remains, and CLI/MCP use the same Git scope and graph context.
