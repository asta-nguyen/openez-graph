import fs from "node:fs";
import module from "node:module";
import path from "node:path";

import { Language, Node, Parser, Tree } from "web-tree-sitter";

declare const __non_webpack_require__: typeof require | undefined;

function getRequireUrl(): string {
  try {
    if (typeof import.meta !== "undefined" && import.meta.url) {
      return import.meta.url;
    }
  } catch {
    // import.meta not available (CJS)
  }
  return `file://${__filename}`;
}

const _require: typeof require =
  typeof __non_webpack_require__ === "function"
    ? __non_webpack_require__
    : module.createRequire(getRequireUrl());

// ── WASM asset path resolution ──
// web-tree-sitter ships tree-sitter.wasm in its package root.
// tree-sitter-wasms ships per-language grammar .wasm files in out/.
// Both packages are marked external in tsup, so they resolve from node_modules
// at runtime — same strategy as better-sqlite3.

function resolvePackageFile(packageName: string, subPath: string): string | null {
  try {
    return _require.resolve(`${packageName}/${subPath}`);
  } catch {
    return null;
  }
}

function resolveWebTreeSitterWasm(): string | null {
  // The runtime wasm is at web-tree-sitter/tree-sitter.wasm (not web-tree-sitter.wasm)
  const candidates = [
    resolvePackageFile("web-tree-sitter", "tree-sitter.wasm"),
    resolvePackageFile("web-tree-sitter", "web-tree-sitter.wasm"),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Language key → grammar npm package and wasm artifact name. Most languages
 * follow the `tree-sitter-<language>` convention on both sides; csharp does
 * not — its package is `tree-sitter-c-sharp` while the artifact keeps the
 * grammar's C name `tree-sitter-c_sharp.wasm`.
 */
const GRAMMAR_PACKAGES: Record<string, { packageName: string; wasmFile: string }> = {
  csharp: { packageName: "tree-sitter-c-sharp", wasmFile: "tree-sitter-c_sharp.wasm" },
};

function resolveGrammarWasm(language: string): string | null {
  const { packageName, wasmFile } = GRAMMAR_PACKAGES[language] ?? {
    packageName: `tree-sitter-${language}`,
    wasmFile: `tree-sitter-${language}.wasm`,
  };
  // Individual grammar packages ship the .wasm in their package root.
  const grammarPath = resolvePackageFile(packageName, wasmFile);
  if (grammarPath && fs.existsSync(grammarPath)) return grammarPath;

  // Fallback: tree-sitter-wasms monolith package (older ABI, may not work
  // with newer web-tree-sitter, but kept for resilience).
  const wasmsPath = resolvePackageFile("tree-sitter-wasms", `out/${wasmFile}`);
  if (wasmsPath && fs.existsSync(wasmsPath)) return wasmsPath;

  return null;
}

// ── Lazy initialization + grammar caching ──

let initPromise: Promise<void> | null = null;
const languageCache = new Map<string, Language | null>();
const languageLoadPromises = new Map<string, Promise<Language | null>>();

async function ensureInit(): Promise<void> {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const wasmPath = resolveWebTreeSitterWasm();
    const moduleOptions: Record<string, unknown> = {};
    if (wasmPath) {
      const wasmDir = path.dirname(wasmPath);
      const wasmBase = path.basename(wasmPath);
      moduleOptions.locateFile = (file: string) =>
        file === wasmBase || file === "tree-sitter.wasm" ? wasmPath : path.join(wasmDir, file);
    }
    await Parser.init(moduleOptions);
  })();

  return initPromise;
}

export async function loadLanguage(language: string): Promise<Language | null> {
  const cached = languageCache.get(language);
  if (cached !== undefined) return cached;

  const existing = languageLoadPromises.get(language);
  if (existing) return existing;

  const loadPromise = (async () => {
    await ensureInit();
    const wasmPath = resolveGrammarWasm(language);
    if (!wasmPath) {
      languageCache.set(language, null);
      return null;
    }
    try {
      const lang = await Language.load(wasmPath);
      languageCache.set(language, lang);
      return lang;
    } catch {
      languageCache.set(language, null);
      return null;
    }
  })();

  languageLoadPromises.set(language, loadPromise);
  const result = await loadPromise;
  languageLoadPromises.delete(language);
  return result;
}

export async function parseContent(language: string, content: string): Promise<Tree | null> {
  const lang = await loadLanguage(language);
  if (!lang) return null;

  const parser = new Parser();
  try {
    parser.setLanguage(lang);
    return parser.parse(content);
  } catch {
    return null;
  } finally {
    parser.delete();
  }
}

export type { Parser, Tree, Language, Node };
