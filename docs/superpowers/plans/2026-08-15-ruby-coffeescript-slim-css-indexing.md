# Ruby + CoffeeScript/Slim/CSS/SCSS Indexing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the OpenEZ indexer to handle Ruby (via `tree-sitter-ruby` WASM grammar, matching the existing Python/Go/Rust path) and four additional languages (CoffeeScript, Slim, CSS, SCSS) via scanner inclusion + `FallbackParser`.

**Architecture:** Ruby gets a `rubyConfig` in `packages/indexer/src/tree-sitter/configs.ts` plus a `parseRuby` regex fallback in `packages/indexer/src/languages.ts`, registered in the existing `TreeSitterParser`. The `SymbolRule` and `LanguageConfig` types gain optional fields (`contextOnly`, `contextKind`, `qualifyCall`) and a new `ContextFrame` type with optional `kind?: "class" | "module"` to support Ruby's `class << self` context-only nesting and `self.foo` call qualification. CoffeeScript/Slim/CSS/SCSS get new extension maps in `languages.ts` and fall through to `FallbackParser` — no new parser class.

**Tech Stack:** TypeScript, `web-tree-sitter@^0.26.11`, `tree-sitter-ruby@^0.23.1` (WASM grammar), `bun test`, `tsup`, pnpm workspace.

## Global Constraints

- `tree-sitter-ruby` version: `^0.23.1` (ships `tree-sitter-ruby.wasm` in package root, compatible with `web-tree-sitter@0.26.11`).
- `ContextFrame.kind` is `?: "class" | "module"` — optional, only Ruby `class`/`module` rules set it. Python/Go/Rust frames have `kind: undefined`.
- Only `require_relative` paths enter `importPaths`. `require` (gem), `load`, `autoload` do not produce graph edges.
- `.coffee.md` is excluded (compound suffix, `path.extname()` returns `.md`). `.coffee` and `.litcoffee` are included.
- Regex fallback `parseRuby` uses `stripNonCode(content, { hashComments: true })` — no heredoc, no `%w[]`, no deep `end` matching.
- Test runner: `bun test`. Typecheck: `pnpm typecheck` (turbo). Build: `pnpm build:cli` (tsup).
- Commit style: conventional commits (`feat:`, `test:`, `refactor:`).

---

## File Structure

| File                                                 | Responsibility                                                                                                                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/indexer/package.json`                      | Add `tree-sitter-ruby` dependency.                                                                                                                                        |
| `packages/indexer/src/languages.ts`                  | Ruby extension registration, `styleExtensions`/`templateExtensions`/`scriptExtensions` maps, `inferDocumentKind` update, `parseRuby` regex fallback, `RUBY_CALL_IGNORES`. |
| `packages/indexer/src/scanner.ts`                    | Extend `ALLOWED_EXTENSIONS` and `DEFAULT_INCLUDE_PATTERNS` with all new extensions.                                                                                       |
| `packages/indexer/src/tree-sitter/parse.ts`          | `ContextFrame` type, `contextOnly`/`contextKind` on `SymbolRule`, `qualifyCall` on `LanguageConfig`, `walkTree` + `extractCallsInNode` updates.                           |
| `packages/indexer/src/tree-sitter/configs.ts`        | `rubyConfig` with symbol/import/call rules, `RUBY_CALL_IGNORES`, `extractRubyImports`, `normalizeRubyCallName`, `rubyQualifyCall`.                                        |
| `packages/indexer/src/tree-sitter/index.ts`          | Export `rubyConfig`.                                                                                                                                                      |
| `packages/indexer/src/parsers/tree-sitter-parser.ts` | Register `ruby` in `LANGUAGE_CONFIGS` and `REGEX_FALLBACKS`.                                                                                                              |
| `packages/indexer/src/index-workspace.ts`            | Add `.rb` to `RESOLVABLE_SOURCE_EXTENSIONS`; add Ruby branch in `resolveImport`.                                                                                          |
| `tests/ruby-indexer.test.ts`                         | New: `parseRuby` regex fallback tests.                                                                                                                                    |
| `tests/tree-sitter-parser.test.ts`                   | Extend: Ruby AST parser test block.                                                                                                                                       |
| `tests/parser-registry.test.ts`                      | Extend: dispatch assertions for new extensions.                                                                                                                           |
| `tests/scanner.test.ts`                              | New: scanner includes new extensions.                                                                                                                                     |
| `tests/index-workspace.test.ts`                      | Extend: E2E Ruby indexing with import edges.                                                                                                                              |
| `tests/fixtures/ruby/user.rb`                        | Fixture: class + method + `def self.` + `class << self`.                                                                                                                  |
| `tests/fixtures/ruby/helper.rb`                      | Fixture: module + `require_relative`.                                                                                                                                     |
| `tests/fixtures/styles/app.scss`                     | Fixture: SCSS for fallback chunking.                                                                                                                                      |
| `tests/fixtures/views/index.slim`                    | Fixture: Slim for fallback chunking.                                                                                                                                      |

---

### Task 1: Add `tree-sitter-ruby` dependency and verify WASM loads

**Files:**

- Modify: `packages/indexer/package.json`
- Test: inline `bun eval` smoke test

**Interfaces:**

- Produces: `tree-sitter-ruby@^0.23.1` in `packages/indexer/node_modules/tree-sitter-ruby/tree-sitter-ruby.wasm` — consumed by `resolveGrammarWasm` in Task 6.

- [ ] **Step 1: Add the dependency**

Edit `packages/indexer/package.json` — add to `dependencies` (alphabetical after `tree-sitter-rust`):

```json
"tree-sitter-ruby": "^0.23.1",
```

- [ ] **Step 2: Install**

Run: `pnpm install`
Expected: `tree-sitter-ruby@0.23.1` resolves and installs. Verify the WASM file exists:

```bash
ls packages/indexer/node_modules/tree-sitter-ruby/tree-sitter-ruby.wasm
```

Expected: file exists, ~2.1MB.

- [ ] **Step 3: Smoke-test WASM load with web-tree-sitter**

Run:

```bash
cd packages/indexer && bun eval '
const { Parser, Language } = require("web-tree-sitter");
const path = require("node:path");
(async () => {
  await Parser.init();
  const wasmPath = path.join(__dirname, "node_modules/tree-sitter-ruby/tree-sitter-ruby.wasm");
  const lang = await Language.load(wasmPath);
  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse("class Foo; def bar; end; end");
  console.log("root:", tree.rootNode.type);
  console.log("children:", tree.rootNode.namedChildren.map(c => c.type));
  tree.delete();
  parser.delete();
})().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
'
```

Expected: prints `root: program` and `children: [ 'class' ]`. If it prints `FAIL:` with an ABI error, the WASM is incompatible with `web-tree-sitter@0.26` — stop and report the error; do not proceed to Task 2.

- [ ] **Step 4: Commit**

```bash
git add packages/indexer/package.json pnpm-lock.yaml
git commit -m "feat(indexer): add tree-sitter-ruby dependency for Ruby AST parsing"
```

---

### Task 2: Extend `SymbolRule`, `LanguageConfig`, and add `ContextFrame` types

**Files:**

- Modify: `packages/indexer/src/tree-sitter/parse.ts:14-61` (type definitions)
- Modify: `packages/indexer/src/tree-sitter/parse.ts:117-121` (contextStack declaration)
- Modify: `packages/indexer/src/tree-sitter/configs.ts:338-341` (Rust impl_item extractContextName)
- Test: `pnpm typecheck`

**Interfaces:**

- Produces: `ContextFrame` interface, `SymbolRule.contextOnly`, `SymbolRule.contextKind`, `SymbolRule.extractContextName` new signature `(node, contextStack) => string | null`, `LanguageConfig.qualifyCall`.
- Consumes: nothing (first task in the type chain).

- [ ] **Step 1: Add `ContextFrame` type and update `SymbolRule`**

In `packages/indexer/src/tree-sitter/parse.ts`, after line 33 (closing `}` of `SymbolRule`), insert the new `ContextFrame` interface. Then add the new fields to `SymbolRule`.

Replace the `extractContextName` field at line 24:

```ts
  /** override context name for nesting (defaults to symbol name) */
  extractContextName?: (node: Node) => string | null;
```

with:

```ts
  /** override context name for nesting (defaults to symbol name) */
  extractContextName?: (
    node: Node,
    contextStack: ReadonlyArray<ContextFrame>,
  ) => string | null;
  /** push context stack without emitting a symbol or extracting calls */
  contextOnly?: boolean;
  /** context kind for this rule's frames; only "class" | "module" for Ruby */
  contextKind?: "class" | "module";
```

Then after the `SymbolRule` interface (after line 33), add:

```ts
/**
 * Context frame on the walker's context stack. `kind` is optional — only
 * Ruby class/module rules set it so singleton_class.extractContextName and
 * the qualifyCall hook can walk back for the nearest class/module frame.
 * Python/Go/Rust frames have kind: undefined.
 */
export interface ContextFrame {
  name: string;
  endRow: number;
  kind?: "class" | "module";
  receiver?: { varName: string; typeName: string };
}
```

- [ ] **Step 2: Add `qualifyCall` to `LanguageConfig`**

In `packages/indexer/src/tree-sitter/parse.ts`, after line 60 (`contextNameField: string;`), add:

```ts
  /**
   * Optional hook to qualify a callee name based on the call node's receiver
   * and the active context stack. Returns the qualified callee, or null to
   * keep the normalized name unqualified. Used for Ruby self.foo →
   * TypeName::foo. Go receiver qualification stays in extractCallsInNode
   * via receiverInfo and is unaffected.
   */
  qualifyCall?: (
    callNode: Node,
    calleeName: string,
    normalized: string,
    contextStack: ReadonlyArray<ContextFrame>,
  ) => string | null;
```

- [ ] **Step 3: Update `contextStack` declaration in `walkTree`**

In `packages/indexer/src/tree-sitter/parse.ts`, replace lines 117-121:

```ts
const contextStack: Array<{
  name: string;
  endRow: number;
  receiver?: { varName: string; typeName: string };
}> = [];
```

with:

```ts
const contextStack: ContextFrame[] = [];
```

- [ ] **Step 4: Update `extractContextName` call site in `walkTree`**

In `packages/indexer/src/tree-sitter/parse.ts`, replace lines 267-269:

```ts
const contextName = symbolRule.extractContextName
  ? (symbolRule.extractContextName(node) ?? fullName)
  : fullName;
```

with:

```ts
const contextName = symbolRule.extractContextName
  ? (symbolRule.extractContextName(node, contextStack) ?? fullName)
  : fullName;
```

Then update the `contextStack.push` at line 270 to include `kind`:

```ts
contextStack.push({
  name: contextName,
  endRow,
  kind: symbolRule.contextKind,
  receiver: receiverInfo,
});
```

- [ ] **Step 5: Add `contextOnly` handling in `walkTree`**

In `packages/indexer/src/tree-sitter/parse.ts`, inside the `if (symbolRule)` block (line 205), before the existing `const name = symbolRule.extractName ...` line, add:

```ts
    if (symbolRule.contextOnly) {
      const contextName = symbolRule.extractContextName
        ? (symbolRule.extractContextName(node, contextStack) ?? null)
        : null;
      if (contextName) {
        contextStack.push({
          name: contextName,
          endRow,
          kind: symbolRule.contextKind,
        });
      }
      // Skip symbol emission and call extraction — context-only.
    } else {
```

Then close the `else` block after the existing `if (isContextNode) { ... }` block (after line 271). The existing symbol extraction code (lines 206-271) becomes the body of the `else` block. Indent accordingly.

- [ ] **Step 6: Update `extractCallsInNode` to invoke `qualifyCall`**

In `packages/indexer/src/tree-sitter/parse.ts`, the `extractCallsInNode` function signature (line 298) needs to accept `contextStack`. Add a parameter:

```ts
function extractCallsInNode(
  symbolNode: Node,
  config: LanguageConfig,
  callerName: string,
  receiverInfo: { varName: string; typeName: string } | undefined,
  calledIdentifiers: Set<string>,
  callExpressions: Array<{ callerName: string; calleeName: string }>,
  contextStack: ReadonlyArray<ContextFrame>,
): void {
```

Then after the `qualifiedCallee` assignment (line 331-334), add the `qualifyCall` override:

```ts
const hookQualified = config.qualifyCall?.(callNode, calleeName, normalized, contextStack);
const finalCallee = hookQualified ?? qualifiedCallee;
```

Replace `qualifiedCallee` with `finalCallee` in the `if` condition (line 336-340) and the `calledIdentifiers.add` / `callExpressions.push` (lines 344-345).

- [ ] **Step 7: Update `extractCallsInNode` call site in `walkTree`**

In `packages/indexer/src/tree-sitter/parse.ts`, the call to `extractCallsInNode` at lines 253-260, add `contextStack` as the last argument:

```ts
extractCallsInNode(
  node,
  config,
  fullName,
  receiverInfo,
  calledIdentifiers,
  callExpressions,
  contextStack,
);
```

- [ ] **Step 8: Update Rust `impl_item` `extractContextName` signature**

In `packages/indexer/src/tree-sitter/configs.ts`, the Rust `impl_item` rule (line 338-341) has:

```ts
      extractContextName: (node) => {
        // Use the type name for nesting (Circle::draw, not impl Circle::draw)
        return node.childForFieldName("type")?.text ?? null;
      },
```

Update to accept the second parameter (ignored):

```ts
      extractContextName: (node, _contextStack) => {
        // Use the type name for nesting (Circle::draw, not impl Circle::draw)
        return node.childForFieldName("type")?.text ?? null;
      },
```

- [ ] **Step 9: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS — no type errors. The `ContextFrame` type is compatible with existing code because `kind` and `receiver` are optional and `name`/`endRow` keep the same shape.

- [ ] **Step 10: Run existing tests to verify no regression**

Run: `bun test tests/tree-sitter-parser.test.ts tests/python-indexer.test.ts tests/go-rust-indexer.test.ts`
Expected: all existing tests PASS.

- [ ] **Step 11: Commit**

```bash
git add packages/indexer/src/tree-sitter/parse.ts packages/indexer/src/tree-sitter/configs.ts
git commit -m "refactor(indexer): add ContextFrame, contextOnly, qualifyCall to tree-sitter parser"
```

---

### Task 3: Register Ruby extensions and add `parseRuby` regex fallback

**Files:**

- Modify: `packages/indexer/src/languages.ts:20-32` (codeExtensions)
- Modify: `packages/indexer/src/languages.ts` (append `parseRuby` after `parseRust`, ~line 850)
- Test: `tests/ruby-indexer.test.ts` (new)

**Interfaces:**

- Produces: `parseRuby(content, counter?) => IndexedCodeResult` — consumed by `REGEX_FALLBACKS` in Task 5.
- Produces: `.rb`/`.rake`/`.gemspec` in `codeExtensions` — consumed by `inferDocumentKind` and scanner.

- [ ] **Step 1: Add Ruby to `codeExtensions`**

In `packages/indexer/src/languages.ts`, extend the `codeExtensions` map (line 20-32). After the `.rs` entry:

```ts
  [".rs", "rust"],
  [".rb", "ruby"],
  [".rake", "ruby"],
  [".gemspec", "ruby"],
```

- [ ] **Step 2: Write the failing test for `parseRuby`**

Create `tests/ruby-indexer.test.ts`:

```ts
import { describe, expect, it } from "bun:test";

import { parseRuby } from "../packages/indexer/src/languages";

describe("parseRuby regex fallback", () => {
  it("extracts class, module, and method symbols", () => {
    const result = parseRuby(`
module MyApp
  class User
    def greet(name)
      puts "Hello, \#{name}"
    end

    def self.admin?
      true
    end
  end
end
`);

    const names = result.definedSymbols.map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining(["MyApp", "MyApp::User", "MyApp::User::greet", "MyApp::User::admin?"]),
    );
    const user = result.definedSymbols.find((s) => s.name === "MyApp::User");
    expect(user?.symbolType).toBe("class");
    const greet = result.definedSymbols.find((s) => s.name === "MyApp::User::greet");
    expect(greet?.symbolType).toBe("function");
  });

  it("extracts require_relative imports only", () => {
    const result = parseRuby(`
require "rails"
require_relative "./user"
load "helper.rb"
autoload :Cache, "cache"

class App
end
`);

    expect(result.importPaths).toEqual(["./user"]);
    expect(result.importPaths).not.toContain("rails");
    expect(result.importPaths).not.toContain("helper.rb");
    expect(result.importPaths).not.toContain("cache");
  });

  it("extracts calls ignoring builtins", () => {
    const result = parseRuby(`
class User
  def save
    validate
    puts "saving"
    raise "error" unless valid?
  end
end
`);

    expect(result.calledIdentifiers).toEqual(expect.arrayContaining(["validate", "valid?"]));
    expect(result.calledIdentifiers).not.toContain("puts");
    expect(result.calledIdentifiers).not.toContain("raise");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/ruby-indexer.test.ts`
Expected: FAIL — `parseRuby is not a function` (not yet implemented).

- [ ] **Step 4: Implement `parseRuby`**

In `packages/indexer/src/languages.ts`, after the `parseRust` function (find its closing `}` and add after it), add:

```ts
// ── Ruby parser (regex fallback) ──

const RUBY_CALL_IGNORES = new Set([
  "if",
  "unless",
  "while",
  "until",
  "for",
  "return",
  "yield",
  "break",
  "next",
  "redo",
  "retry",
  "puts",
  "pp",
  "p",
  "print",
  "raise",
  "require",
  "require_relative",
  "load",
  "autoload",
  "attr_accessor",
  "attr_reader",
  "attr_writer",
  "include",
  "extend",
  "define_method",
  "lambda",
  "proc",
  "super",
  "self",
  "nil",
  "true",
  "false",
  "new",
  "Array",
  "Hash",
  "String",
  "Integer",
  "Float",
  "Symbol",
]);

function normalizeRubyCallName(value: string): string {
  const parts = value.split(/[.::]/).filter(Boolean);
  return parts[parts.length - 1] ?? value;
}

function findRubyBlockEnd(codeLines: string[], startIndex: number): number {
  const baseIndent = codeLines[startIndex]?.search(/\S/) ?? 0;
  for (let i = startIndex + 1; i < codeLines.length; i++) {
    const trimmed = codeLines[i].trim();
    if (trimmed === "") continue;
    if (trimmed === "end" || trimmed.startsWith("end ") || trimmed.startsWith("end\t")) {
      return i + 1;
    }
    const indent = codeLines[i].search(/\S/);
    if (indent >= 0 && indent < baseIndent) {
      return i;
    }
  }
  return codeLines.length;
}

export function parseRuby(
  content: string,
  counter: TokenCounter = exactTokenCounter,
): IndexedCodeResult {
  const lines = content.split("\n");
  const codeLines = stripNonCode(content, { hashComments: true }).split("\n");
  const definedSymbols: ExtractedSymbol[] = [];
  const importPaths: string[] = [];
  const calledIdentifiers = new Set<string>();
  const callExpressions: Array<{ callerName: string; calleeName: string }> = [];

  const symbolRegex =
    /^\s*(?:def\s+(?:self\.)?(\w+[?!]?)|class\s+(\w+(?:::\w+)*)|module\s+(\w+(?:::\w+)*))/;
  const requireRelativeRegex = /\brequire_relative\s+['"]([^'"]+)['"]/g;
  const callRegex = /(\w+(?:::\w+)*(?:\.\w+)*)\s*\(/g;

  const contextStack: Array<{ name: string; endLine: number }> = [];

  for (let i = 0; i < codeLines.length; i++) {
    const line = codeLines[i];
    const trimmed = line.trim();

    while (contextStack.length > 0 && i >= contextStack[contextStack.length - 1].endLine) {
      contextStack.pop();
    }

    const match = symbolRegex.exec(trimmed);
    if (match) {
      const rawName = match[1] ?? match[2] ?? match[3];
      if (!rawName) continue;
      const isMethod = Boolean(match[1]);
      const symbolType = isMethod ? "function" : match[2] ? "class" : "module";
      const parentName =
        contextStack.length > 0 ? contextStack[contextStack.length - 1].name : null;
      const name = parentName ? `${parentName}::${rawName}` : rawName;
      const endLine = findRubyBlockEnd(codeLines, i);

      definedSymbols.push({
        name,
        symbolType,
        type: symbolType,
        exported: !rawName.startsWith("_"),
        startLine: i + 1,
        endLine,
      });

      if (isMethod) {
        callRegex.lastIndex = 0;
        for (let lineIdx = i; lineIdx < endLine; lineIdx++) {
          const bodyLine = codeLines[lineIdx];
          if (!bodyLine) continue;
          callRegex.lastIndex = 0;
          let callMatch: RegExpExecArray | null;
          while ((callMatch = callRegex.exec(bodyLine)) !== null) {
            const rawCalled = callMatch[1];
            const called = normalizeRubyCallName(rawCalled);
            if (
              !RUBY_CALL_IGNORES.has(rawCalled) &&
              !RUBY_CALL_IGNORES.has(called) &&
              called !== rawName
            ) {
              calledIdentifiers.add(called);
              callExpressions.push({ callerName: name, calleeName: called });
            }
          }
        }
      }

      contextStack.push({ name, endLine });
      continue;
    }

    // require_relative only
    requireRelativeRegex.lastIndex = 0;
    let reqMatch: RegExpExecArray | null;
    while ((reqMatch = requireRelativeRegex.exec(line)) !== null) {
      importPaths.push(reqMatch[1]);
    }
  }

  const chunks = createSymbolChunks(definedSymbols, lines, "ruby", counter);
  if (chunks.length === 0) {
    return {
      ...makeFallbackChunks(content, lines, counter),
      importPaths: [...new Set(importPaths)],
    };
  }

  return {
    chunks,
    importPaths: [...new Set(importPaths)],
    definedSymbols,
    calledIdentifiers: [...calledIdentifiers],
    callExpressions,
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/ruby-indexer.test.ts`
Expected: PASS.

- [ ] **Step 6: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/indexer/src/languages.ts tests/ruby-indexer.test.ts
git commit -m "feat(indexer): add parseRuby regex fallback and Ruby extension registration"
```

---

### Task 4: Add `rubyConfig` to tree-sitter configs

**Files:**

- Modify: `packages/indexer/src/tree-sitter/configs.ts` (append after `rustConfig`, ~line 376)
- Modify: `packages/indexer/src/tree-sitter/index.ts:3` (export `rubyConfig`)
- Test: `tests/tree-sitter-parser.test.ts` (extend with Ruby block)

**Interfaces:**

- Produces: `rubyConfig: LanguageConfig` — consumed by `LANGUAGE_CONFIGS` in Task 5.
- Consumes: `ContextFrame`, `qualifyCall`, `contextOnly`, `contextKind` from Task 2.

- [ ] **Step 1: Write the failing test for `rubyConfig`**

In `tests/tree-sitter-parser.test.ts`, add imports at the top (line 4-8 area). The existing import is:

```ts
import {
  goConfig,
  parseWithTreeSitter,
  pythonConfig,
  rustConfig,
} from "../packages/indexer/src/tree-sitter";
```

Add `rubyConfig`:

```ts
import {
  goConfig,
  parseWithTreeSitter,
  pythonConfig,
  rubyConfig,
  rustConfig,
} from "../packages/indexer/src/tree-sitter";
```

Then at the end of the file, add:

```ts
// ── Ruby ──

describe("tree-sitter ruby parser", () => {
  it("extracts class, module, method, and singleton_method", async () => {
    const result = await parseWithTreeSitter(
      rubyConfig,
      [
        "module MyApp",
        "  class User",
        "    def greet(name)",
        '      puts "Hello"',
        "    end",
        "",
        "    def self.admin?",
        "      true",
        "    end",
        "  end",
        "end",
      ].join("\n"),
    );

    expect(result).not.toBeNull();
    const names = result!.definedSymbols.map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "MyApp",
        "MyApp::User",
        "MyApp::User::greet",
        "MyApp::User::admin?",
      ]),
    );
  });

  it("class << self is context-only — no pseudo-symbol, methods nest under parent class", async () => {
    const result = await parseWithTreeSitter(
      rubyConfig,
      [
        "class User",
        "  def instance_method",
        "  end",
        "",
        "  class << self",
        "    def bulk_create",
        "    end",
        "  end",
        "end",
      ].join("\n"),
    );

    expect(result).not.toBeNull();
    const names = result!.definedSymbols.map((s) => s.name);
    // No <Class::User> pseudo-symbol
    expect(names).not.toContain("<Class::User>");
    expect(names).not.toContain("User::<Class::User>");
    // bulk_create nests under User, not under a pseudo class
    expect(names).toContain("User::bulk_create");
    expect(names).toContain("User::instance_method");
  });

  it("class << self nested in method walks back to class frame", async () => {
    const result = await parseWithTreeSitter(
      rubyConfig,
      [
        "class User",
        "  def setup",
        "    class << self",
        "      def dynamic_method",
        "      end",
        "    end",
        "  end",
        "end",
      ].join("\n",
    );

    expect(result).not.toBeNull();
    const names = result!.definedSymbols.map((s) => s.name);
    // dynamic_method should nest under User, not under User::setup
    expect(names).toContain("User::dynamic_method");
    expect(names).not.toContain("User::setup::dynamic_method");
  });

  it("self.foo call qualification produces User::foo → User::bar edge", async () => {
    const result = await parseWithTreeSitter(
      rubyConfig,
      [
        "class User",
        "  def foo",
        "    self.bar",
        "  end",
        "",
        "  def bar",
        "  end",
        "end",
      ].join("\n"),
    );

    expect(result).not.toBeNull();
    const edge = result!.callExpressions.find(
      (e) => e.callerName === "User::foo" && e.calleeName === "User::bar",
    );
    expect(edge).toBeDefined();
  });

  it("extracts require_relative imports only", async () => {
    const result = await parseWithTreeSitter(
      rubyConfig,
      [
        'require "rails"',
        'require_relative "./user"',
        'load "helper.rb"',
        'autoload :Cache, "cache"',
        "",
        "class App",
        "end",
      ].join("\n"),
    );

    expect(result).not.toBeNull();
    expect(result!.importPaths).toEqual(["./user"]);
    expect(result!.importPaths).not.toContain("rails");
    expect(result!.importPaths).not.toContain("helper.rb");
    expect(result!.importPaths).not.toContain("cache");
  });

  it("extracts named lambda assignment", async () => {
    const result = await parseWithTreeSitter(
      rubyConfig,
      [
        "class Handler",
        "  handler = lambda { |x| x + 1 }",
        "  proc_var = proc { |x| x * 2 }",
        "end",
      ].join("\n"),
    );

    expect(result).not.toBeNull();
    const names = result!.definedSymbols.map((s) => s.name);
    expect(names).toContain("Handler::handler");
    expect(names).toContain("Handler::proc_var");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/tree-sitter-parser.test.ts`
Expected: FAIL — `rubyConfig` is not exported (import error).

- [ ] **Step 3: Implement `rubyConfig`**

In `packages/indexer/src/tree-sitter/configs.ts`, after the `rustConfig` export (end of file, line 376), add:

```ts
// ── Ruby ──

const RUBY_CALL_IGNORES = new Set([
  "if",
  "unless",
  "while",
  "until",
  "for",
  "return",
  "yield",
  "break",
  "next",
  "redo",
  "retry",
  "puts",
  "pp",
  "p",
  "print",
  "raise",
  "require",
  "require_relative",
  "load",
  "autoload",
  "attr_accessor",
  "attr_reader",
  "attr_writer",
  "include",
  "extend",
  "define_method",
  "lambda",
  "proc",
  "super",
  "self",
  "nil",
  "true",
  "false",
  "new",
  "Array",
  "Hash",
  "String",
  "Integer",
  "Float",
  "Symbol",
]);

function normalizeRubyCallName(value: string): string {
  const parts = value.split(/[.::]/).filter(Boolean);
  return parts[parts.length - 1] ?? value;
}

function extractRubyImports(node: Node): string[] {
  const paths: string[] = [];
  // Only require_relative calls produce import edges.
  // require (gem), load, autoload do not resolve to local files.
  if (node.type === "call") {
    const methodNode = node.childForFieldName("method");
    if (methodNode && methodNode.text === "require_relative") {
      const argsNode = node.childForFieldName("arguments");
      if (argsNode) {
        const stringNode = argsNode.namedChildren.find(
          (c) => c.type === "string" || c.type === "argument_list",
        );
        const target =
          stringNode?.type === "string"
            ? stringNode
            : stringNode?.namedChildren.find((c) => c.type === "string");
        if (target) {
          const text = target.text.replace(/^['"]|['"]$/g, "");
          if (text) paths.push(text);
        }
      }
    }
  }
  return paths;
}

function rubyQualifyCall(
  callNode: Node,
  _calleeName: string,
  normalized: string,
  contextStack: ReadonlyArray<ContextFrame>,
): string | null {
  const receiverNode = callNode.childForFieldName("receiver");
  if (!receiverNode || receiverNode.text !== "self") return null;
  for (let i = contextStack.length - 1; i >= 0; i--) {
    const frame = contextStack[i];
    if (frame.kind === "class" || frame.kind === "module") {
      return `${frame.name}::${normalized}`;
    }
  }
  return null;
}

export const rubyConfig: LanguageConfig = {
  language: "ruby",
  symbolRules: [
    {
      nodeType: "class",
      symbolType: "class",
      nameField: "name",
      establishesContext: true,
      contextKind: "class",
      isExported: (name) => name[0] >= "A" && name[0] <= "Z",
    },
    {
      nodeType: "module",
      symbolType: "module",
      nameField: "name",
      establishesContext: true,
      contextKind: "module",
      isExported: (name) => name[0] >= "A" && name[0] <= "Z",
    },
    {
      nodeType: "method",
      symbolType: "function",
      nameField: "name",
      establishesContext: true,
      isExported: () => false,
    },
    {
      nodeType: "singleton_method",
      symbolType: "function",
      nameField: "name",
      establishesContext: true,
      isExported: () => false,
    },
    {
      nodeType: "singleton_class",
      symbolType: "class",
      nameField: "value",
      contextOnly: true,
      extractContextName: (_node, contextStack) => {
        for (let i = contextStack.length - 1; i >= 0; i--) {
          const frame = contextStack[i];
          if (frame.kind === "class" || frame.kind === "module") {
            return frame.name;
          }
        }
        return null;
      },
      isExported: () => false,
    },
    {
      nodeType: "assignment",
      symbolType: "lambda",
      nameField: "left",
      extractName: (node) => {
        const rightNode = node.childForFieldName("right");
        if (!rightNode) return null;
        // lambda { } or lambda do |x| end
        if (rightNode.type === "lambda") {
          const leftNode = node.childForFieldName("left");
          return leftNode?.text ?? null;
        }
        // proc { } or Proc.new { } or lambda { } via call
        if (rightNode.type === "call") {
          const methodNode = rightNode.childForFieldName("method");
          const methodName = methodNode?.text;
          if (methodName === "proc" || methodName === "lambda") {
            const leftNode = node.childForFieldName("left");
            return leftNode?.text ?? null;
          }
          // Proc.new — check receiver is "Proc" and method is "new"
          const receiverNode = rightNode.childForFieldName("receiver");
          if (receiverNode?.text === "Proc" && methodName === "new") {
            const leftNode = node.childForFieldName("left");
            return leftNode?.text ?? null;
          }
        }
        return null;
      },
      isExported: () => false,
    },
  ],
  importRules: [{ nodeType: "call", extract: extractRubyImports }],
  callRule: { nodeType: "call", functionField: "method" },
  callIgnores: RUBY_CALL_IGNORES,
  normalizeCallName: normalizeRubyCallName,
  contextNodeTypes: new Set(["class", "module", "method", "singleton_method"]),
  contextNameField: "name",
  qualifyCall: rubyQualifyCall,
};
```

Also add the import for `ContextFrame` at the top of `configs.ts`. The existing import from `./parse` is:

```ts
import type { LanguageConfig, ImportRule } from "./parse";
```

Update to:

```ts
import type { ContextFrame, LanguageConfig, ImportRule } from "./parse";
```

- [ ] **Step 4: Export `rubyConfig` from index**

In `packages/indexer/src/tree-sitter/index.ts`, update line 3:

```ts
export { pythonConfig, goConfig, rustConfig } from "./configs";
```

to:

```ts
export { pythonConfig, goConfig, rustConfig, rubyConfig } from "./configs";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/tree-sitter-parser.test.ts`
Expected: PASS — all Ruby tests pass. If the WASM fails to load, tests will fail with a null result error — this is the ABI compatibility signal from Task 1 Step 3.

- [ ] **Step 6: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/indexer/src/tree-sitter/configs.ts packages/indexer/src/tree-sitter/index.ts tests/tree-sitter-parser.test.ts
git commit -m "feat(indexer): add rubyConfig with tree-sitter AST symbol extraction"
```

---

### Task 5: Register Ruby in `TreeSitterParser` and add import resolver

**Files:**

- Modify: `packages/indexer/src/parsers/tree-sitter-parser.ts:3-20`
- Modify: `packages/indexer/src/index-workspace.ts:26-38` (RESOLVABLE_SOURCE_EXTENSIONS)
- Modify: `packages/indexer/src/index-workspace.ts:216-232` (resolveImport)
- Test: `tests/parser-registry.test.ts` (extend)

**Interfaces:**

- Produces: `.rb` files dispatch to `TreeSitterParser`; `require_relative` paths resolve via `resolveRelativeImport`.

- [ ] **Step 1: Write the failing test for parser dispatch**

In `tests/parser-registry.test.ts`, find the test:

```ts
it("selects TreeSitterParser for Python/Go/Rust files", () => {
  expect(getParserForPath("main.py")).toBeInstanceOf(TreeSitterParser);
  expect(getParserForPath("main.go")).toBeInstanceOf(TreeSitterParser);
  expect(getParserForPath("main.rs")).toBeInstanceOf(TreeSitterParser);
});
```

Add Ruby assertions:

```ts
it("selects TreeSitterParser for Python/Go/Rust/Ruby files", () => {
  expect(getParserForPath("main.py")).toBeInstanceOf(TreeSitterParser);
  expect(getParserForPath("main.go")).toBeInstanceOf(TreeSitterParser);
  expect(getParserForPath("main.rs")).toBeInstanceOf(TreeSitterParser);
  expect(getParserForPath("app.rb")).toBeInstanceOf(TreeSitterParser);
  expect(getParserForPath("Rakefile.rake")).toBeInstanceOf(TreeSitterParser);
  expect(getParserForPath("mygem.gemspec")).toBeInstanceOf(TreeSitterParser);
});
```

Then find the fallback test and add new language assertions:

```ts
it("falls back to FallbackParser for CoffeeScript/Slim/CSS/SCSS files", () => {
  expect(getParserForPath("app.coffee")).toBeInstanceOf(FallbackParser);
  expect(getParserForPath("app.litcoffee")).toBeInstanceOf(FallbackParser);
  expect(getParserForPath("styles/app.scss")).toBeInstanceOf(FallbackParser);
  expect(getParserForPath("styles/app.css")).toBeInstanceOf(FallbackParser);
  expect(getParserForPath("views/index.slim")).toBeInstanceOf(FallbackParser);
  expect(getParserForPath("views/index.haml")).toBeInstanceOf(FallbackParser);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/parser-registry.test.ts`
Expected: FAIL — `.rb` dispatches to `FallbackParser` (not yet registered in `LANGUAGE_CONFIGS`).

- [ ] **Step 3: Register Ruby in `TreeSitterParser`**

In `packages/indexer/src/parsers/tree-sitter-parser.ts`, update imports (line 3):

```ts
import { parseGo, parsePython, parseRuby, parseRust, type IndexedCodeResult } from "../languages";
import {
  goConfig,
  parseWithTreeSitter,
  pythonConfig,
  rubyConfig,
  rustConfig,
} from "../tree-sitter";
```

Update `LANGUAGE_CONFIGS` (line 7-11):

```ts
const LANGUAGE_CONFIGS = {
  python: pythonConfig,
  go: goConfig,
  rust: rustConfig,
  ruby: rubyConfig,
} as const;
```

Update `REGEX_FALLBACKS` (line 13-20):

```ts
const REGEX_FALLBACKS: Record<
  string,
  (content: string, counter: TokenCounter) => IndexedCodeResult
> = {
  python: parsePython,
  go: parseGo,
  rust: parseRust,
  ruby: parseRuby,
};
```

- [ ] **Step 4: Add `.rb` to `RESOLVABLE_SOURCE_EXTENSIONS`**

In `packages/indexer/src/index-workspace.ts`, extend the array (lines 26-38). After `.py`:

```ts
  ".py",
  ".rb",
] as const;
```

- [ ] **Step 5: Add Ruby branch in `resolveImport`**

In `packages/indexer/src/index-workspace.ts`, the `resolveImport` function (lines 217-232). After the Python branch, add:

```ts
    resolveImport(
      importerRelativePath: string,
      importPath: string,
      language?: string,
    ): string | null {
      if (language === "python") {
        const resolved = resolvePythonImport(importerRelativePath, importPath);
        if (resolved) return resolved;
      }

      if (language === "ruby") {
        return resolveRelativeImport(importerRelativePath, importPath);
      }

      if (importPath.startsWith(".")) {
        return resolveRelativeImport(importerRelativePath, importPath);
      }

      return null;
    },
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test tests/parser-registry.test.ts`
Expected: PASS.

- [ ] **Step 7: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/indexer/src/parsers/tree-sitter-parser.ts packages/indexer/src/index-workspace.ts tests/parser-registry.test.ts
git commit -m "feat(indexer): register Ruby in TreeSitterParser and add require_relative resolver"
```

---

### Task 6: Add CoffeeScript/Slim/CSS/SCSS extension maps and scanner support

**Files:**

- Modify: `packages/indexer/src/languages.ts:34-41` (after configExtensions)
- Modify: `packages/indexer/src/languages.ts:49-65` (inferDocumentKind)
- Modify: `packages/indexer/src/scanner.ts:10-22`
- Test: `tests/scanner.test.ts` (new)

**Interfaces:**

- Produces: `styleExtensions`, `templateExtensions`, `scriptExtensions` maps — consumed by `inferDocumentKind` and `scanner.ts`.

- [ ] **Step 1: Write the failing test for scanner**

Create `tests/scanner.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "bun:test";

import { scanWorkspaceFiles } from "../packages/indexer/src/scanner";

describe("scanWorkspaceFiles", () => {
  it("includes Ruby, CoffeeScript, CSS, SCSS, Slim, Haml files", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openez-scan-"));
    try {
      fs.writeFileSync(path.join(root, "app.rb"), "class App; end\n");
      fs.writeFileSync(path.join(root, "script.coffee"), "console.log 'hi'\n");
      fs.writeFileSync(path.join(root, "doc.litcoffee"), "# Title\n");
      fs.writeFileSync(path.join(root, "style.css"), ".a { color: red; }\n");
      fs.writeFileSync(path.join(root, "style.scss"), ".a { color: red; }\n");
      fs.writeFileSync(path.join(root, "style.sass"), ".a\n  color: red\n");
      fs.writeFileSync(path.join(root, "style.less"), ".a { color: red; }\n");
      fs.writeFileSync(path.join(root, "view.slim"), "h1 Hello\n");
      fs.writeFileSync(path.join(root, "view.haml"), "%h1 Hello\n");
      fs.mkdirSync(path.join(root, "node_modules"));
      fs.writeFileSync(path.join(root, "node_modules", "ignored.js"), "ignored\n");

      const files = await scanWorkspaceFiles({ rootPath: root });
      const relativePaths = files.map((f) => f.relativePath).sort();
      expect(relativePaths).toEqual(
        expect.arrayContaining([
          "app.rb",
          "script.coffee",
          "doc.litcoffee",
          "style.css",
          "style.scss",
          "style.sass",
          "style.less",
          "view.slim",
          "view.haml",
        ]),
      );
      expect(relativePaths).not.toContain("node_modules/ignored.js");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/scanner.test.ts`
Expected: FAIL — scanner returns empty (extensions not in `ALLOWED_EXTENSIONS`).

- [ ] **Step 3: Add extension maps to `languages.ts`**

In `packages/indexer/src/languages.ts`, after `configExtensions` (line 39), add:

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

- [ ] **Step 4: Update `inferDocumentKind`**

In `packages/indexer/src/languages.ts`, the `inferDocumentKind` function (lines 49-65). After the `configExtensions` check (line 61), add checks for the new maps before the `text` fallback:

```ts
export function inferDocumentKind(filePath: string): LanguageInfo {
  const extension = path.extname(filePath).toLowerCase();

  if (markdownExtensions.has(extension)) {
    return { kind: "markdown", language: "markdown", extension };
  }

  if (codeExtensions.has(extension)) {
    return { kind: "code", language: codeExtensions.get(extension) ?? null, extension };
  }

  if (styleExtensions.has(extension)) {
    return { kind: "code", language: styleExtensions.get(extension) ?? null, extension };
  }

  if (templateExtensions.has(extension)) {
    return { kind: "code", language: templateExtensions.get(extension) ?? null, extension };
  }

  if (scriptExtensions.has(extension)) {
    return { kind: "code", language: scriptExtensions.get(extension) ?? null, extension };
  }

  if (configExtensions.has(extension)) {
    return { kind: "config", language: configExtensions.get(extension) ?? null, extension };
  }

  return { kind: "text", language: extension.slice(1) || null, extension };
}
```

- [ ] **Step 5: Update `scanner.ts`**

In `packages/indexer/src/scanner.ts`, update the import (line 10):

```ts
import {
  codeExtensions,
  configExtensions,
  markdownExtensions,
  scriptExtensions,
  styleExtensions,
  templateExtensions,
} from "./languages";
```

Update `DEFAULT_INCLUDE_PATTERNS` (lines 12-16):

```ts
const DEFAULT_INCLUDE_PATTERNS = [
  ...Array.from(codeExtensions.keys()).map((ext) => `**/*${ext}`),
  ...Array.from(configExtensions.keys()).map((ext) => `**/*${ext}`),
  ...Array.from(markdownExtensions).map((ext) => `**/*${ext}`),
  ...Array.from(styleExtensions.keys()).map((ext) => `**/*${ext}`),
  ...Array.from(templateExtensions.keys()).map((ext) => `**/*${ext}`),
  ...Array.from(scriptExtensions.keys()).map((ext) => `**/*${ext}`),
];
```

Update `ALLOWED_EXTENSIONS` (lines 18-22):

```ts
const ALLOWED_EXTENSIONS = new Set([
  ...codeExtensions.keys(),
  ...configExtensions.keys(),
  ...markdownExtensions,
  ...styleExtensions.keys(),
  ...templateExtensions.keys(),
  ...scriptExtensions.keys(),
]);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test tests/scanner.test.ts`
Expected: PASS.

- [ ] **Step 7: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/indexer/src/languages.ts packages/indexer/src/scanner.ts tests/scanner.test.ts
git commit -m "feat(indexer): add CoffeeScript/Slim/CSS/SCSS scanner support"
```

---

### Task 7: E2E Ruby indexing test with import edges

**Files:**

- Create: `tests/fixtures/ruby/user.rb`
- Create: `tests/fixtures/ruby/helper.rb`
- Create: `tests/fixtures/styles/app.scss`
- Create: `tests/fixtures/views/index.slim`
- Modify: `tests/index-workspace.test.ts` (extend)
- Test: `bun test tests/index-workspace.test.ts`

**Interfaces:**

- Consumes: `indexWorkspace`, `createRegistryRepository`, `createWorkspaceRepository` from existing test setup.

- [ ] **Step 1: Create fixtures**

Create `tests/fixtures/ruby/user.rb`:

```ruby
class User
  def greet(name)
    puts "Hello, #{name}"
  end

  def self.admin?
    true
  end

  class << self
    def bulk_create(users)
      users.map { |u| u }
    end
  end
end
```

Create `tests/fixtures/ruby/helper.rb`:

```ruby
require_relative "./user"

module Helper
  def self.process(user)
    user.greet("World")
  end
end
```

Create `tests/fixtures/styles/app.scss`:

```scss
.container {
  max-width: 1200px;
  .header {
    color: #333;
  }
}
```

Create `tests/fixtures/views/index.slim`:

```slim
h1 Welcome
p Hello world
```

- [ ] **Step 2: Write the failing E2E test**

In `tests/index-workspace.test.ts`, add a new test inside the `describe("indexWorkspace", ...)` block:

```ts
it("indexes Ruby files with symbols and require_relative import edges", async () => {
  fs.mkdirSync(path.join(workspaceRoot, "lib"), { recursive: true });
  fs.writeFileSync(
    path.join(workspaceRoot, "lib", "user.rb"),
    [
      "class User",
      "  def greet(name)",
      '    puts "Hello"',
      "  end",
      "",
      "  def self.admin?",
      "    true",
      "  end",
      "end",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(workspaceRoot, "lib", "helper.rb"),
    [
      'require_relative "./user"',
      "",
      "module Helper",
      "  def self.process(user)",
      "    user.greet",
      "  end",
      "end",
    ].join("\n"),
  );

  const workspace = await createRegistryRepository().ensureWorkspace({ rootPath: workspaceRoot });
  await indexWorkspace({ workspaceId: workspace.id });
  await ensureGraphReady(workspace.id);
  const repo = createWorkspaceRepository(workspaceRoot);

  // helper.rb should have an import edge to user.rb
  const importEdges = await repo.queryRaw(
    `SELECT count(*) AS c FROM graph_edges e
       JOIN graph_nodes n ON n.id = e.from_node_id
       WHERE e.type = 'imports' AND n.label = 'lib/helper.rb'`,
  );
  expect(Number(importEdges[0]?.c ?? 0)).toBe(1);

  // User class symbol should exist
  const userSymbol = await repo.queryRaw(
    `SELECT label FROM graph_nodes
       WHERE node_type = 'symbol' AND label = 'User::greet'`,
  );
  expect(userSymbol.length).toBeGreaterThan(0);
});

it("indexes SCSS and Slim files via FallbackParser with no symbols", async () => {
  fs.writeFileSync(path.join(workspaceRoot, "app.scss"), ".container { max-width: 1200px; }\n");
  fs.writeFileSync(path.join(workspaceRoot, "index.slim"), "h1 Welcome\np Hello\n");

  const workspace = await createRegistryRepository().ensureWorkspace({ rootPath: workspaceRoot });
  await indexWorkspace({ workspaceId: workspace.id });
  const repo = createWorkspaceRepository(workspaceRoot);

  const scssDoc = await repo.getDocumentByPath("app.scss");
  expect(scssDoc).not.toBeNull();
  const scssChunks = await repo.getChunksByDocument(scssDoc!.id);
  expect(scssChunks.length).toBeGreaterThanOrEqual(1);

  const slimDoc = await repo.getDocumentByPath("index.slim");
  expect(slimDoc).not.toBeNull();
  const slimChunks = await repo.getChunksByDocument(slimDoc!.id);
  expect(slimChunks.length).toBeGreaterThanOrEqual(1);

  // No symbol nodes for SCSS/Slim
  const symbolNodes = await repo.queryRaw(
    `SELECT count(*) AS c FROM graph_nodes WHERE node_type = 'symbol'`,
  );
  expect(Number(symbolNodes[0]?.c ?? 0)).toBe(0);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/index-workspace.test.ts -t "indexes Ruby files"`
Expected: FAIL — Ruby files not indexed (or import edge missing).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/index-workspace.test.ts -t "indexes Ruby files"`
Expected: PASS — Ruby files indexed with symbols and import edges.

If this fails because the WASM didn't load (parser falls back to regex), the regex fallback should still produce symbols and the import edge. If the import edge is missing, verify `resolveImport` Ruby branch is reached — check that `parsed.language` is `"ruby"` (not `null`).

- [ ] **Step 5: Run full test suite**

Run: `bun test tests/index-workspace.test.ts`
Expected: all tests PASS (including existing TS tests — no regression).

- [ ] **Step 6: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add tests/fixtures/ruby/ tests/fixtures/styles/ tests/fixtures/views/ tests/index-workspace.test.ts
git commit -m "test(indexer): E2E Ruby indexing with import edges and fallback chunking"
```

---

### Task 8: Full regression and build verification

**Files:**

- None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: all tests PASS.

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Build CLI**

Run: `pnpm build:cli`
Expected: build succeeds (tsup bundles the indexer including new `tree-sitter-ruby` WASM resolution).

- [ ] **Step 4: Verify CLI version**

Run: `bun apps/cli/dist/cli.cjs --version`
Expected: prints current version (no crash from new dependency).

- [ ] **Step 5: Smoke test in temp dir**

Run:

```bash
tmpdir=$(mktemp -d)
mkdir -p "$tmpdir/lib"
cat > "$tmpdir/lib/test.rb" << 'RUBY'
class App
  def run
    puts "running"
  end
end
RUBY
bun apps/cli/dist/cli.cjs init "$tmpdir" --no-index
bun apps/cli/dist/cli.cjs index "$tmpdir"
bun apps/cli/dist/cli.cjs status "$tmpdir"
rm -rf "$tmpdir"
```

Expected: `init`, `index`, `status` all succeed. `status` should show 1 file scanned.

- [ ] **Step 6: Commit if any fixes were needed**

If any fixes were needed during verification, commit them:

```bash
git add -A
git commit -m "fix(indexer): resolve build/test issues from Ruby indexing integration"
```

If no fixes needed, skip this step.

---

## Self-Review Notes

**Spec coverage:**

- Ruby dependency + extension registration → Task 1, Task 3 Step 1.
- `rubyConfig` with class/module/method/singleton_method/singleton_class/lambda → Task 4.
- `SymbolRule.contextOnly` + `contextKind` + `extractContextName(node, contextStack)` → Task 2.
- `ContextFrame` with `kind?: "class" | "module"` → Task 2.
- `qualifyCall` hook for `self.foo` → Task 2 (type), Task 4 (implementation).
- `singleton_class` context-only, walk back for class/module → Task 4.
- `class << self` nested in method → Task 4 test.
- `parseRuby` regex fallback with `stripNonCode({ hashComments: true })` → Task 3.
- Only `require_relative` in importPaths → Task 3 (regex), Task 4 (AST).
- Ruby branch in `resolveImport` → Task 5.
- `.rb` in `RESOLVABLE_SOURCE_EXTENSIONS` → Task 5.
- CoffeeScript/Slim/CSS/SCSS extension maps + scanner → Task 6.
- `.coffee.md` excluded → Task 6 (not in `scriptExtensions`).
- Test matrix: ruby-indexer, tree-sitter-parser, parser-registry, scanner, index-workspace → Tasks 3-7.

**Placeholder scan:** No TBD/TODO. All code blocks contain actual implementation.

**Type consistency:** `ContextFrame` used consistently across `parse.ts`, `configs.ts`. `qualifyCall` signature matches between `LanguageConfig` definition and `rubyQualifyCall` implementation. `extractContextName` signature `(node, contextStack)` matches between `SymbolRule` definition, `walkTree` call site, Rust `impl_item` update, and Ruby `singleton_class` implementation.
