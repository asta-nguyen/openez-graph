# Ruby + CoffeeScript/Slim/CSS/SCSS Indexing Design

## Goal

Extend the OpenEZ indexer to handle a Ruby/CoffeeScript/Slim/CSS/SCSS-heavy codebase
(currently ~78% of files are skipped by the scanner). Ruby gets full tree-sitter AST
symbol extraction via `web-tree-sitter` + `tree-sitter-ruby` WASM grammar, matching the
existing Python/Go/Rust path. The four remaining languages get scanner-level inclusion
and fall through to the existing `FallbackParser` for FTS/embedding-only indexing.

## Scope

- Add `tree-sitter-ruby@^0.23.1` dependency (ships `tree-sitter-ruby.wasm`).
- Register `.rb`, `.rake`, `.gemspec` as `ruby` in `codeExtensions`.
- Add `rubyConfig` to `packages/indexer/src/tree-sitter/configs.ts`.
- Add `parseRuby` regex fallback to `packages/indexer/src/languages.ts`.
- Register Ruby in `TreeSitterParser` (`LANGUAGE_CONFIGS` + `REGEX_FALLBACKS`).
- Add Ruby branch to `createWorkspaceFileResolver.resolveImport`.
- Add `.rb` to `RESOLVABLE_SOURCE_EXTENSIONS`.
- Add scanner support for `.coffee`, `.litcoffee`, `.css`, `.scss`, `.sass`, `.less`,
  `.slim`, `.haml` via new extension maps; these fall through to `FallbackParser`.
- Extend `SymbolRule` with `contextOnly?: boolean` and change `extractContextName`
  signature to `(node, contextStack) => string | null`.
- Tests covering Ruby AST parsing, regex fallback, parser dispatch, scanner inclusion,
  and end-to-end indexing with import edges.

## Non-goals

- Native `tree-sitter-ruby` addon path (peer-dep `tree-sitter`). WASM only, matching
  the existing Python/Go/Rust pattern.
- Symbol extraction for CoffeeScript/Slim/CSS/SCSS. These use `FallbackParser`
  (single chunk, FTS/embedding only). Adding grammars for them is a separate spec.
- Tracking gem `require` paths in the graph. They do not resolve to local files.
- `load` / `autoload` graph edges. Their resolution semantics are ambiguous relative
  to the current file; only `require_relative` produces import edges.
- `.coffee.md` compound extension. `path.extname()` returns `.md`, which would route
  to MarkdownParser. Excluded from this spec; `.coffee` and `.litcoffee` are included.

## Design

### Ruby: dependency and extension registration

`packages/indexer/package.json` — add:

```json
"tree-sitter-ruby": "^0.23.1"
```

`packages/indexer/src/languages.ts` — extend `codeExtensions`:

```ts
[".rb", "ruby"],
[".rake", "ruby"],
[".gemspec", "ruby"],
```

`packages/indexer/src/index-workspace.ts` — add `.rb` to
`RESOLVABLE_SOURCE_EXTENSIONS` so the graph resolver attempts `.rb` suffix
resolution for `require_relative` targets.

### Ruby: `rubyConfig` in `tree-sitter/configs.ts`

Based on `tree-sitter-ruby` node-types.json (verified fields):

| nodeType           | symbolType | nameField | establishesContext | contextOnly | isExported             |
| ------------------ | ---------- | --------- | ------------------ | ----------- | ---------------------- |
| `class`            | `class`    | `name`    | yes                | no          | uppercase first letter |
| `module`           | `module`   | `name`    | yes                | no          | uppercase first letter |
| `method`           | `function` | `name`    | yes                | no          | false                  |
| `singleton_method` | `function` | `name`    | yes                | no          | false                  |
| `singleton_class`  | `class`    | (unused)  | yes                | **yes**     | false                  |

**Nesting**: `class`/`module` push context. A `method` inside `class User` becomes
`User::greet`. A `singleton_method` `def self.admin?` inside `class User` becomes
`User::admin?` (qualified by the enclosing class/module context name, not by parsing
the `self` receiver — `self` always refers to the enclosing type context).

**Singleton class (`class << self`)**: `contextOnly: true`. The walker pushes a
context frame but does not emit a symbol node and does not call
`extractCallsInNode`. `extractContextName` receives the walker's `contextStack` and
walks it backwards for the nearest frame with `kind: "class" | "module"`, so
methods defined inside `class << self` nest under the parent class (e.g.
`User::bulk_create`) rather than under a pseudo-symbol like `<Class::User>`. If
there is no enclosing class/module frame (top-level `class << self` on a singleton
object), `extractContextName` returns `null` and the context frame is skipped —
methods inside fall back to unqualified names.

This requires the context frame to carry a `kind` discriminator (see
`SymbolRule` and context frame changes below). Without `kind`, a `class << self`
nested inside a method would pick up the method frame (`User::my_method`) as the
enclosing context, producing wrong names like `User::my_method::bulk_create`.

**Lambda / proc with name**: extracted only when assigned to a named variable. The
rule targets `assignment` nodes whose `right` field is a `lambda` node or a `call`
to `proc` / `lambda` / `Proc.new`. The symbol name is the left-hand identifier;
`symbolType` is `lambda`. Anonymous inline blocks (`x.map { }`, `do...end` without
assignment) are not extracted — they have no stable name and would create graph
noise. This rule does not establish context. Calls inside the lambda body are
attributed to the lambda variable name via `extractCallsInNode` — this is an
approximation (the enclosing scope may also call into the RHS before the lambda
captures it), but acceptable for heuristic call-edge tracking. The rule's
`extractName` returns `null` for non-lambda assignments, so regular assignments
are unaffected.

**Imports**: `extractRubyImports` inspects `call` nodes:

- `require_relative "foo/bar"` → push `"foo/bar"` into `importPaths`.
- `require "rails"` (gem) → do not push. No local resolution possible.
- `load "foo.rb"` → do not push. Resolution semantics relative to `$LOAD_PATH`,
  not the current file; producing graph edges would be incorrect.
- `autoload :User, "user"` → do not push. Same reasoning as `load`.

Only `require_relative` paths reach `importPaths` and thus the graph resolver.

**Calls**: `callRule` is `{ nodeType: "call", functionField: "method" }`. The `method`
field holds the callee identifier or operator.

`callIgnores` (Ruby keywords + common builtins — illustrative, refined during implementation):

```
if, unless, while, until, for, return, yield, break, next, redo, retry,
puts, pp, p, print, raise, require, require_relative, load, autoload,
attr_accessor, attr_reader, attr_writer, include, extend, define_method,
lambda, proc, super, self, nil, true, false, new, Array, Hash, String,
Integer, Float, Symbol
```

`normalizeCallName`: split on `.` and `::`, return the last segment.
`User.greet` → `greet`. `ActiveSupport::Concern` → `Concern`.

**Receiver qualification for `self`**: when a `call` node's receiver text is `self`
and the active context stack has a receiver-less type context (class/module), the
callee is qualified as `TypeName::methodName`. Calls through instance variables
(`@user.save`) or local variables (`user.save`) are not qualified — the type is
unknown statically.

This requires a new hook because `extractCallsInNode` currently only qualifies
callees via Go-style `receiverInfo` (varName + typeName matched against the
callee prefix). Ruby's `self.foo` does not match that pattern — `self` is not a
receiver variable with a known type, it refers to the enclosing type context.
The `call` node exposes a `receiver` field (verified in node-types.json:
`field receiver: ['_primary']`). The hook reads `callNode.childForFieldName("receiver")`,
checks `text === "self"`, and if so walks the context stack backwards for the
nearest frame with `kind: "class" | "module"` (see context frame change below),
then qualifies the callee as `${contextName}::${normalized}`.

`LanguageConfig` gains an optional `qualifyCall` hook:

```ts
export interface LanguageConfig {
  // ...existing fields...
  /**
   * Optional hook to qualify a callee name based on the call node's receiver
   * and the active context stack. Returns the qualified callee, or null to
   * keep the normalized name unqualified. Used for Ruby `self.foo` →
   * `TypeName::foo`. Go receiver qualification stays in extractCallsInNode
   * via receiverInfo and is unaffected.
   */
  qualifyCall?: (
    callNode: Node,
    calleeName: string,
    normalized: string,
    contextStack: ReadonlyArray<ContextFrame>,
  ) => string | null;
}
```

`extractCallsInNode` calls `config.qualifyCall?.(callNode, calleeName, normalized, contextStack)`
after the existing Go `receiverInfo` qualification. If the hook returns non-null,
that value overrides `qualifiedCallee`. The hook receives a readonly snapshot of
the walker's context stack. Go/Python/Rust configs do not set `qualifyCall`, so
their behavior is unchanged.

Test assertion: in `class User; def foo; self.bar; end; end`, the call edge is
`User::foo → User::bar`, not `User::foo → bar`.

### Ruby: `SymbolRule`, `ContextFrame`, and `extractContextName` signature changes

`packages/indexer/src/tree-sitter/parse.ts`:

```ts
/**
 * Discriminator for context frames. Lets context-only rules (singleton_class)
 * and qualifyCall hooks walk the stack backwards for the nearest class/module
 * frame, skipping method frames that may sit between.
 */
export type ContextKind = "class" | "module" | "method" | "singleton_class" | "lambda";

export interface ContextFrame {
  name: string;
  endRow: number;
  kind: ContextKind;
  receiver?: { varName: string; typeName: string };
}

export interface SymbolRule {
  // ...existing fields...
  /** Push context stack without emitting a symbol or extracting calls. */
  contextOnly?: boolean;
  /** Context kind for this rule's frames. Defaults to the symbolType. */
  contextKind?: ContextKind;
  /**
   * Override context name for nesting. Receives the walker's current context
   * stack so context-only rules can derive their name from the enclosing scope
   * (e.g. singleton_class walks back for the nearest class/module frame).
   * Defaults to the symbol name.
   */
  extractContextName?: (node: Node, contextStack: ReadonlyArray<ContextFrame>) => string | null;
}
```

The existing `contextStack` array in `walkTree` changes from
`Array<{ name: string; endRow: number; receiver?: ... }>` to
`Array<ContextFrame>`. Every push site sets `kind`:

- `class` rule → `kind: "class"`
- `module` rule → `kind: "module"`
- `method` / `singleton_method` rule → `kind: "method"`
- `singleton_class` rule (context-only) → `kind: "singleton_class"`
- named lambda rule → `kind: "lambda"`

Go/Python/Rust configs do not set `contextKind`, so their frames default to
`symbolType` (e.g. Go `function_declaration` → `kind: "function"`). The
`ContextKind` union is open enough to admit those without conflict; existing
code that reads `contextStack[i].name` / `.endRow` / `.receiver` is unaffected
because those fields keep the same shape.

`walkTree` changes:

- When `symbolRule.contextOnly` is true: skip symbol emission and
  `extractCallsInNode`. If `extractContextName` returns a non-null name, push a
  context frame with that name, `kind: symbolRule.contextKind ?? "singleton_class"`,
  and the node's `endRow`. If it returns null, do not push (the block is treated
  as top-level for nested symbols).
- Pass the current `contextStack` (as a readonly snapshot) to `extractContextName`.
- Pass the current `contextStack` (readonly snapshot) to `config.qualifyCall` when
  set (see receiver qualification above).

The existing Rust `impl_item` rule uses `extractContextName(node)` to read the
`type` field. It is updated to `extractContextName(node, _contextStack)` —
behavior unchanged because it ignores the second argument.

### Ruby: regex fallback `parseRuby` in `languages.ts`

~120 lines, same structure as `parsePython` / `parseGo`:

- `stripNonCode(content, { hashComments: true })`. The existing helper (verified
  at `packages/indexer/src/languages.ts:95-126`) already strips single and double
  quote strings by default (lines 122-124), and `hashComments: true` switches
  comment stripping from `//` + `/* */` to `#`. No heredoc handling, no
  `%w[]`/`%i[]` literal handling, no deep `end`-keyword matching — the fallback
  is intentionally minimal.
- Symbol regex (top-level + nested via indent stack):
  `/^\s*(?:def\s+(?:self\.)?(\w+[?!]?)|class\s+(\w+(?:::\w+)*)|module\s+(\w+(?:::\w+)*))/`
  — only `class`, `module`, `def`, `def self.`. No lambda, no block, no
  `singleton_class`.
- Block end: count `end` at the same indent level as the opening `def`/`class`/
  `module` line. No `do`/`if`/`begin`/`case` tracking — fallback precision is
  best-effort; the WASM AST is the source of truth.
- Import regex: `/\brequire_relative\s+['"]([^'"]+)['"]/g` only. `require`, `load`,
  `autoload` are not extracted by the fallback.
- Call regex: `/(\w+(?:::\w+)*(?:\.\w+)*)\s*\(/g`. No `self.` qualification in
  fallback (the WASM path handles that).
- `RUBY_CALL_IGNORES` set mirrors the AST config's `callIgnores`.

The fallback exists so indexing does not crash when the WASM grammar fails to load.
It produces coarse symbols and calls; the AST path is the primary one.

### Ruby: parser registration

`packages/indexer/src/parsers/tree-sitter-parser.ts`:

```ts
const LANGUAGE_CONFIGS = {
  python: pythonConfig,
  go: goConfig,
  rust: rustConfig,
  ruby: rubyConfig,
} as const;

const REGEX_FALLBACKS = {
  python: parsePython,
  go: parseGo,
  rust: parseRust,
  ruby: parseRuby,
};
```

No new parser class. `TreeSitterParser` is generic and already handles the
config + fallback dispatch.

### Ruby: import resolver

`packages/indexer/src/index-workspace.ts` — `createWorkspaceFileResolver`:

```ts
if (language === "ruby") {
  return resolveRelativeImport(importerRelativePath, importPath);
}
```

`require_relative "foo/bar"` resolves against the importing file's directory, with
`.rb` suffix appended via `RESOLVABLE_SOURCE_EXTENSIONS`. Gem `require` paths never
reach this branch (not in `importPaths`).

### CoffeeScript / Slim / CSS / SCSS: scanner inclusion

`packages/indexer/src/languages.ts` — new extension maps:

```ts
export const styleExtensions = new Map<string, string>([
  [".css", "css"],
  [".scss", "scss"],
  [".sass", "scss"],
  [".less", "less"],
]);

export const templateExtensions = new Map<string, string>([
  [".slim", "slim"],
  [".haml", "haml"],
]);

export const scriptExtensions = new Map<string, string>([
  [".coffee", "coffeescript"],
  [".litcoffee", "coffeescript"],
]);
```

`inferDocumentKind` check order: markdown → code (incl. Ruby) → style → template →
script → config → text. Style/template/script return `kind: "code"` with the
mapped language name.

`packages/indexer/src/scanner.ts` — `ALLOWED_EXTENSIONS` and
`DEFAULT_INCLUDE_PATTERNS` extended with all new extensions.

**Parser dispatch**: these languages have no entry in `LANGUAGE_CONFIGS`, so
`TreeSitterParser.canParse` returns false. `OxcParser` only matches TS/JS.
`MarkdownParser` only matches `.md`/`.mdx`. `ConfigParser` only matches yaml/json/
toml. They fall through to `FallbackParser`, which produces a single chunk covering
the whole file — enough for FTS and embedding retrieval, no symbol graph nodes.

### Testing

| File                                    | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/ruby-indexer.test.ts` (new)      | `parseRuby` regex fallback: class/module/def extraction, `def self.` qualification, `require_relative` imports, call extraction, nesting.                                                                                                                                                                                                                                                                                                                                                             |
| `tests/tree-sitter-parser.test.ts`      | New `describe("tree-sitter ruby parser")` block: `rubyConfig` via `parseWithTreeSitter` — class/module/method/singleton_method, `class << self` context-only (assert no `<Class::User>` symbol, methods nest under `User`), `class << self` nested inside a method (assert method walks back to class frame, not method frame), named lambda, `self.foo` call qualification (assert edge `User::foo → User::bar`), `require_relative` import. WASM load failure is the early signal for ABI mismatch. |
| `tests/parser-registry.test.ts`         | Assert `.rb` → `TreeSitterParser`, `.coffee`/`.scss`/`.slim`/`.css` → `FallbackParser`.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `tests/scanner.test.ts` (new or extend) | Scanner includes `.rb .coffee .litcoffee .scss .sass .less .css .slim .haml` files.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `tests/index-workspace.test.ts`         | E2E: index a fixture with `.rb` files; verify chunks, symbol nodes, and import edges (`require_relative` resolves, gem `require` produces no edge).                                                                                                                                                                                                                                                                                                                                                   |

**Fixtures**: `tests/fixtures/ruby/user.rb` (class + instance method + `def self.` +
`class << self` block), `tests/fixtures/ruby/helper.rb` (module +
`require_relative "./user"`), `tests/fixtures/styles/app.scss`,
`tests/fixtures/views/index.slim` (verify fallback chunking).

### Risk: WASM ABI compatibility

`tree-sitter-ruby@0.23.1` ships a WASM grammar built against a specific tree-sitter
ABI. `web-tree-sitter@0.26.11` is the version OpenEZ currently uses. If the ABI
mismatches, `Language.load()` throws and `parseContent` returns `null`, triggering
the regex fallback. The first `tree-sitter ruby parser` test will fail loudly if the
WASM does not load, making the mismatch obvious during implementation rather than at
runtime. Mitigation: if load fails, pin a compatible `tree-sitter-ruby` version or
upgrade `web-tree-sitter`. The regex fallback ensures indexing still works in the
degraded state.

## File change summary

| File                                                                            | Change                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/indexer/package.json`                                                 | Add `tree-sitter-ruby@^0.23.1` dependency.                                                                                                                                                                                                                                                                                                                                        |
| `packages/indexer/src/languages.ts`                                             | Add Ruby to `codeExtensions`; add `styleExtensions`, `templateExtensions`, `scriptExtensions`; add `parseRuby` regex fallback; update `inferDocumentKind`.                                                                                                                                                                                                                        |
| `packages/indexer/src/scanner.ts`                                               | Extend `ALLOWED_EXTENSIONS` and `DEFAULT_INCLUDE_PATTERNS` with new extensions.                                                                                                                                                                                                                                                                                                   |
| `packages/indexer/src/tree-sitter/configs.ts`                                   | Add `rubyConfig` with symbol/import/call rules.                                                                                                                                                                                                                                                                                                                                   |
| `packages/indexer/src/tree-sitter/parse.ts`                                     | Add `contextOnly`, `contextKind` to `SymbolRule`; add `ContextFrame`/`ContextKind` types; change `contextStack` shape to `ContextFrame[]`; change `extractContextName` signature to accept `contextStack`; add optional `qualifyCall` to `LanguageConfig`; update `walkTree` to handle `contextOnly` and call `qualifyCall`; update `extractCallsInNode` to invoke `qualifyCall`. |
| `packages/indexer/src/tree-sitter/index.ts`                                     | Export `rubyConfig`.                                                                                                                                                                                                                                                                                                                                                              |
| `packages/indexer/src/parsers/tree-sitter-parser.ts`                            | Register `ruby` in `LANGUAGE_CONFIGS` and `REGEX_FALLBACKS`.                                                                                                                                                                                                                                                                                                                      |
| `packages/indexer/src/index-workspace.ts`                                       | Add `.rb` to `RESOLVABLE_SOURCE_EXTENSIONS`; add Ruby branch in `resolveImport`.                                                                                                                                                                                                                                                                                                  |
| `tests/ruby-indexer.test.ts`                                                    | New test file for regex fallback.                                                                                                                                                                                                                                                                                                                                                 |
| `tests/tree-sitter-parser.test.ts`                                              | Add Ruby test block.                                                                                                                                                                                                                                                                                                                                                              |
| `tests/parser-registry.test.ts`                                                 | Add dispatch assertions for new extensions.                                                                                                                                                                                                                                                                                                                                       |
| `tests/scanner.test.ts`                                                         | New or extended: scanner includes new extensions.                                                                                                                                                                                                                                                                                                                                 |
| `tests/index-workspace.test.ts`                                                 | E2E Ruby indexing with import edges.                                                                                                                                                                                                                                                                                                                                              |
| `tests/fixtures/ruby/*.rb`, `tests/fixtures/styles/*`, `tests/fixtures/views/*` | Test fixtures.                                                                                                                                                                                                                                                                                                                                                                    |
