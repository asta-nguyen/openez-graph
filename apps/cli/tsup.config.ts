import { defineConfig } from "tsup";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

function getBuildId() {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim();
    return `${sha}${dirty ? "-dirty" : ""}`;
  } catch {
    return "unknown";
  }
}

export default defineConfig({
  entry: ["src/cli.ts", "../../packages/indexer/src/parse-worker.ts"],
  format: ["cjs"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: false,
  minify: true,
  splitting: false,
  define: { __OPENEZ_BUILD_ID__: JSON.stringify(getBuildId()) },
  // bun:sqlite is built-in to Bun — no external needed
  // gpt-tokenizer is external — its 965KB BPE vocab is only needed for retrieval, not indexing
  external: ["bun:sqlite", "gpt-tokenizer"],
  // Bundle everything else (workspace packages + npm deps)
  noExternal: [
    "@openez-graph/config",
    "@openez-graph/core",
    "@openez-graph/db",
    "@openez-graph/indexer",
    "@openez-graph/mcp",
    "@openez-graph/web",
    "@modelcontextprotocol/sdk",
    "chokidar",
    "commander",
    "smol-toml",
    "zod",
    "fast-glob",
    "github-slugger",
    "drizzle-orm",
    "dotenv",
    "openai",
    "ollama",
    "oxc-parser"
  ],
  banner: {
    js: "#!/usr/bin/env node"
  },
  onSuccess: async () => {
    // Copy frontend dist into CLI dist/web for bundled web serving
    const webDist = path.resolve(__dirname, "../web/dist");
    const cliWebDist = path.resolve(__dirname, "dist/web");
    if (existsSync(webDist)) {
      mkdirSync(path.dirname(cliWebDist), { recursive: true });
      cpSync(webDist, cliWebDist, { recursive: true });
      console.log("✓ Copied frontend dist → dist/web");
    } else {
      console.log("⚠ Frontend dist not found — run 'pnpm --filter @openez-graph/web build' first");
    }

    // Copy CHANGELOG.md into dist for bundled changelog serving
    const changelogSrc = path.resolve(__dirname, "../../CHANGELOG.md");
    const changelogDest = path.resolve(__dirname, "dist/CHANGELOG.md");
    if (existsSync(changelogSrc)) {
      cpSync(changelogSrc, changelogDest);
      console.log("✓ Copied CHANGELOG.md → dist/CHANGELOG.md");
    }

    // Copy package.json into dist/apps/cli/ for runtime version lookup
    const pkgSrc = path.resolve(__dirname, "package.json");
    const pkgDest = path.resolve(__dirname, "dist/apps/cli/package.json");
    if (existsSync(pkgSrc)) {
      mkdirSync(path.dirname(pkgDest), { recursive: true });
      cpSync(pkgSrc, pkgDest);
      console.log("✓ Copied package.json → dist/apps/cli/package.json");
    }

    // Copy prebuilt SQLite templates into dist for fast init
    const templateSrc = path.resolve(__dirname, "../../packages/db/template.sqlite");
    const templateDest = path.resolve(__dirname, "dist/template.sqlite");
    if (existsSync(templateSrc)) {
      cpSync(templateSrc, templateDest);
      console.log("✓ Copied template.sqlite → dist/template.sqlite");
    } else {
      console.log("⚠ template.sqlite not found — run 'bun packages/db/scripts/build-template.ts' first");
    }

    const regTemplateSrc = path.resolve(__dirname, "../../packages/db/registry-template.sqlite");
    const regTemplateDest = path.resolve(__dirname, "dist/registry-template.sqlite");
    if (existsSync(regTemplateSrc)) {
      cpSync(regTemplateSrc, regTemplateDest);
      console.log("✓ Copied registry-template.sqlite → dist/registry-template.sqlite");
    } else {
      console.log("⚠ registry-template.sqlite not found — run 'bun packages/db/scripts/build-template.ts' first");
    }
  }
});
