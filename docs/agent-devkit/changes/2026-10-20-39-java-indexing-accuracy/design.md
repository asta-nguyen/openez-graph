# Java indexing accuracy and native parity

Issue: #39

## Goal

Index Java source as structured code and produce useful, low-noise import and call edges. Native and WASM parsing must agree, while external, unresolved, and ambiguous calls stay unlinked.

## Scope

- Add .java as language java. No .java file is scanned today (the scanner builds its file list from `codeExtensions`), so the first `openez index` after upgrading ingests Java files for the first time. Parse through the existing optional native tree-sitter path with WASM fallback.
- Extract packages, nested/top-level classes, interfaces, enums, records, fields, methods, and constructors. Name members with the existing `Owner::member` convention (`Outer::Inner::run`) and preserve call receiver text.
- Resolve package, same-package, and explicit single-type/static imports from workspace source. Do not invoke a JDK, Maven/Gradle, download dependencies, or read a classpath.
- Resolve only unique calls: bare/this calls in the innermost enclosing type, calls qualified by a type found by the type lookup order below, and bare calls from a single static import. Do not infer variable receiver types, overload choice, inheritance, or dynamic dispatch.
- Emit imports edges only for explicit imports mapping to one in-workspace file. External and wildcard imports do not create guessed edges.
- Remove generic 30-symbol and 20-call graph limits for Java only, at every site that applies them (see Interfaces). Keep database/public APIs unchanged.
- Ship the Java grammar in the published CLI, not only in the workspace packages.
- Bump parser cache versions from the implementation baseline and run openez reindex after the change.

### CodeGraph reference

I inspected [colbymchenry/codegraph at commit 204315274e7902c713ba3ad61e8df511aa634b10](https://github.com/colbymchenry/codegraph/tree/204315274e7902c713ba3ad61e8df511aa634b10). Its [Java extractor](https://github.com/colbymchenry/codegraph/blob/204315274e7902c713ba3ad61e8df511aa634b10/src/extraction/languages/java.ts), [outside-import fixture](https://github.com/colbymchenry/codegraph/blob/204315274e7902c713ba3ad61e8df511aa634b10/__tests__/java-outside-imports.test.ts), and [bare-call scope fixture](https://github.com/colbymchenry/codegraph/blob/204315274e7902c713ba3ad61e8df511aa634b10/__tests__/java-bare-call-scope.test.ts) inform import-ownership and current-type cases. That fixture covers an own-class call, an inherited `helper()` from a base class, a static import, and an external static import that must not bind to a workspace namesake; it has no nested/inner-class or same-package case, so those are specified here. This plan deliberately emits no edge for the inherited case. Its [declared-receiver fixture](https://github.com/colbymchenry/codegraph/blob/204315274e7902c713ba3ad61e8df511aa634b10/__tests__/java-declared-receiver.test.ts) demonstrates type inference, which this plan leaves out to keep OpenEZ unique-only and build-tool-free. Use its [grammar registry](https://github.com/colbymchenry/codegraph/blob/204315274e7902c713ba3ad61e8df511aa634b10/src/extraction/grammars.ts) to identify the Java grammar revision, then verify that revision against OpenEZ's Rust and WASM parser ABIs before pinning it.

### Coordination

This is a separate plan alongside the archived [Go indexing work (native CI pending)](../archive/2026-10-20-39-go-indexing-accuracy/design.md), archived [Python indexing work](../archive/2026-10-20-39-python-index-accuracy/design.md), and the C# and C++ plans of this series; the [Ruby](../archive/2026-10-20-39-ruby-native-indexing/design.md) and [Rust](../archive/2026-10-20-39-rust-index-accuracy/design.md) plans have already landed. These plans share parser, native grammar, cache-version, graph-builder, parity, and CLI packaging files; implement them in isolated worktrees in parallel, then integrate shared files serially. This plan owns the Java fixtures and resolver branch; advance shared parser tags from the value present on the integration branch (`native-v5`/`fallback-v5` at planning time).

## Behavior

- Package declarations and enclosing type names identify Java types; folder conventions and build metadata are ignored.
- Type lookup for a simple name used as a call qualifier, in order: member types of the enclosing types (innermost first) and the file's own top-level types; single-type imports; types declared in the same package in any workspace file. The first level that has the name decides; two distinct workspace types at one level produce no edge. A single-type import beats a same-package type; an external single-type import reserves its name and never falls through to a workspace namesake. A name supplied only by a wildcard import resolves to nothing.
- A single static-member import binds its final member; an external one reserves the name.
- local() and this.local() resolve only in the innermost enclosing named type, and only when it declares exactly one method with that name (any arity). Nested types do not walk outward: a bare call from a nested type to an outer-type method has no edge.
- A bare call whose name no enclosing type declares can resolve through one explicit static import. A declaration in any enclosing type blocks the static import.
- Type.run() resolves when Type is found by the lookup order and declares exactly one run. A receiver written as a package-qualified name (`app.Util.format()`) resolves when the dotted text equals one workspace type's package-qualified name.
- Bare and this-qualified calls inside an anonymous class body are not emitted (the anonymous supertype may supply the name); type-qualified calls inside it are kept. Lambdas are not scopes.
- Variable receivers, chained calls, inherited methods, method references, constructors, wildcard imports, duplicate type declarations, and overloaded same-name methods produce no edge.
- If both AST paths fail, generic text chunks remain searchable and no Java symbols/calls are emitted; parsing does not throw. No regex Java parser is added.

## Edge cases

- Nested type imports target the nested type's file when unique. External type/static imports own their name.
- Wildcard imports and implicit java.lang names do not authorize project edges.
- Ambiguous overloads, duplicate types (for example the same class in two modules), unknown receivers, and unresolved imports produce no edge.
- Known ceilings: an inherited method that shadows a static import, and a field, parameter, or local variable named like a type used as a receiver, are not detected.
- Files with more than 30 symbols or 20 calls retain all Java graph entries; other languages keep their caps.
- LF and CRLF produce identical native/WASM results. OPENEZ_NATIVE=0 still uses WASM; WASM failure falls back to text chunks.

## Interfaces

- Language key java and extension .java. Existing ParsedDocument fields carry everything the resolver needs; no public type, cache payload, SQLite schema, MCP, or CLI shape changes.
- Symbol contract: one `package` symbol per file (dotted name); type symbols class/interface/enum/record; members and nested types named `Owner::member` with the same convention for call callerName; raw import statements (including `static` and `.*`) in importPaths. The resolver reads only these fields (symbols with line ranges, importPaths, calls), never the source.
- A new packages/indexer/src/java-resolver.ts builds a package/type/method index from parsed files once per graph build.
- Imports edges are emitted in one loop in `buildGraphGeneration` that calls `resolveModuleSpecifier` and then `createWorkspaceFileResolver.resolveImport`, which only resolves `.`-relative paths (plus Python and Ruby). Java routes through its own resolver in `resolveModuleSpecifier`; the generic resolver keeps returning null for java.
- Caps are applied at the `uncapped` decision in `buildGraphGeneration` and at both native `callExpressions.slice(0, 20)` sites; extend those conditions, never `OXC_GRAPH_LANGUAGES`.
- The loader resolves `tree-sitter-java` and `tree-sitter-java.wasm` by default naming. Add the package to packages/indexer and apps/cli dependencies and to the apps/cli tsup externals; add the matching Rust crate to packages/native.
- Parser tags advance from the implementation baseline; full openez reindex rebuilds graph artifacts and other languages' stale rows.

## Verification

- Parser fixtures cover nested/top-level declarations, imports, calls, comments/strings, overloads, anonymous classes, and line ranges.
- Resolver and edge-accuracy fixtures (expected-edges.json plus baseline.json, as in tests/go-edge-accuracy.test.ts) assert exact package/type/static-import edges and no edges for external, wildcard, ambiguous, nested-to-outer, or unknown-receiver cases; false positives stay 0.
- Require exact native/WASM parity including CRLF (java fixtures listed in the parity test's required-fixture manifest), cache-version reparse, and an above-cap graph fixture.
- Run focused and full Bun tests, pnpm typecheck, native build, parity with OPENEZ_NATIVE_EXPECT=1, and existing Linux x64/macOS arm64/Windows x64 native CI.
- Build the CLI and run init/index on a temporary Java workspace from `apps/cli/dist`, confirming Java symbols are indexed. Record the install-size change from the new grammar package.

## Related context

None. This repository has no docs/llm wiki.
