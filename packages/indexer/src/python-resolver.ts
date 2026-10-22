import type { ImportBinding } from "./parsers/types";

/**
 * Bounded Python binding extraction, shadow marking, and module/call
 * resolution for graph edges. Everything derives from source text and the
 * workspace file list — no Python runtime is consulted. See
 * docs/agent-devkit/changes/2026-10-20-39-python-index-accuracy.
 *
 * - Bindings: one extractor reads logical import statements from the source
 *   (comments/strings blanked; parenthesized and backslash-continued
 *   statements joined) so native, WASM, and regex results carry identical
 *   `ImportBinding` records. An import inside a function or class body gets
 *   `scopeStart`/`scopeEnd` set to the enclosing symbol's line range — it
 *   applies only to calls inside that scope and conflicts with any other
 *   binding of the same name.
 * - Modules: a module path resolves through source roots — the workspace
 *   root plus each non-package ancestor of the importing file; the nearest
 *   root wins and a root holding both `a.py` and `a/__init__.py` is
 *   ambiguous and resolves nothing.
 * - Module symbols: a name resolves to a top-level function or class, then
 *   to a named re-export (`from .mod import f`, up to three modules deep
 *   with a cycle guard), then to a submodule of a package `__init__.py`.
 *   Star re-exports never expand.
 * - Calls: bare names walk enclosing function scopes (class scopes are
 *   skipped), then the module level, then a unique import binding. Dotted
 *   calls are walked segment by segment from a bound root; `self`/`cls`
 *   resolve to the enclosing class's own method; `Class.name()` resolves
 *   only for statically bound classes. Conflicting bindings, unresolved
 *   roots, and deeper member chains drop the call.
 * - Shadowing is function-granular: a call whose root name is bound as a
 *   local value by the calling function or an enclosing function is marked
 *   `shadowedLocal` at parse time and never resolves through imports.
 *   `self`/`cls` are exempt.
 */

// ── Source blanking ──

/** Blank comments and string literal contents, preserving byte offsets and
 *  newlines so positions stay meaningful. Handles `'`/`"`/`'''`/`"""`
 *  literals with r/b/f/u prefixes and escapes in non-raw strings. */
export function blankPythonTrivia(source: string): string {
  const out = source.split("");
  let i = 0;
  while (i < out.length) {
    const ch = out[i];
    if (ch === "#") {
      while (i < out.length && out[i] !== "\n") out[i++] = " ";
      continue;
    }
    // String literal: optional prefix (r/b/f/u combos) then quote. The
    // prefix must not be a tail of an identifier (`for x in range` etc.).
    let j = i;
    while (j < out.length && /[rRbBuUfF]/.test(out[j])) j++;
    const prevWord = i > 0 && /\w/.test(out[i - 1]);
    if (!prevWord && j < out.length && (out[j] === '"' || out[j] === "'")) {
      const quote = out[j];
      const prefix = source.slice(i, j);
      const raw = /[rR]/.test(prefix);
      const triple = out[j + 1] === quote && out[j + 2] === quote;
      for (let k = i; k < j + (triple ? 3 : 1); k++) out[k] = " ";
      i = j + (triple ? 3 : 1);
      while (i < out.length) {
        if (!raw && out[i] === "\\") {
          out[i] = " ";
          if (i + 1 < out.length) out[i + 1] = " ";
          i += 2;
          continue;
        }
        if (triple) {
          if (out[i] === quote && out[i + 1] === quote && out[i + 2] === quote) {
            out[i] = " ";
            out[i + 1] = " ";
            out[i + 2] = " ";
            i += 3;
            break;
          }
        } else if (out[i] === quote) {
          out[i++] = " ";
          break;
        } else if (out[i] === "\n") {
          break; // unterminated single-line string
        }
        if (out[i] !== "\n") out[i] = " ";
        i++;
      }
      continue;
    }
    i++;
  }
  return out.join("");
}

// ── Logical statements ──

export interface PythonStatement {
  text: string;
  /** 1-based line where the statement starts. */
  startLine: number;
}

/** Split blanked source into logical statements: `;` at bracket depth 0
 *  separates, bracket-open lines and trailing backslashes continue. */
export function pythonLogicalStatements(blanked: string, firstLine = 1): PythonStatement[] {
  const statements: PythonStatement[] = [];
  let cur = "";
  let curStart = 0;
  let depth = 0;
  const push = () => {
    if (cur.trim()) statements.push({ text: cur, startLine: curStart });
    cur = "";
  };
  const lines = blanked.split("\n");
  for (let li = 0; li < lines.length; li++) {
    const lineNo = firstLine + li;
    for (const c of lines[li]) {
      if (depth === 0 && c === ";") {
        push();
        continue;
      }
      if (!cur.trim()) curStart = lineNo;
      cur += c;
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);
    }
    const trimmedEnd = cur.trimEnd();
    if (depth <= 0 && !trimmedEnd.endsWith("\\")) {
      push();
    } else {
      // A trailing backslash continues the statement — drop the marker so
      // `import a, \` + `b` parses as `import a, b`.
      cur = trimmedEnd.endsWith("\\") ? `${trimmedEnd.slice(0, -1)} ` : `${cur}\n`;
    }
  }
  push();
  return statements;
}

// ── Import bindings ──

interface SymbolRange {
  name: string;
  symbolType?: string;
  type?: string;
  startLine?: number;
  endLine?: number;
}

/**
 * Extract import bindings from source. Produces the shared `ImportBinding`
 * shape: `import a.b.c` binds `a` to module `a.b.c`; `import a.b as m`
 * binds `m`; `from p import n as m` binds `m`; `from . import x` binds `x`
 * to module `.`; `from p import *` yields a marker binding with empty
 * `local` and imported `*`.
 *
 * When `symbols` is given, an import that sits inside a function or class
 * body gets `scopeStart`/`scopeEnd` = that symbol's line range — the
 * binding is function/class-local, not module-level.
 */
export function extractPythonBindings(
  source: string,
  symbols?: Array<SymbolRange>,
): ImportBinding[] {
  const statements = pythonLogicalStatements(blankPythonTrivia(source));
  const scopeOf = (line: number): { start: number; end: number } | null => {
    if (!symbols) return null;
    let best: { start: number; end: number } | null = null;
    for (const sym of symbols) {
      if (sym.startLine === undefined || sym.endLine === undefined) continue;
      if (line < sym.startLine || line > sym.endLine) continue;
      const size = sym.endLine - sym.startLine;
      if (!best || size < best.end - best.start) {
        best = { start: sym.startLine, end: sym.endLine };
      }
    }
    return best;
  };

  const bindings: ImportBinding[] = [];
  for (const stmt of statements) {
    const s = stmt.text.trim();
    if (!s) continue;
    const scope = scopeOf(stmt.startLine);
    const scoped = scope && symbols ? { scopeStart: scope.start, scopeEnd: scope.end } : {};

    const fromMatch = /^from\s+([.\w]+)\s+import\s+([\s\S]+)$/.exec(s);
    if (fromMatch) {
      const modulePath = fromMatch[1];
      let names = fromMatch[2].trim();
      if (names.startsWith("(") && names.endsWith(")")) {
        names = names.slice(1, -1);
      }
      for (const item of names.split(",")) {
        const part = item.trim();
        if (!part) continue;
        if (part === "*") {
          bindings.push({ local: "", module: modulePath, imported: "*", ...scoped });
          continue;
        }
        const asMatch = /^([\w.]+)\s+as\s+(\w+)$/.exec(part);
        if (asMatch) {
          bindings.push({ local: asMatch[2], module: modulePath, imported: asMatch[1], ...scoped });
        } else if (/^[\w.]+$/.test(part)) {
          bindings.push({
            local: part.split(".").pop()!,
            module: modulePath,
            imported: part,
            ...scoped,
          });
        }
      }
      continue;
    }
    const importMatch = /^import\s+([\s\S]+)$/.exec(s);
    if (importMatch) {
      for (const item of importMatch[1].split(",")) {
        const part = item.trim();
        if (!part) continue;
        const asMatch = /^([\w.]+)\s+as\s+(\w+)$/.exec(part);
        if (asMatch) {
          bindings.push({ local: asMatch[2], module: asMatch[1], imported: "*", ...scoped });
        } else if (/^[\w.]+$/.test(part)) {
          bindings.push({ local: part.split(".")[0], module: part, imported: "*", ...scoped });
        }
      }
    }
  }
  return bindings;
}

/** The import paths a binding set implies — module path plus one joined
 *  path per named import. Used to derive regex-path `importPaths` from the
 *  same statements the bindings come from, and asserted equal to the AST
 *  parsers' `importPaths` by test. */
export function pythonImpliedImportPaths(bindings: ImportBinding[]): string[] {
  const paths: string[] = [];
  for (const binding of bindings) {
    paths.push(binding.module);
    if (binding.imported !== "*") {
      paths.push(
        binding.module.endsWith(".")
          ? `${binding.module}${binding.imported}`
          : `${binding.module}.${binding.imported}`,
      );
    }
  }
  return [...new Set(paths)];
}

// ── Function-granular local names (shadowing) ──

const PYTHON_IDENT = /^[A-Za-z_]\w*$/;
const CASE_KEYWORDS = new Set([
  "case",
  "as",
  "if",
  "and",
  "or",
  "not",
  "in",
  "is",
  "None",
  "True",
  "False",
]);

/** Identifier names bound by a target fragment (`x`, `a, b`, `(a, b)`,
 *  `[a, *rest]`, `x: int`). Attribute/subscript targets (`x.y`, `x[0]`) do
 *  not rebind the root and produce nothing. */
function namesInTarget(target: string): string[] {
  const text = target.trim();
  if (!text) return [];
  // Unwrap one level of tuple/list parens.
  if (
    (text.startsWith("(") && text.endsWith(")")) ||
    (text.startsWith("[") && text.endsWith("]"))
  ) {
    return namesInTarget(text.slice(1, -1));
  }
  const names: string[] = [];
  // Split top-level commas (no bracket nesting survives blanking anyway).
  for (const item of text.split(",")) {
    let piece = item.trim();
    if (!piece) continue;
    piece = piece.replace(/^\*+/, "").trim();
    // `x: int` annotated target — keep the name before the annotation.
    const colon = piece.indexOf(":");
    if (colon >= 0) piece = piece.slice(0, colon).trim();
    if (PYTHON_IDENT.test(piece)) names.push(piece);
  }
  return names;
}

/** Parameter names from a `def`/`lambda` parameter list text (without the
 *  surrounding parens). */
function namesInParams(params: string): string[] {
  const names: string[] = [];
  for (const item of params.split(",")) {
    let piece = item.trim();
    if (!piece || piece === "/" || piece === "*") continue;
    piece = piece.replace(/^\*{1,2}/, "");
    const m = /^([A-Za-z_]\w*)/.exec(piece);
    if (m) names.push(m[1]);
  }
  return names;
}

/** Slice a balanced `(...)` region starting at `open` (the `(` index). */
function parenSlice(text: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

/** Bound-name contributions of one logical statement. `import`/`from`
 *  statements bind modules through `ImportBinding`, not locals, so they
 *  produce nothing here. */
function boundNamesInStatement(stmt: string, out: Set<string>): void {
  const s = stmt.trim();
  if (!s || /^import\s/.test(s) || /^from\s/.test(s)) return;

  // def/class headers — nested definitions bind their name in the parent.
  const defMatch = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(s);
  if (defMatch) {
    out.add(defMatch[1]);
    const open = s.indexOf("(", defMatch[0].length - 1);
    const params = open >= 0 ? parenSlice(s, open) : null;
    if (params !== null) for (const n of namesInParams(params)) out.add(n);
    return;
  }
  const classMatch = /^class\s+([A-Za-z_]\w*)/.exec(s);
  if (classMatch) {
    out.add(classMatch[1]);
    return;
  }

  // for/comprehension targets — `for x, y in`, anywhere in the statement.
  for (const m of s.matchAll(/\bfor\s+([^=]+?)\s+in\s/g)) {
    for (const n of namesInTarget(m[1])) out.add(n);
  }

  // `with … as x` / `except … as x` names.
  if (/\bwith\b|\bexcept\b/.test(s)) {
    for (const m of s.matchAll(/\bas\s+([A-Za-z_]\w*)/g)) out.add(m[1]);
  }

  // Walrus targets.
  for (const m of s.matchAll(/\b([A-Za-z_]\w*)\s*:=/g)) out.add(m[1]);

  // Lambda parameters.
  for (const m of s.matchAll(/\blambda\b/g)) {
    let i = m.index! + m[0].length;
    const start = i;
    let depth = 0;
    for (; i < s.length; i++) {
      const c = s[i];
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth--;
      else if (c === ":" && depth === 0) break;
    }
    for (const n of namesInParams(s.slice(start, i))) out.add(n);
  }

  // `case` pattern captures: `as name`, and bare identifiers not followed
  // by `(`/`.`/`=` and not preceded by `.` (class/enum patterns excluded).
  if (/^case\b/.test(s)) {
    const pat = s.replace(/:\s*$/, "");
    for (const m of pat.matchAll(/\b([A-Za-z_]\w*)/g)) {
      const name = m[1];
      if (CASE_KEYWORDS.has(name)) continue;
      const index = m.index!;
      const next = pat[index + name.length];
      const prev = pat[index - 1];
      if (next === "(" || next === "." || next === "=" || prev === ".") continue;
      out.add(name);
    }
    return;
  }

  // Assignment targets: every `=` at bracket depth 0 that is not a
  // comparison (`==`, `<=`, `>=`, `!=`) or walrus (`:=`). Handles augmented
  // and chained assignments; the fragment before each `=` is a target.
  let segStart = 0;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "=" && depth === 0) {
      const prev = s[i - 1] ?? "";
      const next = s[i + 1] ?? "";
      if (next === "=" || prev === "=" || prev === "!" || prev === ":") continue;
      if (prev === "<" || prev === ">") {
        // `<<=`/`>>=` augmented — single `<`/`>` are comparisons.
        const before = s[i - 2] ?? "";
        if (before !== prev) continue;
        for (const n of namesInTarget(s.slice(segStart, i - 2))) out.add(n);
        segStart = i + 1;
        continue;
      }
      let end = i;
      if ("+-*/%@&|^".includes(prev)) {
        end = i - 1;
        // `**=`/`//=` double operators.
        if ((prev === "*" || prev === "/") && s[end - 1] === prev) end = i - 2;
      }
      for (const n of namesInTarget(s.slice(segStart, end))) out.add(n);
      segStart = i + 1;
    }
  }
}

/** Local names bound inside `[startLine, endLine]` (1-based, inclusive). */
function boundNamesInRange(
  blankedLines: string[],
  startLine: number,
  endLine: number,
): Set<string> {
  const names = new Set<string>();
  const slice = blankedLines.slice(startLine - 1, endLine).join("\n");
  for (const stmt of pythonLogicalStatements(slice)) {
    boundNamesInStatement(stmt.text, names);
  }
  return names;
}

/**
 * Mark calls whose callee root is bound as a local value in the calling
 * function or an enclosing function. Mutates the call records in place and
 * returns the same array. `self`/`cls` are exempt.
 */
export function markPythonCallShadowing<
  T extends { callerName: string; calleeName: string; shadowedLocal?: boolean },
>(content: string, symbols: SymbolRange[], calls: T[]): T[] {
  const blankedLines = blankPythonTrivia(content).split("\n");
  const symbolByName = new Map(symbols.map((s) => [s.name, s]));
  const boundCache = new Map<string, Set<string>>();

  const boundForCaller = (callerName: string): Set<string> => {
    const cached = boundCache.get(callerName);
    if (cached) return cached;
    const caller = symbolByName.get(callerName);
    let range = caller;
    // Outermost enclosing *function* wins — a whole-function scan covers
    // the caller plus every nested definition inside the same function.
    const parts = callerName.split("::");
    for (let i = 1; i < parts.length; i++) {
      const ancestor = symbolByName.get(parts.slice(0, i).join("::"));
      if (ancestor && (ancestor.symbolType ?? ancestor.type) === "function") {
        range = ancestor;
        break;
      }
    }
    const bound =
      range && range.startLine !== undefined && range.endLine !== undefined
        ? boundNamesInRange(blankedLines, range.startLine, range.endLine)
        : new Set<string>();
    boundCache.set(callerName, bound);
    return bound;
  };

  for (const call of calls) {
    const root = call.calleeName.split(".")[0];
    if (root === "self" || root === "cls") continue;
    if (boundForCaller(call.callerName).has(root)) {
      call.shadowedLocal = true;
    }
  }
  return calls;
}

// ── Module resolution ──

const normRel = (p: string) => p.split("\\").join("/").replace(/^\.\//, "");
const dirOf = (rel: string) => {
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
};

interface ModuleLookup {
  file?: string;
  /** Both `a.py` and `a/__init__.py` exist under this base — ambiguous. */
  ambiguous?: boolean;
}

export interface PythonModuleResolver {
  /** Resolve an absolute (`pkg.mod`) or dot-relative (`.mod`, `..`) module
   *  path to a workspace-relative .py file, or null. */
  resolveModule(importerRel: string, modulePath: string): string | null;
}

/** Create a resolver over the known workspace file set (normalized
 *  workspace-relative paths). */
export function createPythonModuleResolver(pythonFiles: Iterable<string>): PythonModuleResolver {
  const fileSet = new Set([...pythonFiles].map(normRel));
  const isPkgDir = (dir: string) => fileSet.has(dir ? `${dir}/__init__.py` : "__init__.py");

  /** Source roots of an importer: the workspace root plus each ancestor
   *  directory that is not itself a package, nearest first. */
  function sourceRoots(importerRel: string): string[] {
    const roots: string[] = [];
    let dir = dirOf(importerRel);
    while (dir) {
      if (!isPkgDir(dir)) roots.push(dir);
      dir = dirOf(dir);
    }
    roots.push("");
    return roots;
  }

  function moduleIn(base: string, segs: string[]): ModuleLookup {
    const p = segs.join("/");
    const py = `${base ? `${base}/` : ""}${p}.py`;
    const init = `${base ? `${base}/` : ""}${p}/__init__.py`;
    const hasPy = fileSet.has(py);
    const hasInit = fileSet.has(init);
    if (hasPy && hasInit) return { ambiguous: true };
    if (hasPy) return { file: py };
    if (hasInit) return { file: init };
    return {};
  }

  function resolveModule(importerRel: string, modulePath: string): string | null {
    const importer = normRel(importerRel);
    if (modulePath.startsWith(".")) {
      const m = /^(\.*)(.*)$/.exec(modulePath);
      if (!m) return null;
      const level = m[1].length;
      const rest = m[2];
      let base = dirOf(importer);
      for (let i = 1; i < level; i++) {
        if (!base) return null;
        base = dirOf(base);
      }
      if (!rest) {
        // `from . import x` — the module is the package directory itself.
        return isPkgDir(base) ? (base ? `${base}/__init__.py` : "__init__.py") : null;
      }
      return moduleIn(base, rest.split(".")).file ?? null;
    }
    const segs = modulePath.split(".").filter(Boolean);
    if (segs.length === 0) return null;
    for (const root of sourceRoots(importer)) {
      const found = moduleIn(root, segs);
      if (found.ambiguous) return null;
      if (found.file) return found.file;
    }
    return null;
  }

  return { resolveModule };
}

// ── Call resolution ──

export interface PythonSymbol extends SymbolRange {
  name: string;
}

export interface PythonResolver extends PythonModuleResolver {
  /** Resolve a Python call to a unique in-workspace (file, symbol) target,
   *  or null when the call is external, ambiguous, shadowed, or dynamic. */
  resolveCall(call: {
    callerName: string;
    calleeName: string;
    filePath: string;
    shadowedLocal?: boolean;
  }): { filePath: string; symbolName: string } | null;
}

type ResolvedValue =
  | { kind: "module"; file: string }
  | { kind: "symbol"; file: string; name: string; symbolType: string };

export function createPythonResolver(options: {
  /** Workspace-relative paths of every indexed .py file. */
  pythonFiles: Iterable<string>;
  /** Symbols parsed for a file (name + symbolType + line range). */
  symbolsFor: (file: string) => PythonSymbol[] | undefined;
  /** Import bindings for a file (extractPythonBindings output). */
  bindingsFor: (file: string) => ImportBinding[] | undefined;
}): PythonResolver {
  const { resolveModule } = createPythonModuleResolver(options.pythonFiles);
  const pyFileSet = new Set([...options.pythonFiles].map(normRel));

  const symbolTypeOf = (s: PythonSymbol) => s.symbolType ?? s.type ?? "";

  // Per-file top-level (non `::`) symbols by name.
  const topLevelCache = new Map<string, Map<string, PythonSymbol[]> | null>();
  function topLevel(file: string): Map<string, PythonSymbol[]> | null {
    if (topLevelCache.has(file)) return topLevelCache.get(file)!;
    const symbols = options.symbolsFor(file);
    if (!symbols) {
      topLevelCache.set(file, null);
      return null;
    }
    const byName = new Map<string, PythonSymbol[]>();
    for (const sym of symbols) {
      if (sym.name.includes("::")) continue;
      const list = byName.get(sym.name) ?? [];
      list.push(sym);
      byName.set(sym.name, list);
    }
    topLevelCache.set(file, byName);
    return byName;
  }

  // Depth-0 entry results are context-free (fresh visited set) and safe to
  // memoize; deeper re-export walks stay uncached since they depend on the
  // caller's visited set.
  const symbolCache = new Map<string, ResolvedValue | null>();
  /** Resolve `name` as an attribute of module file `modFile`: top-level
   *  function/class → module-scope named re-export binding (≤3 modules
   *  deep, cycle guard) → submodule. More than one candidate at a step
   *  resolves to nothing. */
  function resolveModuleSymbol(
    modFile: string,
    name: string,
    visited: Set<string>,
    depth: number,
  ): ResolvedValue | null {
    const key = `${modFile}\0${name}`;
    if (visited.has(key) || depth > 3) return null;
    if (depth === 0) {
      const cached = symbolCache.get(key);
      if (cached !== undefined) return cached;
      visited.add(key);
      const result = resolveModuleSymbolInner(modFile, name, visited, depth);
      symbolCache.set(key, result);
      return result;
    }
    visited.add(key);
    return resolveModuleSymbolInner(modFile, name, visited, depth);
  }

  function resolveModuleSymbolInner(
    modFile: string,
    name: string,
    visited: Set<string>,
    depth: number,
  ): ResolvedValue | null {
    // 1. Top-level function or class of the module.
    const syms = topLevel(modFile)?.get(name) ?? [];
    if (syms.length > 1) return null;
    if (syms.length === 1) {
      return { kind: "symbol", file: modFile, name, symbolType: symbolTypeOf(syms[0]) };
    }
    // 2. Module-scope named re-export bindings (function/class-local
    //    imports are not re-exports).
    const candidates = new Map<string, ResolvedValue>();
    for (const binding of options.bindingsFor(modFile) ?? []) {
      if (binding.local !== name || binding.imported === "*") continue;
      if (binding.scopeStart !== undefined) continue;
      const target = resolveModule(modFile, binding.module);
      if (!target) continue;
      const resolved = resolveModuleSymbol(target, binding.imported, visited, depth + 1);
      if (resolved) {
        candidates.set(
          `${resolved.kind}\0${resolved.file}\0${resolved.kind === "symbol" ? resolved.name : ""}`,
          resolved,
        );
      }
    }
    if (candidates.size > 1) return null;
    if (candidates.size === 1) return [...candidates.values()][0];
    // 3. Submodule of a package (__init__.py) file.
    if (modFile.endsWith("/__init__.py") || modFile === "__init__.py") {
      const dir = dirOf(modFile);
      const base = dir ? `${dir}/` : "";
      const py = `${base}${name}.py`;
      const init = `${base}${name}/__init__.py`;
      const hasPy = pyFileSet.has(py);
      const hasInit = pyFileSet.has(init);
      if (hasPy && hasInit) return null; // ambiguous
      if (hasPy) return { kind: "module", file: py };
      if (hasInit) return { kind: "module", file: init };
    }
    return null;
  }

  /**
   * The binding a local name has in a file for a given caller. All bindings
   * of the name file-wide must agree on (module, imported) — a second
   * distinct binding site (module + function-local, or try/except twins)
   * makes the name ambiguous and drops every call through it. A scoped
   * (function/class-local) binding applies only to callers inside its
   * range; a class-scope binding is visible only to the class body itself
   * since class scopes are invisible to nested functions.
   */
  function uniqueBinding(
    file: string,
    local: string,
    callerSym: PythonSymbol | undefined,
  ): ImportBinding | null | "conflict" {
    const matches = (options.bindingsFor(file) ?? []).filter((b) => b.local === local);
    if (matches.length === 0) return null;
    const distinct = new Set(matches.map((b) => `${b.module}\0${b.imported}`));
    if (distinct.size > 1) return "conflict";
    const applies = matches.some((binding) => {
      if (binding.scopeStart === undefined || binding.scopeEnd === undefined) return true;
      if (callerSym?.startLine === undefined || callerSym?.endLine === undefined) return false;
      if (callerSym.startLine < binding.scopeStart || callerSym.endLine > binding.scopeEnd) {
        return false;
      }
      const scopeSym = options
        .symbolsFor(file)
        ?.find((s) => s.startLine === binding.scopeStart && s.endLine === binding.scopeEnd);
      if (scopeSym && symbolTypeOf(scopeSym) === "class" && scopeSym.name !== callerSym.name) {
        return false;
      }
      return true;
    });
    return applies ? matches[0] : null;
  }

  /** Symbols matching `name` in a file — full `A::B` names included. */
  function symbolCount(file: string, name: string): number {
    let count = 0;
    for (const sym of options.symbolsFor(file) ?? []) if (sym.name === name) count++;
    return count;
  }

  /** Nearest enclosing class symbol of a caller name (`K::m` → `K`), or
   *  null. Class ancestors only — function ancestors are skipped over. */
  function enclosingClass(file: string, callerName: string): string | null {
    const parts = callerName.split("::");
    const syms = options.symbolsFor(file);
    for (let i = parts.length - 1; i >= 1; i--) {
      const prefix = parts.slice(0, i).join("::");
      const sym = syms?.find((s) => s.name === prefix);
      if (sym && symbolTypeOf(sym) === "class") return prefix;
    }
    return null;
  }

  function isFunctionSymbol(file: string, name: string): boolean {
    const sym = options.symbolsFor(file)?.find((s) => s.name === name);
    return sym ? symbolTypeOf(sym) === "function" : false;
  }

  function resolveCall(call: {
    callerName: string;
    calleeName: string;
    filePath: string;
    shadowedLocal?: boolean;
  }): { filePath: string; symbolName: string } | null {
    const file = call.filePath;
    const segs = call.calleeName.split(".");
    const root = segs[0];
    const callerSym = options.symbolsFor(file)?.find((s) => s.name === call.callerName);

    if (segs.length === 1) {
      // ── Bare call: enclosing scopes (the caller's own range counts;
      //    class ancestors are skipped), then module level, then a unique
      //    import binding. ──
      if (PYTHON_IDENT.test(root)) {
        const parts = call.callerName.split("::");
        for (let i = parts.length; i >= 1; i--) {
          const prefix = parts.slice(0, i).join("::");
          if (i < parts.length && !isFunctionSymbol(file, prefix)) continue;
          const candidate = `${prefix}::${root}`;
          const count = symbolCount(file, candidate);
          if (count === 1) return { filePath: file, symbolName: candidate };
          if (count > 1) return null; // ambiguous at this scope
        }
      }
      const moduleHits = topLevel(file)?.get(root) ?? [];
      const bound = uniqueBinding(file, root, callerSym);
      if (moduleHits.length > 1) return null;
      if (moduleHits.length === 1) {
        // Module-level definition + an import binding, or a shadowing
        // local → the name is ambiguous/overridden; no edge.
        if (bound || call.shadowedLocal) return null;
        return { filePath: file, symbolName: root };
      }
      if (call.shadowedLocal || !bound || bound === "conflict") return null;
      if (bound.imported === "*") return null; // bound name is a module
      const modFile = resolveModule(file, bound.module);
      if (!modFile) return null;
      const resolved = resolveModuleSymbol(modFile, bound.imported, new Set(), 0);
      if (resolved?.kind === "symbol") {
        return { filePath: resolved.file, symbolName: resolved.name };
      }
      return null;
    }

    // ── Dotted calls ──
    if (!PYTHON_IDENT.test(root)) return null;

    if (root === "self" || root === "cls") {
      if (segs.length !== 2) return null;
      const klass = enclosingClass(file, call.callerName);
      if (!klass) return null;
      const target = `${klass}::${segs[1]}`;
      return symbolCount(file, target) === 1 ? { filePath: file, symbolName: target } : null;
    }

    if (call.shadowedLocal) return null;

    // `Class.name()` — Class is a unique top-level class of this file, or
    // an imported name that resolves to a class. Both present → drop.
    const classHits = (topLevel(file)?.get(root) ?? []).filter((s) => symbolTypeOf(s) === "class");
    const bound = uniqueBinding(file, root, callerSym);
    let importedClass: Extract<ResolvedValue, { kind: "symbol" }> | null = null;
    if (bound && bound !== "conflict" && bound.imported !== "*") {
      const modFile = resolveModule(file, bound.module);
      if (modFile) {
        const r = resolveModuleSymbol(modFile, bound.imported, new Set(), 0);
        if (r?.kind === "symbol" && r.symbolType === "class") importedClass = r;
      }
    }
    if (classHits.length + (importedClass ? 1 : 0) === 1) {
      if (segs.length !== 2) return null;
      const cls = classHits.length === 1 ? { file, name: root } : importedClass!;
      const target = `${cls.name}::${segs[1]}`;
      return symbolCount(cls.file, target) === 1
        ? { filePath: cls.file, symbolName: target }
        : null;
    }
    if (classHits.length > 1 || bound === "conflict" || !bound) return null;

    // Module- and name-bound dotted walks.
    let current: ResolvedValue | null;
    if (bound.imported === "*") {
      // Unaliased `import a.b.c` binds the top-level package `a`; the
      // callee's remaining segments walk submodules from there.
      const moduleName = bound.module.startsWith(".")
        ? bound.module
        : bound.module.includes(".") && bound.local === bound.module.split(".")[0]
          ? bound.module.split(".")[0]
          : bound.module;
      const modFile = resolveModule(file, moduleName);
      if (!modFile) return null;
      current = { kind: "module", file: modFile };
    } else {
      const modFile = resolveModule(file, bound.module);
      if (!modFile) return null;
      current = resolveModuleSymbol(modFile, bound.imported, new Set(), 0);
      if (!current) return null;
    }

    const rest = segs.slice(1);
    for (let i = 0; i < rest.length; i++) {
      const seg = rest[i];
      if (current.kind === "module") {
        current = resolveModuleSymbol(current.file, seg, new Set(), 0);
        if (!current) return null;
      } else {
        // A class accepts exactly one further segment, resolved to its
        // own method in the same file — never through inheritance.
        if (current.symbolType !== "class" || i !== rest.length - 1) return null;
        const target: string = `${current.name}::${seg}`;
        current =
          symbolCount(current.file, target) === 1
            ? { kind: "symbol", file: current.file, name: target, symbolType: "function" }
            : null;
        if (!current) return null;
      }
    }
    return current.kind === "symbol" ? { filePath: current.file, symbolName: current.name } : null;
  }

  return { resolveModule, resolveCall };
}
