import fs from "node:fs";
import path from "node:path";

/**
 * C# namespace/using-aware call and import resolver.
 *
 * Callees keep their qualified dotted path (`Ns.Type.M`, `this.M`, `Alias.M`)
 * and resolve through the C# lookup order — member types of enclosing types,
 * then each enclosing namespace level innermost→global (that level's
 * declared types and namespaces, then its own alias/ordinary/using-static
 * bindings), and finally compilation-unit usings plus the global usings of
 * the caller's project root — never a global name lookup. A qualified
 * path's head segment binds once through that order: a namespace binding
 * descends into the path's next segment, a type binding walks nested
 * member types, and the first level that binds decides — there is no
 * fall-through to an outer or global namesake. Only unique targets produce
 * edges: duplicates across partial parts, overloads, same identity in two
 * project roots, ambiguous paths, and reserved alias names all drop.
 *
 * The resolver consumes only parsed-document fields: symbols carry
 * `Owner::member` names plus 1-based line ranges; importPaths carry the full
 * using-directive text (global/alias/static modifiers included). Directives
 * inside a block namespace (or after a file-scoped namespace) carry their
 * enclosing declaration encoded as `<qualified-name>@<decl-line>\0<text>`
 * (with a `#<ordinal>` suffix when earlier declarations share that name and
 * line); such a using applies inside that declaration block and its nested
 * namespaces only, and its target resolves relative to that namespace.
 * Symbols carry the same `name@line[#k]` scope key in `receiver`, naming
 * their innermost enclosing namespace declaration — true lexical ancestry
 * for cases line ranges cannot express (same-line nesting vs siblings).
 * Each C# file's project root is the nearest ancestor directory containing
 * a `*.csproj` file (directories are listed once and memoized; project
 * files are never read) or the workspace root when none exists.
 */

// ── Public types ──

export interface CSharpResolverFileInput {
  filePath: string;
  symbols: Array<{
    name: string;
    symbolType: string;
    type: string;
    exported: boolean;
    startLine?: number;
    endLine?: number;
    receiver?: string;
  }>;
  importPaths: string[];
}

export interface CSharpResolvedTarget {
  filePath: string;
  name: string;
}

/** Resolved target plus the symbol's emission index — lets the graph map
 *  same (file,label) occurrences (same-named members in one file) to their
 *  distinct nodes instead of collapsing to the last node of that label. */
export interface CSharpResolvedOccurrence extends CSharpResolvedTarget {
  index: number;
}

export interface CSharpResolver {
  resolveCall(
    filePath: string,
    callerName: string,
    calleeName: string,
  ): CSharpResolvedTarget | null;
  resolveCallOccurrence(
    filePath: string,
    callerName: string,
    calleeName: string,
  ): CSharpResolvedOccurrence | null;
  resolveImport(filePath: string, directive: string): string | null;
}

// ── Internal model ──

const TYPE_KINDS = new Set(["class", "struct", "interface", "record", "enum", "delegate"]);

/** Call targets are methods only: fields, properties, nested type
 *  declarations (including delegates), and constructors/destructors share
 *  member names but an invocation never targets them. `static_method` is
 *  the parser's internal distinction for members declared `static`. */
const CALLABLE_MEMBER_KINDS = new Set(["method", "static_method"]);

/** `using static` binds only members parsed as static. */
const STATIC_MEMBER_KINDS = new Set(["static_method"]);

interface FileSymbol {
  name: string;
  symbolType: string;
  startLine: number;
  endLine: number;
  /** Position in the file's emitted symbol array (DFS order). Distinguishes
   *  declaration occurrences that share file, name, and line. */
  index: number;
  /** Scope key (`name@line[#k]`) of the innermost enclosing namespace
   *  declaration — parser-derived true ancestry (for a namespace
   *  declaration itself, the *parent* declaration's key). */
  receiver?: string;
}

interface Usings {
  /** alias name → target path (e.g. "Ns.Outer.Inner") */
  aliases: Map<string, string>;
  ordinary: string[];
  staticTypes: string[];
}

interface TypePart {
  file: string;
  startLine: number;
  endLine: number;
  /** Emission index of the type symbol that declared this part. */
  index: number;
}

interface TypeIdentity {
  key: string;
  root: string;
  ns: string;
  chain: string;
  parts: TypePart[];
}

/** Parse one using-directive text into its kind + operands. */
function parseUsing(
  text: string,
):
  | { kind: "ordinary"; ns: string; global: boolean }
  | { kind: "static"; target: string; global: boolean }
  | { kind: "alias"; name: string; target: string; global: boolean }
  | null {
  let body = text.trim().replace(/;$/, "").trim();
  let isGlobal = false;
  if (body.startsWith("global ")) {
    isGlobal = true;
    body = body.slice("global ".length).trim();
  }
  if (!body.startsWith("using ")) return null;
  body = body.slice("using ".length).trim();
  if (body.startsWith("static ")) {
    const target = body.slice("static ".length).trim();
    return target ? { kind: "static", target: stripGlobal(target), global: isGlobal } : null;
  }
  const eq = body.indexOf("=");
  if (eq >= 0) {
    const name = body.slice(0, eq).trim();
    const target = body.slice(eq + 1).trim();
    if (!/^[A-Za-z_]\w*$/.test(name) || !target) return null;
    return { kind: "alias", name, target: stripGlobal(target), global: isGlobal };
  }
  return body ? { kind: "ordinary", ns: stripGlobal(body), global: isGlobal } : null;
}

function stripGlobal(value: string): string {
  return value.startsWith("global::") ? value.slice("global::".length) : value;
}

/**
 * Split an encoded using entry into its scope key and directive text.
 * Entries are either verbatim (`using X;`) or scope-prefixed
 * (`<qualified-name>@<decl-line>\0<verbatim>`, plus a `#<ordinal>` suffix
 * when earlier declarations share that name and line); the scope key
 * identifies the enclosing namespace *declaration*, so two same-named
 * sibling blocks in one file always stay distinct.
 */
function splitUsingScope(raw: string): { scopeKey: string; text: string } {
  const sep = raw.indexOf("\0");
  return sep === -1
    ? { scopeKey: "", text: raw }
    : { scopeKey: raw.slice(0, sep), text: raw.slice(sep + 1) };
}

/** Semantic namespace part of a scope key (`"A.B"` out of `"A.B@3#1"`). */
function scopeNamespace(scopeKey: string): string {
  const at = scopeKey.lastIndexOf("@");
  return at > 0 ? scopeKey.slice(0, at) : "";
}

export function createCSharpResolver(
  files: CSharpResolverFileInput[],
  rootPath: string,
): CSharpResolver {
  const workspaceRoot = path.resolve(rootPath);

  // ── Per-file symbol index + namespace declarations ──
  const symbolsByFile = new Map<string, FileSymbol[]>();
  const nameIndexByFile = new Map<string, Map<string, FileSymbol[]>>();
  /** full namespace name → files that declare it (prefix-expanded) */
  const nsDeclared = new Map<string, Set<string>>();
  /** member symbol index → owning type symbol index (nearest preceding
   *  same-named type in emission order), per file. */
  const memberOwnerByFile = new Map<string, Map<number, number>>();
  /** symbol index → enclosing namespace chain (dotted), per file. */
  const nsChainByFile = new Map<string, Map<number, string>>();
  const projectRootByFile = new Map<string, string>();
  /** file → scope key (`""` for compilation-unit level, `"Q@line[#k]"` for
   *  the namespace declaration containing the directive) → resolved usings. */
  const usingsByFileScope = new Map<string, Map<string, Usings>>();
  /** file → scope key → non-global usings collected in pass one, resolved
   *  into `usingsByFileScope` once the type/namespace indices exist. */
  const rawUsingsByFile = new Map<string, Map<string, Usings>>();
  /** symbol index → scope keys of the enclosing namespace *declarations*
   *  (`name@line`/`name@line#k`), innermost→outermost, per file. */
  const nsAncestorsByFile = new Map<string, Map<number, string[]>>();
  const globalUsingsByRoot = new Map<string, Usings>();

  const dirCsproj = new Map<string, boolean>();
  function dirHasCsproj(dir: string): boolean {
    const hit = dirCsproj.get(dir);
    if (hit !== undefined) return hit;
    let found = false;
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (entry.endsWith(".csproj")) {
          found = true;
          break;
        }
      }
    } catch {
      /* unreadable directory */
    }
    dirCsproj.set(dir, found);
    return found;
  }

  function projectRootOf(filePath: string): string {
    const cached = projectRootByFile.get(filePath);
    if (cached !== undefined) return cached;
    // Nearest ancestor directory containing a *.csproj, else the workspace
    // root. The project file is never read — only its name is listed.
    let dir = path.dirname(path.join(workspaceRoot, filePath));
    let root = workspaceRoot;
    for (;;) {
      if (dirHasCsproj(dir)) {
        root = dir;
        break;
      }
      if (dir === workspaceRoot || dir === path.dirname(dir)) break;
      dir = path.dirname(dir);
    }
    projectRootByFile.set(filePath, root);
    return root;
  }

  // First pass: collect symbols per file and per-file usings.
  for (const file of files) {
    const syms: FileSymbol[] = file.symbols.map((s, i) => ({
      name: s.name,
      symbolType: s.symbolType,
      startLine: s.startLine ?? 1,
      endLine: s.endLine ?? s.startLine ?? 1,
      index: i,
      receiver: s.receiver,
    }));
    symbolsByFile.set(file.filePath, syms);

    // Namespace symbols emit fully qualified names (`A.B` for `namespace B`
    // nested in `A`, `B` for a same-line sibling — the parser walks ancestor
    // declarations, so no guessing is needed here). A symbol's enclosing
    // namespace comes from its `receiver` scope key — the parser serializes
    // the innermost enclosing namespace *declaration* as `name@line[#k]`
    // (for a namespace declaration itself, its parent's key). Line ranges
    // alone cannot distinguish same-line nesting (`A{using U; B{}}`) from
    // same-line siblings (`A{using U;} B{}`): the emitted payloads would be
    // identical, yet C# scopes the first inside A and the second outside.
    const nsSyms = syms.filter((x) => x.symbolType === "namespace");
    // A declaration's own scope key uses the same `name@line` + `#k`
    // ordinal the parser emits into using-directive scope tags, recomputed
    // from symbol emission order.
    const nsOrdinal = new Map<number, number>();
    const nsSeen = new Map<string, number>();
    for (const n of nsSyms) {
      const seenKey = `${n.name}\0${n.startLine}`;
      const ord = nsSeen.get(seenKey) ?? 0;
      nsOrdinal.set(n.index, ord);
      nsSeen.set(seenKey, ord + 1);
    }
    const nsScopeKey = (n: FileSymbol): string => {
      const ord = nsOrdinal.get(n.index) ?? 0;
      return ord > 0 ? `${n.name}@${n.startLine}#${ord}` : `${n.name}@${n.startLine}`;
    };
    const declByScopeKey = new Map<string, FileSymbol>();
    for (const n of nsSyms) declByScopeKey.set(nsScopeKey(n), n);
    const nsChain = new Map<number, string>();
    const nsAncestors = new Map<number, string[]>();
    const lastTypeIdx = new Map<string, number>();
    const memberOwner = new Map<number, number>();
    for (const s of syms) {
      // Semantic namespace = the receiver scope key's namespace part.
      nsChain.set(s.index, scopeNamespace(s.receiver ?? ""));
      // Lexical ancestor declarations: the receiver names the innermost
      // enclosing declaration; each declaration's own receiver names its
      // parent — the chain walks innermost→outermost until the top level.
      const ancestors: string[] = [];
      let key = s.receiver;
      const seen = new Set<string>();
      while (key && !seen.has(key)) {
        seen.add(key);
        ancestors.push(key);
        key = declByScopeKey.get(key)?.receiver;
      }
      nsAncestors.set(s.index, ancestors);
      const sep = s.name.lastIndexOf("::");
      if (sep > 0) {
        const owner = lastTypeIdx.get(s.name.slice(0, sep));
        if (owner !== undefined) memberOwner.set(s.index, owner);
      }
      if (TYPE_KINDS.has(s.symbolType)) lastTypeIdx.set(s.name, s.index);
    }
    memberOwnerByFile.set(file.filePath, memberOwner);
    nsChainByFile.set(file.filePath, nsChain);
    nsAncestorsByFile.set(file.filePath, nsAncestors);
    const byName = new Map<string, FileSymbol[]>();
    for (const s of syms) {
      const list = byName.get(s.name) ?? [];
      list.push(s);
      byName.set(s.name, list);
    }
    nameIndexByFile.set(file.filePath, byName);

    // Usings are collected per enclosing-declaration scope key but only
    // resolved after the type/namespace indices exist (third pass).
    const rawUsings = new Map<string, Usings>();
    for (const raw of file.importPaths) {
      const { scopeKey, text } = splitUsingScope(raw);
      const parsed = parseUsing(text);
      if (!parsed || parsed.global) continue;
      let bucket = rawUsings.get(scopeKey);
      if (!bucket) {
        bucket = { aliases: new Map(), ordinary: [], staticTypes: [] };
        rawUsings.set(scopeKey, bucket);
      }
      if (parsed.kind === "alias") {
        // Last alias wins locally only for collection; duplicates are a
        // compile error, keep first for determinism.
        if (!bucket.aliases.has(parsed.name)) bucket.aliases.set(parsed.name, parsed.target);
      } else if (parsed.kind === "ordinary") {
        bucket.ordinary.push(parsed.ns);
      } else if (parsed.kind === "static") {
        bucket.staticTypes.push(parsed.target);
      }
    }
    rawUsingsByFile.set(file.filePath, rawUsings);
  }

  /** Enclosing namespace chain for a symbol, precomputed per file from
   *  receiver-based namespace ancestry — each symbol's `receiver` scope
   *  key names its innermost enclosing declaration (see the first pass). */
  function namespaceOf(file: string, sym: FileSymbol): string {
    return nsChainByFile.get(file)?.get(sym.index) ?? "";
  }

  // Second pass: project roots, namespace declarations, type identities,
  // and global usings.
  const typesByKey = new Map<string, TypeIdentity>();
  const typesByNsChain = new Map<string, TypeIdentity[]>();
  for (const file of files) {
    const root = projectRootOf(file.filePath);
    const syms = symbolsByFile.get(file.filePath) ?? [];
    const nsSyms = syms.filter((s) => s.symbolType === "namespace");
    for (const n of nsSyms) {
      // Namespace names are already fully qualified (parser-derived).
      const full = n.name;
      // Prefix expansion: `namespace A.B.C` declares A, A.B, and A.B.C.
      const segs = full.split(".");
      for (let i = 1; i <= segs.length; i++) {
        const prefix = segs.slice(0, i).join(".");
        const set = nsDeclared.get(prefix) ?? new Set<string>();
        set.add(file.filePath);
        nsDeclared.set(prefix, set);
      }
    }
    for (const s of syms) {
      if (!TYPE_KINDS.has(s.symbolType)) continue;
      const ns = namespaceOf(file.filePath, s);
      const key = `${root}|${ns}|${s.name}`;
      let ident = typesByKey.get(key);
      if (!ident) {
        ident = { key, root, ns, chain: s.name, parts: [] };
        typesByKey.set(key, ident);
        const list = typesByNsChain.get(`${ns}|${s.name}`) ?? [];
        list.push(ident);
        typesByNsChain.set(`${ns}|${s.name}`, list);
      }
      ident.parts.push({
        file: file.filePath,
        startLine: s.startLine,
        endLine: s.endLine,
        index: s.index,
      });
    }

    // Global usings declared here apply to every file in this file's root.
    for (const raw of file.importPaths) {
      const parsed = parseUsing(splitUsingScope(raw).text);
      if (!parsed?.global) continue;
      let bucket = globalUsingsByRoot.get(root);
      if (!bucket) {
        bucket = { aliases: new Map(), ordinary: [], staticTypes: [] };
        globalUsingsByRoot.set(root, bucket);
      }
      if (parsed.kind === "alias") {
        if (!bucket.aliases.has(parsed.name)) bucket.aliases.set(parsed.name, parsed.target);
      } else if (parsed.kind === "ordinary") {
        bucket.ordinary.push(parsed.ns);
      } else {
        bucket.staticTypes.push(parsed.target);
      }
    }
  }

  // Resolve each file's non-global usings at the scope where they were
  // declared: a using inside `namespace A.B` searches A.B, then A, then
  // the global namespace — the same order C# applies inside the block.
  // Runs after the type/namespace indices so targets can bind eagerly.
  for (const [filePath, rawUsings] of rawUsingsByFile) {
    const resolved = new Map<string, Usings>();
    for (const [scopeKey, bucket] of rawUsings) {
      const ns = scopeNamespace(scopeKey);
      const u: Usings = { aliases: new Map(), ordinary: [], staticTypes: [] };
      for (const [name, target] of bucket.aliases) {
        u.aliases.set(name, resolveScopedAlias(ns, target));
      }
      for (const target of bucket.ordinary) u.ordinary.push(resolveScopedNs(ns, target));
      for (const target of bucket.staticTypes) u.staticTypes.push(resolveScopedType(ns, target));
      resolved.set(scopeKey, u);
    }
    usingsByFileScope.set(filePath, resolved);
  }

  /** In-scope usings for a caller symbol: each enclosing namespace
   *  declaration's usings (innermost→outermost, matched by the
   *  declaration's own `name@line[#k]` scope key), then compilation-unit
   *  usings, then the caller's project-root globals. Inner bindings win:
   *  outer aliases only fill names not already bound. */
  function scopeUsings(file: string, sym: FileSymbol): Usings {
    const scoped = usingsByFileScope.get(file);
    const merged: Usings = { aliases: new Map(), ordinary: [], staticTypes: [] };
    const mergeInto = (u: Usings | undefined) => {
      if (!u) return;
      for (const [k, v] of u.aliases) {
        if (!merged.aliases.has(k)) merged.aliases.set(k, v);
      }
      merged.ordinary.push(...u.ordinary);
      merged.staticTypes.push(...u.staticTypes);
    };
    for (const key of nsAncestorsByFile.get(file)?.get(sym.index) ?? []) {
      mergeInto(scoped?.get(key));
    }
    mergeInto(scoped?.get(""));
    mergeInto(globalUsingsByRoot.get(projectRootOf(file)));
    return merged;
  }

  interface MemberCandidate extends CSharpResolvedTarget {
    /** Emission index of the member symbol — preserves declaration
     *  occurrence identity even when file, name, and line are identical. */
    index: number;
  }

  /**
   * Symbols `chain::member` of the given kinds inside the parts of one type
   * identity. Ranges disambiguate same-named types sharing one file across
   * namespaces.
   */
  function membersOf(
    identity: TypeIdentity,
    member: string,
    kinds: ReadonlySet<string>,
  ): MemberCandidate[] {
    const found: MemberCandidate[] = [];
    const full = `${identity.chain}::${member}`;
    for (const part of identity.parts) {
      const candidates = nameIndexByFile.get(part.file)?.get(full) ?? [];
      for (const c of candidates) {
        if (c.startLine < part.startLine || c.startLine > part.endLine) continue;
        // Owner attribution by emission order: the member belongs to the
        // nearest preceding same-named type in its file, so same-named
        // types sharing one line range keep distinct member sets.
        if (memberOwnerByFile.get(part.file)?.get(c.index) !== part.index) continue;
        if (!kinds.has(c.symbolType)) continue;
        found.push({ filePath: part.file, name: full, index: c.index });
      }
    }
    return found;
  }

  /**
   * Unique (file,name,occurrence) targets for member `name` on a set of
   * type identities, restricted to callable method symbols. Same-named
   * symbols in one file — overloads, #if/#else bodies, and declarations
   * sharing a line — stay distinct, so resolution requires exactly one
   * candidate.
   */
  function memberTargets(
    identities: TypeIdentity[],
    member: string,
    kinds: ReadonlySet<string> = CALLABLE_MEMBER_KINDS,
  ): MemberCandidate[] {
    const seen = new Map<string, MemberCandidate>();
    for (const ident of identities) {
      for (const target of membersOf(ident, member, kinds)) {
        const key = `${target.filePath}\0${target.name}\0${target.index}`;
        if (!seen.has(key)) seen.set(key, target);
      }
    }
    return [...seen.values()];
  }

  /** Occurrence result keeps the internal index for node-level routing. */
  const unwrap = (t: MemberCandidate): CSharpResolvedOccurrence => ({
    filePath: t.filePath,
    name: t.name,
    index: t.index,
  });

  /** Type identities named `chain` in namespace `ns` across all roots. */
  function typeIdentitiesIn(ns: string, chain: string): TypeIdentity[] {
    return typesByNsChain.get(`${ns}|${chain}`) ?? [];
  }

  interface CallerContext {
    file: string;
    ns: string;
    /** `::`-joined enclosing-type chain of the caller ("" for top-level). */
    chain: string;
    /** The caller symbol — anchors namespace-scoped using visibility. */
    sym: FileSymbol;
  }

  /** What a qualified path's head segment bound to: a type identity, or a
   *  namespace declared at some enclosing level. */
  type HeadBinding = { kind: "type"; ident: TypeIdentity } | { kind: "ns"; ns: string };

  /**
   * Resolve a qualified path's head segment through the C# lookup order.
   * Returns the bound type or namespace, "reserved" when an alias binds
   * the name to a non-workspace target, or null when the name is unbound
   * or binds ambiguously.
   *
   * Lookup is per namespace level: member types of enclosing types, then
   * at each level innermost→global the declared types and namespaces (one
   * declaration space — a type and a nested namespace cannot share a
   * name), then that level's alias, ordinary-using, and using-static
   * bindings — and only after all enclosing levels the compilation-unit
   * and project-root global usings. The first level that binds the name
   * decides: an ambiguous or reserved inner binding ends the lookup
   * rather than falling outward.
   */
  function resolveHeadName(ctx: CallerContext, name: string): HeadBinding | "reserved" | null {
    // 1. Member types of enclosing types, innermost outward. Types cannot
    //    contain namespaces, so this tier binds types only.
    if (ctx.chain) {
      const segs = ctx.chain.split("::");
      for (let len = segs.length; len >= 1; len--) {
        const chain = `${segs.slice(0, len).join("::")}::${name}`;
        const found = typeIdentitiesIn(ctx.ns, chain);
        if (found.length === 1) return { kind: "type", ident: found[0] };
        if (found.length > 1) return null; // ambiguous at this level
      }
    }

    // 2. Namespace levels innermost→global: at each level the declared
    //    types and namespaces first, then the usings declared inside that
    //    namespace declaration. The caller's ancestor scope keys carry
    //    the level each scoped using belongs to.
    const scoped = usingsByFileScope.get(ctx.file);
    const levelUsings = new Map<string, Usings>();
    for (const key of nsAncestorsByFile.get(ctx.file)?.get(ctx.sym.index) ?? []) {
      const level = scopeNamespace(key);
      const u = scoped?.get(key);
      if (u && !levelUsings.has(level)) levelUsings.set(level, u);
    }
    const nsParts = ctx.ns ? ctx.ns.split(".") : [];
    for (let len = nsParts.length; len >= 0; len--) {
      const nsLevel = nsParts.slice(0, len).join(".");
      const found = typeIdentitiesIn(nsLevel, name);
      const nestedNs = nsLevel ? `${nsLevel}.${name}` : name;
      const candidates = found.length + (nsDeclared.has(nestedNs) ? 1 : 0);
      if (candidates === 1) {
        return found.length === 1
          ? { kind: "type", ident: found[0] }
          : { kind: "ns", ns: nestedNs };
      }
      if (candidates > 1) return null; // ambiguous at this level
      const hit = resolveViaUsings(levelUsings.get(nsLevel), name);
      if (hit !== undefined) {
        if (hit === "reserved") return "reserved";
        if (hit === null) return null; // ambiguous at this level
        return { kind: "type", ident: hit };
      }
    }

    // 3. Compilation-unit usings plus the project root's global usings.
    const tier: Usings = { aliases: new Map(), ordinary: [], staticTypes: [] };
    const mergeTier = (u: Usings | undefined) => {
      if (!u) return;
      for (const [k, v] of u.aliases) {
        if (!tier.aliases.has(k)) tier.aliases.set(k, v);
      }
      tier.ordinary.push(...u.ordinary);
      tier.staticTypes.push(...u.staticTypes);
    };
    mergeTier(scoped?.get(""));
    mergeTier(globalUsingsByRoot.get(projectRootOf(ctx.file)));
    const hit = resolveViaUsings(tier, name);
    if (hit === undefined || hit === null) return null;
    return hit === "reserved" ? "reserved" : { kind: "type", ident: hit };
  }

  /**
   * Bind a type name through one level's using directives: the level's
   * alias binds first (an external target reserves the name), then the
   * pooled ordinary-using namespaces and using-static nested types decide
   * by uniqueness. `undefined` means this level binds nothing — lookup
   * continues outward; `null` means the level binds ambiguously; a
   * "reserved" alias ends the lookup without a type.
   */
  function resolveViaUsings(
    u: Usings | undefined,
    name: string,
  ): TypeIdentity | "reserved" | null | undefined {
    if (!u) return undefined;
    const aliasTarget = u.aliases.get(name);
    if (aliasTarget !== undefined) {
      // The alias binds the name. When its target is not a workspace type
      // the name is still taken — no fall-through to a workspace namesake.
      const resolved = resolveQualifiedTypeFromGlobal(aliasTarget);
      return resolved ?? "reserved";
    }
    const found: TypeIdentity[] = [];
    const push = (ident: TypeIdentity) => {
      if (!found.includes(ident)) found.push(ident);
    };
    for (const ns of u.ordinary) {
      for (const ident of typeIdentitiesIn(ns, name)) push(ident);
    }
    for (const target of u.staticTypes) {
      const ident = resolveQualifiedTypeFromGlobal(target);
      if (!ident) continue;
      const nested = typesByKey.get(`${ident.root}|${ident.ns}|${ident.chain}::${name}`);
      if (nested) push(nested);
    }
    if (found.length === 0) return undefined;
    return found.length === 1 ? found[0] : null;
  }

  /**
   * Resolve a qualified path (`Ns.Outer.Inner`) to a unique type identity:
   * the longest declared-namespace prefixes, then a type in that namespace,
   * then nested member types. Also tries the global namespace (no prefix).
   */
  function resolveQualifiedTypeFromGlobal(pathName: string): TypeIdentity | null {
    const segs = pathName.split(".");
    const results = new Map<string, TypeIdentity>();
    for (let i = segs.length - 1; i >= 0; i--) {
      const ns = segs.slice(0, i).join(".");
      if (i > 0 && !nsDeclared.has(ns)) continue;
      const typeName = segs[i];
      let current = typeIdentitiesIn(ns, typeName);
      let alive = current.length > 0;
      for (let j = i + 1; j < segs.length && alive; j++) {
        const next: TypeIdentity[] = [];
        for (const ident of current) {
          const nested = typesByKey.get(`${ident.root}|${ident.ns}|${ident.chain}::${segs[j]}`);
          if (nested) next.push(nested);
        }
        current = next;
        alive = current.length > 0;
      }
      if (alive) for (const ident of current) results.set(ident.key, ident);
    }
    return results.size === 1 ? [...results.values()][0] : null;
  }

  /** Candidate qualified names for a target declared inside namespace
   *  `ns`: each enclosing prefix innermost→global (the last candidate is
   *  the verbatim target itself, i.e. the global namespace level). */
  function scopedCandidates(ns: string, target: string): string[] {
    const segs = ns ? ns.split(".") : [];
    const out: string[] = [];
    for (let i = segs.length; i >= 0; i--) {
      out.push(i === 0 ? target : `${segs.slice(0, i).join(".")}.${target}`);
    }
    return out;
  }

  /** Namespace target of an ordinary using, resolved relative to its
   *  declaration scope; no match keeps the verbatim target so a declared
   *  namespace can still bind verbatim. */
  function resolveScopedNs(ns: string, target: string): string {
    for (const c of scopedCandidates(ns, target)) {
      if (nsDeclared.has(c)) return c;
    }
    return target;
  }

  /** `using static` target, resolved relative to its declaration scope —
   *  first candidate that resolves to a type identity, else verbatim. */
  function resolveScopedType(ns: string, target: string): string {
    for (const c of scopedCandidates(ns, target)) {
      if (resolveQualifiedTypeFromGlobal(c)) return c;
    }
    return target;
  }

  /** Alias target, which may be a type or a namespace — first candidate
   *  matching either, else verbatim. */
  function resolveScopedAlias(ns: string, target: string): string {
    for (const c of scopedCandidates(ns, target)) {
      if (resolveQualifiedTypeFromGlobal(c) || nsDeclared.has(c)) return c;
    }
    return target;
  }

  /**
   * Resolve `Q1.Q2.…​.M` to member targets. The head segment binds once
   * through the enclosing-namespace lookup — whatever it binds to decides:
   * a type head walks nested member types, and a namespace head walks its
   * members segment by segment (each a nested namespace or a type).
   * A dead end or ambiguity produces no target rather than falling through
   * to an outer interpretation — C# reports an error for those instead.
   */
  function resolveQualifiedMember(ctx: CallerContext, dotted: string): MemberCandidate[] {
    const segs = dotted.split(".");
    const member = segs[segs.length - 1];
    const mids = segs.slice(0, -1);
    const head = resolveHeadName(ctx, mids[0]);
    if (!head || head === "reserved") return [];

    // Segments beneath a bound type are nested member types only.
    const walkTypes = (initial: TypeIdentity[], start: number): TypeIdentity[] | null => {
      let current = initial;
      for (let j = start; j < mids.length; j++) {
        const next: TypeIdentity[] = [];
        for (const ident of current) {
          const nested = typesByKey.get(`${ident.root}|${ident.ns}|${ident.chain}::${mids[j]}`);
          if (nested) next.push(nested);
        }
        if (next.length === 0) return null;
        current = next;
      }
      return current;
    };

    let current: TypeIdentity[] | null;
    if (head.kind === "type") {
      current = walkTypes([head.ident], 1);
    } else {
      // Descend from the bound namespace: each segment binds to that
      // namespace's unique nested namespace or declared type — a segment
      // that binds neither (dead end) or both (impossible in valid C#)
      // ends the path with no target.
      let ns = head.ns;
      current = null;
      let j = 1;
      for (; j < mids.length; j++) {
        const seg = mids[j];
        const types = typeIdentitiesIn(ns, seg);
        const nestedNs = `${ns}.${seg}`;
        const nsHit = nsDeclared.has(nestedNs);
        if (types.length + (nsHit ? 1 : 0) !== 1) return [];
        if (nsHit) {
          ns = nestedNs;
        } else {
          current = types;
          j++;
          break;
        }
      }
      // A path that ends inside a namespace has no type to hold a member.
      if (current) current = walkTypes(current, j);
    }
    return current ? memberTargets(current, member) : [];
  }

  /** Caller type identity: (root, ns, chain) of the symbol the call sits in. */
  function callerContext(file: string, callerName: string): CallerContext | null {
    const syms = nameIndexByFile.get(file)?.get(callerName) ?? [];
    const chain = callerName.includes("::")
      ? callerName.slice(0, callerName.lastIndexOf("::"))
      : "";
    // Caller must be a single occurrence. Call records carry no position, so
    // two same-file symbols sharing this label (overloads, #if duplicates,
    // same-named members) cannot be attributed to their own graph nodes —
    // the (file,label) caller lookup would collapse them onto one node and
    // emit an edge from the wrong source. Fail closed: no context, no edge.
    if (syms.length !== 1) return null;
    return { file, ns: namespaceOf(file, syms[0]!), chain, sym: syms[0]! };
  }

  function resolveCall(
    filePath: string,
    callerName: string,
    calleeName: string,
  ): CSharpResolvedTarget | null {
    const hit = resolveCallOccurrence(filePath, callerName, calleeName);
    return hit ? { filePath: hit.filePath, name: hit.name } : null;
  }

  function resolveCallOccurrence(
    filePath: string,
    callerName: string,
    calleeName: string,
  ): CSharpResolvedOccurrence | null {
    const ctx = callerContext(filePath, callerName);
    if (!ctx) return null;

    const isGlobal = calleeName.startsWith("global::");
    const dotted = isGlobal ? calleeName.slice("global::".length) : calleeName;
    const segs = dotted.split(".");

    if (segs.length === 1) {
      // Bare call: same-type member across all partial parts, else
      // uniquely bound using-static members.
      const member = segs[0];
      if (ctx.chain) {
        const own = typeIdentitiesIn(ctx.ns, ctx.chain).filter(
          (t) => t.root === projectRootOf(filePath),
        );
        for (const ident of own) {
          const targets = memberTargets([ident], member);
          // Parts declare the name: unique target wins; duplicates
          // (overloads, #if/#else bodies, partial parts) are ambiguous and
          // never fall through to using-static.
          if (targets.length > 0) return targets.length === 1 ? unwrap(targets[0]) : null;
        }
      }
      const usings = scopeUsings(filePath, ctx.sym);
      const staticTargets = new Map<string, MemberCandidate>();
      for (const target of usings.staticTypes) {
        const ident = resolveQualifiedTypeFromGlobal(target);
        if (!ident) continue;
        for (const t of memberTargets([ident], member, STATIC_MEMBER_KINDS)) {
          staticTargets.set(`${t.filePath}\0${t.name}\0${t.index}`, t);
        }
      }
      return staticTargets.size === 1 ? unwrap([...staticTargets.values()][0]) : null;
    }

    // Qualified call.
    if (segs[0] === "this") {
      // this.M — same-type member across all parts.
      if (!ctx.chain || segs.length !== 2) return null;
      const own = typeIdentitiesIn(ctx.ns, ctx.chain).filter(
        (t) => t.root === projectRootOf(filePath),
      );
      const targets = new Map<string, MemberCandidate>();
      for (const ident of own) {
        for (const t of memberTargets([ident], segs[1])) {
          targets.set(`${t.filePath}\0${t.name}\0${t.index}`, t);
        }
      }
      return targets.size === 1 ? unwrap([...targets.values()][0]) : null;
    }

    if (isGlobal) {
      // global::Ns.Type.M — ns-rooted only.
      const targets = new Map<string, MemberCandidate>();
      const mids = segs.slice(0, -1);
      const member = segs[segs.length - 1];
      for (let i = mids.length - 1; i >= 1; i--) {
        const ns = mids.slice(0, i).join(".");
        if (!nsDeclared.has(ns)) continue;
        let current = typeIdentitiesIn(ns, mids[i]);
        let alive = current.length > 0;
        for (let j = i + 1; j < mids.length && alive; j++) {
          const next: TypeIdentity[] = [];
          for (const ident of current) {
            const nested = typesByKey.get(`${ident.root}|${ident.ns}|${ident.chain}::${mids[j]}`);
            if (nested) next.push(nested);
          }
          current = next;
          alive = current.length > 0;
        }
        if (alive) {
          for (const t of memberTargets(current, member)) {
            targets.set(`${t.filePath}\0${t.name}\0${t.index}`, t);
          }
        }
      }
      return targets.size === 1 ? unwrap([...targets.values()][0]) : null;
    }

    const targets = resolveQualifiedMember(ctx, dotted);
    return targets.length === 1 ? unwrap(targets[0]) : null;
  }

  /**
   * Imports edges: only an explicit using binding that resolves to exactly
   * one in-workspace file. Namespaces/types spread over several files, and
   * namespaces the workspace does not declare, produce no edge.
   */
  function resolveImport(filePath: string, directive: string): string | null {
    const { scopeKey, text } = splitUsingScope(directive);
    const parsed = parseUsing(text);
    if (!parsed) return null;
    const scopeNs = scopeKey ? scopeNamespace(scopeKey) : "";
    if (parsed.kind === "ordinary") {
      const files = nsDeclared.get(resolveScopedNs(scopeNs, parsed.ns));
      return files && files.size === 1 ? [...files][0] : null;
    }
    if (parsed.kind === "static") {
      const ident = resolveQualifiedTypeFromGlobal(resolveScopedType(scopeNs, parsed.target));
      if (!ident) return null;
      const files = new Set(ident.parts.map((p) => p.file));
      return files.size === 1 ? [...files][0] : null;
    }
    // alias — target may be a type or a namespace.
    const target = resolveScopedAlias(scopeNs, parsed.target);
    const ident = resolveQualifiedTypeFromGlobal(target);
    if (ident) {
      const files = new Set(ident.parts.map((p) => p.file));
      return files.size === 1 ? [...files][0] : null;
    }
    const nsFiles = nsDeclared.get(target);
    return nsFiles && nsFiles.size === 1 ? [...nsFiles][0] : null;
  }

  return { resolveCall, resolveCallOccurrence, resolveImport };
}
