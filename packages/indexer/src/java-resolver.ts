/**
 * Java call/import resolver — static package/type/member index.
 *
 * Resolution rules (see design.md):
 * - Type identity is `${packageName}.${Outer.Inner}` (no package → dotted name).
 * - Bare/this calls resolve only within the innermost enclosing named type;
 *   nested types never walk outward, but a member declared in any enclosing
 *   type blocks a static import fallback.
 * - `Type.member()` resolves the qualifier through: member types of enclosing
 *   types (innermost first) → the file's own top-level types → explicit
 *   single-type imports → same-package types. First hit wins; ambiguity or an
 *   external import claim returns null (no fallthrough).
 * - Fully dotted receivers must equal a package-qualified type name.
 * - A bare call resolves through a single static import only when nothing in
 *   the enclosing types declares the member.
 * - Overloads (more than one method with the simple name) never resolve.
 * - No variable-receiver, inherited, overload, or type-inference resolution.
 */

export interface JavaResolverFile {
  filePath: string;
  symbols: Array<{ name: string; symbolType: string }>;
  importPaths: string[];
}

export interface JavaResolver {
  resolveCall(input: {
    filePath: string;
    callerName: string;
    calleeName: string;
  }): { filePath: string; symbolName: string } | null;
  /** Resolve an explicit import specifier (from importPaths) to a workspace
   *  file, or null for external/wildcard/ambiguous imports. */
  resolveImport(filePath: string, specifier: string): string | null;
}

interface JavaTypeRef {
  filePath: string;
  /** symbol label, e.g. `Outer::Inner` */
  symbolName: string;
  /** package-qualified name, e.g. `app.Outer.Inner` or `Outer.Inner` */
  qualifiedName: string;
  /** last segment of the symbol label */
  simpleName: string;
}

interface JavaFileIndex {
  packageName: string;
  /** every type symbol label in the file → ref */
  typesByName: Map<string, JavaTypeRef>;
  /** simple name → top-level type refs declared in this file */
  topLevelBySimple: Map<string, JavaTypeRef[]>;
  /** normalized import specifier → {isStatic} */
  /** simple name → distinct imported qualified names. A set with more than
   *  one entry is a conflicting import pair and resolves to null. */
  singleTypeImports: Map<string, Set<string>>;
  /** member name → distinct imported qualified type names (same rule). */
  staticImports: Map<string, Set<string>>;
  /** owner symbol label → method simple-name → count */
  methodsByOwner: Map<string, Map<string, number>>;
  /** owner symbol label → all member simple-names (methods/fields/types/consts) */
  membersByOwner: Map<string, Set<string>>;
}

const TYPE_SYMBOL_TYPES = new Set(["class", "interface", "enum", "record"]);
const MEMBER_OWNED_TYPES = new Set([
  "class",
  "interface",
  "enum",
  "record",
  "function",
  "constructor",
  "field",
  "const",
]);

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const QUAL_RE = /^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;

function ownerOf(symbolName: string): string {
  const idx = symbolName.lastIndexOf("::");
  return idx === -1 ? "" : symbolName.slice(0, idx);
}

function simpleOf(symbolName: string): string {
  const idx = symbolName.lastIndexOf("::");
  return idx === -1 ? symbolName : symbolName.slice(idx + 2);
}

export function createJavaResolver(files: JavaResolverFile[]): JavaResolver {
  const fileIndex = new Map<string, JavaFileIndex>();
  /** package-qualified dotted name → refs across the workspace */
  const typesByQualified = new Map<string, JavaTypeRef[]>();
  /** package name → simple name → top-level refs across the workspace */
  const packageTypes = new Map<string, Map<string, JavaTypeRef[]>>();

  // ---- pass 1: build per-file type/member index --------------------------
  for (const file of files) {
    const idx: JavaFileIndex = {
      packageName: "",
      typesByName: new Map(),
      topLevelBySimple: new Map(),
      singleTypeImports: new Map(),
      staticImports: new Map(),
      methodsByOwner: new Map(),
      membersByOwner: new Map(),
    };

    const names = new Set(file.symbols.map((s) => s.name));

    for (const sym of file.symbols) {
      if (sym.symbolType === "package") {
        idx.packageName = sym.name;
      }
      const owner = ownerOf(sym.name);
      if (MEMBER_OWNED_TYPES.has(sym.symbolType) && owner && names.has(owner)) {
        let set = idx.membersByOwner.get(owner);
        if (!set) idx.membersByOwner.set(owner, (set = new Set()));
        set.add(simpleOf(sym.name));
        if (sym.symbolType === "function") {
          let m = idx.methodsByOwner.get(owner);
          if (!m) idx.methodsByOwner.set(owner, (m = new Map()));
          const simple = simpleOf(sym.name);
          m.set(simple, (m.get(simple) ?? 0) + 1);
        }
      }
    }

    for (const sym of file.symbols) {
      if (!TYPE_SYMBOL_TYPES.has(sym.symbolType)) continue;
      const qualified = idx.packageName
        ? `${idx.packageName}.${sym.name.replaceAll("::", ".")}`
        : sym.name.replaceAll("::", ".");
      const ref: JavaTypeRef = {
        filePath: file.filePath,
        symbolName: sym.name,
        qualifiedName: qualified,
        simpleName: simpleOf(sym.name),
      };
      idx.typesByName.set(sym.name, ref);
      if (!sym.name.includes("::")) {
        let arr = idx.topLevelBySimple.get(ref.simpleName);
        if (!arr) idx.topLevelBySimple.set(ref.simpleName, (arr = []));
        arr.push(ref);
        let pkgMap = packageTypes.get(idx.packageName);
        if (!pkgMap) packageTypes.set(idx.packageName, (pkgMap = new Map()));
        let parr = pkgMap.get(ref.simpleName);
        if (!parr) pkgMap.set(ref.simpleName, (parr = []));
        parr.push(ref);
        let qarr = typesByQualified.get(qualified);
        if (!qarr) typesByQualified.set(qualified, (qarr = []));
        qarr.push(ref);
      } else {
        // nested types also reachable via package-qualified dotted name
        let qarr = typesByQualified.get(qualified);
        if (!qarr) typesByQualified.set(qualified, (qarr = []));
        qarr.push(ref);
      }
    }

    // ---- imports --------------------------------------------------------
    for (const raw of file.importPaths) {
      let spec = raw.trim();
      let isStatic = false;
      if (spec.startsWith("static ")) {
        isStatic = true;
        spec = spec.slice(7).trim();
      }
      if (!QUAL_RE.test(spec) && !spec.endsWith(".*")) continue;
      if (spec.endsWith(".*")) continue; // wildcard: no binding, no edge
      if (isStatic) {
        const dot = spec.lastIndexOf(".");
        if (dot === -1) continue;
        const member = spec.slice(dot + 1);
        const typeQual = spec.slice(0, dot);
        let set = idx.staticImports.get(member);
        if (!set) idx.staticImports.set(member, (set = new Set()));
        set.add(typeQual);
      } else {
        const simple = simpleOf(spec.replaceAll(".", "::"));
        let set = idx.singleTypeImports.get(simple);
        if (!set) idx.singleTypeImports.set(simple, (set = new Set()));
        set.add(spec);
      }
    }

    fileIndex.set(file.filePath, idx);
  }

  // ---- helpers ------------------------------------------------------------

  /** Unique workspace type for a package-qualified dotted name, or null. */
  function resolveQualified(qual: string): JavaTypeRef | null {
    const refs = typesByQualified.get(qual);
    return refs && refs.length === 1 ? refs[0] : null;
  }

  /** Enclosing named types of the caller, innermost first. The caller itself
   *  is a candidate when it is a type symbol (calls attributed to a type via
   *  initializers/instance blocks). */
  function enclosingTypes(fileIdx: JavaFileIndex, callerName: string): JavaTypeRef[] {
    const out: JavaTypeRef[] = [];
    if (fileIdx.typesByName.has(callerName)) out.push(fileIdx.typesByName.get(callerName)!);
    let owner = ownerOf(callerName);
    while (owner) {
      const t = fileIdx.typesByName.get(owner);
      if (t) out.push(t);
      owner = ownerOf(owner);
    }
    return out;
  }

  function methodCount(fileIdxOfType: JavaFileIndex, ownerName: string, member: string): number {
    return fileIdxOfType.methodsByOwner.get(ownerName)?.get(member) ?? 0;
  }

  function declaresMember(
    fileIdxOfType: JavaFileIndex,
    ownerName: string,
    member: string,
  ): boolean {
    return fileIdxOfType.membersByOwner.get(ownerName)?.has(member) ?? false;
  }

  /** Resolve a simple (non-dotted) type qualifier within a source file. */
  function resolveTypeName(
    fileIdx: JavaFileIndex,
    enclosing: JavaTypeRef[],
    name: string,
  ): JavaTypeRef | null {
    // member types of enclosing types, innermost first
    for (const enc of enclosing) {
      const cand = fileIdx.typesByName.get(`${enc.symbolName}::${name}`);
      if (cand) return cand;
    }
    // this file's own top-level types
    const own = fileIdx.topLevelBySimple.get(name);
    if (own && own.length === 1) return own[0];
    if (own && own.length > 1) return null;
    // explicit single-type import owns the name: conflicting pairs resolve
    // to null; a single external binding reserves the name (still null, and
    // never falls through to the same-package rule below)
    const imported = fileIdx.singleTypeImports.get(name);
    if (imported !== undefined) {
      if (imported.size !== 1) return null;
      return resolveQualified([...imported][0]);
    }
    // same-package top-level types
    const pkgRefs = packageTypes.get(fileIdx.packageName)?.get(name);
    if (pkgRefs && pkgRefs.length === 1) return pkgRefs[0];
    return null;
  }

  function methodsEdge(
    type: JavaTypeRef,
    member: string,
  ): { filePath: string; symbolName: string } | null {
    const idx = fileIndex.get(type.filePath);
    if (!idx) return null;
    if (methodCount(idx, type.symbolName, member) !== 1) return null;
    return { filePath: type.filePath, symbolName: `${type.symbolName}::${member}` };
  }

  return {
    resolveCall({ filePath, callerName, calleeName }) {
      const fileIdx = fileIndex.get(filePath);
      if (!fileIdx) return null;
      const enclosing = enclosingTypes(fileIdx, callerName);
      const innermost = enclosing[0];

      if (calleeName.startsWith("this.")) {
        const member = calleeName.slice(5);
        if (!IDENT_RE.test(member) || !innermost) return null;
        return methodCount(fileIdx, innermost.symbolName, member) === 1
          ? { filePath, symbolName: `${innermost.symbolName}::${member}` }
          : null;
      }

      if (!calleeName.includes(".")) {
        const member = calleeName;
        if (!IDENT_RE.test(member)) return null;
        if (innermost) {
          const c = methodCount(fileIdx, innermost.symbolName, member);
          if (c === 1) return { filePath, symbolName: `${innermost.symbolName}::${member}` };
          if (c > 1) return null;
          // a member declaration in the innermost or any outer enclosing type
          // blocks the static import fallback
          if (declaresMember(fileIdx, innermost.symbolName, member)) return null;
          for (const outer of enclosing.slice(1)) {
            if (declaresMember(fileIdx, outer.symbolName, member)) return null;
          }
        }
        const typeQuals = fileIdx.staticImports.get(member);
        if (typeQuals === undefined || typeQuals.size !== 1) return null;
        const target = resolveQualified([...typeQuals][0]);
        return target ? methodsEdge(target, member) : null;
      }

      // qualified receiver
      const dot = calleeName.lastIndexOf(".");
      const qualifier = calleeName.slice(0, dot);
      const member = calleeName.slice(dot + 1);
      if (!IDENT_RE.test(member) || !QUAL_RE.test(qualifier)) return null;
      const type = qualifier.includes(".")
        ? resolveQualified(qualifier)
        : resolveTypeName(fileIdx, enclosing, qualifier);
      return type ? methodsEdge(type, member) : null;
    },

    resolveImport(filePath, specifier) {
      const fileIdx = fileIndex.get(filePath);
      if (!fileIdx) return null;
      let spec = specifier.trim();
      if (spec.startsWith("static ")) {
        spec = spec.slice(7).trim();
        const dot = spec.lastIndexOf(".");
        if (dot === -1 || spec.endsWith(".*")) return null;
        const target = resolveQualified(spec.slice(0, dot));
        return target?.filePath ?? null;
      }
      if (spec.endsWith(".*")) return null;
      const target = resolveQualified(spec);
      return target?.filePath ?? null;
    },
  };
}
