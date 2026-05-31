import fg from "fast-glob";
import fsAsync from "node:fs/promises";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

import type { FileToIndex } from "./types";
import { codeExtensions, configExtensions, markdownExtensions } from "./languages";

const DEFAULT_INCLUDE_PATTERNS = [
  ...Array.from(codeExtensions.keys()).map((ext) => `**/*${ext}`),
  ...Array.from(configExtensions.keys()).map((ext) => `**/*${ext}`),
  ...Array.from(markdownExtensions).map((ext) => `**/*${ext}`)
];

const DEFAULT_EXCLUDE_PATTERNS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.next/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.turbo/**",
  "**/.openez/**"
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
      .map((pattern) => {
        if (pattern.startsWith("/")) return `${pattern.slice(1)}/**`;
        if (pattern.endsWith("/")) return `**/${pattern}**`;
        if (!pattern.includes("/") && !pattern.startsWith("**/")) return `**/${pattern}/**`;
        return pattern;
      });
  } catch {
    return [];
  }
}

function baseName(filePath: string): string {
  return path.basename(filePath);
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
    ...(input.exclude ? input.exclude.split("\n").filter(Boolean).map((p) => p.trim()) : [])
  ];

  const includePatterns = input.include
    ? input.include.split("\n").filter(Boolean).map((p) => p.trim())
    : DEFAULT_INCLUDE_PATTERNS;

  const entries = await fg(includePatterns, {
    cwd: rootPath,
    ignore: ignorePatterns,
    onlyFiles: true,
    absolute: true,
    followSymbolicLinks: false,
    dot: false
  });

  const results = await Promise.all(
    entries.map(async (absolutePath) => {
      const stat = await fsAsync.stat(absolutePath);
      return {
        absolutePath,
        relativePath: path.relative(rootPath, absolutePath),
        sizeBytes: stat.size,
        mtimeMs: Math.trunc(stat.mtimeMs)
      } satisfies FileToIndex;
    })
  );

  return results.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}
