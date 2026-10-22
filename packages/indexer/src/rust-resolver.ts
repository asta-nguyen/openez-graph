import fs from "node:fs";
import path from "node:path";

import { lastRustCallSegment } from "./languages";

/**
 * Rust crate/module-aware call resolver.
 *
 * Callees keep their qualified path (`crate::util::run`, `helper::tool`,
 * `x.run`, `Self::new`). Resolution walks Cargo crate roots and `mod`
 * declarations — never a global name lookup — and emits a target only when a
 * unique in-crate symbol answers. Glob imports, external crates, ambiguous
 * or shadowed bindings, unknown receivers, and unresolved paths all drop.
 *
 * Module directory rules: `mod.rs`, `lib.rs`, `main.rs` own their directory;
 * any other `foo.rs` owns `foo/`. Both `x.rs` and `x/mod.rs` existing (or
 * neither) leaves the declaration unresolved. Inline `mod x {}` blocks are
 * flat per-file items — they never create a file module.
 */

// ── Public types ──

export interface RustResolverFileInput {
  filePath: string;
  symbols: Array<{
    name: string;
    symbolType: string;
    type: string;
    exported: boolean;
    startLine?: number;
    endLine?: number;
  }>;
  importPaths: string[];
}

export interface RustResolvedTarget {
  filePath: string;
  name: string;
}

export interface RustResolver {
  resolveCall(
    filePath: string,
    callerName: string,
    calleeName: string,
    shadowedLocal?: boolean,
  ): RustResolvedTarget | null;
}

// ── Text blanking ──

/** Blank Rust comments and string literals; line structure preserved. */
function blankRustCode(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length))
    .replace(/r(#*)"[\s\S]*?"\1/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/"(?:\\.|[^"\\])*"/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/'(?:\\.|[^'\\])*'/g, (m) => m.replace(/[^\n]/g, " "));
}

// ── Cargo crate discovery ──

interface RustCrate {
  /** Crate root directory (workspace-relative, "" for workspace root). */
  dir: string;
  /** `[package] name` with dashes converted to underscores. */
  packageName: string;
  libRoot?: RustModule;
  roots: RustModule[];
}

interface RustModule {
  file: string;
  crate: RustCrate;
  parent: RustModule | null;
  /** Declared child modules: name → module (absent = unresolved/none). */
  children: Map<string, RustModule>;
  /** use bindings of the module's file: local name → absolute path targets. */
  bindings: Map<string, Set<string>>;
}

function readCargoPackageName(toml: string): string | null {
  const packageMatch = /^\s*\[package\]\s*$/m.exec(toml);
  if (!packageMatch) return null;
  const rest = toml.slice(packageMatch.index + packageMatch[0].length);
  const sectionEnd = rest.search(/^\s*\[/m);
  const section = sectionEnd === -1 ? rest : rest.slice(0, sectionEnd);
  const nameMatch = /^\s*name\s*=\s*"([^"]+)"/m.exec(section);
  return nameMatch ? nameMatch[1].replace(/-/g, "_") : null;
}

function dirnameRel(file: string): string {
  const dir = path.posix.dirname(file);
  return dir === "." ? "" : dir;
}

/** Directory a module file owns for resolving `mod x;` declarations. */
function moduleOwnedDir(file: string): string {
  const dir = dirnameRel(file);
  const base = path.posix.basename(file);
  if (base === "mod.rs" || base === "lib.rs" || base === "main.rs") return dir;
  return `${dir}/${base.slice(0, -3)}`;
}

// ── Use-tree expansion ──

type UseToken = { kind: "ident" | "sep" | "brace" | "star" | "as"; text: string };

function tokenizeUseTree(text: string): UseToken[] {
  const tokens: UseToken[] = [];
  const re = /(::)|([{},])|(\*)|(\bas\b)|(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) tokens.push({ kind: "sep", text: m[1] });
    else if (m[2]) tokens.push({ kind: "brace", text: m[2] });
    else if (m[3]) tokens.push({ kind: "star", text: m[3] });
    else if (m[4]) tokens.push({ kind: "as", text: m[4] });
    else tokens.push({ kind: "ident", text: m[5] });
  }
  return tokens;
}

interface UseBinding {
  /** Local name bound in the file. */
  bind: string;
  /** Absolute path the name binds to, e.g. ["crate","util","run"]. */
  path: string[];
}

/**
 * Expand one `use` declaration body into its (local name → path) bindings.
 * `use a::b::{self, c as d, e::{f, g}, *}` → `b`→`a::b`, `d`→`a::b::c`,
 * `f`→`a::b::e::f`, `g`→`a::b::e::g`; `*` contributes nothing.
 */
function expandUseTree(raw: string): UseBinding[] {
  const tokens = tokenizeUseTree(raw);
  const bindings: UseBinding[] = [];
  let pos = 0;

  function peek(): UseToken | undefined {
    return tokens[pos];
  }
  function next(): UseToken | undefined {
    return tokens[pos++];
  }

  /** Parse a path (`a::b::c`) starting at pos; returns segments or null.
   *  `::{`/`::*` continue into a tree — the sep is not consumed here. */
  function parsePath(): string[] | null {
    const segs: string[] = [];
    const first = peek();
    if (!first || first.kind !== "ident") return null;
    segs.push(next()!.text);
    while (peek()?.kind === "sep" && tokens[pos + 1]?.kind === "ident") {
      next();
      segs.push(next()!.text);
    }
    return segs;
  }

  /** Parse a `::{...}` tree at `prefix` and record bindings. */
  function parseGroup(prefix: string[]): boolean {
    // caller already consumed "::" + "{"
    for (;;) {
      const t = peek();
      if (!t) return false;
      if (t.kind === "brace" && t.text === "}") {
        next();
        return true;
      }
      if (t.kind === "brace" && t.text === ",") {
        next();
        continue;
      }
      if (t.kind === "star") {
        next(); // glob binds nothing
        continue;
      }
      if (t.kind !== "ident") return false;
      if (t.text === "self") {
        next();
        // `self` inside a group binds the parent path's last segment.
        const parentName = prefix[prefix.length - 1];
        if (parentName) bindings.push({ bind: parentName, path: [...prefix] });
        continue;
      }
      const itemPath = [...prefix, next()!.text];
      while (peek()?.kind === "sep" && tokens[pos + 1]?.kind === "ident") {
        next();
        itemPath.push(next()!.text);
      }
      if (peek()?.kind === "as") {
        next();
        const alias = peek();
        if (!alias || alias.kind !== "ident") return false;
        bindings.push({ bind: next()!.text, path: itemPath });
      } else if (peek()?.kind === "sep") {
        next();
        const brace = peek();
        if (brace?.kind === "brace" && brace.text === "{") {
          next();
          if (!parseGroup(itemPath)) return false;
        } else if (brace?.kind === "star") {
          next(); // `a::b::*` — glob binds nothing
        } else {
          return false;
        }
      } else {
        bindings.push({ bind: itemPath[itemPath.length - 1], path: itemPath });
      }
    }
  }

  const head = parsePath();
  if (!head) return [];
  if (peek()?.kind === "as") {
    next();
    const alias = peek();
    if (!alias || alias.kind !== "ident") return [];
    bindings.push({ bind: next()!.text, path: head });
    return bindings;
  }
  if (peek()?.kind === "sep") {
    next();
    const brace = peek();
    if (brace?.kind === "brace" && brace.text === "{") {
      next();
      if (!parseGroup(head)) return bindings;
      return bindings;
    }
    if (brace?.kind === "star") {
      // `use a::*` binds nothing.
      return bindings;
    }
    // `use a::b` continues as a longer path — the path parser already
    // consumed it fully, so reaching here means only `::{` or `::*`.
    return bindings;
  }
  // `use a::b;` — bind the last segment.
  const last = head[head.length - 1];
  if (last) bindings.push({ bind: last, path: head });
  return bindings;
}

/** Collect a file's use bindings: local name → set of distinct paths. */
function collectBindings(importPaths: string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const raw of importPaths) {
    for (const { bind, path } of expandUseTree(raw)) {
      const key = path.join("::");
      const set = out.get(bind) ?? new Set<string>();
      set.add(key);
      out.set(bind, set);
    }
  }
  return out;
}

// ── Module tree construction ──

const MOD_DECL_REGEX = /^(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/;

/**
 * Names declared `mod x;` at brace depth 0 of a file (comments and strings
 * blanked). Over-blanked decls simply go missing — a conservative drop.
 */
function topLevelModDecls(content: string): string[] {
  const lines = blankRustCode(content).split("\n");
  const names: string[] = [];
  let depth = 0;
  for (const line of lines) {
    if (depth === 0) {
      const m = MOD_DECL_REGEX.exec(line.trim());
      if (m) names.push(m[1]);
    }
    for (const ch of line) {
      if (ch === "{") depth++;
      else if (ch === "}") depth = Math.max(0, depth - 1);
    }
  }
  return names;
}

const DEFAULT_ROOT_PATTERNS = [
  /^src\/lib\.rs$/,
  /^src\/main\.rs$/,
  /^src\/bin\/[^/]+\.rs$/,
  /^src\/bin\/[^/]+\/main\.rs$/,
];

// ── Path resolution ──

type PathPosition =
  | { kind: "module"; module: RustModule }
  | { kind: "item"; file: string; name: string };

const MAX_FORWARD_HOPS = 3;

export function createRustResolver(
  rustFiles: RustResolverFileInput[],
  allFilePaths: string[],
  rootPath: string,
): RustResolver {
  const fileSet = new Set(allFilePaths);
  const contentCache = new Map<string, string | null>();
  const readContent = (rel: string): string | null => {
    const cached = contentCache.get(rel);
    if (cached !== undefined) return cached;
    let text: string | null = null;
    try {
      text = fs.readFileSync(path.join(rootPath, rel), "utf8");
    } catch {
      /* file may be gone */
    }
    contentCache.set(rel, text);
    return text;
  };

  // Items per file: label → count by kind bucket.
  const itemIndex = new Map<string, Map<string, { total: number; functions: number }>>();
  const fileBindings = new Map<string, Map<string, Set<string>>>();
  for (const file of rustFiles) {
    const items = new Map<string, { total: number; functions: number }>();
    for (const sym of file.symbols) {
      const entry = items.get(sym.name) ?? { total: 0, functions: 0 };
      entry.total++;
      if (sym.symbolType === "function") entry.functions++;
      items.set(sym.name, entry);
    }
    itemIndex.set(file.filePath, items);
    fileBindings.set(file.filePath, collectBindings(file.importPaths));
  }

  // Crate discovery: directories holding Cargo.toml.
  const crates: RustCrate[] = [];
  for (const file of fileSet) {
    if (path.posix.basename(file) !== "Cargo.toml") continue;
    const dir = dirnameRel(file);
    const toml = readContent(file);
    crates.push({ dir, packageName: toml ? (readCargoPackageName(toml) ?? "") : "", roots: [] });
  }
  crates.sort((a, b) => b.dir.length - a.dir.length); // longest dir first

  const crateForFile = new Map<string, RustCrate>();
  for (const file of rustFiles) {
    const crate = crates.find(
      (c) => c.dir === "" || file.filePath === c.dir || file.filePath.startsWith(`${c.dir}/`),
    );
    if (crate) crateForFile.set(file.filePath, crate);
  }

  // Modules a file claims: a file reachable as a module under >1 root or >1
  // declaration is ambiguous for self/super/crate purposes.
  const modulesByFile = new Map<string, RustModule[]>();

  function attachModule(crate: RustCrate, file: string, parent: RustModule | null): RustModule {
    const mod: RustModule = {
      file,
      crate,
      parent,
      children: new Map(),
      bindings: fileBindings.get(file) ?? new Map(),
    };
    const list = modulesByFile.get(file) ?? [];
    list.push(mod);
    modulesByFile.set(file, list);
    return mod;
  }

  function moduleForFile(file: string): RustModule | null {
    const list = modulesByFile.get(file);
    return list && list.length === 1 ? list[0] : null;
  }

  // Build module trees per crate root via mod declarations.
  for (const file of rustFiles) {
    const crate = crateForFile.get(file.filePath);
    if (!crate) continue;
    const rel = file.filePath.startsWith(`${crate.dir}/`)
      ? file.filePath.slice(crate.dir.length + 1)
      : file.filePath;
    if (!DEFAULT_ROOT_PATTERNS.some((re) => re.test(rel))) continue;
    const mod = attachModule(crate, file.filePath, null);
    if (rel === "src/lib.rs") crate.libRoot = mod;
    crate.roots.push(mod);
  }

  const queue: RustModule[] = crates.flatMap((c) => c.roots);
  const visitedPairs = new Set<string>();
  while (queue.length > 0) {
    const mod = queue.shift()!;
    const visitKey = `${mod.crate.dir}:${mod.file}`;
    if (visitedPairs.has(visitKey)) continue;
    visitedPairs.add(visitKey);
    const content = readContent(mod.file);
    if (content === null) continue;
    const ownedDir = moduleOwnedDir(mod.file);
    for (const name of topLevelModDecls(content)) {
      const a = ownedDir === "" ? `${name}.rs` : `${ownedDir}/${name}.rs`;
      const b = ownedDir === "" ? `${name}/mod.rs` : `${ownedDir}/${name}/mod.rs`;
      const hasA = fileSet.has(a);
      const hasB = fileSet.has(b);
      if (hasA === hasB) continue; // both or neither: unresolved
      const childFile = hasA ? a : b;
      // A file may only be a module under one crate; a second claim marks it
      // ambiguous (moduleForFile returns null).
      const child = attachModule(mod.crate, childFile, mod);
      mod.children.set(name, child);
      queue.push(child);
    }
  }

  function bindingsForFile(file: string): Map<string, Set<string>> {
    return fileBindings.get(file) ?? new Map();
  }

  /**
   * Resolve a `::`-joined path to a module or item position.
   * `scopeFile` is the file the path is evaluated in — the calling file for
   * direct paths, or the declaring file when a `use` binding forwards.
   * `hops` counts use-binding forwards (cycle guard).
   */
  function resolvePath(segments: string[], scopeFile: string, hops: number): PathPosition | null {
    if (segments.length === 0 || hops > MAX_FORWARD_HOPS) return null;
    const callerModule = moduleForFile(scopeFile);
    const crate = crateForFile.get(scopeFile);
    const seg0 = segments[0];
    let i = 0;
    let pos: PathPosition | null = null;

    if (seg0 === "crate") {
      // The crate root of the scope file's own root module.
      const roots = (modulesByFile.get(scopeFile) ?? [])
        .map((m) => {
          let m2: RustModule = m;
          while (m2.parent) m2 = m2.parent;
          return m2;
        })
        .filter((m, idx, arr) => arr.indexOf(m) === idx);
      if (roots.length === 1) pos = { kind: "module", module: roots[0] };
      i = 1;
    } else if (seg0 === "self") {
      if (callerModule) pos = { kind: "module", module: callerModule };
      i = 1;
    } else if (seg0 === "super") {
      let mod = callerModule;
      while (i < segments.length && segments[i] === "super") {
        mod = mod?.parent ?? null;
        i++;
      }
      if (mod) pos = { kind: "module", module: mod };
    } else {
      const bound = bindingsForFile(scopeFile).get(seg0);
      if (bound && bound.size > 1) return null; // conflicting bindings
      if (bound && bound.size === 1) {
        const target = resolvePath([...bound][0].split("::"), scopeFile, hops + 1);
        if (!target) return null;
        pos = target;
        i = 1;
      }
      if (!pos && callerModule) {
        const child = callerModule.children.get(seg0);
        if (child) {
          pos = { kind: "module", module: child };
          i = 1;
        }
      }
      if (!pos && crate?.libRoot && seg0 === crate.packageName && crate.packageName) {
        pos = { kind: "module", module: crate.libRoot };
        i = 1;
      }
      if (!pos) {
        // Item of the scope file — enables `Type::function` on an unbound
        // local type.
        const items = itemIndex.get(scopeFile)?.get(seg0);
        if (items && items.total >= 1) {
          pos = { kind: "item", file: scopeFile, name: seg0 };
          i = 1;
        } else {
          return null;
        }
      }
    }
    if (!pos) return null;

    // Walk the remaining segments.
    for (; i < segments.length; i++) {
      const seg = segments[i];
      const last = i === segments.length - 1;
      if (pos!.kind === "item") {
        // An item accepts at most a `Type::member` continuation.
        if (!last) return null;
        return { kind: "item", file: pos!.file, name: `${pos!.name}::${seg}` };
      }
      const mod: RustModule = (pos as { kind: "module"; module: RustModule }).module;
      const child = mod.children.get(seg);
      if (child) {
        pos = { kind: "module", module: child };
        continue;
      }
      const items = itemIndex.get(mod.file)?.get(seg);
      if (items && items.total >= 1) {
        pos = { kind: "item", file: mod.file, name: seg };
        continue;
      }
      if (!last) return null;
      // Forwarding: the module lacks the item but binds the name via `use`.
      const bound = mod.bindings.get(seg);
      if (bound && bound.size === 1) {
        return resolvePath([...bound][0].split("::"), mod.file, hops + 1);
      }
      return null;
    }
    return pos;
  }

  /** File that defines item `name`, via caller-file item or a use binding. */
  function typeDefiningFile(name: string, fromFile: string): string | null {
    const items = itemIndex.get(fromFile)?.get(name);
    if (items && items.total >= 1) return fromFile;
    const bound = bindingsForFile(fromFile).get(name);
    if (bound && bound.size === 1) {
      const pos = resolvePath([...bound][0].split("::"), fromFile, 0);
      if (pos?.kind === "item") return pos.file;
    }
    return null;
  }

  /** Count of `T::m` function symbols in a file. */
  function methodCount(file: string, label: string): number {
    return itemIndex.get(file)?.get(label)?.functions ?? 0;
  }

  /** `Self::f` / `self.f` / `Type::f` resolution. */
  function resolveTypeMethod(
    fromFile: string,
    typeName: string | null,
    method: string,
  ): RustResolvedTarget | null {
    if (!typeName) return null;
    const label = `${typeName}::${method}`;
    const inFile = methodCount(fromFile, label);
    if (inFile === 1) return { filePath: fromFile, name: label };
    if (inFile > 1) return null;
    const defFile = typeDefiningFile(typeName, fromFile);
    if (!defFile || defFile === fromFile) return null;
    return methodCount(defFile, label) === 1 ? { filePath: defFile, name: label } : null;
  }

  function resolveCall(
    filePath: string,
    callerName: string,
    calleeName: string,
    shadowedLocal?: boolean,
  ): RustResolvedTarget | null {
    if (shadowedLocal) return null;
    let target: RustResolvedTarget | null = null;

    if (calleeName.includes(".")) {
      // Only `self.method()` is supported; any other receiver drops.
      const segs = calleeName.split(".");
      if (segs.length === 2 && segs[0] === "self" && segs[1]) {
        const typeName = callerName.includes("::")
          ? callerName.slice(0, callerName.lastIndexOf("::"))
          : null;
        target = resolveTypeMethod(filePath, typeName, segs[1]);
      }
    } else if (calleeName.includes("::")) {
      const segs = calleeName.split("::");
      const last = segs[segs.length - 1];
      if (segs[0] === "Self") {
        const typeName = callerName.includes("::")
          ? callerName.slice(0, callerName.lastIndexOf("::"))
          : null;
        target = segs.length === 2 && last ? resolveTypeMethod(filePath, typeName, last) : null;
      } else {
        const pos = resolvePath(segs, filePath, 0);
        if (pos?.kind === "item") {
          const items = itemIndex.get(pos.file)?.get(pos.name);
          if (items && items.functions === 1) {
            target = { filePath: pos.file, name: pos.name };
          }
        }
        // A path ending at a module is not callable.
      }
    } else if (/^\w+$/.test(calleeName)) {
      const items = itemIndex.get(filePath)?.get(calleeName);
      if (items && items.functions === 1) {
        target = { filePath, name: calleeName };
      } else if (!items || items.functions === 0) {
        const bound = bindingsForFile(filePath).get(calleeName);
        if (bound && bound.size === 1) {
          const pos = resolvePath([...bound][0].split("::"), filePath, 0);
          if (pos?.kind === "item") {
            const targetItems = itemIndex.get(pos.file)?.get(pos.name);
            if (targetItems && targetItems.functions === 1) {
              target = { filePath: pos.file, name: pos.name };
            }
          }
        }
      }
      // items.functions > 1 → ambiguous → drop.
    }

    // Self-edges stay out (matches the parsers' recursion filter).
    if (target && target.filePath === filePath && target.name === callerName) return null;
    return target;
  }

  return { resolveCall };
}

// The `shadowedLocal` marker lives in languages.ts (markRustCallShadowing) —
// it runs inside the regex/WASM parsers and on native batch results.
