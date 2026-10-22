# Release CLI

When the user asks to "release", "publish", "deploy cli", or "bump version", follow this tight loop — every step has a checkable gate before moving on.

## 1. Determine the version bump

Read `apps/cli/package.json` for the current version. Classify changes since last release:

- **Patch**: UI fixes, doc updates, minor bug fixes, no new features.
- **Minor**: New features, significant fixes (security, data integrity), new routes/pages.
- **Major**: Breaking changes to CLI commands, MCP tool signatures, or DB schema.

Default to **minor** when multiple fixes ship together. Ask the user if unsure.

## 2. Bump version

Edit `apps/cli/package.json` — update the `"version"` field only.

## 3. Update CHANGELOG.md

Add a new `## [X.Y.Z] - YYYY-MM-DD` section at the top of `CHANGELOG.md` using [Keep a Changelog](https://keepachangelog.com/) groups:

- `### Added` — new features, routes, UI pages
- `### Changed` — changes to existing functionality
- `### Removed` — deleted features, removed endpoints
- `### Fixed` — bug fixes, security patches
- `### Security` — security-relevant fixes

Each entry is one bullet. Add a compare link at the bottom.

## 4. Fetch native binaries

The CLI ships the three CI-built `.node` binaries in `dist/native/`. They are
not committed to Git — download them from GitHub Actions before building:

```bash
# Use the successful native.yml run for the release commit. If that commit has
# no run (native.yml is path-filtered), fall back to the run for the last
# commit that touched packages/native/ — its binaries are identical.
NATIVE_SHA=$(git log -1 --format=%H origin/main -- packages/native)
RUN_ID=$(gh run list --workflow native.yml --commit "$NATIVE_SHA" --status success --limit 1 --json databaseId -q '.[0].databaseId')

gh run download "$RUN_ID" -n native-linux-x64-gnu -D packages/native
gh run download "$RUN_ID" -n native-darwin-arm64 -D packages/native
gh run download "$RUN_ID" -n native-win32-x64-msvc -D packages/native
```

Then require exactly these three files and no other `index.*.node` in
`packages/native/`:

```bash
ls packages/native/index.linux-x64-gnu.node \
   packages/native/index.darwin-arm64.node \
   packages/native/index.win32-x64-msvc.node
ls packages/native/index.*.node | wc -l   # must print 3
```

Fewer than three binaries is a stop condition — do not publish unless the user
explicitly accepts a reduced platform list.

## 5. Build and verify

Run from monorepo root, in order:

```bash
pnpm build:web    # rebuild frontend (CLI bundles it)
pnpm build:cli    # build CLI with tsup
bun apps/cli/dist/cli.cjs --version   # must print the new version
bun apps/cli/dist/cli.cjs --help      # must list all commands
ls apps/cli/dist/native/              # must contain index.js + the three index.*.node files
```

Then smoke test in a temp dir: `init` + `status` must succeed.

## 6. Publish to npm

```bash
cd apps/cli && npm publish --access public
```

If npm requires OTP (2FA), tell the user to run with `--otp=<6-digit-code>`.

## 7. Commit and push

```bash
git add apps/cli/package.json CHANGELOG.md
git commit -m "chore(cli): release v<VERSION>"
git push
```

## Pitfalls

- Always run `pnpm build:web` before `pnpm build:cli` — CLI bundles stale frontend otherwise.
- Fetch the `native.yml` artifacts before `pnpm build:cli` — a build without `packages/native/*.node` succeeds but ships no native acceleration on any platform.
- Check `--version` output before publishing — npm rejects re-publishing the same version.
- Always commit `package.json` and `CHANGELOG.md` together to avoid changelog drift.
