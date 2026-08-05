import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { execSync } from "node:child_process";
import module from "node:module";

import { createRegistryRepository } from "@openez-graph/db";

// ESM-safe require.resolve — createRequire needs a file URL.
// In the CJS bundle `import.meta` is empty, so fall back to `__filename`.
const _require =
  typeof require === "function"
    ? require
    : module.createRequire(
        typeof import.meta !== "undefined" && import.meta.url
          ? import.meta.url
          : `file://${__filename}`,
      );

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
}

export async function setupContext7(options: {
  apiKey?: string;
  nonInteractive?: boolean;
}): Promise<void> {
  const registry = createRegistryRepository();

  // 1. API key
  let apiKey = options.apiKey;
  if (!apiKey) {
    if (options.nonInteractive) {
      console.error("Error: --api-key is required in non-interactive mode.");
      process.exit(1);
    }
    apiKey = await prompt("Enter your Context7 API key (get one at https://context7.com): ");
    if (!apiKey) {
      console.error("Error: API key is required.");
      process.exit(1);
    }
  }

  // 2. Try to resolve the context7-mcp binary
  let binPath: string | null = null;
  try {
    binPath = _require.resolve("@upstash/context7-mcp/bin/context7-mcp.mjs");
  } catch {
    if (!options.nonInteractive) {
      const install = await prompt(
        "Could not find @upstash/context7-mcp. Install it globally now? (y/n): ",
      );
      if (install.toLowerCase() === "y" || install.toLowerCase() === "yes") {
        console.log("Installing @upstash/context7-mcp globally...");
        try {
          execSync("npm install -g @upstash/context7-mcp", { stdio: "inherit" });
          binPath = _require.resolve("@upstash/context7-mcp/bin/context7-mcp.mjs");
        } catch {
          console.error("Warning: global install failed. You may need to install it manually.");
        }
      }
    }
  }

  // 3. Store config
  await registry.setSetting("context7.enabled", "true");
  await registry.setSetting("context7.api_key", apiKey);
  await registry.setSetting("context7.cache_ttl_days", "7");
  if (binPath) {
    await registry.setSetting("context7.bin_path", binPath);
  }

  console.log("Context7 enabled.");
  console.log("  API key: stored securely");
  console.log(`  Binary: ${binPath ?? "not found (will auto-resolve from node_modules)"}`);
  console.log("  Cache TTL: 7 days");
  console.log("");
  console.log("Restart your agent to pick up the new `library_docs` tool.");
}
