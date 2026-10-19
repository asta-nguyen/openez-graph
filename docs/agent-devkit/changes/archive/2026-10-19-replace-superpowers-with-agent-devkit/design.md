# Remove Superpowers and adopt agent-devkit

## Goal

Remove the Superpowers tooling, records, and local state from this project, and use the official `asta-nguyen/agent-devkit` skills instead.

## Scope

- In the main checkout and the three existing Git worktrees (`feat/enhance-merge-ready`, `feature-java-c`, and `task-3-cli-diff-context`), replace every `.agents/skills/superpowers-*` directory with the canonical `skills/` tree from `asta-nguyen/agent-devkit` at commit `b7e67f591a7f7ce8407edffabb8d7da951d05134`.
- In each checkout, update `AGENTS.md` to route work through `using-devkit`, retarget the Devin SessionStart hook to inject the project-local Devkit skill, and remove the `.superpowers/` ignore rule from `.prettierignore`.
- Delete each checkout's `docs/superpowers/` history and its ignored `.superpowers/` state, wherever present.
- In the root ignored `reviews/pull-21.md`, remove only the two review sections that point to the deleted `docs/superpowers/` files; retain unrelated findings.
- Keep the separate project-specific `release-cli` skill in each checkout.
- Preserve the three Git worktree directories and their application source. The migration will leave expected uncommitted skill/config/document deletions and additions in those worktrees; do not commit or remove any worktree.
- Preserve the pre-existing deletion of `.windsurf/skills/release-cli/SKILL.md`. Do not modify global agent installations or user-level configuration.
- Do not change application source, dependencies, schemas, or product APIs.

The repository has no `docs/llm/` wiki, so this change has no wiki delta.

## Behavior

All four current checkouts expose the pinned upstream Devkit skill set under `.agents/skills/`, with `using-devkit` as the workflow entry point. Devin's SessionStart hook in each checkout injects that skill and retains its existing project-first/user-level fallback and fail-open behavior.

No Superpowers skill, historical doc, local SDD state, runtime hook, or ignore entry remains in these checkouts. The targeted references in `reviews/pull-21.md` are removed while unrelated review findings remain. The new migration record documents this removal. Devkit skills are managed copies and are not customized locally.

## Edge cases

- `release-cli` is not part of Superpowers and must remain untouched.
- The ignored `.superpowers/` trees contain local SDD ledgers, briefs, reports, and review diffs. The user's instruction explicitly authorizes deleting this state; it will not be recoverable through Git.
- The three existing worktrees are separate clean branch checkouts. This change will make only the requested Devkit/Superpowers-related edits in them; their branch source and worktree directories remain intact, and the worktrees will show those edits as uncommitted changes.
- `reviews/pull-21.md` is ignored local review data; preserve its unrelated code findings while removing only sections tied to the deleted Superpowers docs.
- Do not remove global skills or any other files merely because they mention the old workflow outside these four project checkouts.
- A fresh agent session is needed in each checkout for the skill inventory to reload.

## Interfaces

- The repository-local skill loader consumes `SKILL.md` files under `.agents/skills/`.
- Each `.devin/hooks.v1.json` retains its existing `SessionStart` schema and points to a project-local Devkit bootstrap script.
- Each `AGENTS.md` names the Devkit entry point and installed skills without changing its other project-specific guidance.
- No product API, database schema, dependency, or runtime interface changes.

## Verification

- In each checkout, compare the installed Devkit skill files with the pinned upstream tree; confirm no `superpowers-*` skill directories, `docs/superpowers/`, `.superpowers/`, or `.superpowers/` ignore entries remain, and confirm `release-cli` remains.
- Parse each Devin hook config, run `bash -n` on each new hook, and validate the hook output JSON contains the `using-devkit` content.
- Confirm `reviews/pull-21.md` no longer references `docs/superpowers/` while unrelated review sections remain.
- Confirm all worktree directories and branch source files remain present; only intended migration paths are modified in those worktrees.
- Run `git diff --check` in all four checkouts.
- No application tests are in scope because this change does not touch application code. Baseline static checks passed in the main checkout before edits: `git diff --check`, the current hook's `bash -n`, and parsing `.devin/hooks.v1.json`; all three worktrees were clean at their recorded baseline commits.

## Related context

None. No verified `docs/llm/` wiki pages exist in this repository.
