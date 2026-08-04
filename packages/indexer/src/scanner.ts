import fg from "fast-glob";
import fsAsync from "node:fs/promises";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

import type { FileToIndex } from "./types";
import { codeExtensions, configExtensions, markdownExtensions } from "./languages";
import picomatch from "picomatch";

const DEFAULT_INCLUDE_PATTERNS = [
  ...Array.from(codeExtensions.keys()).map((ext) => `**/*${ext}`),
  ...Array.from(configExtensions.keys()).map((ext) => `**/*${ext}`),
  ...Array.from(markdownExtensions).map((ext) => `**/*${ext}`)
];

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
  "**/yarn.lock"
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

function baseName(filePath: string): string {
  return path.basename(filePath);
}

const ALLOWED_EXTENSIONS = new Set([
  ...codeExtensions.keys(),
  ...configExtensions.keys(),
  ...markdownExtensions
]);

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

  // Custom include patterns: fall back to fast-glob (needs pattern matching)
  if (input.include) {
    const includePatterns = input.include.split("\n").filter(Boolean).map((p) => p.trim());
    const entries = await fg(includePatterns, {
      cwd: rootPath,
      ignore: ignorePatterns,
      onlyFiles: true,
      absolute: true,
      followSymbolicLinks: false,
      dot: false
    });

    const STAT_CONCURRENCY = 64;
    const results: FileToIndex[] = [];
    let statIndex = 0;
    async function statWorker() {
      while (statIndex < entries.length) {
        const i = statIndex++;
        try {
          const stat = await fsAsync.stat(entries[i]);
          results.push({
            absolutePath: entries[i],
            relativePath: path.relative(rootPath, entries[i]),
            sizeBytes: stat.size,
            mtimeMs: Math.trunc(stat.mtimeMs)
          });
        } catch { /* deleted between glob and stat */ }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(STAT_CONCURRENCY, entries.length) }, () => statWorker())
    );
    return results.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }

  // Default: recursive readdir with Dirent (avoids fast-glob pattern matching + separate stat)
  const ignoreDirs = new Set(["node_modules", "dist", "build", "coverage", "target", ".git", ".next", ".turbo", ".openez"]);
  for (const p of gitignorePatterns) {
    // Only extract simple directory names: **/dirname or dirname/
    let dirName: string | null = null;
    if (p.startsWith("**/")) dirName = p.slice(3).replace(/\/$/, "");
    else if (p.endsWith("/")) dirName = p.replace(/^\//, "").replace(/\/$/, "");
    if (dirName && !dirName.includes("/") && !dirName.includes("*")) ignoreDirs.add(dirName);
  }
  const isIgnored = picomatch(ignorePatterns, { dot: true });
  const results: FileToIndex[] = [];
  let scanErrors = 0;

  async function walk(dir: string) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fsAsync.readdir(dir, { withFileTypes: true });
    } catch { scanErrors++; return; }

    const tasks: Promise<void>[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(dir, entry.name);
      const relative = path.relative(rootPath, fullPath).split(path.sep).join("/");

      if (entry.isDirectory()) {
        if (ignoreDirs.has(entry.name)) continue;
        if (isIgnored(relative)) continue;
        tasks.push(walk(fullPath));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (!ALLOWED_EXTENSIONS.has(ext)) continue;
        if (isIgnored(relative)) continue;
        tasks.push(
          fsAsync.stat(fullPath).then((stat) => {
            results.push({
              absolutePath: fullPath,
              relativePath: relative,
              sizeBytes: stat.size,
              mtimeMs: Math.trunc(stat.mtimeMs)
            });
          }).catch(() => { scanErrors++; })
        );
      }
    }
    await Promise.all(tasks);
  }

  await walk(rootPath);
  if (scanErrors > 0) console.warn(`[openez] scan: ${scanErrors} errors`);
  return results.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}
