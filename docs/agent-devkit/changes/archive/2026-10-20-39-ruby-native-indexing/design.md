# Ruby native indexing and parity

Issue: #39

## Goal

Add Ruby to OpenEZ's optional Rust native parser with exact native/WASM parity for the existing behavior, then make Ruby call edges follow class and module scope instead of the first same-named symbol in the workspace.

## Current evidence

- Ruby has a tree-sitter WASM parser (npm `tree-sitter-ruby@^0.23.1`) and a regex fallback. Ruby is not in the native batch-language sets: `TS_LANGS` in `parseInline` and `NATIVE_LANGS` in `buildGraphGeneration` list Python, Go, and Rust only.
- The native walker cannot express what `rubyConfig` needs. Its `SymbolRule` and `LanguageConfig` have no context-only rule (the `class << self` singleton frame), no context kind (class or module), no call-qualify hook (`self.foo`), and its context-name callback does not see the context stack.
- Existing Ruby behavior: class << self context, `self.foo` call qualification, and `require_relative`-only import edges. Symbols carry their full nesting (`Billing::Invoice::total`), so an instance method and a singleton method with the same name share one label, and a reopened class shares labels across files.
- Ruby call normalization strips every receiver. In a sample file, `self.tax` becomes `Billing::Invoice::tax`, but `Invoice.build`, `Billing::Invoice.build`, `Helper.run`, and `other.tax` become `build`, `build`, `run`, and `tax`, indistinguishable from the bare call `helper_fn(1)`. Observed by running the WASM parser on the sample. A call with no parentheses or arguments is an identifier node, not a call, and is not recorded.
- The regex fallback records no call expressions.
- The shared relative-path resolver probes `.ts`, `.tsx`, `.js`, … `.md`, `.mdx`, `.py`, `.rb` in that order, so `require_relative "foo"` with `foo.md` beside `foo.rb` resolves to the markdown file.
- Call resolution falls back to a global first-match map, and its same-file lookup splits scopes on `.` while Ruby labels use `::`.
- Native/WASM parity fixtures currently cover Python, Go, and Rust only. The generic graph builder keeps at most 30 symbols and 20 calls per file.

## Scope

- Add the Ruby tree-sitter grammar to the optional native extension, pinned to the same upstream version as the WASM grammar, and extend the native walker with context-only rules, context kinds, and a call-qualify hook. Route `.rb`, `.rake`, and `.gemspec` files through the batch parser.
- First match the WASM parser's current Ruby symbols, exported flags, line ranges, `require_relative` imports, call expressions, and called identifiers exactly on the maintained fixture set, with no behavior change.
- Then keep constant receivers in call names (`Invoice.build`, `Billing::Invoice.build`) in the native, WASM, and regex parsers, and stop recording calls on any other receiver as bare names.
- Preserve `class << self` context-only behavior and `self.foo` qualification.
- Resolve unqualified calls within the caller's own class or module, then top-level methods; resolve `self.foo` and constant-receiver calls to a unique method of that class or module; resolve `require_relative` to `.rb` files only. Do not infer ordinary object receiver types, walk ancestors, or resolve gems.
- Remove the 30-symbol and 20-call graph caps for Ruby only, including both native parse-result slices.
- Keep native optional, preserve the existing fallback, and keep graph/schema/API shapes unchanged.

Do not add Ruby as a new product language; Ruby indexing already exists. This change adds native acceleration, parity, and scope-aware call edges for that language.

## Behavior

With a compatible native binary, Ruby source is parsed by the native batch path; when native is unavailable or disabled, the existing WASM/regex fallback remains usable. Native and WASM parser outputs match exactly for the required Ruby fixtures, including CRLF.

**Call names.** A call with no receiver keeps its method name. `self.foo` keeps its class-qualified form. A call whose receiver is a constant or scope resolution is recorded as `Const.foo` or `A::B.foo`. A call on any other receiver — a local, an instance variable, a call result, `&.` on a non-constant — is not recorded in `callExpressions`; its method name stays in `calledIdentifiers`. `new`, `require`, `include`, and the other names already ignored stay ignored.

**Resolution.** Labels are the full nesting path, so resolution is label based and counts only a unique match.

- A bare call `foo()` in a caller whose label is `A::B::m` resolves to `A::B::foo`, then to a top-level `foo`. It does not walk to enclosing namespaces (`A::foo`) or ancestors, because Ruby method lookup does not.
- `self.foo` resolves to the already-qualified label.
- A constant receiver resolves its first segment lexically, innermost nesting first: for a caller in `A::B`, `Const` is tried as `A::B::Const`, `A::Const`, then `Const`, and the first class or module that exists wins; remaining segments are appended. The call resolves to `<resolved>::foo` when exactly one method has that label in the workspace.
- A label shared by an instance method and a singleton method is one label; a label declared in more than one file is ambiguous and drops the call.
- Targets are methods. `Foo.new` and calls on inherited or mixed-in methods produce no edge.

**Imports.** Only `require_relative` with a literal string creates an imports edge. The path is relative to the requiring file and is probed as written and with `.rb` only. `require`, `load`, `autoload`, interpolated strings, and non-literal arguments create none.

**Graph limits.** Ruby symbols and calls are not truncated by the generic graph limits; non-Ruby languages retain their current limits. The cap decision and the call-resolver choice are separate per-language decisions, following the per-language branch the Go work landed: lifting the cap for Ruby must not route Ruby calls through the OXC module-binding resolver, the same-file lexical lookup, or the global first-match map.

**Versions.** Adding the grammar is a compile-time native dependency only; no Ruby runtime or RubyGems command is required. Native and fallback parser-version tags are bumped, incrementing from the value left by whichever indexing plan landed before this one (the Python and Rust plans share the tags), and again if the call-name step ships separately. A parser-version mismatch is checked during graph construction, while a completed graph can short-circuit after a no-op incremental index. Run `openez reindex <path>` after this change to rebuild old parsed rows and graph artifacts; a no-op `openez index <path>` is not sufficient. Shared tags may also refresh Python, Go, and Rust cache rows.

## CodeGraph reference

I inspected [colbymchenry/codegraph at commit `204315274e7902c713ba3ad61e8df511aa634b10`](https://github.com/colbymchenry/codegraph/tree/204315274e7902c713ba3ad61e8df511aa634b10). Its [Ruby extractor](https://github.com/colbymchenry/codegraph/blob/204315274e7902c713ba3ad61e8df511aa634b10/src/extraction/languages/ruby.ts) and [call-scope fixture](https://github.com/colbymchenry/codegraph/blob/204315274e7902c713ba3ad61e8df511aa634b10/__tests__/ruby-call-scope.test.ts) show inherited and mixed-in dispatch as a separate resolution tier: a bare call inside a class is a call on self, reaching the class's own methods, its superclasses', and mixed-in modules', while a call in a module body is left alone because a module runs on whatever includes it.

Further material read at the same commit and adopted:

- The [kernel parity test](https://github.com/colbymchenry/codegraph/blob/204315274e7902c713ba3ad61e8df511aa634b10/__tests__/kernel-ruby-parity.test.ts) compares the native walker with the WASM extractor over one torture fixture and a CRLF copy derived in memory. The fixture covers class-body DSL calls, mixins, module nesting, visibility, `require` and `require_relative` forms including `Kernel.require` and interpolated paths, `.new`, `&.` joins, bare-call statements, heredocs, `=begin` docstrings, and a `__END__` trailer. This plan's parity fixture list is widened to match.
- The bare-call rule: a bare name inside a class belongs to that class's methods before anything global, which is why the plan resolves the caller's own class first. Calls in a module body are not resolved to includers.

Deliberate differences. CodeGraph follows superclasses and `include`/`extend`/`prepend` for bare calls, records bare identifier statements as calls, and links an untyped `receiver.m()` to the lone project method `m` when the receiver is named after the owner. This plan does none of these: it keeps parity fixtures and edges focused on existing modules, singleton context, `self.foo`, and constant receivers, and adds no inherited or mixin dispatch, gem resolution, or CodeGraph native kernel/runtime.

## Edge cases

- `def self.build` and an instance method `build` share a label; the call resolves only if one declaration exists across the workspace.
- A call in a module body resolves only within that module and top level; it is not linked to a including class.
- `Invoice.build` inside `module Billing` resolves `Invoice` as `Billing::Invoice` first, then `Invoice`. A constant that matches no class or module drops the call.
- `Child.build` where `build` is defined only in the parent class produces no edge.
- `other.tax`, `@client.get`, and `user&.name` produce no call record and no edge.
- Calls with no parentheses and no arguments are not call nodes and produce no edge, as today.
- `require_relative "foo"` with both `foo.md` and `foo.rb` resolves to `foo.rb`; an interpolated path resolves to nothing.
- A lambda assigned to a name (`handler = lambda { … }`) stays a symbol as today; parity covers it.
- Dynamic calls (`send`, `public_send`, `method_missing`, `eval`, `const_get`) produce no edge.
- When native is disabled, unavailable, or fails to load, the WASM or regex fallback remains usable. Exact parity is required between native and WASM, not between AST parsers and the regex fallback, which records no calls.
- CRLF input must produce the same normalized parser results as LF input.

## Interfaces

- The native parseCodeBatch result shape is unchanged; Ruby is added to the languages it accepts. The generated typings do not change.
- A new indexer module, `packages/indexer/src/ruby-resolver.ts`, holds constant resolution, the scope rules, and `.rb`-only `require_relative` lookup. Ruby needs no shadow marker: a local variable cannot be called with parentheses or arguments.
- The native build gains one grammar crate; the three-platform CI must compile its C++ scanner.

## Coordination

The Go (landed), Python, and Rust plans edit the same native parser file, the same shared parser version tags, and the cap and resolver block of `buildGraphGeneration`. To keep them independent of landing order:

- Each plan re-verifies names and paths on HEAD in its Task 1 before editing.
- Version tags are incremented from the value left by the previous plan.
- The parity manifest is created by the first plan to land and extended by the others; this plan owns only the Ruby entries.
- This plan follows the Go work's per-language pattern: a Ruby cap condition at the three cap sites and a Ruby resolver branch ahead of the OXC and global fallbacks. It does not add `ruby` to the OXC set or restructure the OXC gate. The 20-call native slice is removed for Ruby only at both sites; Python and Rust keep theirs unless their own plans change them.
- The native walker generalization in Task 3 is additive: existing Python, Go, and Rust rules keep their behavior.

## Verification

- Add required Ruby parity fixtures: modules and classes with nesting and reopening, instance and singleton methods, `class << self`, `self.foo`, constant receivers and `&.`, `require_relative` and other require forms including interpolated and `Kernel.require`, class-body DSL calls, lambda assignments, heredocs, `=begin` comments and a `__END__` trailer, comments and strings, and a CRLF copy.
- Require exact native/WASM parity for Ruby symbols, exports, line ranges, imports, calls, and called identifiers, first on the current WASM behavior and again after the call-name change.
- Add Ruby graph fixtures for `self.foo`, constant receivers under nesting, bare calls to own and top-level methods, label sharing, duplicate labels across files, unknown receivers, unresolved dynamic calls, `require_relative` with `.md` beside `.rb`, and a file above both graph caps while a Python file keeps its caps; assert exact edges and zero false positives.
- Verify native loader fallback, parser cache invalidation, focused and full Bun suites, the native build, and CI on Linux x64, macOS arm64, and Windows x64.
- Record graph size and parse/index time for the Ruby fixture corpus; timing is informational.

## Out of scope

Python, Go, Rust, TypeScript, JavaScript, gem dependency resolution, Ruby runtime execution, inheritance and mixin dispatch, Rails autoload conventions, dynamic dispatch, eval, `method_missing` inference, schema/API changes, and new CLI/MCP tools.

## Related context

None. This repository has no docs/llm wiki.
