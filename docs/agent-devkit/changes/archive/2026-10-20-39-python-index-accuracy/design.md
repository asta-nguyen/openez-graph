# Python indexing accuracy

Issue: #39

## Goal

Make Python call edges follow Python import bindings and package-relative imports so calls resolve to the intended in-workspace symbol instead of the first same-named symbol found elsewhere.

## Current evidence

- Python call normalization reduces dotted calls to their last component in the native, tree-sitter WASM, and regex parsers, so module and class qualifiers are lost.
- Import parsing records module and imported-name paths but drops local aliases.
- The WASM and native parsers join a relative `from` import with its imported name using an unconditional dot. `from . import sibling` yields `..sibling` and `from .. import up` yields `...up`; the regex fallback yields `.sibling`. The workspace resolver reads `..sibling` as a level-2 import of the parent directory. Observed by running the WASM parser on a sample file.
- Graph construction falls back to a global symbol-name map that keeps the first matching name. Its same-file lookup splits nested scopes on `.`, while Python nested symbols are named with `::` (for example `K::m`), so a scope walk never matches them. A method call `self.helper()` is cut to `helper` and today reaches only a top-level or first-match `helper`, never the class's own `K::helper`.
- The workspace resolver maps an absolute Python module only to `<root>/a/b.py` or `<root>/a/b/__init__.py`, so a package rooted under `src/` or a service directory does not resolve.
- Native Python rows are cached with `importPaths` only; the completed JavaScript plan's versioned `imports` envelope can carry bindings, but the native cache read path ignores them.
- Existing Python tests cover parsing and path resolution, and the parity suite has one Python fixture with no pins, but there is no graph-level Python edge-accuracy fixture.
- The generic graph builder keeps at most 30 symbols and 20 calls per file, and the native path slices parse results to 20 calls at two sites.

## Scope

- Preserve local import bindings for import, from-import, aliases, and relative imports, and preserve call qualifiers across the native parser, tree-sitter WASM parser, and regex fallback. Fix the relative-import joining bug in all three paths.
- Resolve calls to a directly imported symbol or module-qualified symbol only through that binding and only when it identifies one in-workspace target. Follow named re-exports through package `__init__.py` files.
- Resolve unqualified calls with Python scoping — enclosing function scopes, then the module — before considering imported bindings. Drop unresolved or ambiguous calls.
- Resolve `self.name()` and `cls.name()` to the enclosing class's own method, and `Class.name()` to a method of a statically bound class. Never resolve these through imports or inheritance.
- Drop a call whose root name is bound as a local value in the calling function or an enclosing function.
- Keep current decorator, nested-function, and symbol extraction behavior unless a regression fixture requires a correction.
- Remove the 30-symbol and 20-call graph caps for Python only, including both native parse-result slices.
- Keep Python text chunks, SQLite schema, CLI/MCP interfaces, and optional-native behavior unchanged.

Dynamic imports, import-star expansion, runtime monkey-patching, inheritance, and receiver type inference are out of scope. Standard-library and third-party imports do not produce calls edges.

## Behavior

**Bindings.** Each import statement yields bindings `{ local, module, imported }`, using the `ImportBinding` type and versioned `imports` envelope from the completed JavaScript plan.

- `import a.b.c` binds `a` to module `a`; the dotted callee `a.b.c.f` is walked from there.
- `import a.b.c as x` binds `x` to module `a.b.c`.
- `from p import n as m` binds `m` to module `p`, imported name `n`.
- `from . import x` and `from ..p import n` keep their leading dots in `module` (`.` and `..p`); no dotted name is joined to a bare dot.
- `from p import *` creates no binding.
- If one local name has more than one distinct binding in a file (`try`/`except ImportError` fallbacks, `TYPE_CHECKING` blocks, function-local imports of a different module), calls through that name are dropped. Imports at any depth otherwise count for the whole file.

Bindings come from one TypeScript extractor that reads logical import statements from the source (comments and strings blanked; parenthesized and backslash-continued statements joined). It runs on the result of every parser path, so native, WASM, and regex results carry identical bindings and the native result shape does not change. The AST parsers still produce `importPaths`; a test asserts the paths implied by the bindings equal them.

**Modules.** A module path resolves to a workspace file through source roots: the workspace root and each ancestor directory of the importing file that is not itself a Python package (has no `__init__.py`). The nearest root that contains `a/b.py` or `a/b/__init__.py` wins; a root containing both is ambiguous and resolves to nothing. A relative import counts levels from the importing file's directory, as Python does. Namespace packages and `sys.path` configuration (`pyproject`, `pytest.ini`) are not evaluated. This resolver also serves file-level imports edges, so they and call edges agree.

**Module symbols.** A name imported from a module resolves to, in order: a top-level function or class of that module; a name the module re-exports with a named import (`from .mod import f`), followed up to three modules deep with a cycle guard; otherwise a submodule file of that name. An attribute of the package takes precedence over a submodule, as in Python. A name found more than once at the same step resolves to nothing. Star re-exports are not expanded.

**Calls.**

- A bare call `f()` resolves against the enclosing function scopes of the caller (`outer::f`), then module-level `f`. Class scope is not visible from a method body, so `helper()` inside a method never reaches `K::helper`. If a name is both defined at module level and bound by an import, the call is dropped. Otherwise an import binding is consulted.
- A dotted call is walked segment by segment from its bound root: a module accepts a submodule or a top-level symbol; a class accepts one further segment resolved to its own method `Class::name`; any other shape drops the call.
- `self.name()` and `cls.name()` resolve to `Class::name` in the same file, where `Class` is the nearest enclosing class of the caller, when exactly one such method exists. They never go through an import binding or a base class.
- `Class.name()` resolves only when `Class` is a top-level class of the same file or an imported name that resolves to a class; capitalization is not used as evidence.
- Calls through ordinary object attributes (`obj.attr()`, `self.attr.method()`, `super().name()`) are dropped.
- Targets are functions, classes, and, through the class rules above, methods.

**Local shadowing.** A call is marked `shadowedLocal` and dropped when its root name — the bare callee, or the first segment of a dotted callee — is bound by the calling function or an enclosing function as a parameter, assignment or augmented-assignment target (including tuple unpacking), `for` or comprehension target, `with … as` or `except … as` name, walrus, lambda parameter, `case` capture, or nested `def`/`class` name. An import statement is a binding, not a shadow. `self` and `cls` are exempt. The scan is function-granular: it covers the whole function body, nested definitions included, so it may drop a valid edge but never turns a local value into a project call. The marker is computed at parse time from the source and the symbol line ranges, and persisted on the call record in the existing `calls` JSON, as the TypeScript work does.

**Graph limits.** Python symbols and calls are not truncated by the generic graph limits; non-Python languages retain their current limits. The cap decision and the call-resolver choice are separate per-language decisions: lifting the cap for Python must not route Python calls through the OXC module-binding resolver, the same-file lexical lookup, or the global first-match map.

**Versions.** Binding metadata extends the internal parser result and the existing parsed-document JSON payload; it does not change CLI/MCP interfaces or add a SQL column. Native and fallback parser-version tags are bumped, incrementing from the value left by whichever indexing plan landed before this one (the Go, Rust, and Ruby plans share the tags). Because the tags are shared, unchanged Go and Rust parse rows may also be refreshed. A parser-version mismatch is checked during graph construction, while a completed graph can short-circuit after a no-op incremental index. Run `openez reindex <path>` after this change to rebuild old parsed rows and graph artifacts; a no-op `openez index <path>` is not sufficient. The relative-import fix changes file-level imports edges for `from . import x` forms from a wrong or missing target to the correct sibling module.

## CodeGraph reference

I inspected [colbymchenry/codegraph at commit `204315274e7902c713ba3ad61e8df511aa634b10`](https://github.com/colbymchenry/codegraph/tree/204315274e7902c713ba3ad61e8df511aa634b10). Its [Python package re-export fixture](https://github.com/colbymchenry/codegraph/blob/204315274e7902c713ba3ad61e8df511aa634b10/__tests__/python-package-reexports.test.ts) covers `__init__.py` re-exports, including wildcard imports, in a project whose packages live under a subdirectory; its [local-binding fixture](https://github.com/colbymchenry/codegraph/blob/204315274e7902c713ba3ad61e8df511aa634b10/__tests__/python-local-binding.test.ts) checks that a local value does not become a call to a same-named project function.

Further fixtures and resolver code read at the same commit and adopted:

- [Self-calls do not resolve through a same-named import](https://github.com/colbymchenry/codegraph/blob/204315274e7902c713ba3ad61e8df511aa634b10/__tests__/python-self-call-not-import.test.ts): `self.get_ip()` is the class's own method even when the file imports a function `get_ip`. CodeGraph's `self`/`cls` handling in [`name-matcher.ts`](https://github.com/colbymchenry/codegraph/blob/204315274e7902c713ba3ad61e8df511aa634b10/src/resolution/name-matcher.ts) looks members up on the enclosing class.
- [Import-alias binding](https://github.com/colbymchenry/codegraph/blob/204315274e7902c713ba3ad61e8df511aa634b10/__tests__/sync-python-import-binding-retry.test.ts): `from .models import User as UserModel` and `from . import helpers as h` bind a name the module never declares, and an unaliased name can come from a package `__init__.py` re-export (`from fastapi import FastAPI`).
- Resolver behavior in [`import-resolver.ts`](https://github.com/colbymchenry/codegraph/blob/204315274e7902c713ba3ad61e8df511aa634b10/src/resolution/import-resolver.ts): module symbols follow named re-exports up to three modules deep with a cycle guard; a name imported from two places in one file is not resolved; and `pythonBindsLocally` in `name-matcher.ts` walks the enclosing functions and reads parameters, assignments, `for`, `as`, lambda, walrus, and imports, with a statement scanner that joins continuation lines.

Deliberate differences. CodeGraph finds a module by path suffix and takes the first match; this plan uses source roots and drops ambiguity, so a sibling file that happens to share a standard-library name cannot capture an import. CodeGraph expands `from x import *` re-exports, follows base classes for `self.name()`, and treats a capitalized receiver as a class; this plan does none of these. CodeGraph scopes locals per enclosing function chain; this plan uses the simpler whole-function rule above. Keep OpenEZ's native/WASM/regex paths and do not adopt CodeGraph's parser or runtime architecture.

## Edge cases

- `from . import sibling` resolves to the sibling module, never the parent directory, in every parser mode and in LF and CRLF.
- A multi-line `from x import (a,\n b as c)` produces bindings for every name in all parser modes.
- A package whose files live under a non-package directory (`src/app/models.py`, `tests/test_models.py` importing `app.models`) resolves through the nearest source root; a test directory outside any root that cannot see the package resolves nothing.
- A sibling module named like a standard-library module inside a package does not capture `import logging`, because the package directory is not a source root.
- `from pkg import name` where `pkg/__init__.py` re-exports `name` from a submodule resolves to the definition. A re-export cycle resolves to nothing.
- A call available only through `from x import *` has no edge.
- Duplicate function names in separate packages resolve through the binding; ambiguous names drop.
- A local value with an imported function's name (`view = X.as_view(); view(request)`), a parameter, a loop variable, or a `with … as` name produces no edge.
- `helper()` inside a method with only a class-level `helper` produces no edge.
- A decorator written as `@helpers.cached` resolves through the same binding rules; `@app.route(...)` on a non-imported object does not.
- A function-local import of a name that the module also imports from elsewhere drops calls through that name.
- When native is disabled, unavailable, or fails to load, the WASM or regex fallback remains usable and produces the same bindings. Exact parity is required between native and WASM, not between AST parsers and the regex fallback.
- CRLF input must produce the same normalized parser results as LF input.

## Interfaces

- The native parseCodeBatch result shape is unchanged. Python call names keep their qualifiers in the existing calleeName string; `calledIdentifiers` keeps the last segment.
- `ParsedDocument.importBindings` and the versioned `parsed_documents.imports` envelope carry Python bindings; the native cache write and read paths and the in-memory parsed-file records carry them for native rows too. No second encoding and no schema change.
- A new indexer module, `packages/indexer/src/python-resolver.ts`, holds the binding extractor, the shadow marker, module and symbol resolution, and the call resolver. The extractor and marker run once on every Python parse result, wherever it is produced.

## Coordination

The Go, Rust, and Ruby plans edit the same native parser file, the same shared parser version tags, and the cap and resolver block of `buildGraphGeneration`. To keep them independent of landing order:

- Each plan re-verifies names and paths on HEAD in its Task 1 before editing.
- Version tags are incremented from the value left by the previous plan.
- The parity manifest is created by the first plan to land and extended by the others; this plan owns only the Python entries.
- This plan adds a Python cap decision and a Python resolver branch beside the existing OXC ones and does not rename or restructure the OXC gate. The 20-call native slice is removed for Python only at both sites; Go and Rust keep theirs unless their own plans change them.

## Verification

- Add a Python edge fixture with duplicate function names in separate packages, absolute and relative imports (including `from . import x` and `from .. import y`), module and symbol aliases, dotted module attribute calls, same-file calls, method scoping, `self`/`cls`/`Class.method` calls, local shadowing, named and star re-exports, a `src/` layout, a standard-library-named sibling, conflicting bindings, and ambiguous or external calls.
- Require exact expected edge targets, zero false positives, and no edge for unresolved or ambiguous calls.
- Include a file with more than 30 symbols and 20 calls; all Python graph nodes and calls must be retained, while a Go or Rust file keeps its caps.
- Cover native, WASM, and regex-fallback extraction; require exact native/WASM parity for maintained fixtures, including CRLF, and a test that bindings are identical across all three modes.
- Verify parser-version invalidation, the native cache round trip of bindings, focused Python and cache tests, the full Bun suite, and the existing native CI matrix.
- Record Python standard-library fixture graph counts and indexing time as an informational measure.

## Out of scope

TypeScript, JavaScript, Go, Rust, Ruby, dynamic import evaluation, wildcard import expansion, inheritance and base-class dispatch, property semantics, receiver type inference, `sys.path` and project-config evaluation, third-party dependency indexing, schema/API changes, and adding a language to the native extension.

## Related context

None. This repository has no docs/llm wiki.
