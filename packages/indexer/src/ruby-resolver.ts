import path from "node:path";

/**
 * Scope-aware Ruby call/import resolution for graph edges. Resolves only
 * unique (file, label) symbol targets — ambiguous labels produce no edge.
 * See docs/agent-devkit/changes/archive/2026-10-20-39-ruby-native-indexing.
 *
 * - Bare `foo` resolves to a unique method of the caller's own class/module
 *   (reopened classes in other files count), then a unique top-level method.
 *   The "own" scope is the caller's label when the caller is a class/module
 *   (calls sitting in the class/module body itself, e.g. `class M; helper()`),
 *   else the caller method's enclosing class/module. Enclosing namespaces
 *   beyond the caller's own scope are not walked.
 * - `C::foo` / `Outer::C::foo` (produced by `self.foo` and constant-receiver
 *   call normalization) resolves the constant's first segment lexically —
 *   the innermost scope that defines it wins, remaining segments are
 *   appended — then binds only to a unique method of that resolved label.
 * - Only `function` symbols (methods) are call targets; lambda/constant
 *   assignments and class/module labels never receive a `calls` edge.
 * - `require_relative` resolves literal paths to `.rb` files only; a
 *   same-stem `.md` or any other extension never captures the edge.
 * - No ancestor traversal, mixin dispatch, gem resolution, or receiver-type
 *   inference — the parser already suppresses ordinary receiver calls.
 */

export interface RubyCallTarget {
  filePath: string;
  symbolName: string;
}

export interface RubyResolver {
  resolveCall(call: {
    callerName: string;
    calleeName: string;
    filePath: string;
  }): RubyCallTarget | null;
}

/** The label's final `::` segment starts with an uppercase letter. */
function isConstantLike(label: string): boolean {
  const index = label.lastIndexOf("::");
  const last = index < 0 ? label : label.slice(index + 2);
  return last.length > 0 && last[0] >= "A" && last[0] <= "Z";
}

function enclosingScope(name: string): string | null {
  const index = name.lastIndexOf("::");
  return index < 0 ? null : name.slice(0, index);
}

export function createRubyResolver(options: {
  /** Every (filePath, label, symbolType) symbol triple for Ruby files. */
  symbols: Array<{ filePath: string; name: string; symbolType: string }>;
}): RubyResolver {
  // label -> set of files defining it. Multiple same-label symbols inside
  // one file (e.g. `def audit` + `class << self; def audit`) collapse to a
  // single candidate — uniqueness is judged per file, matching the
  // file+name keying of the graph's symbol node map. `filesByFunc` holds
  // only methods so bare calls never bind to lambda/constant assignments.
  const filesByLabel = new Map<string, Set<string>>();
  const filesByFunc = new Map<string, Set<string>>();
  for (const { filePath, name, symbolType } of options.symbols) {
    let files = filesByLabel.get(name) ?? new Set<string>();
    if (!filesByLabel.has(name)) filesByLabel.set(name, files);
    files.add(filePath);
    if (symbolType === "function") {
      files = filesByFunc.get(name) ?? new Set<string>();
      if (!filesByFunc.has(name)) filesByFunc.set(name, files);
      files.add(filePath);
    }
  }

  /** Resolve `name` to a method only when exactly one file defines it. */
  function uniqueMatch(name: string): RubyCallTarget | null {
    const files = filesByFunc.get(name);
    if (!files || files.size !== 1) return null;
    return { filePath: files.values().next().value!, symbolName: name };
  }

  function resolveCall(call: {
    callerName: string;
    calleeName: string;
    filePath: string;
  }): RubyCallTarget | null {
    // The caller's own lexical scope: a class/module label is its own scope
    // (calls in the body itself), a method contributes its enclosing
    // class/module, a top-level caller has none.
    const scope = isConstantLike(call.callerName)
      ? call.callerName
      : enclosingScope(call.callerName);
    let calleeName = call.calleeName;
    const absolute = calleeName.startsWith("::");
    if (absolute) calleeName = calleeName.slice(2);

    if (calleeName.includes("::")) {
      // Qualified callee: resolve the first segment lexically — innermost
      // scope defining the constant wins — then bind the rest uniquely. A
      // leading `::` callee is absolute and skips the lexical walk.
      const head = calleeName.slice(0, calleeName.indexOf("::"));
      const rest = calleeName.slice(calleeName.indexOf("::") + 2);
      for (let current: string | null = absolute ? null : scope; ; ) {
        const resolvedHead = current ? `${current}::${head}` : head;
        if (filesByLabel.has(resolvedHead)) {
          return uniqueMatch(`${resolvedHead}::${rest}`);
        }
        if (!current) break;
        current = enclosingScope(current);
      }
      return null;
    }

    // Bare call: caller's own class/module only (no ancestor walk), then
    // unique top-level methods.
    if (scope) {
      const scoped = `${scope}::${calleeName}`;
      if (filesByFunc.has(scoped)) return uniqueMatch(scoped);
    }
    return uniqueMatch(calleeName);
  }

  return { resolveCall };
}

export interface RubyImportResolver {
  resolveImport(importerRelativePath: string, importPath: string): string | null;
}

export function createRubyImportResolver(options: {
  workspaceRoot: string;
  /** Map an absolute path to a workspace-relative path, or null. */
  workspaceRelativeFor: (absolutePath: string) => string | null;
}): RubyImportResolver {
  function resolveImport(importerRelativePath: string, importPath: string): string | null {
    const importerDirectory = path.dirname(
      path.resolve(options.workspaceRoot, importerRelativePath),
    );
    const baseCandidate = path.resolve(importerDirectory, importPath);
    // require_relative resolves .rb files only: a literal "x.rb" as written,
    // otherwise the `.rb`-appended path. Any other extension is not an import.
    if (importPath.endsWith(".rb")) return options.workspaceRelativeFor(baseCandidate);
    return options.workspaceRelativeFor(`${baseCandidate}.rb`);
  }

  return { resolveImport };
}
