import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["cjs"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: false,
  minify: false,
  splitting: false,
  // better-sqlite3 is a native module — must remain external
  external: ["better-sqlite3"],
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
    "ts-morph",
    "gpt-tokenizer",
    "drizzle-orm",
    "dotenv",
    "openai",
    "ollama"
  ],
  banner: {
    js: "#!/usr/bin/env node"
  }
});
