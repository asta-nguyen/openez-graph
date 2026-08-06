import { defineConfig } from "tsup";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
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
  entry: ["src/cli.ts"],
  format: ["cjs"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: false,
  minify: false,
  splitting: false,
  define: { __OPENEZ_BUILD_ID__: JSON.stringify(getBuildId()) },
  // Native modules + wasm binaries must remain external — they resolve from node_modules at runtime.
  external: [
    "bun:sqlite",
    "@openez-graph/native",
    "web-tree-sitter",
    "tree-sitter-python",
    "tree-sitter-go",
    "tree-sitter-rust",
  ],
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
    "gpt-tokenizer",
    "drizzle-orm",
    "dotenv",
    "openai",
    "ollama",
  ],
  banner: {
    js: "#!/usr/bin/env node",
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

    // Copy native .node binary + loader into dist so it resolves without node_modules
    const nativeDir = path.resolve(__dirname, "../../packages/native");
    const nodeFile = path.join(nativeDir, "index.linux-x64-gnu.node");
    if (existsSync(nodeFile)) {
      const nativeDest = path.resolve(__dirname, "dist/native");
      mkdirSync(nativeDest, { recursive: true });
      cpSync(nodeFile, path.join(nativeDest, "index.linux-x64-gnu.node"));
      cpSync(path.join(nativeDir, "index.js"), path.join(nativeDest, "index.js"));
      // Create node_modules/@openez-graph/native/package.json so require resolves from dist
      mkdirSync(path.resolve(__dirname, "dist/node_modules/@openez-graph/native"), {
        recursive: true,
      });
      writeFileSync(
        path.resolve(__dirname, "dist/node_modules/@openez-graph/native/package.json"),
        JSON.stringify(
          { name: "@openez-graph/native", version: "0.1.0", main: "../../native/index.js" },
          null,
          2,
        ),
      );
      console.log("✓ Copied native .node + loader → dist/native/");
    } else {
      console.log("⚠ Native .node not found — run cargo build first");
    }
  },
});
