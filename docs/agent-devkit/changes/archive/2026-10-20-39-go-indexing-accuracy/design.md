# Go indexing accuracy and native parity

Issue: #39

## Goal

Improve OpenEZ's Go symbol and call graph so package-qualified calls reach the correct in-workspace symbol, Go declarations are not lost by parser or graph limits, and the optional native parser agrees with the WASM parser on supported Go fixtures.

The existing Go edge baseline shows the concrete gaps: the packages fixture has 3/4 expected package edges and the types fixture has 2/3 expected package edges, with zero false positives. The three receiver-type edges in the types fixture require type inference and remain out of scope. The work must improve package-tier recall without adding guessed edges.

## Previous work

- [Native parity and multi-platform CI design](../archive/2026-10-19-native-parity-and-ci/design.md)
- [Native parity and multi-platform CI tasks](../archive/2026-10-19-native-parity-and-ci/tasks.md)

Change 1 established the parser parity harness, Go edge baseline, optional native loader, and three-platform native CI. Its Go extraction and call-resolution changes were explicitly deferred.

## Scope

This change covers Go parsing and Go graph construction across the existing native Rust parser, tree-sitter WASM parser, and regex fallback.

- Extract each package-level identifier in const and var declarations, including grouped declarations. Do not promote local variables or the blank identifier `_` to graph symbols. Preserve the existing generic receiver naming behavior and add regression coverage for pointer and generic receivers.
- Preserve package qualifiers in Go calls. Build package identity from the nearest `go.mod` and each file's Go `package` declaration, keyed by (directory, declared package name). Resolve in-workspace imports to that package under the module-matching, import-name, and target rules in Behavior.
- Resolve an unqualified call only within its own package and only to a package-level function; a bare call never reaches a method. Resolve an import-qualified call only to an exported package-level function declared directly in the imported workspace package. If the target is missing or ambiguous, omit the call edge. Do not infer receiver types or interface dispatch.
- Drop a call whose root name — the import qualifier, or the bare callee — is declared as a receiver, parameter, result, or `:=`/`var`/`const` name anywhere in the calling function. This function-granular rule may drop a valid edge, but a local value must not become a package call.
- Exclude Go files under a vendor path component from symbol and call graph generation. Keep their indexed documents and text chunks searchable.
- Remove the current per-file limits of 30 symbols and 20 call expressions for Go graph nodes and edges, at the graph-build truncation and at both native parse-result `slice(0, 20)` sites. Keep those limits unchanged for other languages, including Python and Rust on the same native path.
- Keep the existing Go edge fixtures as the accuracy ratchet. The packages fixture must reach 4/4 package true positives, zero package false negatives, and zero false positives. The types fixture must reach 3/3 package true positives, zero package false negatives, and zero false positives. Its three type-tier misses remain unchanged because receiver type inference is not part of this change.
- Require exact native-versus-WASM parity for the maintained Go fixtures, including CRLF. For the recursive-call case pinned for `go/example.go` (native `Node::Traverse`, WASM `Traverse`), the canonical result is the receiver-qualified native form, so the WASM path changes. Keep Python and Rust behavior and their current pins unchanged. A Go pin is removed only when the corresponding difference no longer occurs.
- Make parity fixture coverage explicit: missing required fixtures and stale or orphaned pin entries must fail instead of silently reducing coverage. The manifest is shared with the Python, Rust, and Ruby plans; see Coordination.
- Update the agent and CLI language guidance to describe Go's package-aware, unique-only call edges, function-granular shadowing, and vendor graph exclusion.

The Go graph uses all extracted Go symbols and calls, including the 31st symbol and 21st call in a file. This may increase graph size and build time for large Go files; the verification records the effect on the existing Go standard-library smoke corpus.

## CodeGraph comparison

I inspected [colbymchenry/codegraph at commit `204315274e7902c713ba3ad61e8df511aa634b10`](https://github.com/colbymchenry/codegraph/tree/204315274e7902c713ba3ad61e8df511aa634b10). Its README describes a native Rust extraction kernel with a portable reference path and byte-for-byte parity gates. Its [Go extractor](https://github.com/colbymchenry/codegraph/blob/204315274e7902c713ba3ad61e8df511aa634b10/src/extraction/languages/go.ts) and [import-alias precedence fixture](https://github.com/colbymchenry/codegraph/blob/204315274e7902c713ba3ad61e8df511aa634b10/__tests__/go-import-alias-precedence.test.ts) give a concrete case for this plan: an explicit alias must win even if another import's inferred package name collides with it, regardless of import order. The [grouped-var fixture](https://github.com/colbymchenry/codegraph/blob/204315274e7902c713ba3ad61e8df511aa634b10/__tests__/go-var-groups.test.ts) is a useful parser regression example.

Apply the alias-precedence case to the existing Go edge fixtures in both import declaration orders, in LF and CRLF. Keep OpenEZ's unique-target policy. Do not port CodeGraph's native kernel, its broader type/reference extraction, or any receiver-type and interface-dispatch behavior; the current plan still adds no Go toolchain or parser dependency.

Further fixtures read at the same commit are adopted as ground truth for the rules below:

- [Module resolution](https://github.com/colbymchenry/codegraph/blob/204315274e7902c713ba3ad61e8df511aa634b10/src/resolution/go-module.ts) and its [nested-module fixture](https://github.com/colbymchenry/codegraph/blob/204315274e7902c713ba3ad61e8df511aa634b10/__tests__/go-nested-module.test.ts): the longest `/`-bounded module-path prefix wins, a tie goes to the importing file's own module, an import that only shares a prefix with a module path stays unresolved, and a module under `testdata` never answers for the module it imitates.
- [Locals named like an import](https://github.com/colbymchenry/codegraph/blob/204315274e7902c713ba3ad61e8df511aa634b10/__tests__/go-stdlib-named-locals.test.ts): a parameter or `:=` local that takes an import's name makes `name.Call()` a call on that value, not into the package.
- [Bare call never reaches a method](https://github.com/colbymchenry/codegraph/blob/204315274e7902c713ba3ad61e8df511aa634b10/__tests__/go-bare-call-no-method.test.ts) and [unexported names stay in their package](https://github.com/colbymchenry/codegraph/blob/204315274e7902c713ba3ad61e8df511aa634b10/__tests__/go-unexported-namesake.test.ts).
- [Import-block parsing](https://github.com/colbymchenry/codegraph/blob/204315274e7902c713ba3ad61e8df511aa634b10/__tests__/go-import-package-names.test.ts): a word in a trailing comment is not an import name, and import-like text in comments or strings is not an import.

Two deliberate differences. CodeGraph infers an unaliased import's name from the path (last element plus the goimports-assumed name) because it does not read the target. OpenEZ resolves workspace imports only, so it reads the exact `package` declaration of the target directory, and an unaliased external import binds no name. CodeGraph tracks locals per block with a regex scope index; this plan uses the simpler function-granular rule and accepts the extra dropped edges.

CodeGraph's broader language coverage is a reference for future expansion, but this Go plan does not add a language to the native parser. Ruby native parity is covered by a separate pending plan and must be reviewed independently.

Out of scope: TypeScript/JavaScript parser changes, adding a new language to the native extension, Go receiver type inference, implicit interface edges, external dependency indexing, go.work replace evaluation, block-level scope analysis, persisting Go package context in the parsed-document cache, CLI/MCP/API changes, and database schema changes.

## Behavior

**Modules.** For each Go file outside vendor, graph generation finds the nearest ancestor `go.mod` and reads its `module` directive (line comments stripped, optional quotes removed). A directory that holds its own `go.mod` belongs to that module, not to a parent module. A `go.mod` under `vendor`, `testdata`, or a directory whose name starts with `_` or `.` is ignored, as the Go toolchain ignores those directories, and files there are never import targets. An import path belongs to the discovered module whose path equals it or is a `/`-bounded prefix of it; the longest module path wins, and a tie goes to the importing file's own module. The package directory is the module directory plus the rest of the import path. A path with no matching module is standard-library or external. go.work and replace directives are not evaluated.

**Packages.** A package is identified by its (directory, declared package name). Files named `_test.go` never provide import targets. A `_test` package such as `foo_test` is its own package: its unqualified calls resolve inside it, and its import of `foo` resolves to `foo`'s non-test files. If a directory declares more than one non-test package name, for example a `//go:build ignore` file with `package main`, an import of that directory resolves to nothing.

**Import names.** An import is bound to the name written before its path, otherwise to the `package` name declared by the imported workspace directory, not the last path element: `…/client/v3` declaring `package clientv3` is `clientv3`. An external or unmatched import binds no name, so an explicit alias never competes with it. Blank imports bind nothing and dot imports are not resolved. If two imports of one file bind the same name, calls through that name are dropped.

**Calls.** The Go parser preserves a selector in call names until graph resolution. A call through a known method receiver keeps its existing receiver-qualified name. An import-qualified function call resolves only through its import mapping, and only to an exported function declared directly in the target directory, never in a sub-package. A same-package unqualified function call resolves only when that package contains one matching function. Types, vars, consts, and methods are not call targets for bare or qualified calls. Calls to external packages, unresolved imports, ambiguous symbols, unexported names of another package, shadowed names, and unknown receiver methods produce no calls edge.

**Graph limits and vendor.** Go files beneath vendor are omitted from graph nodes and edges while their documents and chunks remain indexed. Go symbols and calls are not truncated by the generic graph limits; non-Go languages retain their current limits. Graph generation keeps the cap decision and the call-resolver choice as separate per-language decisions: lifting the cap for Go must not route Go calls through the OXC module-binding resolver, the same-file lexical lookup, or the global first-match map. Go calls other than parser-qualified receiver calls (`Type::method`) go through the Go resolver, including same-file calls; receiver-qualified names keep their existing same-file lookup, so the type tier is unchanged.

**Versions.** Parser output changes bump the existing native and fallback parser version tags (`native-v1`, `fallback-v1`). The Python, Rust, and Ruby plans bump the same tags, so this plan increments from the value left by the plan that landed before it rather than choosing a version in advance. A parser-version mismatch is checked during graph construction, while a completed graph can short-circuit after a no-op incremental index. Run `openez reindex <path>` after this change to rebuild old parsed rows and graph artifacts; a no-op `openez index <path>` is not sufficient. Parsed-document table shape, graph node and edge shape, SQLite schema, and MCP/CLI interfaces stay the same.

## Edge cases

- A missing or malformed go.mod prevents module-qualified resolution for that module; same-package resolution remains available, and unresolved calls are dropped.
- Nested modules and sibling modules resolve each import into the module that owns the longest matching path. An import that only shares a prefix with a module path (`example.com/app2` against `example.com/app`) is unresolved. Two modules declaring one path prefer the importing file's own module.
- Explicit import aliases and default package names resolve to the same target package. An external unaliased import whose last path element equals a workspace alias (`github.com/x/pb/v3` beside `v3 "…/client/v3"`) never takes that name, in either declaration order.
- A workspace import whose directory name differs from its declared package name binds the declared name only.
- A local value that takes an import's name (`store := newStore(); store.Get(k)`, a `func(context *Context)` parameter) or a bare callee's name (`init := func(){…}; init(t)`) produces no package call edge. Receiver-qualified calls that the parser already qualified from the current method receiver are not subject to this rule.
- A bare call to a name that exists only as a method produces no edge.
- A qualified call to an unexported name (`pkg.helper`) produces no edge.
- Duplicate function names in one package, such as build-tagged `a_linux.go` and `a_windows.go`, are ambiguous and produce no edge. Duplicate names in different packages resolve through package identity.
- `foo_test` external test packages and `_test.go` files do not provide import targets.
- Methods on unknown receiver values are dropped unless the parser has already qualified the call from the current method receiver. Type inference and interface dispatch remain deferred.
- Files under vendor remain available through document and text search but have no Go graph symbols or calls.
- Files with more than 30 symbols or 20 calls retain all Go symbols and calls. Other languages retain their existing graph limits.
- A Go source file that cannot be read during graph generation has no Go context; its Go calls produce no edge.
- Comments in an import block, and import-like text inside comments or strings, are not imports.
- When native is disabled, unavailable, or fails to load, the WASM or regex fallback remains usable. The named Go fixtures exercise the fallback path; exact parity is required between native and WASM, not between AST parsers and the regex fallback.
- CRLF input must produce the same normalized Go parser results as LF input.

## Interfaces

- The native parseCodeBatch result shape remains unchanged. Go call names retain package selectors in the existing calleeName string until graph resolution.
- Go package and import context is reconstructed from workspace go.mod and Go source during graph generation; it is not persisted, so no parsed_documents schema migration is needed. CodeGraph resolves Go imports from source at resolution time in the same way.
- A new indexer module, `packages/indexer/src/go-resolver.ts`, owns go.mod discovery and module matching, plus a per-file context `{ packageName, imports, localNamesByCaller }` produced in one pass over the source. The import scan covers only the file header, ending at the first top-level `func`, `type`, `var`, or `const` outside a block comment. Comments and string and raw-string contents are blanked before scanning, and CRLF is handled. `localNamesByCaller` is keyed by the same caller name the parser emits and takes the union across same-named functions in a file (for example repeated `init`). Contexts are memoized per graph build.
- The source is read once per Go file per graph build, as the existing lazy reparse path already reads files. If the net corpus measurement shows this read is significant, persisting the context in the parsed-document imports payload is a follow-up, not part of this change.
- Existing graph node and edge records remain unchanged. Go-specific call edges use the existing calls edge type and are emitted only for unique in-workspace targets.
- The native extension remains optional and OPENEZ_NATIVE=0 continues to force the fallback path.

## Coordination

The Python, Rust, and Ruby plans edit the same native parser file, the same shared parser version tags, and the cap and resolver block of `buildGraphGeneration`. To keep them independent of landing order:

- Each plan re-verifies names and paths on HEAD in its Task 1 before editing.
- Version tags are incremented from the value left by the previous plan.
- The parity manifest is created by the first plan to land and extended by the others; each plan owns only the entries for its own languages.
- This plan adds a Go cap decision and a Go resolver branch beside the existing OXC ones. It does not rename or restructure the OXC gate. The 20-call native slice is removed for Go only at both sites; Python and Rust keep theirs unless their own plans change them.

## Verification

- Extend tests/go-edge-accuracy.test.ts with package alias, same-name package, generic function instantiation, vendor, grouped const/var, nested and sibling modules, `_test` package, local shadowing, bare-call-no-method, unexported-qualifier, and above-cap fixtures. Assert the exact edge targets and the package-tier metrics specified in Goal; assert no false-positive edges.
- Add tests/go-resolver.test.ts for module discovery and matching, import-header parsing (comments, raw strings, grouped imports, CRLF), declared-package binding, and function-granular local names.
- Extend Go parser tests for grouped declarations, blank identifiers, exported status, generic and pointer receivers, selector preservation, and comments/strings. Assert local variables are not top-level symbols.
- Extend tests/native-wasm-parity.test.ts with a required fixture manifest and exact pin-key validation. Go fixture differences must be empty after the parser fix; Python and Rust pins remain unchanged.
- Run the focused parser, edge, parity, and parsed-document-cache suites with native enabled and with OPENEZ_NATIVE=0. Verify old cache entries are reparsed under the bumped version tags.
- Run the full bun test suite, build the native package, and run the native parity and edge suites with OPENEZ_NATIVE_EXPECT=1. Require the existing native CI matrix to pass on Linux x64, macOS arm64, and Windows x64.
- Record graph counts and elapsed time for the existing Go standard-library net smoke corpus, including the extra source read. This measurement is informational; the functional gate is the exact fixture and parity assertions.

## Related context

None. This repository has no docs/llm wiki.
