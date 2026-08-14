import path from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";

// @ts-expect-error — picomatch v4 ships no type declarations
import picomatch from "picomatch";

import type { FileToIndex } from "./types";
import { codeExtensions, configExtensions, markdownExtensions } from "./languages";

const DEFAULT_INCLUDE_PATTERNS = [
  ...Array.from(codeExtensions.keys()).map((ext) => `**/*${ext}`),
  ...Array.from(configExtensions.keys()).map((ext) => `**/*${ext}`),
  ...Array.from(markdownExtensions).map((ext) => `**/*${ext}`),
];

const ALLOWED_EXTENSIONS = new Set([
  ...codeExtensions.keys(),
  ...configExtensions.keys(),
  ...markdownExtensions,
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
      .filter((line) => line && !line.startsWith("#") && !line.startsWith("!"))
      .flatMap((pattern) => {
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

  // Native Rust scanner (parallel walk) — fast path for default includes
  if (!input.include) {
    try {
      let nativeBinding: any = null;
      try {
        nativeBinding = require("@openez-graph/native");
      } catch (requireError) {
        console.debug("[openez] native scanner module unavailable:", requireError);
        nativeBinding = null;
      }
      if (nativeBinding && nativeBinding.scanWorkspaceFast instanceof Function) {
        const rawFiles: Array<{
          absolutePath: string;
          relativePath: string;
          sizeBytes: number;
          mtimeMs: number;
        }> = nativeBinding.scanWorkspaceFast(rootPath, Array.from(ALLOWED_EXTENSIONS));
        if (rawFiles && rawFiles.length > 0) {
          if (input.exclude) {
            const customExcludes = input.exclude
              .split("\n")
              .filter(Boolean)
              .map((p) => p.trim());
            const isCustomIgnored = picomatch(customExcludes, { dot: true });
            return rawFiles
              .filter((f) => !isCustomIgnored(f.relativePath))
              .map((f) => ({
                absolutePath: f.absolutePath,
                relativePath: f.relativePath,
                sizeBytes: Number(f.sizeBytes),
                mtimeMs: Number(f.mtimeMs),
              }))
              .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
          }
          return rawFiles
            .map((f) => ({
              absolutePath: f.absolutePath,
              relativePath: f.relativePath,
              sizeBytes: Number(f.sizeBytes),
              mtimeMs: Number(f.mtimeMs),
            }))
            .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
        }
      }
    } catch (nativeScanError) {
      console.debug("[openez] native scan failed, falling back to glob:", nativeScanError);
    }
  }

  const isIgnored = picomatch(ignorePatterns, { dot: true });
  const matched = new Set<string>();
  for (const pattern of includePatterns) {
    const glob = new Bun.Glob(pattern);
    for (const relPath of glob.scanSync({
      cwd: rootPath,
      onlyFiles: true,
      followSymlinks: false,
      dot: false,
    })) {
      if (!isIgnored(relPath)) {
        matched.add(relPath);
      }
    }
  }

  const results: FileToIndex[] = [];
  for (const relativePath of matched) {
    const absolutePath = path.join(rootPath, relativePath);
    try {
      const stat = statSync(absolutePath);
      results.push({
        absolutePath,
        relativePath,
        sizeBytes: stat.size,
        mtimeMs: Math.trunc(stat.mtimeMs),
      });
    } catch (statError) {
      console.debug("[openez] skipping unreadable file in glob scan:", relativePath, statError);
      continue;
    }
  }

  return results.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}
