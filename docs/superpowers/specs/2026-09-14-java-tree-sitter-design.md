# Generic Java Tree-sitter Indexing Design

## Goal

Add first-class Generic Java support to the OpenEZ indexer so `.java` files are
scanned, parsed into structural symbols, chunked for retrieval, and connected
to local source files through best-effort import and call graph edges.

## Scope

- Add the `tree-sitter-java` WASM grammar to the existing indexer parser path.
- Register `.java` as the `java` source language.
- Extract Java import information, types, methods, constructors, fields, and
  method invocations from Tree-sitter ASTs. Package declarations are syntax
  context for Java source files, not separate symbols or a new persisted field
  in v1.
- Reuse the existing `TreeSitterParser`, symbol chunking, parsed-document cache,
  SQLite graph builder, FTS retrieval, and MCP contracts.
- Resolve local Java imports by mapping fully qualified names to unique `.java`
  files across common source roots and multi-module workspaces.
- Keep unresolved and ambiguous imports/calls searchable without creating unsafe
  graph edges.
- Fall back to a raw file chunk if the Java grammar is unavailable or produces
  no usable symbols.
- Document Java support in the existing language support tables.

## Non-goals

- No Java compiler, JDK, Maven, or Gradle runtime dependency.
- No Maven/Gradle model parsing or classpath discovery.
- No resolution of classes or methods inside JAR dependencies.
- No Java type inference, overload resolution, inheritance resolution, or exact
  dispatch analysis.
- No Spring, Android, Lombok, Jakarta, or other framework-specific semantics.
- No Java native Rust parser in this release; Java uses the existing WASM path.
- No SQLite schema migration and no new CLI/MCP request fields.

## Approved approach

Extend the existing `TreeSitterParser` configuration model rather than creating
a Java-specific parser class or duplicating parsing logic in the native Rust
addon. The loader already resolves a language grammar using the package name
pattern `tree-sitter-${language}.wasm`, and the parser already converts a
language config into `ParsedDocument` data consumed by the rest of the indexer.

The resulting flow is:

```text
.java
  -> scanWorkspaceFiles
  -> inferDocumentKind
  -> parser registry
  -> TreeSitterParser
  -> loadLanguage("java")
  -> javaConfig + parseWithTreeSitter
  -> symbol chunks and parsed-document cache
  -> SQLite file/symbol nodes and defines/imports/calls edges
  -> code_query / code_outline / code_context
```

Java will not be added to the native batch set, which currently exists for
Python, Go, and Rust. This keeps v1 to one parser implementation and avoids
requiring platform-specific native binary builds for the new grammar.

## Symbol model

Java symbols use the existing nested-name convention used by the Tree-sitter
languages. Package names are not prefixed onto graph labels; the file path
remains the identity boundary and keeps symbol search consistent with existing
languages.

| Java construct | `symbolType` | Example graph label |
| --- | --- | --- |
| class declaration | `class` | `User` |
| interface declaration | `interface` | `Repository` |
| enum declaration | `enum` | `Status` |
| record declaration | `record` | `UserDto` |
| annotation type declaration | `annotation` | `Audited` |
| nested type | corresponding type | `Outer::Inner` |
| method declaration | `method` | `User::save` |
| constructor declaration | `constructor` | `User::<constructor>` |
| compact record constructor | `constructor` | `UserDto::<constructor>` |
| class field declaration | `field` | `User::id` |
| interface/annotation constant declaration | `field` | `Config::TIMEOUT` |

Only class-level fields and constants are extracted. Local variable declarations
are deliberately excluded to keep symbol graphs useful for code navigation.
When a field declaration contains multiple declarators, such as `int id,
version;`, the parser emits one field symbol per declarator. This requires an
optional multi-name extraction callback in the shared Tree-sitter symbol rule;
the callback is used only by Java field/constant rules.

Type declarations and callable declarations establish nesting contexts. A
method inside `class User` becomes `User::save`; a method inside nested
`class Outer { class Inner { ... } }` becomes `Outer::Inner::save`.

Visibility is mapped as follows:

- `public` and `protected` symbols have `exported: true`.
- `private` and package-private symbols have `exported: false`.
- The check is based on the declaration's modifier text, matching the existing
  lightweight export checks for Rust and Go.

Java overloads use the stable name `Type::method` rather than embedding a
parameter signature. If a call could match multiple overloads, the graph
builder leaves it unresolved. This is the intentional v1 ceiling for avoiding
false edges; signature-aware symbol identity can be added later if retrieval
needs overload-level navigation.

## Tree-sitter configuration

`packages/indexer/src/tree-sitter/configs.ts` will add `javaConfig` with rules
for these grammar node types:

- `class_declaration` → `class`, name field `name`, context.
- `interface_declaration` → `interface`, name field `name`, context.
- `enum_declaration` → `enum`, name field `name`, context.
- `record_declaration` → `record`, name field `name`, context.
- `annotation_type_declaration` → `annotation`, name field `name`, context.
- `method_declaration` → `method`, name field `name`, context.
- `constructor_declaration` → `constructor`, custom extraction through the
  nested constructor declarator name field, context.
- `compact_constructor_declaration` → `constructor`, name field `name`, context.
- `field_declaration` → `field`, custom multi-name extraction from each
  `variable_declarator` name.
- `constant_declaration` → `field`, custom multi-name extraction.

The Java config will use `method_invocation` with function field `name` as its
call rule. The normalizer returns the method identifier, so `service.save()`
and `this.save()` both produce `save`. Calls remain heuristic and are linked
only when the graph builder finds a unique symbol candidate.

Object creation expressions (`new User(...)`) and method references are kept in
the source chunk but are not emitted as call edges in v1. This avoids changing
the single-call-rule abstraction for a feature that needs type-aware
constructor resolution.

The Java parser will not use a Java regex parser. `TreeSitterParser` will make
language-specific regex fallbacks optional and use `makeFallbackChunks()` when
Java has no AST fallback available.

## Import extraction and resolution

The Java config will inspect `import_declaration` nodes and emit normalized
import strings:

- regular imports: `com.example.User`
- static imports: `com.example.Util.run`
- wildcard imports: `com.example.util.*`

The resolver in `packages/indexer/src/index-workspace.ts` will add a Java branch
with the following behavior:

1. Remove the static-import marker before path matching.
2. Convert a fully qualified name to slash-separated candidates, for example
   `com.example.User` to `com/example/User.java`.
3. Match exact relative paths and unique suffixes, so both
   `com/example/User.java` and `module/src/main/java/com/example/User.java` are
   supported.
4. For static imports and nested classes, progressively remove trailing name
   segments until a class file candidate is found. For example,
   `com.example.Util.run` may resolve to `com/example/Util.java`.
5. Resolve only when exactly one known workspace file matches.
6. Do not create a file edge for wildcard imports because the target set is
   unknown and broad fan-out would create noisy graphs.
7. Do not create edges for JDK or external dependency imports when no local
   source file matches.
8. Do not create edges for ambiguous duplicate classes.

Import strings remain available through parsed content/search even when no edge
is created. The resolver uses the already scanned file list, so it does not
need to inspect the filesystem repeatedly or parse build files.

## Graph and retrieval behavior

The existing `ParsedDocument` shape remains unchanged. Java parse results flow
through the current chunk and graph pipeline:

- one file node per indexed Java document;
- one symbol node per extracted symbol, capped by the existing graph symbol cap;
- `defines` edges from the Java file to its symbols;
- `imports` edges for unique local import matches;
- `calls` edges for unique heuristic method targets;
- symbol chunks carrying `symbolName`, `symbolType`, `language`, visibility, and
  source line metadata;
- existing FTS and optional embedding behavior without Java-specific retrieval
  code.

The current graph resolver already scopes symbols by file and falls back to a
global symbol label for calls. Java call extraction therefore intentionally
uses unqualified method names and does not claim exact receiver type identity.
Ambiguous calls are left as source text rather than linked to an arbitrary
overload.

## Cache, fallback, and failure behavior

- Add `tree-sitter-java` to `packages/indexer/package.json` and update the
  workspace lockfile.
- Register `.java` in `codeExtensions`; scanner include patterns and the native
  scanner's allowed extension set derive from that map automatically.
- Add `.java` to `RESOLVABLE_SOURCE_EXTENSIONS` for Java resolver candidates.
- Register Java in `LANGUAGE_CONFIGS` and export `javaConfig` from the
  Tree-sitter index module.
- Change the shared Tree-sitter fallback registry to allow missing
  language-specific fallback functions.
- When Java grammar loading returns null, return one bounded raw chunk with no
  symbols/imports/calls instead of throwing or aborting the index run.
- Preserve partial AST results when Tree-sitter can parse a syntactically
  incomplete file.
- Bump the shared non-native parser cache version from `fallback-v1` to
  `fallback-v2` so documents parsed by the changed Tree-sitter path are
  invalidated safely. This causes one rebuild of existing Tree-sitter-language
  parse artifacts and does not alter the database schema.
- Keep per-file I/O and parse failures isolated according to current indexer
  behavior; a malformed Java file must not prevent other workspace files from
  indexing.

## File impact

### Modify

- `packages/indexer/package.json` — Java grammar dependency.
- `pnpm-lock.yaml` — locked dependency resolution.
- `packages/indexer/src/languages.ts` — `.java` language registration.
- `packages/indexer/src/tree-sitter/configs.ts` — Java AST rules and helpers.
- `packages/indexer/src/tree-sitter/index.ts` — export `javaConfig`.
- `packages/indexer/src/tree-sitter/parse.ts` — optional multi-name symbol
  extraction and Java field handling support.
- `packages/indexer/src/parsers/tree-sitter-parser.ts` — Java registration and
  generic raw-chunk fallback.
- `packages/indexer/src/index-workspace.ts` — Java import resolution, extension
  list, and parser cache version.
- `tests/parser-registry.test.ts` — Java parser dispatch.
- `tests/scanner.test.ts` — Java inclusion and `target/` exclusion.
- `tests/tree-sitter-parser.test.ts` — Java AST, symbol, import, call, and
  malformed-source behavior.
- `tests/index-workspace.test.ts` — Java graph and incremental-index behavior.
- `README.md` — public language support table.
- `apps/cli/README.md` — CLI language support table.
- `documents/PROJECT_OPERATIONS.md` — operational language support table.

### No change

- `packages/native` — Java stays on WASM in v1.
- `packages/db` — existing parsed-document and graph schema is sufficient.
- `apps/mcp` and MCP tool signatures — retrieval contracts are unchanged.
- `apps/web` — existing symbol/file metadata is generic.

## Verification and acceptance criteria

The feature is complete when all of the following are true:

1. `getParserForPath("src/main/java/User.java")` returns
   `TreeSitterParser`.
2. The default scanner includes Java source files and excludes `target/` build
   output and `.class` files.
3. A fixture containing class, interface, enum, record, annotation, nested
   types, fields, constructors, methods, and overloaded methods produces the
   documented symbol types, names, visibility flags, line ranges, and chunks.
4. Java imports are extracted for regular, static, and wildcard forms.
5. Unique local imports create `imports` edges; missing, wildcard, and
   ambiguous targets do not create unsafe edges.
6. Method invocations in code create heuristic calls when a unique target
   exists, while comments and string literals do not create false call edges.
7. `code_outline` exposes Java symbols and line ranges, and `code_context`
   returns Java source snippets and available graph neighbors.
8. Repeated incremental indexing does not duplicate Java edges, and parser
   cache versioning causes stale Tree-sitter artifacts to be reparsed.
9. A missing/unusable Java grammar results in a searchable raw chunk and a
   successful workspace index rather than an exception.
10. Existing Python, Go, Rust, Ruby, TypeScript, config, and Markdown tests
    continue to pass.
11. Package typecheck passes without requiring a JDK, Maven, or Gradle.

## Related context

- [Repository instructions](../../../AGENTS.md)
- [Existing parser registry](../../../packages/indexer/src/parsers/parser-registry.ts)
- [Existing Tree-sitter parser](../../../packages/indexer/src/parsers/tree-sitter-parser.ts)
- [Existing Tree-sitter configs](../../../packages/indexer/src/tree-sitter/configs.ts)
- [Existing indexing and graph build](../../../packages/indexer/src/index-workspace.ts)
- [Existing Ruby and fallback language design](2026-08-15-ruby-coffeescript-slim-css-indexing-design.md)
