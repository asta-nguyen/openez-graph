# Remove Superpowers and adopt agent-devkit tasks

## Design

[Remove Superpowers and adopt agent-devkit](design.md)

## Global Constraints

- Copy canonical skill files from upstream commit `b7e67f591a7f7ce8407edffabb8d7da951d05134`; do not customize them.
- Apply the migration to the main checkout and the three named existing worktrees, without deleting a worktree or changing its application source.
- Preserve `.agents/skills/release-cli` in every checkout and preserve unrelated findings in `reviews/pull-21.md`.
- Delete the Superpowers-related docs, hooks, ignored local state, and review fragments specified by the design.
- Preserve the user's existing `.windsurf/skills/release-cli/SKILL.md` deletion; do not change global or user-level agent configuration.
- Do not change application source, dependencies, schemas, product APIs, or commit/push changes.

## Impact map

Entry: `AGENTS.md` workflow guidance and `.devin/hooks.v1.json` in the main checkout and three worktrees.
Flow: each checkout's repository-local agent → `.agents/skills/using-devkit/SKILL.md`; Devin → `.devin/hooks.v1.json` → project SessionStart script → Devkit skill content. Existing Superpowers path: `.devin/hooks/superpowers-session-start.sh` → project/global `using-superpowers` skill.
State changes: remove `.superpowers/` local SDD state in the main checkout and in any worktree where present; remove tracked `docs/superpowers/` records in all four checkouts.
External effects: Devin SessionStart still adds skill text to session context; no service calls or persistent application data changes.
Change candidates: in all checkouts, `.agents/skills/superpowers-*/**`, `.agents/skills/**`, `AGENTS.md`, `.devin/hooks.v1.json`, `.devin/hooks/superpowers-session-start.sh`, new `.devin/hooks/agent-devkit-session-start.sh`, `.prettierignore`, and `docs/superpowers/**`; root `.superpowers/**` and existing worktree `.superpowers/**`; the Superpowers-related sections of ignored `reviews/pull-21.md`.
Verification: compare Devkit skill trees to the pinned source; inspect each checkout's status and confirm only planned paths changed; check hook JSON and output, shell syntax, deleted data paths, preserved `release-cli`, preserved review sections, preserved worktree source, and run `git diff --check` in all four checkouts. No application tests apply.
Verified at: main `6aec04fabd5d3538d82b6600977b0f4d46ffdc04`; `feat/enhance-merge-ready` `898a890ac13ee84ca35dfae71d13f72604cc0bb0`; `feature-java-c` `69f8f3abda534f3b879c05ede4fed5236239e884`; `task-3-cli-diff-context` `afd5aa8bc5c7c102a0287030f6c6de798542d195`.

## Tasks

### Task 1 — Switch the four project checkouts to agent-devkit

Files: `AGENTS.md`, each checkout's `.agents/skills/superpowers-*/**` and `.agents/skills/**`, `.devin/hooks.v1.json`, `.devin/hooks/superpowers-session-start.sh`, new `.devin/hooks/agent-devkit-session-start.sh`, and `.prettierignore`.
Interfaces: Use the upstream portable `SKILL.md` tree; expose `using-devkit` and the full skill inventory through each `AGENTS.md`; retain each Devin `SessionStart` JSON contract and current project-first/user-level fallback.
Change: Install the pinned canonical Devkit skills in all four checkouts, remove their Superpowers skill directories, update each `AGENTS.md` skill entry and Devin bootstrap, delete the old hook script, and remove the `.superpowers/` ignore rule. Keep each `release-cli` skill and all unrelated guidance unchanged.
Verify: Compare each Devkit skill tree with the pinned source; confirm `using-devkit` inventory paths resolve, no Superpowers skill paths remain, and each `release-cli` remains. Parse all four hook configs, run `bash -n` on all new hooks, execute each hook and validate its JSON output includes `using-devkit`; run `git diff --check` in each checkout.
Progress: done
Result: Pinned tree comparison, inventory/config checks, shell syntax and hook output validation, and `git diff --check` passed in all four checkouts.

### Task 2 — Delete Superpowers history and local state

Files: `docs/superpowers/**` in all four checkouts; `.superpowers/**` in the main checkout and any worktree where present; Superpowers-targeted blocks in ignored `reviews/pull-21.md`.
Interfaces: No runtime interfaces; remove only records and ignored data explicitly named by the user's scope change.
Change: Delete all `docs/superpowers/` records and existing `.superpowers/` local state in the four project checkouts. Remove only the review blocks in `reviews/pull-21.md` that reference the deleted docs; keep its unrelated findings.
Verify: Confirm no `docs/superpowers/` or `.superpowers/` paths remain in any of the four checkouts; confirm `reviews/pull-21.md` has no references to `docs/superpowers/` and retains its unrelated sections; confirm worktree directories and application source remain present.
Progress: done
Result: Removal checks passed in all four checkouts; the two targeted review sections are gone and unrelated findings remain.

## Files inspected, no change

- `.agents/skills/release-cli/SKILL.md` — separate project-specific skill to preserve.
- `.gitignore` — worktree directories are ignored and remain in place.
- `.worktrees/*` status and branch roots — all three separate checkouts were clean at baseline and remain in place.
- `.windsurf/skills/release-cli/SKILL.md` — pre-existing user-owned deletion to preserve.

## Approval Gate

Status: approved
Approved by: user in the current conversation (`implement-task`), 2026-10-19

## Decision Log

- 2026-10-19 — User expanded scope to delete historical Superpowers docs and ignored local state and apply the migration across the three existing worktrees.
- 2026-10-19 — User approved the revised design and tasks by requesting `implement-task`.
