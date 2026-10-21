# JavaScript indexing accuracy

Issue: #39

## Goal

Resolve JavaScript calls through static ESM and CommonJS imports so local module calls reach the right exported symbol instead of the first same-named symbol in the workspace.

## Current evidence

- JavaScript uses the OXC parser shared with TypeScript.
- OXC import extraction currently records ESM module specifiers but not local import bindings; CommonJS require bindings are not captured as imports.
- Graph construction resolves cross-file calls through a first-match global symbol-name map.
- Existing OXC tests focus on TypeScript syntax and do not assert JavaScript graph edges.
- The generic graph builder keeps at most 30 symbols and 20 calls per file.

## Scope

- Preserve ESM default, named, aliased, and namespace import bindings for JavaScript.
- Recognize static CommonJS require calls with string literals, including namespace and destructured bindings.
- Recognize static CommonJS exports through exports.name, module.exports.name, and object-literal module.exports assignments when a property maps to one local declaration.
- Resolve relative workspace modules and explicit export names to one target; drop unresolved and ambiguous edges.
- Remove the 30-symbol and 20-call graph caps for JavaScript only.
- Keep the OXC parser and existing graph/API shapes; bump the OXC parser version when cached metadata changes.

Dynamic or computed require, package exports, extensionless JavaScript-to-TypeScript resolution, TypeScript tsconfig aliases, external packages, runtime property/type inference, and file-level dependency edges for imports used only as values are out of scope.

## Behavior

ESM imports/re-exports and static CommonJS require bindings map local names to workspace files and exported symbols. Namespace member calls resolve only when the member is uniquely exported. Static CommonJS export forms are supported only when the property maps to one local declaration. External package imports and computed dynamic loads do not create calls edges. A same-name global symbol is never used as a substitute for a missing import target.

Internal binding data may extend the parser result and existing JSON cache payload; no SQL migration is needed. Keep runtime `importPaths: string[]` unchanged. Persist paths and module records in a versioned envelope such as `{ "version": 1, "paths": [], "bindings": [], "commonJsExports": [], "reExports": [] }` under `parsed_documents.imports`; normalize both legacy string arrays and the envelope when reading cache rows, and build file-level imports edges from `paths` only. The index-time writer and lazy graph-build reader/writer must all use this format. The OXC parser-version bump may refresh TypeScript cache rows too, but their behavior must remain unchanged. A parser-version mismatch is checked during graph construction, while a completed graph can short-circuit after a no-op incremental index. Run `openez reindex <path>` after this change to rebuild old parsed rows and graph artifacts; a no-op `openez index <path>` is not sufficient.

## CodeGraph reference

I inspected [colbymchenry/codegraph at commit `204315274e7902c713ba3ad61e8df511aa634b10`](https://github.com/colbymchenry/codegraph/tree/204315274e7902c713ba3ad61e8df511aa634b10). Its [CommonJS require extractor](https://github.com/colbymchenry/codegraph/blob/204315274e7902c713ba3ad61e8df511aa634b10/src/extraction/commonjs-requires.ts) and [require-import fixtures](https://github.com/colbymchenry/codegraph/blob/204315274e7902c713ba3ad61e8df511aa634b10/__tests__/commonjs-require-imports.test.ts) separate literal module paths from bindings and calls; the [CommonJS export fixture](https://github.com/colbymchenry/codegraph/blob/204315274e7902c713ba3ad61e8df511aa634b10/__tests__/commonjs-exports.test.ts) covers supported export assignments. Use those distinctions to keep the fixture matrix explicit, while retaining OXC AST extraction rather than copying CodeGraph's regex helper. CodeGraph also resolves extensionless JavaScript imports to TypeScript modules and creates file-dependency edges for imports used only as values; those cross-language and non-call edges remain outside this JavaScript plan. No SCIP or TypeScript parser behavior is added here.

## Verification

- Add JavaScript fixtures for ESM aliases, default and namespace imports, re-exports, static require, destructured require, CommonJS exports, duplicate exports, external imports, and computed require.
- Assert exact edge targets, zero false positives, and no edge for unresolved or ambiguous imports.
- Include a file exceeding 30 symbols and 20 calls; retain all JavaScript graph entries.
- Verify OXC cache invalidation, focused JS parser/graph tests, the full Bun suite, and no TypeScript fixture regression.
- Record graph counts and elapsed time for a representative JavaScript workspace as informational data.

## Out of scope

TypeScript, Go, Python, Rust, Ruby, tsconfig aliases, package exports, dynamic module evaluation, receiver type inference, SCIP, and schema/API changes.

## Related context

None. This repository has no docs/llm wiki.
