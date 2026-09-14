# Generic Java Tree-sitter Indexing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** Add first-class, generic Java indexing to OpenEZ so .java files are scanned, parsed with the existing Tree-sitter WASM path, chunked into navigable symbols, connected through safe local import edges, and exposed through the existing graph/retrieval contracts.

**Architecture:** Extend the existing language map, TreeSitterParser configuration, shared AST walker, workspace import resolver, and generic graph/cache pipeline. Java remains WASM-only in v1. No Java-specific parser class, native Rust grammar, database migration, CLI flag, or MCP schema change is needed.

**Tech Stack:** TypeScript, Bun tests, web-tree-sitter, tree-sitter-java WASM grammar, pnpm workspace lockfile, existing SQLite graph/indexer.

## Global Constraints

- Follow the approved design in docs/superpowers/specs/2026-09-14-java-tree-sitter-design.md.
- Java scope is generic syntax and best-effort source navigation only: no JDK, compiler, Maven, Gradle, classpath, JAR, type inference, overload resolution, inheritance resolution, or framework semantics.
- Reuse existing TreeSitterParser, LanguageConfig, ParsedDocument, symbol chunking, cache, graph, scanner, and retrieval code.
- Keep Java out of packages/native; it must use the existing WASM loader.
- Keep Java overload identity as Type::method; do not invent parameter-signature symbols.
- Resolve an import edge only for exactly one known local .java target. Wildcards, missing targets, and ambiguous duplicate classes remain searchable source text but do not create edges.
- Keep field extraction class-level only. Do not emit local variables as symbols.
- Preserve partial AST output for malformed source. If no usable AST result is available, return one bounded raw chunk and continue indexing.
- Mark the deliberate v1 ceiling near the implementation with a ponytail: comment: local suffix matching is a bounded heuristic; upgrade path is build-model/classpath/type-aware resolution.
- Do not change SQLite schema or MCP request/response contracts.
- C# is explicitly out of scope for this implementation; it needs a separate grammar/configuration decision.

## Execution Order and Dependency Graph

```text
Task 1 language registration
        |
        v
Task 2 grammar + AST config + shared multi-name walker
        |
        +--> Task 3 generic fallback + cache version
        |
        +--> Task 4 Java import resolver
                         |
                         v
                 Task 5 index/graph/retrieval integration
                         |
                         v
                 Task 6 documentation
                         |
                         v
                 Task 7 full verification and handoff
```

Tasks 3 and 4 are independent after Task 2 and may be delegated in parallel. Task 5 must wait for both because it exercises parser fallback, resolver behavior, and graph materialization together.

## Task 1: Register .java as a scanned source language

**Files:**

- Modify packages/indexer/src/languages.ts:20-35 (codeExtensions).
- Modify tests/parser-registry.test.ts with language inference coverage.
- Modify tests/scanner.test.ts with inclusion and build-output exclusion coverage.

### Step 1: Add failing language and scanner tests

- [ ] In tests/parser-registry.test.ts, import inferDocumentKind from packages/indexer/src/languages and assert that inferDocumentKind("src/main/java/User.java") returns a code document with language "java" and extension ".java".
- [ ] Keep this task’s red test focused on language inference so Task 1 has no grammar dependency. Add the parser-registry dispatch assertion in Task 2 after javaConfig exists.
- [ ] In tests/scanner.test.ts, add src/main/java/com/acme/User.java to the fixture and target/classes/Ignored.java; assert the first file is returned and the second is excluded by the existing target ignore rule.
- [ ] Run:

```bash
bun test tests/parser-registry.test.ts tests/scanner.test.ts
```

- [ ] Confirm the new assertions fail because .java is not in codeExtensions; do not weaken the assertions.

### Step 2: Implement the minimal registration

- [ ] Add { extensions: [".java"], language: "java" } to codeExtensions in packages/indexer/src/languages.ts, next to the other code-language entries.
- [ ] Do not edit scanner include patterns or native scanner code. scanner.ts derives its allowed extension set from codeExtensions, and the default target exclusion already covers Java build output.

### Step 3: Verify and commit

- [ ] Re-run:

```bash
bun test tests/parser-registry.test.ts tests/scanner.test.ts
pnpm exec prettier --check packages/indexer/src/languages.ts tests/parser-registry.test.ts tests/scanner.test.ts
```

- [ ] Commit only this task’s changes:

```bash
git add packages/indexer/src/languages.ts tests/parser-registry.test.ts tests/scanner.test.ts
git commit -m "feat(indexer): register java source files"
```

## Task 2: Add the Java grammar and Tree-sitter AST configuration

**Files:**

- Modify packages/indexer/package.json and pnpm-lock.yaml.
- Modify packages/indexer/src/tree-sitter/parse.ts:14-37,129-371.
- Modify packages/indexer/src/tree-sitter/configs.ts after the Ruby configuration.
- Modify packages/indexer/src/tree-sitter/index.ts:1-3.
- Modify packages/indexer/src/parsers/tree-sitter-parser.ts:1-95.
- Modify tests/parser-registry.test.ts for final Java parser dispatch.
- Modify tests/tree-sitter-parser.test.ts for Java symbols, imports, calls, chunks, and malformed input.

### Step 1: Add the Java parser contract tests first

- [ ] Import javaConfig in tests/tree-sitter-parser.test.ts.
- [ ] Add a Java fixture containing all supported constructs. Use this exact source so line ranges and symbol names remain deterministic:

```java
package com.acme.service;

import java.util.List;
import com.acme.model.User;
import static com.acme.util.Names.normalize;
import com.acme.wildcard.*;

public class UserService {
  private final UserRepository repository;
  protected int version, retries;

  public UserService(UserRepository repository) {
    this.repository = repository;
  }

  public User find(String id) {
    // normalize("comment") must not become a call.
    String sample = "orElseThrow()";
    return repository.findById(normalize(id)).orElseThrow();
  }

  private void hidden() {}

  public void save(String value) {}
  public void save(int value) {}
}

interface Factory {
  int MAX = 1;
  User create();
}

enum Status { READY }

record UserDto(String id) {
  UserDto { }
}

@interface Audited {
  String value();
}
```

- [ ] Call parseWithTreeSitter(javaConfig, fixture), assert the result is non-null, assert chunks exist, and assert importPaths contain java.util.List, com.acme.model.User, static com.acme.util.Names.normalize, and com.acme.wildcard.\*.
- [ ] Assert the defined symbol set contains these canonical names and types:

| Symbol name                | Expected type | Expected visibility                                  |
| -------------------------- | ------------- | ---------------------------------------------------- |
| UserService                | class         | exported                                             |
| UserService::repository    | field         | not exported                                         |
| UserService::version       | field         | exported                                             |
| UserService::retries       | field         | exported                                             |
| UserService::<constructor> | constructor   | exported                                             |
| UserService::find          | method        | exported                                             |
| UserService::hidden        | method        | not exported                                         |
| UserService::save          | method        | exported, two declarations with the same stable name |
| Factory                    | interface     | not exported                                         |
| Factory::MAX               | field         | not exported                                         |
| Factory::create            | method        | not exported                                         |
| Status                     | enum          | not exported                                         |
| UserDto                    | record        | not exported                                         |
| UserDto::<constructor>     | constructor   | not exported                                         |
| Audited                    | annotation    | not exported                                         |

- [ ] Assert UserService::find has the expected one-based startLine/endLine, and its chunk metadata contains language "java", symbolName "UserService::find", and symbolType "method".
- [ ] Assert result.callExpressions contains calls from UserService::find to findById, normalize, and orElseThrow, and does not contain comment or sample-string pseudo-calls.
- [ ] Add a malformed-source test using "public class Broken { public void run( {"; assert parsing does not throw and returns either partial symbols/chunks or a raw fallback result.
- [ ] Run the Java parser tests before implementation:

```bash
bun test tests/tree-sitter-parser.test.ts
```

- [ ] Confirm they fail because the Java config/export/dependency do not exist yet.

### Step 2: Add the pinned grammar dependency

- [ ] Add tree-sitter-java to packages/indexer/package.json at ^0.23.5.
- [ ] Update the lockfile through pnpm, not by hand:

```bash
pnpm --filter @openez-graph/indexer add tree-sitter-java@^0.23.5
```

- [ ] Confirm the package appears once in packages/indexer/package.json and the lockfile resolves the same version.

### Step 3: Extend the shared walker for Java multi-declarator fields

- [ ] Add this optional callback to SymbolRule in packages/indexer/src/tree-sitter/parse.ts:

```typescript
extractNames?: (node: Node) => string[];
```

- [ ] Add a small private helper that returns extractNames(node) when present, otherwise returns the existing single-name result from extractName(node) or getNodeName(node, nameField).
- [ ] Change the symbol-rule branch in walkTree to iterate over the returned names and emit one ExtractedSymbol per name. Preserve the existing context/full-name logic for each emitted symbol.
- [ ] For Java field rules, do not push a context frame. For type/method/constructor rules, preserve the current one-frame context behavior.
- [ ] Preserve the existing call-extraction behavior for all single-name rules, including Ruby assignment/lambda symbols. Skip call extraction only for rules using extractNames; in this plan those are Java field/constant rules, which are non-callable multi-name declarations and must not be scanned once per declarator.
- [ ] Update nested-symbol discovery inside extractCallsInNode to use the same multi-name helper so the new walker contract is consistent for nested Java declarations.
- [ ] Keep all existing Python, Go, Rust, and Ruby behavior unchanged; their rules continue to use the single-name path.

### Step 4: Implement javaConfig

- [ ] Add Java-specific helpers in packages/indexer/src/tree-sitter/configs.ts:
  - isJavaExported(name, node): true only when declaration text contains a public or protected modifier; package-private and private are false.
  - extractJavaConstructorName(node): read the constructor declarator/name field and return the stable string "<constructor>" so UserService constructors become UserService::<constructor>.
  - extractJavaFieldNames(node): inspect variable_declarator children and return each declarator identifier/name text. Support int version, retries; do not descend into local variable declarations.
  - extractJavaImports(node): read import declaration text, trim whitespace, remove import and the trailing semicolon, and preserve static and .\* markers for the resolver.
  - normalizeJavaCallName(value): strip a receiver/path by taking the final identifier, so repository.findById becomes findById; retain the existing call walker ignore filtering.
- [ ] Define javaConfig with these exact symbol rules:

| Tree-sitter node                | Type        | Name/context behavior                          |
| ------------------------------- | ----------- | ---------------------------------------------- |
| class_declaration               | class       | name, establishes context                      |
| interface_declaration           | interface   | name, establishes context                      |
| enum_declaration                | enum        | name, establishes context                      |
| record_declaration              | record      | name, establishes context                      |
| annotation_type_declaration     | annotation  | name, establishes context                      |
| method_declaration              | method      | name, establishes context                      |
| constructor_declaration         | constructor | custom <constructor> name, establishes context |
| compact_constructor_declaration | constructor | custom <constructor> name, establishes context |
| field_declaration               | field       | extractNames, no context                       |
| constant_declaration            | field       | extractNames, no context                       |

- [ ] Configure importRules with import_declaration and the import helper.
- [ ] Configure calls with callRule: { nodeType: "method_invocation", functionField: "name" } and the Java normalizer. Do not add object-creation or method-reference call rules in v1.
- [ ] Use a small Java keyword/control/builtin ignore set only where the grammar can surface those names as invocation-like identifiers; do not add framework names or a long language model.
- [ ] Set contextNodeTypes to the type declaration node types that establish nested names and contextNameField to "name".
- [ ] Add a nearby comment documenting the deliberate ceiling: overloads and receiver types are unresolved; a future type-aware resolver can replace the method-name heuristic.

### Step 5: Register/export Java in the parser path

- [ ] Export javaConfig from packages/indexer/src/tree-sitter/index.ts.
- [ ] Import it and add java: javaConfig to LANGUAGE_CONFIGS in packages/indexer/src/parsers/tree-sitter-parser.ts.
- [ ] Update parser comments to include Java and state that Java has no language-specific regex parser.
- [ ] Add the final getParserForPath("src/main/java/User.java") === TreeSitterParser assertion to tests/parser-registry.test.ts.
- [ ] Run:

```bash
bun test tests/parser-registry.test.ts tests/tree-sitter-parser.test.ts
pnpm typecheck
pnpm exec prettier --check packages/indexer/src/tree-sitter/parse.ts packages/indexer/src/tree-sitter/configs.ts packages/indexer/src/tree-sitter/index.ts packages/indexer/src/parsers/tree-sitter-parser.ts tests/parser-registry.test.ts tests/tree-sitter-parser.test.ts
```

- [ ] Fix only grammar/config/walker issues exposed by these tests. Do not add a native Java implementation as a workaround.
- [ ] Commit:

```bash
git add packages/indexer/package.json pnpm-lock.yaml packages/indexer/src/tree-sitter/parse.ts packages/indexer/src/tree-sitter/configs.ts packages/indexer/src/tree-sitter/index.ts packages/indexer/src/parsers/tree-sitter-parser.ts tests/parser-registry.test.ts tests/tree-sitter-parser.test.ts
git commit -m "feat(indexer): parse generic java with tree-sitter"
```

## Task 3: Make missing Java grammar fallback safe and invalidate stale parser cache

**Files:**

- Modify packages/indexer/src/parsers/tree-sitter-parser.ts:20-95.
- Modify packages/indexer/src/index-workspace.ts:42-124.
- Modify tests/tree-sitter-parser.test.ts with generic fallback behavior.
- Update any existing test that asserts the old fallback-v1 cache version.

### Step 1: Add the failing fallback contract test

- [ ] Add a test that directly invokes new TreeSitterParser().parse(...) with an unknown code language and a small source body, then asserts:

```typescript
expect(result.parser).toBe("fallback");
expect(result.chunks).toHaveLength(1);
expect(result.chunks[0]?.content).toContain("class Broken {}");
expect(result.definedSymbols).toEqual([]);
expect(result.importPaths).toEqual([]);
expect(result.callExpressions).toEqual([]);
```

- [ ] Run bun test tests/tree-sitter-parser.test.ts and confirm the current implementation fails because the unknown-language fallback returns zero chunks.

### Step 2: Implement one shared raw fallback result

- [ ] Change REGEX_FALLBACKS from a required Record<string, ...> to an optional/partial registry so Java can intentionally have no regex parser.
- [ ] Add a private helper in tree-sitter-parser.ts that calls the existing makeFallbackChunks(input.content, input.content.split("\\n"), counter) and fills the existing empty arrays for imports, symbols, identifiers, and calls.
- [ ] In parse, use the language-specific regex fallback when one exists; otherwise use the generic raw-chunk helper. Keep parser: "regex" for an existing language-specific fallback and use parser: "fallback" for the generic path.
- [ ] In regexFallback, use the same helper for unknown languages instead of returning an empty chunk list.
- [ ] Ensure tsResult === null for Java follows the generic raw-chunk path without throwing or dereferencing an absent fallback function.

### Step 3: Bump parser cache version

- [ ] Change PARSER_VERSION_FALLBACK in index-workspace.ts from fallback-v1 to fallback-v2.
- [ ] Update nearby comments that mention the version so they describe the new tag.
- [ ] Leave PARSER_VERSION_NATIVE and PARSER_VERSION_OXC unchanged.
- [ ] Verify parserVersionFor("tree-sitter"), parserVersionFor("regex"), and parserVersionFor("fallback") all map to fallback-v2; keep the helper private unless an existing test needs a black-box cache assertion.
- [ ] If existing cache tests inspect the literal version, update only their expected value and add a regression assertion that a prior fallback-v1 row is reparsed rather than reused.

### Step 4: Verify and commit

- [ ] Run:

```bash
bun test tests/tree-sitter-parser.test.ts tests/parsed-documents-cache.test.ts
pnpm typecheck
```

- [ ] Commit:

```bash
git add packages/indexer/src/parsers/tree-sitter-parser.ts packages/indexer/src/index-workspace.ts tests/tree-sitter-parser.test.ts tests/parsed-documents-cache.test.ts
git commit -m "fix(indexer): provide safe tree-sitter fallback chunks"
```

## Task 4: Resolve unique local Java imports

**Files:**

- Modify packages/indexer/src/index-workspace.ts:26-40,130-239.
- Modify tests/index-workspace.test.ts to cover the exported file resolver.

### Step 1: Add resolver tests

- [ ] Import createWorkspaceFileResolver from packages/indexer/src/index-workspace.
- [ ] Build a resolver with these known relative paths:

```text
src/main/java/com/acme/model/User.java
src/main/java/com/acme/util/Util.java
modules/legacy/src/main/java/com/acme/model/User.java
```

- [ ] Assert unique class resolution, static-member-to-class resolution, wildcard rejection, external/missing rejection, and ambiguity rejection:

```typescript
expect(resolver.resolveImport("Service.java", "com.acme.util.Util", "java")).toBe(
  "src/main/java/com/acme/util/Util.java",
);
expect(resolver.resolveImport("Service.java", "com.acme.util.Util.run", "java")).toBe(
  "src/main/java/com/acme/util/Util.java",
);
expect(resolver.resolveImport("Service.java", "com.acme.model.User", "java")).toBeNull();
expect(resolver.resolveImport("Service.java", "com.acme.util.*", "java")).toBeNull();
expect(resolver.resolveImport("Service.java", "java.util.List", "java")).toBeNull();
```

- [ ] Add a separate unique-User resolver fixture or remove the legacy duplicate for the positive com.acme.model.User assertion. The test must prove both unique resolution and ambiguous rejection, not accidentally pass because the fixture is inconsistent.
- [ ] Run bun test tests/index-workspace.test.ts and confirm the Java branch fails before implementation.

### Step 2: Add Java to resolver candidates

- [ ] Add .java to RESOLVABLE_SOURCE_EXTENSIONS in index-workspace.ts. Do not add .class, generated output, or dependency artifacts.
- [ ] Add a local resolveJavaImport(importPath) helper inside createWorkspaceFileResolver, reusing knownRelativePaths and normalizeRelativePath.
- [ ] Normalize the import by trimming, stripping the leading static marker, and removing a trailing semicolon if present.
- [ ] Return null immediately for a normalized wildcard ending in .\*.
- [ ] Split the remaining qualified name on dots and try candidate class paths from the longest suffix to the shortest. For each suffix, form a slash-separated path ending in .java and match either an exact known relative path or a known path ending in /candidate.
- [ ] Return the path only when exactly one known file matches. Return null when a candidate has multiple matches; do not continue to another suffix because that would hide an ambiguity.
- [ ] Add a ponytail: comment naming the deliberate O(number of known files × import segments) suffix scan and upgrade path: pre-indexed package/class map when workspace scale or build-model integration justifies it.
- [ ] Branch on language === "java" before the existing generic relative-import fallback. Preserve Python, Ruby, and relative TypeScript behavior unchanged.

### Step 3: Verify and commit

- [ ] Run:

```bash
bun test tests/index-workspace.test.ts
pnpm typecheck
```

- [ ] Commit:

```bash
git add packages/indexer/src/index-workspace.ts tests/index-workspace.test.ts
git commit -m "feat(indexer): resolve unique local java imports"
```

## Task 5: Prove end-to-end Java indexing, graph edges, retrieval, and incremental idempotence

**Files:**

- Modify tests/index-workspace.test.ts only; production graph code should remain generic.

### Step 1: Add an end-to-end Java fixture test

- [ ] Add a test under the existing describe("indexWorkspace") using the existing temporary registry/workspace setup and EMBEDDING_PROVIDER=none.
- [ ] Write these two files into the temporary workspace:

```text
src/main/java/com/acme/model/User.java
src/main/java/com/acme/service/UserService.java
```

- [ ] Use source where UserService.java imports com.acme.model.User, declares public class UserService, and contains public User find(User user) { return user; }. Keep the source syntactically valid without requiring a JDK or compiling the project.
- [ ] Run indexWorkspace({ workspaceId }), then ensureGraphReady(workspace.id).
- [ ] Assert through existing repository APIs/raw queries that both Java files have indexed documents with language "java"; UserService and UserService::find have symbol nodes and defines edges; the service file has exactly one imports edge to the model file; and Java chunks retain symbol name/type and line metadata.
- [ ] Call codeContext({ workspaceId, symbolOrPath: "UserService::find", hops: 1 }) and assert the returned symbol/source context contains the Java method body and the available file relationship. This proves existing retrieval consumes Java chunks without a Java-specific MCP change.

### Step 2: Prove incremental idempotence

- [ ] Run indexWorkspace a second time without changing either file and rebuild graph state.
- [ ] Assert the service-to-model imports edge count is still exactly one and the defines edge count for UserService::find is still exactly one.
- [ ] Change only the body of UserService.find, re-index, and assert the same edge counts. This covers stale parsed-document replacement and graph edge rebuilding for Java.
- [ ] Do not assert a Java call edge for user.id() or new User(); the approved v1 design intentionally leaves receiver/type/constructor dispatch heuristic and unresolved when no unique graph target exists. Parser-level method invocation extraction is covered in Task 2.

### Step 3: Verify and commit

- [ ] Run:

```bash
bun test tests/index-workspace.test.ts tests/tree-sitter-parser.test.ts tests/parser-registry.test.ts tests/scanner.test.ts
```

- [ ] Commit:

```bash
git add tests/index-workspace.test.ts
git commit -m "test(indexer): cover java indexing and graph integration"
```

## Task 6: Document Java support in existing language tables

**Files:**

- Modify README.md:37,129-130.
- Modify apps/cli/README.md:12,17,129-139.
- Modify documents/PROJECT_OPERATIONS.md in the existing language-support section.

### Step 1: Update the public support tables

- [ ] Add Java to the top-level README language list/table as: Java — Tree-sitter WASM, generic AST symbols/imports/calls, best-effort local imports.
- [ ] Add Java to apps/cli/README.md using the same wording and make clear that no JDK/build-tool setup is required for indexing.
- [ ] Add Java to documents/PROJECT_OPERATIONS.md and state that target/build output is excluded by the existing scanner patterns.
- [ ] Do not advertise compiler semantics, Maven/Gradle dependency resolution, exact overload dispatch, JAR indexing, or native Java parsing.
- [ ] Do not update CHANGELOG.md; this is not a release request.

### Step 2: Verify documentation formatting and commit

- [ ] Run:

```bash
pnpm exec prettier --check README.md apps/cli/README.md documents/PROJECT_OPERATIONS.md
```

- [ ] Commit:

```bash
git add README.md apps/cli/README.md documents/PROJECT_OPERATIONS.md
git commit -m "docs: document generic java indexing support"
```

## Task 7: Full verification and handoff

### Step 1: Run all automated checks

- [ ] From the repository root, run:

```bash
pnpm typecheck
bun test
pnpm format:check
```

- [ ] If pnpm format:check is not a root script, run the repository’s existing Prettier check command shown in package.json; do not introduce a new formatting script for this feature.
- [ ] Confirm existing Python, Go, Rust, Ruby, TypeScript, configuration, Markdown, graph, cache, and scanner tests remain green.

### Step 2: Run a CLI smoke test without a JDK

- [ ] Create a temporary workspace containing one Java file under src/main/java/com/acme/Hello.java, with a package declaration, a public class, and one public method.
- [ ] Run the existing CLI init/status flow against that temporary workspace using the repository’s normal build or development command. Do not install or invoke Java, Maven, or Gradle.
- [ ] Confirm initialization/indexing succeeds, status reports the Java file, and the generated index contains Java chunks. Remove only the temporary workspace after the check.

### Step 3: Inspect the final diff

- [ ] Run:

```bash
git diff 9521a49..HEAD --stat
git diff 9521a49..HEAD --check
git status --short
```

- [ ] Confirm no changes exist under packages/native, no schema migration was added, no C# files/configuration were added, and no generated .openez/workspace.json is staged.
- [ ] Confirm the final implementation has one bounded raw fallback, one Java config, one resolver branch, and no Java-specific abstraction that duplicates existing parser/graph code.
- [ ] After all checks pass, invoke the repository review/verification workflow before reporting completion.

## Acceptance Checklist

- [ ] .java is inferred as language "java", scanned by default, and target/.class output is excluded.
- [ ] getParserForPath("src/main/java/User.java") selects TreeSitterParser.
- [ ] Tree-sitter extracts class, interface, enum, record, annotation, constructor, method, field, multi-declarator field, and nested symbols with stable names and visibility flags.
- [ ] Package declarations provide syntax context but are not persisted as symbols or a new schema field.
- [ ] Regular, static, and wildcard imports are retained in parsed content; only unique local targets create import edges.
- [ ] Missing and ambiguous imports do not create unsafe graph edges.
- [ ] Method invocations are extracted from AST nodes, while comments and strings produce no false calls.
- [ ] Java chunks flow through existing FTS, code_outline, and code_context behavior.
- [ ] Re-indexing does not duplicate Java graph edges.
- [ ] fallback-v2 invalidates stale non-native parser cache rows.
- [ ] Missing/unusable Java grammar produces a bounded searchable raw chunk and does not abort indexing.
- [ ] No JDK, Maven, Gradle, native parser, SQLite migration, CLI flag, or MCP contract change is required.
- [ ] Full typecheck, tests, and formatting checks pass.
