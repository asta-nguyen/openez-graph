# Contributing to OpenEZ Graph

Thanks for helping improve OpenEZ Graph. Keep changes focused, local-first, and easy to verify.

## Development setup

Requirements:

- Node.js 20 or newer
- pnpm 10

```bash
git clone https://github.com/asta-nguyen/openez-graph.git
cd openez-graph
pnpm install
pnpm typecheck
pnpm test
```

Useful development commands:

```bash
pnpm start       # web UI and MCP server
pnpm dev:web     # web UI and local API
pnpm mcp         # MCP server only
pnpm build:web   # production web build
pnpm build:cli   # CLI bundle
```

## Architecture rules

- Keep SQLite in WAL mode as the default storage path.
- Keep the runtime multi-workspace aware; use `workspaceId` as the canonical key.
- Treat the CLI and MCP server as primary interfaces. The web app is a management layer.
- Do not add Postgres, Redis, Docker, or embeddings as requirements for the default workflow.
- Keep `.openez/` runtime data out of Git.

## Making a change

1. Create a branch from `main`.
2. Make the smallest change that solves the problem.
3. Add or update a focused Vitest test for non-trivial behavior.
4. Run the checks relevant to your change.
5. Open a pull request explaining the problem, solution, and verification.

Use clear, scoped commit messages such as `fix(mcp): resolve workspace from project hint`.

## Verification

Run these checks before opening a pull request:

```bash
pnpm typecheck
pnpm test
```

For CLI changes:

```bash
pnpm build:web
pnpm build:cli
node apps/cli/dist/cli.cjs --version
node apps/cli/dist/cli.cjs --help
```

Also smoke-test `init` and `status` in a temporary project when changing workspace registration, indexing, storage, or CLI behavior.

## Pull requests

- Keep each pull request centered on one problem.
- Describe user-visible behavior and any compatibility impact.
- Include tests for bug fixes and new behavior.
- Update documentation when commands, MCP tool contracts, or storage behavior change.
- Do not include generated `.openez/` data or unrelated formatting changes.

Breaking CLI commands, MCP tool schemas, and database schemas require explicit discussion before implementation.

## Reporting issues

Open an issue at <https://github.com/asta-nguyen/openez-graph/issues> with:

- steps to reproduce
- expected and actual behavior
- OpenEZ, Node.js, and operating system versions
- relevant logs with secrets and private source code removed

Feature requests should explain the workflow being improved, not only the proposed implementation.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
