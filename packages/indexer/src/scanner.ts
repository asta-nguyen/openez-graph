import fg from "fast-glob";
import fsAsync from "node:fs/promises";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

// @ts-expect-error — picomatch v4 ships no type declarations
import picomatch from "picomatch";

import type { FileToIndex } from "./types";
import {
  codeExtensions,
  configExtensions,
  markdownExtensions,
  scriptExtensions,
  styleExtensions,
  templateExtensions,
} from "./languages";

const DEFAULT_INCLUDE_PATTERNS = [
  ...Array.from(codeExtensions.keys()).map((ext) => `**/*${ext}`),
  ...Array.from(configExtensions.keys()).map((ext) => `**/*${ext}`),
  ...Array.from(markdownExtensions).map((ext) => `**/*${ext}`),
  ...Array.from(styleExtensions.keys()).map((ext) => `**/*${ext}`),
  ...Array.from(templateExtensions.keys()).map((ext) => `**/*${ext}`),
  ...Array.from(scriptExtensions.keys()).map((ext) => `**/*${ext}`),
];

const ALLOWED_EXTENSIONS = new Set([
  ...codeExtensions.keys(),
  ...configExtensions.keys(),
  ...markdownExtensions,
  ...styleExtensions.keys(),
  ...templateExtensions.keys(),
  ...scriptExtensions.keys(),
]);

const DEFAULT_EXCLUDE_PATTERNS = [
  "**/node_modules",
  "**/node_modules/**",
  "**/.git",
  "**/.git/**",
  "**/.next",
  "**/.next/**",
  "**/dist",
  "**/dist/**",
  "**/build",
  "**/build/**",
  "**/coverage",
  "**/coverage/**",
  "**/.turbo",
  "**/.turbo/**",
  "**/.openez",
  "**/.openez/**",
  "**/target",
  "**/target/**",
  "**/pnpm-lock.yaml",
  "**/package-lock.json",
  "**/yarn.lock",
];

function loadGitignore(rootPath: string): string[] {
  const gitignorePath = path.join(rootPath, ".gitignore");
  if (!existsSync(gitignorePath)) return [];

  try {
    const content = readFileSync(gitignorePath, "utf8");
    if (!content) return [];

    return content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .flatMap((pattern) => {
        if (pattern.startsWith("!")) {
          const raw = pattern.slice(1).trim();
          const hasSlash = raw.replace(/\/$/, "").includes("/");
          const clean = raw.replace(/^\//, "").replace(/\/$/, "");
          if (hasSlash) {
            return [`!${clean}`, `!${clean}/**`];
          }
          return [`!${clean}`, `!${clean}/**`, `!**/${clean}`, `!**/${clean}/**`];
        }
        const hasSlash = pattern.replace(/\/$/, "").includes("/");
        const clean = pattern.replace(/^\//, "").replace(/\/$/, "");
        if (hasSlash) {
          return [clean, `${clean}/**`];
        }
        return [clean, `${clean}/**`, `**/${clean}`, `**/${clean}/**`];
      });
  } catch {
    return [];
  }
}

function compileIgnoreMatcher(ignorePatterns: string[]) {
  const positiveExcludes: string[] = [];
  const negationIncludes: string[] = [];

  for (const pat of ignorePatterns) {
    if (pat.startsWith("!")) {
      negationIncludes.push(pat.slice(1));
    } else {
      positiveExcludes.push(pat);
    }
  }

  const isExcluded = picomatch(positiveExcludes, { dot: true });
  const isNegated =
    negationIncludes.length > 0 ? picomatch(negationIncludes, { dot: true }) : () => false;

  return (filePath: string) => {
    if (isNegated(filePath)) return false; // Explicitly re-included via !
    return isExcluded(filePath); // True if matched an exclusion pattern
  };
}

export async function scanWorkspaceFiles(input: {
  rootPath: string;
  include?: string;
  exclude?: string;
}): Promise<FileToIndex[]> {
  const rootPath = path.resolve(input.rootPath);
  const gitignorePatterns = loadGitignore(rootPath);

  const ignorePatterns = [
    ...DEFAULT_EXCLUDE_PATTERNS,
    ...gitignorePatterns,
    ...(input.exclude
      ? input.exclude
          .split("\n")
          .filter(Boolean)
          .map((p) => p.trim())
      : []),
  ];

  const includePatterns = input.include
    ? input.include
        .split("\n")
        .filter(Boolean)
        .map((p) => p.trim())
    : DEFAULT_INCLUDE_PATTERNS;

  const isIgnored = compileIgnoreMatcher(ignorePatterns);

  // Native Rust scanner (rayon parallel walk) — fast path for default includes
  if (!input.include) {
    try {
      let nativeBinding: any = null;
      try {
        nativeBinding = require(
          require("path").join(__dirname, "native", "index.linux-x64-gnu.node"),
        );
      } catch {
        nativeBinding = require("@openez-graph/native");
      }
      if (nativeBinding && typeof nativeBinding.scanWorkspaceFast === "function") {
        const rawFiles: Array<{
          absolutePath: string;
          relativePath: string;
          sizeBytes: number;
          mtimeMs: number;
        }> = nativeBinding.scanWorkspaceFast(rootPath, Array.from(ALLOWED_EXTENSIONS));
        if (rawFiles && rawFiles.length > 0) {
          const results: FileToIndex[] = [];
          for (const f of rawFiles) {
            if (!isIgnored(f.relativePath)) {
              results.push({
                absolutePath: f.absolutePath,
                relativePath: f.relativePath,
                sizeBytes: Number(f.sizeBytes),
                mtimeMs: Number(f.mtimeMs),
              });
            }
          }
          return results.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
        }
      }
    } catch {
      /* fallback to fast-glob */
    }
  }

  const entries = await fg(includePatterns, {
    cwd: rootPath,
    ignore: DEFAULT_EXCLUDE_PATTERNS,
    onlyFiles: true,
    absolute: true,
    followSymbolicLinks: false,
    dot: false,
  });

  const filteredEntries = entries.filter((absPath) => {
    const rel = path.relative(rootPath, absPath).replace(/\\/g, "/");
    return !isIgnored(rel);
  });

  const results = await Promise.all(
    filteredEntries.map(async (absolutePath) => {
      const stat = await fsAsync.stat(absolutePath);
      return {
        absolutePath,
        relativePath: path.relative(rootPath, absolutePath).replace(/\\/g, "/"),
        sizeBytes: stat.size,
        mtimeMs: Math.trunc(stat.mtimeMs),
      } satisfies FileToIndex;
    }),
  );

  return results.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}
