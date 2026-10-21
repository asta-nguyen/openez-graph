import fs from "node:fs";
import path from "node:path";

/**
 * Bounded Go module/package resolution for graph edges. Reads `go.mod`
 * module directives and Go source headers at graph-build time; nothing is
 * persisted. See docs/agent-devkit/changes/archive/2026-10-20-39-go-indexing-accuracy.
 *
 * - Module matching: longest `/`-bounded module-path prefix wins; a tie goes
 *   to the importing file's own module.
 * - Package identity: (directory, declared package name). `_test.go` files
 *   never provide import targets; a directory with more than one non-test
 *   package name resolves to nothing.
 * - Import names: explicit alias wins; an unaliased workspace import binds
 *   the target's declared package name; external/blank/dot imports bind no
 *   name. Two imports binding one name drop calls through it.
 * - Shadowing is function-granular: receivers, parameters, result names, and
 *   `:=`/`var`/`const` names inside a function drop calls whose root matches.
 */

const IGNORED_DIR = /^(?:vendor|testdata|_.*|\..*)$/;

export interface GoFileContext {
  /** Declared `package` name of this file, or null when unreadable. */
  packageName: string | null;
  /** Bound import name -> resolved workspace package. */
  imports: Map<string, { dir: string; packageName: string }>;
  /** Bound names seen more than once across this file's imports. */
  ambiguousNames: Set<string>;
  /** Local names per caller symbol name (`Func` or `Type::Method`). */
  localNamesByCaller: Map<string, Set<string>>;
  /** Workspace-relative directory of the package this file belongs to. */
  packageDir: string;
}

interface GoModule {
  /** Module path from the `module` directive. */
  modulePath: string;
  /** Workspace-relative directory containing go.mod. */
  dir: string;
}

export interface GoResolver {
  /** Per-file Go context: package decl, bound imports, local names. */
  contextForFile(relPath: string): GoFileContext | null;
  /** Resolve an import specifier to {dir, packageName} or null. */
  packageForImport(
    importerRel: string,
    importPath: string,
  ): { dir: string; packageName: string } | null;
  /** Workspace files in a directory declaring `packageName`. When
   *  `includeTests` is false, `_test.go` files are excluded (import-target
   *  eligibility); when true, `_test.go` files declaring the same package
   *  name join the caller's own package. */
  packageFiles(dir: string, packageName: string, includeTests: boolean): string[];
}

/** Blank comments (and optionally string contents), preserving byte offsets
 *  and newlines so positions stay meaningful. Import parsing blanks comments
 *  only — import paths are string literals and must survive; the header
 *  boundary (first top-level keyword) already excludes import-like text in
 *  strings, which can only appear inside declarations. */
function blankGo(source: string, blankStrings: boolean): string {
  const out = source.split("");
  let i = 0;
  while (i < out.length) {
    const ch = out[i];
    if (ch === "/" && out[i + 1] === "/") {
      while (i < out.length && out[i] !== "\n") out[i++] = " ";
      continue;
    }
    if (ch === "/" && out[i + 1] === "*") {
      out[i] = " ";
      out[i + 1] = " ";
      i += 2;
      while (i < out.length && !(out[i] === "*" && out[i + 1] === "/")) {
        if (out[i] !== "\n") out[i] = " ";
        i++;
      }
      if (i < out.length) {
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
      }
      continue;
    }
    if (blankStrings && (ch === '"' || ch === "'" || ch === "`")) {
      const quote = ch;
      out[i++] = " ";
      while (i < out.length) {
        if (quote !== "`" && out[i] === "\\") {
          out[i] = " ";
          if (i + 1 < out.length) out[i + 1] = " ";
          i += 2;
          continue;
        }
        if (out[i] === quote) {
          out[i++] = " ";
          break;
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

/** Comments and string/rune literal contents blanked. */
export function blankGoTrivia(source: string): string {
  return blankGo(source, true);
}

/** Comments blanked; string contents kept. */
export function blankGoComments(source: string): string {
  return blankGo(source, false);
}

/** `package X` declaration from blanked source, or null. */
function packageDeclOf(blanked: string): string | null {
  const m = /^[ \t]*package[ \t]+([A-Za-z_]\w*)/m.exec(blanked);
  return m ? m[1] : null;
}

/** Read the `module` directive from go.mod text (comments stripped, optional
 *  quotes removed). */
function moduleDirectiveOf(text: string): string | null {
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\/\/.*$/, "").trim();
    if (/^module\s+\(/.test(line)) break; // `module (…)` blocks unsupported
    const m = /^module\s+(?:"([^"]+)"|`([^`]+)`|(\S+))/.exec(line);
    if (m) {
      const p = m[1] ?? m[2] ?? m[3];
      if (/^[A-Za-z0-9][\w.\-~/]*$/.test(p)) return p;
    }
    if (line.startsWith("module")) break; // `module (…)` blocks unsupported
  }
  return null;
}

interface ImportSpec {
  /** Written alias, `_`, `.`, or null when unaliased. */
  alias: string | null;
  path: string;
}

/** Parse the import header: everything up to the first top-level
 *  `func`/`type`/`var`/`const` keyword outside strings/comments. */
function extractImportSpecs(blanked: string): ImportSpec[] {
  const specs: ImportSpec[] = [];
  // Scan only the header — stop at the first top-level keyword that starts a
  // declaration body (`func`, `type`, `var`, `const` at column 0-ish).
  const headerEnd = /^[ \t]*(func|type|var|const)\b/m.exec(blanked)?.index ?? blanked.length;
  const header = blanked.slice(0, headerEnd);
  const importRe = /\bimport\s*(?:\(([^)]*)\)|([^\n]*))/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(header)) !== null) {
    const block = m[1] !== undefined ? m[1] : m[2];
    if (block === undefined) continue;
    for (const line of block.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const spec =
        /^(?:(\S+)\s+)?["']([^"']+)["']?$/.exec(trimmed) ??
        /^(?:(\S+)\s+)?["']([^"']+)["']/.exec(trimmed);
      if (!spec) continue;
      const alias = spec[1] && spec[1] !== '"' ? spec[1] : null;
      specs.push({ alias, path: spec[2] });
    }
  }
  return specs;
}

/** Brace-match the body of a function starting at `braceIndex` (`{`). */
function bodyRange(blanked: string, braceIndex: number): { start: number; end: number } | null {
  let depth = 0;
  for (let i = braceIndex; i < blanked.length; i++) {
    if (blanked[i] === "{") depth++;
    else if (blanked[i] === "}") {
      depth--;
      if (depth === 0) return { start: braceIndex, end: i };
    }
  }
  return null;
}

/** Identifier list from a comma-separated segment like `a, b int` → [a,b];
 *  `x *T` → [x]; bare types (`int`, `*T`, `[]byte`) → []. */
function namesBeforeType(segment: string): string[] {
  const trimmed = segment.trim();
  if (!trimmed) return [];
  const words = trimmed.split(/\s+/);
  // `a, b int` is already split by commas at the caller level when the list
  // contains commas before the type — handled by caller splitting on commas
  // only up to the last type word.
  if (words.length >= 2)
    return words
      .slice(0, -1)
      .flatMap((w) => w.split(","))
      .map((w) => w.trim())
      .filter((w) => /^[A-Za-z_]\w*$/.test(w));
  // single word — could be a bare type (`int`) or a named param (`x`); treat
  // trailing `*`/`[]` markers as part of the word.
  return [];
}

/** Collect parameter/result names from a parenthesized list `(...)`. */
function namesInParamList(text: string): string[] {
  const inner = text.replace(/^\(/, "").replace(/\)$/, "");
  const names: string[] = [];
  // Split by commas at depth 0. A bare name belongs to the next typed group,
  // as in `a, b T`.
  const segments: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of inner) {
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      segments.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  segments.push(cur);
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const s = segment.trim();
    if (!s) continue;
    // `name type`, `name1, name2 type`, or bare `type`
    const commaNames = s.split(/\s*,\s*/);
    if (commaNames.length > 1) {
      // all but the last comma part are names; the last holds `name type`
      for (const piece of commaNames.slice(0, -1)) {
        if (/^[A-Za-z_]\w*$/.test(piece.trim())) names.push(piece.trim());
      }
      const last = commaNames[commaNames.length - 1];
      const words = last.trim().split(/\s+/);
      if (words.length >= 2 && /^[A-Za-z_]\w*$/.test(words[0])) names.push(words[0]);
      continue;
    }
    const typedNames = namesBeforeType(s);
    names.push(...typedNames);
    if (
      !typedNames.length &&
      /^[A-Za-z_]\w*$/.test(s) &&
      segments[i + 1] &&
      namesBeforeType(segments[i + 1]).length
    ) {
      names.push(s);
    }
  }
  return names;
}

/** Function-level locals: `:=` declarations, `var`/`const` names, and
 *  range/for/if/switch clause variables inside a body range. */
function localsInBody(body: string): string[] {
  const names = new Set<string>();
  const shortDecl =
    /(?:^|[;{}\n])\s*(?:if\s+|for\s+|switch\s+|else\s+|case\s+|go\s+|defer\s+|return\s+)?([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*:=/g;
  let m: RegExpExecArray | null;
  while ((m = shortDecl.exec(body)) !== null) {
    for (const name of m[1].split(",")) names.add(name.trim());
  }
  const varConst =
    /(?:^|[;{}\n])\s*(?:var|const)\s+(?:\(\s*)?([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)/g;
  while ((m = varConst.exec(body)) !== null) {
    for (const n of m[1].split(",")) {
      const name = n.trim();
      if (name !== "_") names.add(name);
    }
  }
  const groupedVarConst = /(?:^|[;{}\n])\s*(?:var|const)\s*\(([^)]*)\)/g;
  while ((m = groupedVarConst.exec(body)) !== null) {
    for (const line of m[1].split("\n")) {
      const head = /^[ \t]*([A-Za-z_]\w*)/.exec(line);
      if (head && head[1] !== "_") names.add(head[1]);
    }
  }
  const rangeVars = /\bfor\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*(?::=|=)\s*range\b/g;
  while ((m = rangeVars.exec(body)) !== null) {
    for (const name of m[1].split(",")) {
      const n = name.trim();
      if (n !== "_") names.add(n);
    }
  }
  return [...names];
}

/** Signature pieces of a `func` declaration found at `funcIndex`. */
interface GoFuncSig {
  name: string;
  receiverType: string | null;
  localNames: string[];
  bodyStart: number;
  bodyEnd: number;
}

function receiverTypeOf(recvText: string): string | null {
  const inner = recvText.replace(/^\(+|\)+$/g, "").trim();
  const parts = inner.split(/\s+/);
  const last = parts[parts.length - 1];
  if (!last) return null;
  // Keep generic arguments (Stack[T]) — caller keys must match the parser's
  // qualified symbol names (`Stack[T]::Push`). Slices still reduce ([]byte →
  // byte) like the tree-sitter receiver normalization.
  return last.replace(/^\*/, "").replace(/^\[\]/, "") || null;
}

function scanFuncLocals(blanked: string): GoFuncSig[] {
  const sigs: GoFuncSig[] = [];
  const funcRe = /\bfunc\s*(\([^)]*\))?\s*([A-Za-z_]\w*)\s*(\(|\[)/g;
  let m: RegExpExecArray | null;
  while ((m = funcRe.exec(blanked)) !== null) {
    const receiver = m[1];
    const name = m[2];
    // m[0] consumed the opening `(` or `[` of params/type-params.
    let i = m.index + m[0].length;
    if (m[3] === "[") {
      // generic type params — skip to matching ], then expect (
      let depth = 1;
      while (i < blanked.length && depth > 0) {
        if (blanked[i] === "[") depth++;
        else if (blanked[i] === "]") depth--;
        i++;
      }
      while (i < blanked.length && /\s/.test(blanked[i])) i++;
      if (blanked[i] !== "(") continue;
      i++;
    }
    const paramsStart = i - 1;
    let depth = 1;
    while (i < blanked.length && depth > 0) {
      if (blanked[i] === "(") depth++;
      else if (blanked[i] === ")") depth--;
      i++;
    }
    const paramsEnd = i;
    // Results: optional `(...)` or bare type word.
    let j = i;
    while (j < blanked.length && /\s/.test(blanked[j]) && blanked[j] !== "\n") j++;
    let resultsText = "";
    if (blanked[j] === "(") {
      depth = 1;
      const rStart = j;
      j++;
      while (j < blanked.length && depth > 0) {
        if (blanked[j] === "(") depth++;
        else if (blanked[j] === ")") depth--;
        j++;
      }
      resultsText = blanked.slice(rStart, j);
      while (j < blanked.length && /\s/.test(blanked[j])) j++;
    } else {
      // bare result type: consume identifier/*T/[]T until `{` or `\n`
      const typeRe = /^[A-Za-z_*[\],\w.]+/;
      const tm = typeRe.exec(blanked.slice(j, j + 200));
      if (tm) j += tm[0].length;
      while (j < blanked.length && /\s/.test(blanked[j]) && blanked[j] !== "\n") j++;
    }
    if (blanked[j] !== "{") continue; // declaration without body
    const range = bodyRange(blanked, j);
    if (!range) continue;
    const locals = new Set<string>();
    if (receiver) {
      // receiver text `(v *T)` — first word is the var name
      const recvName = /^[ \t]*([A-Za-z_]\w*)/.exec(receiver.replace(/^\(+|\)+$/g, ""));
      if (recvName) locals.add(recvName[1]);
    }
    for (const n of namesInParamList(blanked.slice(paramsStart, paramsEnd))) locals.add(n);
    if (resultsText) for (const n of namesInParamList(resultsText)) locals.add(n);
    for (const n of localsInBody(blanked.slice(range.start, range.end + 1))) locals.add(n);
    sigs.push({
      name,
      receiverType: receiver ? receiverTypeOf(receiver) : null,
      localNames: [...locals],
      bodyStart: range.start,
      bodyEnd: range.end,
    });
  }

  // The graph attributes calls inside function literals to their containing
  // named function, so their parameters shadow imports for that caller too.
  const literalRe = /\bfunc\s*\(/g;
  while ((m = literalRe.exec(blanked)) !== null) {
    const owner = sigs.find((sig) => m!.index > sig.bodyStart && m!.index < sig.bodyEnd);
    if (!owner) continue;
    let i = m.index + m[0].length;
    const paramsStart = i - 1;
    let depth = 1;
    while (i < blanked.length && depth > 0) {
      if (blanked[i] === "(") depth++;
      else if (blanked[i] === ")") depth--;
      i++;
    }
    const paramsEnd = i;
    if (depth !== 0) continue;
    for (const name of namesInParamList(blanked.slice(paramsStart, paramsEnd))) {
      owner.localNames.push(name);
    }
  }
  return sigs;
}

export function createGoResolver(options: {
  workspaceRoot: string;
  /** Workspace-relative .go file paths known to the index. */
  goFiles: string[];
}): GoResolver {
  const { workspaceRoot, goFiles } = options;
  const modules: GoModule[] = [];
  const moduleByDir = new Map<string, GoModule | null>();
  const contextCache = new Map<string, GoFileContext | null>();
  const packageCache = new Map<string, { dir: string; packageName: string } | null>();
  const goFileSet = new Set(goFiles.map((p) => p.split(path.sep).join("/")));

  const readFile = (relPath: string): string | null => {
    try {
      return fs.readFileSync(path.join(workspaceRoot, relPath), "utf8");
    } catch {
      return null;
    }
  };

  const sourceCache = new Map<string, string | null>();
  const commentBlankCache = new Map<string, string | null>();
  const triviaBlankCache = new Map<string, string | null>();
  const sourceOf = (relPath: string): string | null => {
    if (!sourceCache.has(relPath)) sourceCache.set(relPath, readFile(relPath));
    return sourceCache.get(relPath)!;
  };
  const commentBlankedOf = (relPath: string): string | null => {
    if (!commentBlankCache.has(relPath)) {
      const text = sourceOf(relPath);
      commentBlankCache.set(relPath, text === null ? null : blankGoComments(text));
    }
    return commentBlankCache.get(relPath)!;
  };
  const triviaBlankedOf = (relPath: string): string | null => {
    if (!triviaBlankCache.has(relPath)) {
      const text = sourceOf(relPath);
      triviaBlankCache.set(relPath, text === null ? null : blankGoTrivia(text));
    }
    return triviaBlankCache.get(relPath)!;
  };

  // Discover go.mod files: walk up from each .go file's directory.
  const goModDirs = new Set<string>();
  const norm = (p: string) => p.split(path.sep).join("/");
  for (const file of goFiles) {
    let dir = norm(path.dirname(file));
    for (;;) {
      if (dir === "." || dir === "" || dir === "/") break;
      const parts = dir.split("/");
      if (parts.some((seg) => IGNORED_DIR.test(seg))) break;
      goModDirs.add(dir);
      dir = norm(path.dirname(dir));
    }
    goModDirs.add(".");
  }
  for (const dir of [...goModDirs].sort((a, b) => b.length - a.length)) {
    const rel = dir === "." ? "go.mod" : `${dir}/go.mod`;
    const text = readFile(rel);
    if (text === null) continue;
    const modulePath = moduleDirectiveOf(text);
    const moduleDir = dir === "." ? "" : dir;
    if (!modulePath) {
      moduleByDir.set(moduleDir, null);
      continue;
    }
    const mod: GoModule = { modulePath, dir: dir === "." ? "" : dir };
    modules.push(mod);
    moduleByDir.set(moduleDir, mod);
  }

  function moduleForFile(relPath: string): GoModule | null | undefined {
    let dir = norm(path.dirname(relPath));
    for (;;) {
      const key = dir === "." ? "" : dir;
      if (moduleByDir.has(key)) return moduleByDir.get(key) ?? null;
      if (dir === "." || dir === "" || dir === "/") return undefined;
      dir = norm(path.dirname(dir));
    }
  }

  // One pass over every Go file: directory → declared package names and file
  // lists. Keeps `declaredPackageName`/`packageFiles` O(1)-ish instead of
  // rescanning the whole workspace per call edge.
  interface DirEntry {
    nonTestNames: Set<string>;
    filesByPackage: Map<string, { regular: string[]; tests: string[] }>;
  }
  const dirIndex = new Map<string, DirEntry>();
  for (const file of goFileSet) {
    const rawDir = norm(path.dirname(file));
    const dir = rawDir === "." ? "" : rawDir;
    const blanked = commentBlankedOf(file);
    if (!blanked) continue;
    const name = packageDeclOf(blanked);
    if (!name) continue;
    let entry = dirIndex.get(dir);
    if (!entry) {
      entry = { nonTestNames: new Set(), filesByPackage: new Map() };
      dirIndex.set(dir, entry);
    }
    const isTest = file.endsWith("_test.go");
    if (!isTest && !name.endsWith("_test")) entry.nonTestNames.add(name);
    let bucket = entry.filesByPackage.get(name);
    if (!bucket) {
      bucket = { regular: [], tests: [] };
      entry.filesByPackage.set(name, bucket);
    }
    (isTest ? bucket.tests : bucket.regular).push(file);
  }

  /** Declared non-test package names in a directory. >1 → ambiguous. */
  function declaredPackageName(dir: string): string | null {
    const names = dirIndex.get(dir)?.nonTestNames;
    return names && names.size === 1 ? [...names][0] : null;
  }

  function packageFiles(dir: string, packageName: string, includeTests: boolean): string[] {
    const bucket = dirIndex.get(dir)?.filesByPackage.get(packageName);
    if (!bucket) return [];
    return includeTests ? [...bucket.regular, ...bucket.tests] : bucket.regular;
  }

  function packageForImport(
    importerRel: string,
    importPath: string,
  ): { dir: string; packageName: string } | null {
    const key = `${importerRel}\0${importPath}`;
    if (packageCache.has(key)) return packageCache.get(key)!;
    const own = moduleForFile(importerRel);
    // A malformed go.mod is a boundary, not permission to inherit its parent.
    if (own === null) {
      packageCache.set(key, null);
      return null;
    }
    let bestLength = -1;
    const matches: GoModule[] = [];
    for (const mod of modules) {
      if (importPath !== mod.modulePath && !importPath.startsWith(`${mod.modulePath}/`)) continue;
      if (mod.modulePath.length > bestLength) {
        bestLength = mod.modulePath.length;
        matches.length = 0;
        matches.push(mod);
      } else if (mod.modulePath.length === bestLength) {
        matches.push(mod);
      }
    }
    const best = matches.length === 1 ? matches[0] : (matches.find((mod) => mod === own) ?? null);
    let resolved: { dir: string; packageName: string } | null = null;
    if (best) {
      const rest = importPath.slice(best.modulePath.length).replace(/^\//, "");
      const dir = best.dir ? (rest ? `${best.dir}/${rest}` : best.dir) : rest;
      const ignoredTarget = dir.split("/").some((part) => IGNORED_DIR.test(part));
      const packageName = ignoredTarget ? null : declaredPackageName(dir);
      if (packageName) resolved = { dir, packageName };
    }
    packageCache.set(key, resolved);
    return resolved;
  }

  function contextForFile(relPath: string): GoFileContext | null {
    const rel = norm(relPath);
    if (contextCache.has(rel)) return contextCache.get(rel)!;
    const commentBlanked = commentBlankedOf(rel);
    if (commentBlanked === null) {
      contextCache.set(rel, null);
      return null;
    }
    const packageName = packageDeclOf(commentBlanked);
    const imports = new Map<string, { dir: string; packageName: string }>();
    const ambiguousNames = new Set<string>();
    const bound = new Map<string, number>();
    for (const spec of extractImportSpecs(commentBlanked)) {
      const alias = spec.alias;
      if (alias === "_" || alias === ".") continue; // blank/dot bind nothing
      const target = packageForImport(rel, spec.path);
      if (!target) continue; // external/unmatched imports bind no name
      const name = alias ?? target.packageName;
      bound.set(name, (bound.get(name) ?? 0) + 1);
      imports.set(name, target);
    }
    for (const [name, count] of bound) {
      if (count > 1) ambiguousNames.add(name);
    }

    const localNamesByCaller = new Map<string, Set<string>>();
    for (const sig of scanFuncLocals(triviaBlankedOf(rel) ?? "")) {
      const caller = sig.receiverType ? `${sig.receiverType}::${sig.name}` : sig.name;
      const set = localNamesByCaller.get(caller) ?? new Set<string>();
      for (const n of sig.localNames) set.add(n);
      localNamesByCaller.set(caller, set);
    }

    const dir = norm(path.dirname(rel));
    const ctx: GoFileContext = {
      packageName,
      imports,
      ambiguousNames,
      localNamesByCaller,
      packageDir: dir === "." ? "" : dir,
    };
    contextCache.set(rel, ctx);
    return ctx;
  }

  return { contextForFile, packageForImport, packageFiles };
}

/** True when a workspace-relative path sits under a `vendor` segment. */
export function isGoVendorPath(relPath: string): boolean {
  return relPath.split("/").includes("vendor");
}
