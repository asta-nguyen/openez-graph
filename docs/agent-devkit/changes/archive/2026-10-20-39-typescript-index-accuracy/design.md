# TypeScript indexing accuracy

Issue: #39

## Goal

Resolve TypeScript call edges through import bindings, TypeScript-only module resolution, and re-exports so they reach the intended workspace declaration instead of the first same-named symbol.

## Dependency and order

Implement this plan only after the approved [JavaScript indexing plan](../javascript-index-accuracy/design.md) is complete. That plan owns shared ESM binding/re-export extraction, JavaScript/CommonJS behavior, and the initial versioned cache format. This plan reuses those records and that extraction code; it does not duplicate them. The JavaScript implementation gates extraction to JavaScript/JSX, so TypeScript/TSX rows currently carry no bindings; this plan enables the same extraction for them.

The OXC parser serves TypeScript, TSX, JavaScript, and JSX. Gate new behavior to `typescript` and `tsx` only; TSX counts as TypeScript, while JavaScript and JSX keep the completed JavaScript plan's behavior and fixtures. Increment the OXC parser version from the value left by the JavaScript plan rather than assuming a fixed version. The full reindex requirement below applies after that bump.

## Current evidence

- At baseline commit `0519b8284324722863d9123a457f28b389389f61`, OXC records module specifier strings but not import bindings or per-specifier type-only state. The approved JavaScript plan owns the shared import/export extraction; its current implementation work adds `ImportBinding` and `ExportBinding` records, which this plan must reuse after that plan is complete.
- The JavaScript implementation currently in the working tree stores `{ "v": 1, "paths": [], "importBindings": [], "exportBindings": [] }` in `parsed_documents.imports` and accepts legacy string arrays. Once the JavaScript plan is complete, its landed envelope is the source of truth; TypeScript extends its import/export records instead of adding a second envelope or changing runtime `importPaths: string[]`.
- In the working tree, the JavaScript plan records bindings only for JavaScript/JSX (`extractModuleBindings` runs only for `JS_LANGUAGES`). Its export-resolution helpers (`collectModuleExports`, `resolveUniqueModuleExport`, `resolveJsCallTarget`) live inside `buildGraphGeneration` with JavaScript-only maps and a hard-coded `"javascript"` resolver flavor, and the graph caps and global-fallback bypass are gated on `javascript`/`jsx`. Treat these names as provisional until they are in HEAD (Task 1). The JavaScript design lists extensionless JavaScript-to-TypeScript resolution and tsconfig aliases as out of scope.
- The baseline OXC parser version at `0519b82` is `oxc-v2`; the approved JavaScript work bumps it. This plan increments from the version left by the completed JavaScript plan rather than choosing a version in advance.
- The root `tsconfig.base.json` defines `baseUrl` and `@openez-graph/*` paths. Package tsconfigs inherit it through a relative `extends`; the web tsconfig defines its own `@/*` mapping. Reading only each nearest config misses the package aliases used across this repo.
- `createWorkspaceFileResolver` resolves relative specifiers; bare specifiers and tsconfig aliases do not resolve to workspace files.
- File-level `imports` edges use the same resolver, so adding TypeScript path aliases will also add file edges for aliases that resolve locally.
- Call-edge construction falls back to the first workspace symbol with the same name when no same-file target exists.
- There is no TypeScript graph-level edge fixture. The generic graph builder currently caps each file at 30 symbols and 20 calls.
- The baseline stores `parsed_documents.imports` as a JSON `string[]`; the index-time writer and lazy graph-build reader/writer must preserve the shared JavaScript metadata and the TypeScript additions.

## Scope

- Reuse the shared OXC ESM binding and re-export records from the completed JavaScript plan. Add TypeScript's per-specifier type-only status, including mixed declarations such as `import { type A, B } from "./mod"`.
- Follow named re-exports, aliases, and `export *` records through workspace barrel files when the requested export resolves uniquely. Generalize the JavaScript plan's export-resolution helpers instead of writing a second traversal: the bindings and exports maps cover all four OXC languages, and each import or `export … from` specifier resolves with the resolver for the language of the file that contains it (TypeScript resolver for `typescript`/`tsx`, the existing JavaScript resolver for `javascript`/`jsx`).
- Cross-language policy: TypeScript/TSX callers may resolve to exports in any OXC-family module, so a TS file calling an `allowJs` module keeps a correct edge instead of losing the old first-name match. JavaScript/JSX callers keep the JavaScript plan's behavior: if the final resolved target is not in a `javascript`/`jsx` file, no edge is produced.
- For TypeScript/TSX only, resolve relative imports, local `baseUrl` lookups, and `paths` mappings from the nearest `tsconfig.json` inside the workspace. Support one relative `extends` hop for inherited `baseUrl` and `paths`, plus direct `paths` without `baseUrl`, exact keys, one `*` wildcard, ordered target arrays, and the TypeScript key precedence described under Behavior.
- For a TypeScript/TSX import ending in `.js`, try the same-stem TypeScript source extensions before the literal JavaScript file so `./util.js` can resolve to `util.ts` or `util.tsx`.
- Keep alias resolution inside the workspace and emit calls edges only to a unique exported declaration. Drop unresolved, external, type-only, cyclic, or ambiguous call targets.
- Preserve same-file lexical resolution. For TypeScript/TSX callers, do not use the global first-name fallback for cross-file calls. A local parameter or variable shadowing an imported name must not resolve to the imported declaration; use the existing `collectLocalBindings` information to mark or suppress that imported-binding match.
- Apply TypeScript alias resolution to both call targets and the existing file-level `imports` edges. This adds file edges for aliases that now resolve locally; verify those edges separately. Type-only imports continue to participate in the existing file-level dependency edges but never produce runtime `calls` edges.
- Remove the generic graph-builder limits of 30 symbols and 20 calls for TypeScript only. Do not change the native parser slices used by Python, Go, or Rust.
- Keep OXC, graph shapes, SQLite schema, CLI/MCP interfaces, and optional-native behavior unchanged. Add no TypeScript compiler or SCIP runtime dependency.

## Behavior

Use the nearest workspace `tsconfig.json`. Parse JSONC comments and trailing commas in it and, when applicable, its base config with a small dependency-free normalizer that preserves comment-like text inside quoted strings, then pass the result to `JSON.parse`. Follow at most one `extends` value when it is a relative path to a config inside the workspace (append `.json` when the value has no extension, as TypeScript does). Read only `compilerOptions.baseUrl` and `compilerOptions.paths` from that base; child values override the corresponding inherited options, and a child `paths` object replaces the inherited `paths` object. Do not follow another `extends` from the base config. Resolve the extends path relative to the child config; resolve `baseUrl` relative to the config where it is declared; resolve path targets relative to the effective `baseUrl`, or to the config where `paths` is declared when no `baseUrl` applies. Ignore unsupported package, absolute, array, out-of-workspace, or deeper extends; a config's own valid `baseUrl`/`paths` still apply. If a config is absent or invalid, its aliases are unavailable and existing relative resolution still works.

For a bare module specifier, try `paths` first. Exact keys win; when multiple wildcard keys match, choose the one with the longest literal prefix. Each key may contain at most one `*`. Resolve each target relative to the effective `baseUrl` when present, otherwise relative to the config file where `paths` was declared. Try target arrays in their declared order and choose the first target that resolves to one workspace file; do not merge targets. If no `paths` target resolves, use `baseUrl` as the local lookup root when configured. Imports that resolve outside the workspace remain external. This bounded policy follows TypeScript's documented relative `extends`, `paths` wildcard, target-array, and optional-`baseUrl` rules without implementing the full compiler resolver ([TypeScript TSConfig reference](https://www.typescriptlang.org/tsconfig/), [module resolution reference](https://www.typescriptlang.org/docs/handbook/modules/reference)).

For an explicit `.js` specifier in TypeScript/TSX, use TypeScript extension substitution order for local files: `.ts`, `.tsx`, `.d.ts`, `.js`, then `.jsx`; select the first existing workspace file. This covers `./util.js` targeting `util.ts` without adding general package or runtime resolution. Do not apply this behavior to JavaScript/JSX callers or `.mjs`/`.cjs` specifiers.

Named imports resolve through their local alias. Namespace calls resolve through the requested exported member. Named re-exports and `export *` are traversed within workspace files with cycle detection; if multiple star exports provide the requested name, drop the call edge. A type-only specifier never creates a `calls` edge, even when it shares a declaration with value imports. A TypeScript/TSX call without a same-file lexical target or a valid import binding never falls back to `globalSymbolNodes`. Calls such as `Api.build()` remain unresolved without receiver/type information, even when `Api` is imported. Named exports win over `export *`, as in the landed helper. The JavaScript-caller guard applies to the final resolved target, so a JavaScript caller that reaches a TypeScript module through a barrel is also dropped.

Keep runtime `importPaths: string[]` unchanged. Extend the final `parsed_documents.imports` envelope produced by the JavaScript plan with per-specifier `typeOnly` flags on TypeScript import and export records. The current working-tree envelope is `{ "v": 1, "paths": [], "importBindings": [], "exportBindings": [] }`; use the final landed field names, do not add a second envelope, and keep `paths` available to existing file-edge generation. The cache reader accepts legacy string arrays as `paths` with empty metadata. Update the index-time writer and lazy graph-build cache read/write paths; the database table shape does not change. Store the TypeScript local-shadow marker with cached call records in the existing `calls` field so graph construction from cache matches a fresh parse.

After parser output changes, run `openez reindex <path>` to refresh parse rows and graph artifacts. A parser-version mismatch is checked during graph construction, and a completed graph can short-circuit after a no-op incremental index; `openez index <path>` alone is not sufficient.

## CodeGraph reference

I inspected [colbymchenry/codegraph at commit `204315274e7902c713ba3ad61e8df511aa634b10`](https://github.com/colbymchenry/codegraph/tree/204315274e7902c713ba3ad61e8df511aa634b10). Its [baseUrl/path-resolution fixture](https://github.com/colbymchenry/codegraph/blob/204315274e7902c713ba3ad61e8df511aa634b10/__tests__/tsconfig-baseurl-imports.test.ts), [named re-export fixture](https://github.com/colbymchenry/codegraph/blob/204315274e7902c713ba3ad61e8df511aa634b10/__tests__/named-reexport-module.test.ts), and [default-import alias fixture](https://github.com/colbymchenry/codegraph/blob/204315274e7902c713ba3ad61e8df511aa634b10/__tests__/import-default-as.test.ts) remain concrete ground-truth examples. Keep OpenEZ's OXC parser and bounded workspace-only resolver; do not adopt CodeGraph's tree-sitter parser, type-receiver dispatch, package/config expansion, or file-dependency behavior beyond the alias edges already described in this plan.

## Verification

- Run the TypeScript baseline after the approved JavaScript plan has completed; preserve its resulting JavaScript fixture outputs as the comparison point.
- Add TS/TSX graph fixtures for default/named/namespace aliases, type-only and mixed specifiers, named and star re-exports, duplicate exports, local shadowing, no-import same-name symbols, `.js` to `.ts` substitution, named export beating `export *`, `export { default as X } from`, TS→JS targets (ESM and CommonJS exports), a TS barrel re-exporting a JS module, a JS caller importing a TS module (expected: no edge), and files above the graph caps.
- Add JSONC tsconfig fixtures with comments, trailing commas, comment-like text inside strings, `paths` without `baseUrl`, exact and overlapping wildcard keys, target arrays, and `baseUrl` bare-specifier resolution. Add a nested package config with one relative `extends` to a root base config and assert its inherited `@openez-graph/*` mapping resolves using the base config's path origin. Assert child options override inherited options, unsupported deeper/package extends are ignored, and external/out-of-workspace targets produce no call edge.
- Assert exact call targets, zero false positives, no edge for type-only/unresolved/ambiguous calls, and expected file-level `imports` edges for relative and newly resolved alias specifiers.
- Add a cache round-trip assertion: parse TS, persist through the index-time writer, then build the graph from the cache. Confirm paths, bindings, per-specifier type-only flags, re-exports, and local-shadow markers survive and that the cached row is consumed. Keep call/import edge assertions in Task 4; there, also confirm legacy string-array rows still produce their existing file imports edges.
- Verify JavaScript/JSX callers are unchanged: the completed JavaScript plan's fixture edges and cache payloads stay identical, and a JS caller importing a TS module still produces no edge. Verify the OXC cache refresh with `openez reindex <path>`.
- Run focused OXC, TypeScript graph, cache, and full Bun suites. Record TypeScript graph counts and elapsed time as informational measures.

## Out of scope

JavaScript/JSX behavior changes (including JS callers resolving into TypeScript modules, which the JavaScript plan also excludes), Go, Python, Rust, Ruby, TypeScript type checking, ordinary or imported-class static receiver inference, recursive, package-name, absolute, and array `tsconfig` extends, project references, package `exports`/`imports`, `node_modules` and external dependency resolution, computed/dynamic imports, `.mjs`/`.cjs` extension substitution, SCIP, and schema/API changes.

## Related context

None. This repository has no docs/llm wiki.
