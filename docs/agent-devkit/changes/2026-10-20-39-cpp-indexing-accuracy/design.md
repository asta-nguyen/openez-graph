# C++ indexing accuracy and native parity

Issue: #39

## Goal

Index C++ declarations and calls and resolve only targets visible in the caller's translation unit. Native and WASM parsing must agree without requiring a compiler or compilation database.

## Scope

- Add .cpp, .cc, .cxx, .c++, .hpp, .hh, .hxx, .h++, and .h as language cpp, and uppercase .C as cpp. None of these, nor lowercase .c, is scanned today (the scanner builds its file list from `codeExtensions`), so the first `openez index` after upgrading ingests them for the first time. Map .h to cpp because OpenEZ has no C parser. Lowercase .c stays unindexed, so a C repository gains its headers only.
- The native scanner and the glob list match extensions case-sensitively, so a `.C` key in `codeExtensions` is enough for discovery. `inferDocumentKind` lowercases the extension before lookup, so it needs an exact-case `.C` check ahead of that.
- Extract namespaces, classes, structs, unions, enums, aliases, free functions, methods, constructors, destructors, templates, and out-of-line qualified definitions. Definitions (functions with a body, including in-class inline ones) keep the existing function/method symbolType; prototypes and in-class member declarations without a body use symbolType `declaration`.
- Preserve namespace/type qualification and call receivers. Resolve unique same-file and explicitly qualified calls visible from the current file or a transitive quoted-include closure.
- Pair each declaration with its definition by fully qualified name so a header prototype and its source definition are one call target.
- Resolve only unique targets. Do not infer variable receiver types, inheritance, overload choice, template specialization, macro-generated declarations, using-directives, compiler flags, or system include paths.
- Resolve quoted includes from the including directory, then the workspace root, then a unique path-suffix match, enforcing workspace containment. Angle/system includes do not create workspace imports edges.
- A .h file whose parse has any syntax error gets generic text chunks and no graph records; other C++ extensions keep their partial trees.
- Remove generic 30-symbol/20-call graph limits for C++ only, at every site that applies them (see Interfaces). Keep DB/API shapes unchanged.
- Ship the C++ grammar in the published CLI, not only in the workspace packages.
- Advance cache tags from implementation baseline and run openez reindex.

### CodeGraph reference

I inspected [colbymchenry/codegraph at commit 204315274e7902c713ba3ad61e8df511aa634b10](https://github.com/colbymchenry/codegraph/tree/204315274e7902c713ba3ad61e8df511aa634b10). Its [C/C++ extractor](https://github.com/colbymchenry/codegraph/blob/204315274e7902c713ba3ad61e8df511aa634b10/src/extraction/languages/c-cpp.ts), [translation-unit fixture](https://github.com/colbymchenry/codegraph/blob/204315274e7902c713ba3ad61e8df511aa634b10/__tests__/cpp-translation-unit.test.ts), and [implicit-this fixture](https://github.com/colbymchenry/codegraph/blob/204315274e7902c713ba3ad61e8df511aa634b10/__tests__/cpp-implicit-this-calls.test.ts) inform include visibility and member scope. The translation-unit fixture expects a source to implement the header beside it and a header overload to call the definition in its own source, and the implicit-this fixture expects an out-of-line member to reach a method declared in its header; this plan adopts declaration/definition pairing for the same reason. That fixture also resolves inherited methods and picks overloads by argument; this plan does neither. Its [overload fixture](https://github.com/colbymchenry/codegraph/blob/204315274e7902c713ba3ad61e8df511aa634b10/__tests__/cpp-free-function-overloads.test.ts) uses argument types to select overloads; OpenEZ instead leaves ambiguous names unresolved because it has no C++ type checker or compilation context. CodeGraph's [grammar registry](https://github.com/colbymchenry/codegraph/blob/204315274e7902c713ba3ad61e8df511aa634b10/src/extraction/grammars.ts) treats .h as C by default and detects C++ syntax from file content. OpenEZ has no C parser, so this plan maps .h to cpp and falls back to text chunks when a header does not parse cleanly.

### Coordination

This is separate from the archived [Go indexing work (native CI pending)](../archive/2026-10-20-39-go-indexing-accuracy/design.md), archived [Python indexing work](../archive/2026-10-20-39-python-index-accuracy/design.md), and the Java and C# plans of this series; the [Ruby](../archive/2026-10-20-39-ruby-native-indexing/design.md) and [Rust](../archive/2026-10-20-39-rust-index-accuracy/design.md) plans have already landed. These plans share native parser, grammar, cache-version, graph-builder, parity, and CLI packaging files; implement them in isolated worktrees in parallel, then integrate shared files serially. This plan owns the C++ fixtures and resolver branch; advance shared parser tags from the value present on the integration branch (`native-v5`/`fallback-v5` at planning time).

## Behavior

- A C++ file sees itself plus recursively reachable literal quoted includes inside the workspace. Direct quotes create imports edges; transitive visibility is used for calls.
- Every callable symbol in the visible set has a fully qualified name: the enclosing namespace chain (from namespace symbol line ranges) plus the owner chain as written, so an out-of-line `Foo::bar` inside `namespace ns` and a `ns::Foo::bar` at global scope both become `ns::Foo::bar`. Symbols with the same qualified name form one candidate group.
- A group is one call target when it has exactly one definition and at most one declaration (the target is the definition), or no definition and exactly one declaration (the target is that declaration). More than one definition, or a definition plus two or more declarations, is ambiguous and produces no edge: without signatures that shape is overloads or duplicates. Because a `.cpp` sees its own header, calls inside the implementation file to methods declared in the header resolve to the definition; a caller in another file that sees only the header links to the header declaration.
- Qualified calls (`ns::f`, `Type::f`) look up their qualified name relative to the caller's enclosing scopes, innermost first. Unqualified calls look in the caller's owner chain (innermost class outward), then enclosing namespaces, then the global namespace; the first scope that has any group with that name decides (inner names hide outer ones) and must contain exactly one group. this->method() and implicit-this calls resolve only against the caller's own class scope. Unknown object receivers (`obj.f()`, `p->f()`) never fall back to a project namesake.
- Templates are indexed by declared name; explicit template arguments do not disambiguate same-name candidates.
- .h uses the C++ grammar as a best effort. Lowercase .c, external headers, macro expansion, build flags, using-directives, and system include search remain unsupported.
- If both AST paths fail, generic text chunks remain searchable and no C++ graph records are emitted. No regex C++ parser is added.

## Edge cases

- Quoted includes resolve from the importer directory, then the workspace root, then a unique path-suffix match among workspace C++ files (this finds `include/foo/bar.h` for `#include "foo/bar.h"`); several suffix matches leave the include unresolved. Outside-workspace and angle includes emit no imports edge.
- Include cycles terminate. Same names in unrelated namespaces do not cross-link.
- A visible header declaration and a same-named source definition are one group and produce one edge to the definition; two visible definitions of one name produce none.
- Overloads, duplicate visible targets, unknown receivers, macro-generated functions, and unresolved template targets emit no edge.
- Implicit member and this-> calls only use unique methods of the caller's class; unrelated class namesakes are excluded.
- Known ceilings: inherited methods, using-directives and using-declarations, argument-dependent lookup, and overloads that split between a declaration in one file and a definition in another are not modeled, so a lexically found target may differ from the real one in those cases.
- A .h file with a syntax error (typically macro-heavy C) is text-chunked only. .h and .C receive cpp metadata; lowercase .c is not indexed.
- Above-cap symbols/calls are retained. LF and CRLF produce exact native/WASM parse parity.

## Interfaces

- Canonical key cpp. Existing ParsedDocument.importPaths carries literal quoted includes as written; no new cache payload, SQLite schema, public API, MCP tool, or CLI command.
- Symbol contract: `namespace` symbols with line ranges; type symbols; members named `Owner::member`, out-of-line definitions with their qualifiers as written; prototypes and member declarations with symbolType `declaration`; call callerName follows the same names. The resolver reads only these fields and never the source.
- New packages/indexer/src/cpp-resolver.ts builds the include graph, translation-unit visibility, and qualified-name groups from parsed files and workspace paths once per graph build.
- Imports edges are emitted in one loop in `buildGraphGeneration` that calls `resolveModuleSpecifier` and then `createWorkspaceFileResolver.resolveImport`, whose generic branch would resolve `"./x.h"` by path. C++ routes through its own resolver in `resolveModuleSpecifier`; the generic resolver returns null for cpp.
- Caps are applied at the `uncapped` decision in `buildGraphGeneration` and at both native `callExpressions.slice(0, 20)` sites; extend those conditions, never `OXC_GRAPH_LANGUAGES`.
- The .h error rule uses the grammar's root error flag (`rootNode.hasError` in web-tree-sitter, `has_error()` in Rust) on both paths.
- Native Rust and WASM parsers use compatible C++ tree-sitter grammars and existing parse result fields. Native stays optional. Add the tree-sitter-cpp package (about 42 MB unpacked, mostly prebuilt binaries for every platform) to packages/indexer and apps/cli dependencies and the apps/cli tsup externals, and the matching Rust crate to packages/native.
- Parser tags advance from implementation baseline; full openez reindex rebuilds graph artifacts and other languages' stale rows.

## Verification

- Parser fixtures cover declarations, namespaces, templates, out-of-line members, calls, quoted/angle includes, macros/comments/strings, and source locations.
- Resolver and edge-accuracy fixtures (expected-edges.json plus baseline.json, as in tests/go-edge-accuracy.test.ts) cover direct/transitive includes, cycles, workspace-root and `include/` suffix includes, namespace isolation, enclosing-namespace lookup, declaration/definition pairing, own-type calls inside the implementation file, cross-file calls to header declarations, overload ambiguity, unknown receivers, and outside-workspace paths; false positives stay 0.
- Require exact native/WASM parity including CRLF (cpp fixtures listed in the parity test's required-fixture manifest), .h/.C/.c classification, the .h syntax-error fallback, cache reparse, and above-cap graph assertions.
- Run focused/full Bun tests, pnpm typecheck, native build, parity with OPENEZ_NATIVE_EXPECT=1, and existing three-platform native CI.
- Build the CLI and run init/index on a temporary C++ workspace from `apps/cli/dist`, confirming C++ symbols are indexed. Record the install-size change from the new grammar package.

## Related context

None. This repository has no docs/llm wiki.
