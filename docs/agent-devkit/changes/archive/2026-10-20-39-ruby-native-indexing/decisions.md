# Decisions — Ruby native indexing

## D1 — Constant receiver call names use `Scope::method` form

Constant receivers (`Invoice.build`, `Billing::Invoice.build`) normalize to the
qualified `Invoice::build` / `Billing::Invoice::build` label, matching the symbol
labels that `class`/`module` contexts already produce. This lets the resolver use
one lexical-scope walk for both `self.foo` and constant-receiver calls. Ordinary
receivers are removed from `callExpressions` entirely while their method name
still lands in `calledIdentifiers`, matching the established Go/TypeScript
receiver semantics. Rationale: a shared resolution vocabulary beats a second
call-name grammar; fixture `scope` and `reopen` encode the approved edges.

## D2 — Ruby call ignores extended to `public_send`, `respond_to`, `respond_to?`

Beyond the planned `send`/`method_missing`/`eval`/`const_get`, the ignore list
gains `public_send` (the safe `send` variant) and `respond_to`/`respond_to?`
(reflection queries, not calls worth graphing). Verified by fixture `negative`.

## D3 — Resolution is unique-only; duplicates are ambiguous

A bare or qualified call binds only when exactly one workspace symbol carries
the candidate label. Same-name methods in different reopened `class` bodies in
one file resolve; two files each defining `Re::render` do not. This mirrors the
Go/TypeScript "unique exported symbol" rule and keeps false positives at 0 in
fixture `duplabel`.

## D4 — Bare calls search the caller's own scope only, then top level

Bare `foo` tries the caller's own `class`/`module` label (cross-file reopens
included), then unique top-level `def foo`. It never walks enclosing
namespaces (`A::helper` is not tried from `A::B`). The "own" scope is the
caller's label itself when the caller is a class/module — calls sitting in a
class/module body are attributed to that symbol — else the caller method's
enclosing label; class/module callers are detected by an uppercase final
segment. No ancestor/inference for `self` beyond the lexical class/module —
documented limitation.

## D8 — Qualified callees resolve the constant's first segment lexically

For `A::B::m` the resolver probes the innermost lexical scope defining `A`
(the caller's own scope, then its parents, then top level), appends the
remaining `B::m`, and binds only to a unique method — a defined constant that
lacks the method produces no edge rather than falling through. A leading
`::` callee is absolute and skips the walk. Only `function` symbols are call
targets, so `foo()` never binds to a same-named lambda or constant
assignment. Added after review found the label-existence walk skipped
class/module-body callers and could fall through shadowing constants.

## D9 — `parseRuby` blanks `=begin`/`=end` blocks and the `__END__` trailer

The fallback regex parser previously scanned raw lines, so
`require_relative "x"` inside `#` comments (via `stripNonCode`, then matched
against the raw line), `=begin`/`=end` document blocks, `__END__` trailers,
and string literals could emit import paths the AST parsers never produce —
a native/fallback edge divergence. The loop now tracks `=begin`/`=end` and
stops at `__END__`, and the import regex is gated on the stripped line.
`require_relative "x.md"` as written also resolves nothing: the import
resolver only probes the literal path when it ends in `.rb`, else the
`.rb`-appended form.

## D5 — `require_relative` resolves literal `.rb` targets only

A same-stem `util.md` in the fixture does not capture `require_relative "util"`;
the file resolver probes `path` then `path.rb`, restricted to `.rb`. Other
`require`/`load`/`autoload` forms remain unimported (unchanged from baseline).

## D6 — Parser tags bumped `native-v4`/`fallback-v4` → `native-v5`/`fallback-v5`

Required because Task 5 changed emitted call names; stale rows reparse on graph
build. Verified via a seeded `fallback-v4` row end-to-end.

## D7 — Sibling-plan `keepQualifiedCallee`/`keep_qualified_calls` preserved

The in-flight Python/Rust plans added `keep_qualified_calls` to `LanguageConfig`
and related WASM branches. Ruby's edits integrate additively and leave those
fields untouched; remaining full-suite red (4 rust-plan tests) is sibling-owned,
verified by attributing each failure to untracked/modified sibling files.
