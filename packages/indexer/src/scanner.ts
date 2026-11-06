import fg from "fast-glob";
import fsAsync from "node:fs/promises";
import path from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// @ts-expect-error — picomatch v4 ships no type declarations
import picomatch from "picomatch";

import type { FileToIndex } from "./types";
import { loadNativeBinding } from "./native-binding";
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
  // Secrets: indexed text can be returned to an agent and sent to its model provider. Only
  // config extensions, so source files such as secrets.ts stay searchable.
  "**/*credentials*.{json,yaml,yml,toml}",
  "**/*secret*.{json,yaml,yml,toml}",
  "**/service-account*.json",
];

// Written by `openez init` / `openez setup` when a project has no .openezignore yet. Only
// patterns the scanner does not already skip (DEFAULT_EXCLUDE_PATTERNS, .gitignore, hidden dirs).
const DEFAULT_OPENEZIGNORE = `# Paths OpenEZ should not index. Same syntax as .gitignore; edit freely.
# Already skipped without listing: .gitignore matches, hidden directories,
# node_modules, dist, build, coverage, target, and lock files.

# Vendored dependencies
vendor/
venv/
Pods/
bower_components/

# Build output and generated code
out/
obj/
*.min.js
*.min.css
*.pb.go
*_pb2.py
*.generated.*

# Test snapshots
__snapshots__/

# Archived agent plans describe superseded designs
docs/agent-devkit/changes/archive/
`;

/** Creates `<root>/.openezignore` with common patterns; returns false when one already exists. */
export function ensureOpenezIgnore(rootPath: string): boolean {
  const filePath = path.join(rootPath, ".openezignore");
  if (existsSync(filePath)) return false;
  writeFileSync(filePath, DEFAULT_OPENEZIGNORE, { flag: "wx" });
  return true;
}

// .gitignore-style file at the workspace root: `.gitignore`, or `.openezignore` for paths that
// stay in Git but should not be indexed (agent plans, archives, generated docs).
function loadIgnoreFile(rootPath: string, fileName: string): string[] {
  const gitignorePath = path.join(rootPath, fileName);
  if (!existsSync(gitignorePath)) return [];

  try {
    const content = readFileSync(gitignorePath, "utf8");
    if (!content) return [];

    return (
      content
        .split("\n")
        .map((line) => line.trim())
        // ponytail: re-include (`!pattern`) lines are dropped, not honored: as a picomatch pattern
        // a leading `!` matches every other path and ignored the whole workspace. Honor them if a
        // project needs to re-include something its own ignore file excludes.
        .filter((line) => line && !line.startsWith("#") && !line.startsWith("!"))
        .flatMap((pattern) => {
          const hasSlash = pattern.replace(/\/$/, "").includes("/");
          const clean = pattern.replace(/^\//, "").replace(/\/$/, "");
          if (hasSlash) {
            return [clean, `${clean}/**`];
          }
          return [clean, `${clean}/**`, `**/${clean}`, `**/${clean}/**`];
        })
    );
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
  const gitignorePatterns = [
    ...loadIgnoreFile(rootPath, ".gitignore"),
    ...loadIgnoreFile(rootPath, ".openezignore"),
  ];

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

  // Native Rust scanner (rayon parallel walk) — fast path for default includes
  if (!input.include) {
    try {
      const nativeBinding = loadNativeBinding() as {
        scanWorkspaceFast?: (
          rootPath: string,
          allowedExtensions: string[],
        ) => Array<{
          absolutePath: string;
          relativePath: string;
          sizeBytes: number;
          mtimeMs: number;
        }>;
      } | null;
      if (nativeBinding && typeof nativeBinding.scanWorkspaceFast === "function") {
        const rawFiles: Array<{
          absolutePath: string;
          relativePath: string;
          sizeBytes: number;
          mtimeMs: number;
        }> = nativeBinding.scanWorkspaceFast(rootPath, [...ALLOWED_EXTENSIONS]);
        if (rawFiles && rawFiles.length > 0) {
          const isIgnored = picomatch(ignorePatterns, { dot: true });
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
    ignore: ignorePatterns,
    onlyFiles: true,
    absolute: true,
    followSymbolicLinks: false,
    dot: false,
  });

  const results = await Promise.all(
    entries.map(async (absolutePath) => {
      const stat = await fsAsync.stat(absolutePath);
      return {
        absolutePath,
        relativePath: path.relative(rootPath, absolutePath),
        sizeBytes: stat.size,
        mtimeMs: Math.trunc(stat.mtimeMs),
      } satisfies FileToIndex;
    }),
  );

  return results.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}
