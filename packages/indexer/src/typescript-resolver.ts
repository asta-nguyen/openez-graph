import fs from "node:fs";
import path from "node:path";

/**
 * Bounded TypeScript module resolution for graph edges: relative specifiers,
 * `baseUrl` lookups, and `paths` mappings read from the nearest workspace
 * `tsconfig.json`, plus `.js` → TypeScript-source extension substitution.
 *
 * This is not the full compiler resolver — see the TypeScript indexing
 * accuracy design (docs/agent-devkit/changes/archive/2026-10-20-39-typescript-index-accuracy):
 * one relative `extends` hop, `compilerOptions.baseUrl` and
 * `compilerOptions.paths` only, at most one `*` per paths key, ordered target
 * arrays, exact keys before longest-prefix wildcards, and workspace-only
 * targets.
 */

/** Extensions probed for a TypeScript module specifier, in order. Trailing
 *  entries keep parity with the shared workspace resolver's file kinds. */
const TS_MODULE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".d.ts",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
  ".md",
  ".mdx",
  ".py",
  ".rb",
] as const;

interface CompilerOptions {
  baseUrl?: string;
  paths?: Record<string, string[]>;
  extends?: string;
}

interface EffectiveTsConfig {
  /** Absolute directory the effective `baseUrl` is anchored to. */
  baseUrlAbs?: string;
  /** Effective `paths` mapping (child replaces inherited, never merged). */
  paths?: Record<string, string[]>;
  /** Absolute directory of the config that declared `paths`. */
  pathsOriginAbs?: string;
}

function normalizeRelativePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

/**
 * Strip `//` and `/* … *​/` comments and trailing commas from JSONC while
 * preserving comment-like text inside string literals.
 */
export function normalizeJsonc(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        if (i + 1 < text.length) out += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }

  // Trailing commas: drop a `,` whose next non-ws token is `}` or `]`.
  let result = "";
  i = 0;
  inString = false;
  while (i < out.length) {
    const ch = out[i];
    if (inString) {
      result += ch;
      if (ch === "\\") {
        if (i + 1 < out.length) result += out[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      result += ch;
      i++;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < out.length && /\s/.test(out[j])) j++;
      if (out[j] === "}" || out[j] === "]") {
        i++;
        continue;
      }
    }
    result += ch;
    i++;
  }
  return result;
}

function sanitizePaths(raw: unknown): Record<string, string[]> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const paths: Record<string, string[]> = Object.create(null);
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const targets = value.filter((entry): entry is string => typeof entry === "string");
    if (targets.length > 0) paths[key] = targets;
  }
  return paths;
}

/** Parse a tsconfig file; returns null on any read/parse failure. */
function readConfigFile(absPath: string): CompilerOptions | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalizeJsonc(fs.readFileSync(absPath, "utf8")));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const topLevel = parsed as Record<string, unknown>;
  const compilerOptions = topLevel.compilerOptions;
  const raw =
    compilerOptions && typeof compilerOptions === "object"
      ? (compilerOptions as Record<string, unknown>)
      : {};
  return {
    baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : undefined,
    // A declared `paths` replaces the inherited mapping even when it is
    // empty (`"paths": {}` = "no aliases") or malformed — absence inherits.
    paths: Object.hasOwn(raw, "paths")
      ? (sanitizePaths(raw.paths) ?? (Object.create(null) as Record<string, string[]>))
      : undefined,
    // `extends` is a top-level tsconfig field, not a compilerOption.
    extends: typeof topLevel.extends === "string" ? topLevel.extends : undefined,
  };
}

export interface TypeScriptModuleResolver {
  /** Resolve a module specifier written in `importerRelPath` to a
   *  workspace-relative file path, or null. */
  resolve(importerRelPath: string, specifier: string): string | null;
}

/**
 * Create the bounded TypeScript resolver. `workspaceRelativeFor` maps an
 * absolute candidate path to a normalized workspace-relative path when the
 * file is inside the workspace and known to the index, else null.
 */
export function createTypeScriptModuleResolver(options: {
  workspaceRoot: string;
  workspaceRelativeFor: (absolutePath: string) => string | null;
}): TypeScriptModuleResolver {
  const { workspaceRoot, workspaceRelativeFor } = options;
  const configCache = new Map<string, EffectiveTsConfig | null>();

  function loadEffectiveConfig(configAbsPath: string): EffectiveTsConfig | null {
    const child = readConfigFile(configAbsPath);
    if (!child) return null;
    const childDir = path.dirname(configAbsPath);
    let base: { options: CompilerOptions; dir: string } | null = null;
    // One relative `extends` hop, inside the workspace only; the base's own
    // extends is never followed.
    if (child.extends && child.extends.startsWith(".")) {
      let baseAbs = path.resolve(childDir, child.extends);
      if (!baseAbs.endsWith(".json")) baseAbs += ".json";
      const relToWorkspace = normalizeRelativePath(path.relative(workspaceRoot, baseAbs));
      if (!relToWorkspace.startsWith("..") && fs.existsSync(baseAbs)) {
        const baseOptions = readConfigFile(baseAbs);
        if (baseOptions) base = { options: baseOptions, dir: path.dirname(baseAbs) };
      }
    }

    const effective: EffectiveTsConfig = {};
    const baseUrlSource =
      child.baseUrl !== undefined
        ? { value: child.baseUrl, dir: childDir }
        : base?.options.baseUrl !== undefined
          ? { value: base!.options.baseUrl!, dir: base!.dir }
          : null;
    if (baseUrlSource) effective.baseUrlAbs = path.resolve(baseUrlSource.dir, baseUrlSource.value);
    if (child.paths !== undefined) {
      effective.paths = child.paths;
      effective.pathsOriginAbs = childDir;
    } else if (base?.options.paths !== undefined) {
      effective.paths = base.options.paths;
      effective.pathsOriginAbs = base.dir;
    }
    return effective;
  }

  /** Nearest `tsconfig.json` walking up from the file's directory toward the
   *  workspace root. Every walked directory caches the RESOLVED config (an
   *  ancestor's config applies to all descendants), so a cached null means
   *  "no config found from here to the root", not "no config in this dir". */
  function configForFile(importerRelPath: string): EffectiveTsConfig | null {
    const visited: string[] = [];
    let dir = normalizeRelativePath(path.dirname(importerRelPath));
    for (;;) {
      const cached = configCache.get(dir);
      if (cached !== undefined) {
        for (const visitedDir of visited) configCache.set(visitedDir, cached);
        return cached;
      }
      visited.push(dir);
      const configAbs = path.join(workspaceRoot, dir, "tsconfig.json");
      if (fs.existsSync(configAbs)) {
        // The nearest config wins even when invalid — its aliases are
        // unavailable and no ancestor config is consulted.
        const effective = loadEffectiveConfig(configAbs);
        for (const visitedDir of visited) configCache.set(visitedDir, effective);
        return effective;
      }
      if (dir === "." || dir === "" || dir === "/") break;
      const parent = normalizeRelativePath(path.dirname(dir));
      if (parent === dir) break;
      dir = parent;
    }
    for (const visitedDir of visited) configCache.set(visitedDir, null);
    return null;
  }

  /** Map an absolute candidate (no guaranteed extension) to a workspace file,
   *  probing TS substitution for `.js` stems and index files. */
  function probeCandidate(absCandidate: string): string | null {
    if (absCandidate.endsWith(".js")) {
      const stem = absCandidate.slice(0, -".js".length);
      for (const ext of [".ts", ".tsx", ".d.ts"] as const) {
        const hit = workspaceRelativeFor(stem + ext);
        if (hit) return hit;
      }
      const jsHit = workspaceRelativeFor(absCandidate);
      if (jsHit) return jsHit;
      return workspaceRelativeFor(stem + ".jsx");
    }
    const direct = workspaceRelativeFor(absCandidate);
    if (direct) return direct;
    for (const ext of TS_MODULE_EXTENSIONS) {
      const hit = workspaceRelativeFor(absCandidate + ext);
      if (hit) return hit;
    }
    for (const ext of TS_MODULE_EXTENSIONS) {
      const hit = workspaceRelativeFor(path.join(absCandidate, `index${ext}`));
      if (hit) return hit;
    }
    return null;
  }

  /** Anchor for `paths` targets: the effective baseUrl when set, else the
   *  directory of the config that declared the paths mapping. */
  function pathsBaseDir(config: EffectiveTsConfig): string {
    return config.baseUrlAbs ?? config.pathsOriginAbs ?? workspaceRoot;
  }

  function resolvePaths(specifier: string, config: EffectiveTsConfig): string | null {
    const paths = config.paths;
    if (!paths) return null;
    // Exact keys win over any wildcard — and the winning pattern alone
    // supplies candidates: a failed exact match does not fall back to
    // wildcard keys (TypeScript's single-pattern rule).
    const exact = Object.hasOwn(paths, specifier) ? paths[specifier] : undefined;
    if (exact) {
      for (const target of exact) {
        const hit = probeCandidate(path.resolve(pathsBaseDir(config), target));
        if (hit) return hit;
      }
      return null;
    }
    // Wildcard keys: at most one `*`; the longest literal prefix wins.
    let best: { prefixLength: number; targets: string[]; matchedPart: string } | null = null;
    for (const [key, targets] of Object.entries(paths)) {
      const star = key.indexOf("*");
      if (star < 0 || key.indexOf("*", star + 1) >= 0) continue;
      const prefix = key.slice(0, star);
      const suffix = key.slice(star + 1);
      if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
      if (specifier.length < prefix.length + suffix.length) continue;
      if (best && prefix.length <= best.prefixLength) continue;
      best = {
        prefixLength: prefix.length,
        targets,
        matchedPart: specifier.slice(prefix.length, specifier.length - suffix.length),
      };
    }
    if (best) {
      for (const target of best.targets) {
        const hit = probeCandidate(
          path.resolve(pathsBaseDir(config), target.replace("*", best.matchedPart)),
        );
        if (hit) return hit;
      }
    }
    return null;
  }

  return {
    resolve(importerRelPath: string, specifier: string): string | null {
      const importerDirAbs = path.dirname(path.resolve(workspaceRoot, importerRelPath));
      if (specifier.startsWith(".")) {
        return probeCandidate(path.resolve(importerDirAbs, specifier));
      }
      const config = configForFile(importerRelPath);
      if (!config) return null;
      return (
        resolvePaths(specifier, config) ??
        (config.baseUrlAbs ? probeCandidate(path.resolve(config.baseUrlAbs, specifier)) : null)
      );
    },
  };
}
