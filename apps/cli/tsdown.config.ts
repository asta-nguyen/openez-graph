import { defineConfig } from "tsdown";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: "cjs",
  target: "node20",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: false,
  minify: false,
  // Native modules — must remain external (not bundled)
  deps: {
    neverBundle: ["better-sqlite3"],
    // Bundle everything else (workspace packages + npm deps)
    alwaysBundle: [
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
      "ts-morph",
      "gpt-tokenizer",
      "drizzle-orm",
      "dotenv"
    ]
  },
  banner: {
    js: "#!/usr/bin/env node"
  },
  hooks: {
    "build:done": async () => {
      // Copy frontend dist into CLI dist/web for bundled web serving
      const webDist = path.resolve(import.meta.dirname, "../web/dist");
      const cliWebDist = path.resolve(import.meta.dirname, "dist/web");
      if (existsSync(webDist)) {
        mkdirSync(path.dirname(cliWebDist), { recursive: true });
        cpSync(webDist, cliWebDist, { recursive: true });
        console.log("✓ Copied frontend dist → dist/web");
      } else {
        console.log("⚠ Frontend dist not found — run 'pnpm --filter @openez-graph/web build' first");
      }
    }
  }
});
