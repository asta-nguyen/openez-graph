# C# indexing accuracy and native parity

Issue: #39

## Goal

Index C# as structured code and resolve calls through namespaces and explicit using bindings without cross-project name guessing. Native and WASM parsers must agree.

## Scope

- Add .cs and .csx as csharp through the optional native tree-sitter path with WASM fallback. Neither extension is scanned today (the scanner builds its file list from `codeExtensions`), so the first `openez index` after upgrading ingests C# files for the first time.
- Extract namespaces; class, struct, interface, record, enum, and delegate declarations; fields, properties, methods, constructors, and destructors. Name members with the existing `Owner::member` convention (`Outer::Inner::Run`).
- Resolve file/block namespaces, ordinary/alias/global/static using directives from source. Do not invoke dotnet, Roslyn, MSBuild, or NuGet.
- Define a project root for each C# file: the nearest ancestor directory that contains a `*.csproj` file (found by listing directories on disk during graph generation; the project file is never read or evaluated), or the workspace root when none exists.
- Merge partial type parts for lookup: types with the same namespace, enclosing-type chain, and name inside one project root are parts of one type, while source symbols stay in their original files. The same identity in different project roots stays distinct.
- Resolve only unique bare/this calls in the calling type (all its parts), explicitly type-qualified calls, and uniquely bound using-static calls. Do not infer receiver variable types or choose overloads by argument types.
- Emit imports edges only when an explicit using binding resolves to one in-workspace file.
- Index both bodies of #if/#else directives: blank only directive text while preserving source offsets and both branches.
- Remove generic 30-symbol and 20-call graph limits for C# only, at every site that applies them (see Interfaces). Keep DB and public interfaces unchanged.
- Ship the C# grammar in the published CLI, not only in the workspace packages.
- Advance cache tags from the implementation baseline and run openez reindex.

### CodeGraph reference

I inspected [colbymchenry/codegraph at commit 204315274e7902c713ba3ad61e8df511aa634b10](https://github.com/colbymchenry/codegraph/tree/204315274e7902c713ba3ad61e8df511aa634b10). Its [C# extractor](https://github.com/colbymchenry/codegraph/blob/204315274e7902c713ba3ad61e8df511aa634b10/src/extraction/languages/csharp.ts), [namespace scope fixture](https://github.com/colbymchenry/codegraph/blob/204315274e7902c713ba3ad61e8df511aa634b10/__tests__/csharp-namespace-scope.test.ts), and [namespace visibility fixture](https://github.com/colbymchenry/codegraph/blob/204315274e7902c713ba3ad61e8df511aa634b10/__tests__/csharp-namespace-visibility.test.ts) inform scope and name-binding cases. The visibility fixture covers same-namespace reach, an alias, and a using-directive namespace that must not reach a shadowing type elsewhere; it has no parent-namespace or global-using case, so those are specified here. Its [grammar registry](https://github.com/colbymchenry/codegraph/blob/204315274e7902c713ba3ad61e8df511aa634b10/src/extraction/grammars.ts) maps csharp to the tree-sitter-c_sharp.wasm artifact; OpenEZ's loader needs that language-to-artifact mapping. This plan adopts namespace/alias ownership but not Roslyn/MSBuild, framework route extraction, or argument-type overload resolution.

### Coordination

This is separate from the archived [Go indexing work](../2026-10-20-39-go-indexing-accuracy/design.md), archived [Python indexing work](../2026-10-20-39-python-index-accuracy/design.md), and the Java and C++ plans of this series; the [Ruby](../2026-10-20-39-ruby-native-indexing/design.md) and [Rust](../2026-10-20-39-rust-index-accuracy/design.md) plans have already landed. These plans share parser, native grammar, cache-version, graph-builder, parity, and CLI packaging files; implement them in isolated worktrees in parallel, then integrate shared files serially. This plan owns the C# fixtures and resolver branch; advance shared parser tags from the value present on the integration branch (`native-v5`/`fallback-v5` at planning time).

## Behavior

- Type identity uses namespace declarations and enclosing types, not folders. File-scoped and block-scoped namespaces behave alike.
- Type lookup for a simple name, in order: member types of the enclosing types; then each enclosing namespace from the caller's innermost outward to the global namespace (so code in `A.B` sees types in `A` without a using), where the types declared in that namespace across all files come first, then that level's alias, ordinary using, and using-static directives; finally compilation-unit usings and the global usings of the caller's project root. The first level that has the name decides; two distinct workspace types at one level produce no edge.
- A using alias binds only its name to its target; an alias whose target is not a workspace type reserves the name and never falls through to a workspace namesake. Ordinary usings of namespaces the workspace does not declare are ignored, because valid C# cannot have two using-supplied types of one name at a level.
- global using applies to files in the same project root, not to the whole workspace. Using static binds the static members of the named type.
- Same-type calls, including methods in another partial part, resolve only when exactly one same-name target exists across the parts. A bare call whose name no part declares can resolve through uniquely bound using-static members. Type-qualified (`Type.M()`, `Ns.Type.M()`, `Alias.M()`) calls follow the lookup order. Properties/accessors are symbols, not calls.
- Variable-receiver, inherited/base, delegate, extension-method, generator, external-type, and overloaded same-name calls produce no call edge.
- If both AST paths fail, generic text remains searchable and no C# graph records are emitted. No regex C# parser is added.

## Edge cases

- Duplicate method names across partial parts or overloads are ambiguous and produce no edge. The same member in both an #if and its #else body is a duplicate too, so calls to it get no edge.
- Conflicting aliases cannot bind a workspace namesake. A using resolving to multiple files produces no imports edge (a namespace spread over several files has none).
- The same type identity in two project roots is two types; a lookup that reaches both produces no edge.
- A global using in one project is invisible to files under another project root. Without any .csproj, the whole workspace is one root.
- Both #if/#else bodies and later declarations are indexed with original line numbers; build symbols are not evaluated.
- Known ceilings: local functions or lambdas named like a member, inherited/base members that shadow a using-static binding, and generic arity (`Foo` and `Foo<T>` in one root merge into one type) are not modeled.
- Above-cap C# symbols/calls are retained. LF/CRLF produce exact native/WASM parity; WASM failure falls back to text chunks.

## Interfaces

- Canonical key csharp. The loader's default naming looks for `tree-sitter-csharp`, which does not exist: map csharp to the `tree-sitter-c-sharp` package and its `tree-sitter-c_sharp.wasm` artifact.
- Symbol contract: `namespace` symbols with a dotted name and line range (a file-scoped namespace runs to the end of the file); type symbols; members and nested types named `Owner::member`, with the same convention for call callerName; importPaths carry the full using directive text including alias/static/global modifiers. The resolver derives each symbol's namespace chain from namespace line ranges and reads no source. No public type, cached payload, SQLite, MCP, or CLI shape changes.
- New packages/indexer/src/csharp-resolver.ts resolves namespace, alias, partial-type, project-root, and method maps once per graph build.
- Imports edges are emitted in one loop in `buildGraphGeneration` that calls `resolveModuleSpecifier` and then `createWorkspaceFileResolver.resolveImport`. C# routes through its own resolver in `resolveModuleSpecifier`; the generic resolver keeps returning null for csharp.
- Caps are applied at the `uncapped` decision in `buildGraphGeneration` and at both native `callExpressions.slice(0, 20)` sites; extend those conditions, never `OXC_GRAPH_LANGUAGES`.
- Conditional directives are blanked in a pre-pass applied identically on the native and WASM paths.
- Add the tree-sitter-c-sharp package (about 68 MB unpacked, mostly prebuilt binaries for every platform) to packages/indexer and apps/cli dependencies and the apps/cli tsup externals, and the matching Rust crate to packages/native.
- Parser tags advance from the implementation baseline; full openez reindex rebuilds graph artifacts and other languages' stale rows.

## Verification

- Parser fixtures cover namespaces/nested and partial types, fields/properties/methods/constructors, imports, conditional branches, comments/strings, line ranges, and CRLF.
- Resolver and edge-accuracy fixtures (expected-edges.json plus baseline.json, as in tests/go-edge-accuracy.test.ts) cover partial calls, parent-namespace lookup, aliases, global/static using scoped by project root, external names, overloads, #if/#else duplicates, and no-edge receiver/inheritance cases; false positives stay 0.
- Require exact native/WASM parity (csharp fixtures listed in the parity test's required-fixture manifest), cache reparse, and above-cap graph assertions.
- Run focused/full Bun tests, pnpm typecheck, native build, parity with OPENEZ_NATIVE_EXPECT=1, and existing three-platform native CI.
- Build the CLI and run init/index on a temporary C# workspace from `apps/cli/dist`, confirming C# symbols are indexed. Record the install-size change from the new grammar package.

## Related context

None. This repository has no docs/llm wiki.
