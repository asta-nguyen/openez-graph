---
description: Release the OpenEZ CLI to npm — bump version, update changelog, build, publish, and push. Use when the user says "release", "publish", "deploy cli", "bump version", or wants to ship a new version to npm.
---

# Release CLI

A release is a **tight loop** — bump, log, build, verify, publish, push — where every step has a checkable gate before moving on. No step starts until the previous one is green.

## Prerequisites

- Working directory is the openez-graph monorepo root.
- `npm whoami` returns `asta_nguyen` (or the user is logged in to npm).
- Current branch is `main` (or the user has confirmed the branch).

## Steps

### 1. Determine the version bump

Read `apps/cli/package.json` for the current version. Classify the changes since the last release:

- **Patch** (0.x.Y → 0.x.Y+1): UI fixes, doc updates, minor bug fixes, no new features.
- **Minor** (0.X.y → 0.X+1.0): New features, significant fixes (security, data integrity), new routes/pages — anything that adds capability.
- **Major** (X.y.z → X+1.0.0): Breaking changes to CLI commands, MCP tool signatures, or DB schema.

If unsure, ask the user. Default to **minor** when multiple fixes ship together.

**Completion criterion**: A target version number is chosen and stated.

### 2. Bump version

Edit `apps/cli/package.json` — update the `"version"` field only.

**Completion criterion**: `bun apps/cli/dist/cli.cjs --version` would show the new version after rebuild (verify in step 4).

### 3. Update CHANGELOG.md

Add a new `## [X.Y.Z] - YYYY-MM-DD` section at the top (below the header block) of `/CHANGELOG.md`.

Use [Keep a Changelog](https://keepachangelog.com/) groups:

- `### Added` — new features, new routes, new UI pages
- `### Changed` — changes to existing functionality
- `### Deprecated`
- `### Removed` — deleted features, removed endpoints
- `### Fixed` — bug fixes, security patches
- `### Security` — security-relevant fixes (call out separately from Fixed)

Each entry is one bullet, prefixed with the area in parens when helpful: `- Web index endpoint now runs real indexing (FIX-05)`.

Add a compare link at the bottom of the file:

```
[X.Y.Z]: https://github.com/asta-nguyen/openez-graph/compare/<prev-commit-sha>...<current-head-sha>
```

**Completion criterion**: CHANGELOG.md has a new dated section with at least one bullet, and the compare link is present.

### 4. Build and verify

Run in order from the monorepo root:

```bash
pnpm build:web    # rebuild frontend (CLI bundles it)
pnpm build:cli    # build CLI with tsup
bun apps/cli/dist/cli.cjs --version   # must print the new version
bun apps/cli/dist/cli.cjs --help      # must list all commands
```

Then run a smoke test in a temp directory:

```bash
tmpdir=$(mktemp -d)
echo 'export const greet = (name: string) => `Hello, ${name}!`;' > "$tmpdir/greet.ts"
echo 'import { greet } from "./greet"; console.log(greet("world"));' > "$tmpdir/main.ts"
bun apps/cli/dist/cli.cjs init "$tmpdir"
bun apps/cli/dist/cli.cjs status "$tmpdir"
rm -rf "$tmpdir"
```

**Completion criterion**: `--version` prints the new version, `--help` lists all 7 commands, `init` + `status` succeed in a temp workspace.

### 5. Publish to npm

```bash
cd apps/cli && npm publish --access public
```

If npm requires OTP (2FA), tell the user to run:

```bash
cd apps/cli && npm publish --access public --otp=<6-digit-code>
```

**Completion criterion**: npm prints `+ @openez-graph/cli@X.Y.Z` and exit code 0.

### 6. Commit and push

```bash
git add apps/cli/package.json CHANGELOG.md apps/cli/README.md
git commit -m "chore(cli): release v<VERSION>"
git push
```

**Completion criterion**: `git log --oneline -1` shows the release commit, `git status` is clean, and `git push` succeeded.

## Reference

### Version history

| Version | Date       | Type  | Highlights                                                                           |
| ------- | ---------- | ----- | ------------------------------------------------------------------------------------ |
| 0.5.1   | 2026-07-31 | patch | Fast indexing, import path validation                                                |
| 0.6.0   | 2026-08-01 | minor | FIX-01 to FIX-08 remediation, loopback binding, edge dedup, incremental optimization |
| 0.6.1   | 2026-08-01 | patch | Syntax-highlighted context blocks, markdown fenced code rendering                    |

### Files touched in a release

- `apps/cli/package.json` — version bump
- `CHANGELOG.md` — new section + compare link
- `apps/cli/README.md` — only if new features need documenting
- `apps/web/` — rebuilt dist (bundled into CLI via `pnpm build:cli`)

### npm package contents

The CLI package (`files` field) bundles: `dist/` (cli.cjs + web/), `README.md`, `LICENSE`. CHANGELOG.md is NOT bundled — it lives in the repo and is linked from README.

### Common pitfalls

- **Forgot `pnpm build:web` before `pnpm build:cli`** — CLI bundles stale frontend. Always rebuild web first.
- **Published without bumping version** — npm rejects with "You cannot publish over the previously published versions." Check `--version` output.
- **OTP required** — npm 2FA blocks publish. The error says `EOTP`. User must provide `--otp=<code>`.
- **Forgot to commit CHANGELOG.md** — changelog drifts from published versions. Always commit both `package.json` and `CHANGELOG.md` together.
