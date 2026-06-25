import path from "node:path";

declare const __dirname: string | undefined;

function getThisDir(): string {
  if (typeof __dirname !== "undefined") {
    return __dirname;
  }
  if (typeof import.meta !== "undefined" && import.meta.dirname) {
    return import.meta.dirname;
  }
  return process.cwd();
}

export interface CliInvocation {
  command: string;
  args: string[];
  repoRoot: string;
}

export function resolveCliInvocation(): CliInvocation {
  const thisDir = getThisDir();

  // Bundled mode: __dirname is dist/
  if (path.basename(thisDir) === "dist") {
    const repoRoot = path.resolve(thisDir, "..");
    const cliPath = path.join(thisDir, "cli.cjs");
    return {
      command: process.execPath,
      args: [cliPath, "serve", "--mcp"],
      repoRoot
    };
  }

  // Source mode: __dirname is src/ inside monorepo
  const repoRoot = path.resolve(thisDir, "../../..");
  const tsxPath = path.join(repoRoot, "node_modules", ".bin", "tsx");
  const cliPath = path.resolve(thisDir, "./cli.ts");
  return {
    command: tsxPath,
    args: [cliPath, "serve", "--mcp"],
    repoRoot
  };
}
