import path from "node:path";

/**
 * C++ translation-unit include/call resolution for graph edges. A C++ file
 * sees itself plus the recursively reachable literal quoted includes inside
 * the workspace; calls resolve only to unique targets visible through that
 * closure. See docs/agent-devkit/changes/2026-10-20-39-cpp-indexing-accuracy.
 *
 * - Include resolution: the literal quoted path is tried relative to the
 *   including file's directory, then the workspace root, then a unique
 *   path-suffix match among workspace C++ files. Angle/system includes are
 *   never extracted, and nothing may resolve outside the workspace.
 * - Pairing: a candidate name binds to the group of symbols sharing that
 *   qualified name across visible files. The group resolves only when it
 *   holds exactly one definition and at most one declaration (target = the
 *   definition) or exactly one declaration and no definitions.
 * - Lookup: unqualified calls walk the caller's enclosing scopes
 *   innermost-to-global — the first scope holding any visible group with
 *   that name decides (closer scopes hide further ones). Qualified
 *   `a::b::f` names resolve against the same scope prefixes; a leading
 *   `::` binds global scope only. `this.f`/`this->f` look up only methods
 *   on the caller's innermost class/struct/union scope.
 * - Not resolved (by design): receiver-variable types, inheritance,
 *   overload choice, template specialization, macro-generated
 *   declarations, using-directives, compiler flags, system include paths.
 */

export interface CppCallTarget {
  filePath: string;
  symbolName: string;
}

export interface CppResolver {
  /** Resolve a quoted include specifier to a workspace-relative C++ file. */
  resolveImport(importerRel: string, spec: string): string | null;
  resolveCall(call: {
    filePath: string;
    callerName: string;
    calleeName: string;
  }): CppCallTarget | null;
}

interface GroupMember {
  file: string;
  name: string;
  isDefinition: boolean;
}

const CALLABLE_TYPES = new Set(["function", "method", "declaration"]);
const TYPE_SCOPE_TYPES = new Set(["class", "struct", "union"]);
const SCOPE_SYMBOL_TYPES = new Set([
  "namespace",
  "class",
  "struct",
  "union",
  "enum",
  "type",
]);

export function createCppResolver(options: {
  /** Workspace-relative paths of all parsed C++ files. */
  cppFiles: string[];
  symbolsFor: (file: string) => Array<{ name: string; symbolType: string }>;
  importPathsFor: (file: string) => string[];
  workspaceRelativeFor: (absPath: string) => string | null;
  workspaceRoot: string;
}): CppResolver {
  const cppFileSet = new Set(options.cppFiles);

  // Qualified name -> members across every parsed C++ file; visibility is
  // filtered per caller at lookup time. Every declaration counts — two
  // same-name declarations (overloads) make the group ambiguous.
  const groupsByName = new Map<string, GroupMember[]>();
  // `${file}\0${name}` -> symbolType, for caller-scope classification.
  const symbolTypeByFileAndName = new Map<string, string>();
  // type-scope name -> files declaring it (class/struct/union).
  const typeFilesByName = new Map<string, Set<string>>();

  for (const file of options.cppFiles) {
    for (const sym of options.symbolsFor(file)) {
      symbolTypeByFileAndName.set(`${file}\0${sym.name}`, sym.symbolType);
      if (TYPE_SCOPE_TYPES.has(sym.symbolType)) {
        const files = typeFilesByName.get(sym.name) ?? new Set<string>();
        files.add(file);
        typeFilesByName.set(sym.name, files);
      }
      if (!CALLABLE_TYPES.has(sym.symbolType)) continue;
      const list = groupsByName.get(sym.name) ?? [];
      list.push({
        file,
        name: sym.name,
        isDefinition: sym.symbolType !== "declaration",
      });
      groupsByName.set(sym.name, list);
    }
  }

  /**
   * Resolve a literal quoted include path: importer directory first, then
   * workspace root, then a unique suffix match among workspace C++ files.
   * Workspace containment is enforced by workspaceRelativeFor.
   */
  function resolveInclude(importerRel: string, spec: string): string | null {
    if (!spec || spec.startsWith("<")) return null;
    const normalizedSpec = spec.replace(/^\.\//, "");
    const dir = path.posix.dirname(importerRel);
    const candidates = new Set<string>([
      dir === "." ? normalizedSpec : `${dir}/${normalizedSpec}`,
      normalizedSpec,
    ]);
    for (const rel of candidates) {
      const resolved = options.workspaceRelativeFor(
        path.resolve(options.workspaceRoot, rel),
      );
      if (resolved && cppFileSet.has(resolved)) return resolved;
    }
    const suffixMatches = options.cppFiles.filter(
      (p) => p === normalizedSpec || p.endsWith(`/${normalizedSpec}`),
    );
    return suffixMatches.length === 1 ? suffixMatches[0] : null;
  }

  // Self + transitively reachable quoted includes, cycle-safe, memoized.
  const visibilityCache = new Map<string, Set<string>>();
  function visibleFiles(file: string): Set<string> {
    const cached = visibilityCache.get(file);
    if (cached) return cached;
    const seen = new Set<string>();
    const stack = [file];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const spec of options.importPathsFor(cur)) {
        const target = resolveInclude(cur, spec);
        if (target && !seen.has(target)) stack.push(target);
      }
    }
    visibilityCache.set(file, seen);
    return seen;
  }

  function groupFor(name: string, visible: Set<string>): GroupMember[] {
    const members = groupsByName.get(name);
    if (!members) return [];
    return members.filter((m) => visible.has(m.file));
  }

  /** Unique-target rule: one definition (+ at most one declaration), or a
   *  single declaration with no definition. Anything else is ambiguous. */
  function resolveGroup(members: GroupMember[]): GroupMember | null {
    const defs = members.filter((m) => m.isDefinition);
    const decls = members.filter((m) => !m.isDefinition);
    if (defs.length === 1 && decls.length <= 1) return defs[0];
    if (defs.length === 0 && decls.length === 1) return decls[0];
    return null;
  }

  /** Caller scopes innermost-to-global: the caller symbol itself when it is
   *  a scope-bearing type (calls in class/namespace bodies), then each
   *  `::`-separated prefix, then "" for global. */
  function callerScopes(file: string, callerName: string): string[] {
    const scopes: string[] = [];
    const type = symbolTypeByFileAndName.get(`${file}\0${callerName}`);
    if (type && SCOPE_SYMBOL_TYPES.has(type)) scopes.push(callerName);
    let name = callerName;
    for (;;) {
      const index = name.lastIndexOf("::");
      if (index < 0) break;
      name = name.slice(0, index);
      scopes.push(name);
    }
    scopes.push("");
    return scopes;
  }

  /** Innermost caller scope that is a class/struct/union visible to the
   *  caller — the `this` receiver's only legal lookup scope. */
  function ownTypeScope(scopes: string[], visible: Set<string>): string | null {
    for (const scope of scopes) {
      if (!scope) break;
      const files = typeFilesByName.get(scope);
      if (files && [...files].some((f) => visible.has(f))) return scope;
    }
    return null;
  }

  return {
    resolveImport: resolveInclude,

    resolveCall(call) {
      const callee = call.calleeName;
      if (!callee) return null;
      const visible = visibleFiles(call.filePath);
      const scopes = callerScopes(call.filePath, call.callerName);

      const toTarget = (members: GroupMember[]): CppCallTarget | null => {
        const target = resolveGroup(members);
        return target ? { filePath: target.file, symbolName: target.name } : null;
      };

      // this.f / this->f (the parser normalizes `->` to `.`): own class only.
      if (callee.startsWith("this.")) {
        const member = callee.slice(5);
        if (!member || member.includes(".")) return null;
        const scope = ownTypeScope(scopes, visible);
        if (!scope) return null;
        return toTarget(groupFor(`${scope}::${member}`, visible));
      }
      if (callee === "this") return null;

      // Receiver-qualified calls (obj.f, a.b.c, p->f) never resolve — the
      // receiver's type is unknown by design.
      if (callee.includes(".")) return null;

      // Leading :: binds global scope only.
      if (callee.startsWith("::")) {
        const name = callee.slice(2);
        if (!name) return null;
        return toTarget(groupFor(name, visible));
      }

      // Unqualified or relatively-qualified name: the first scope holding a
      // visible group with that candidate name decides; further scopes are
      // hidden even when their group would have resolved.
      for (const scope of scopes) {
        const candidate = scope ? `${scope}::${callee}` : callee;
        const members = groupFor(candidate, visible);
        if (members.length === 0) continue;
        return toTarget(members);
      }
      return null;
    },
  };
}
