import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveCliInvocation } from "./resolve-cli";

function getClaudeConfigPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}

export async function setupClaude(rootPath: string): Promise<void> {
  const resolvedPath = path.resolve(rootPath);

  if (!fs.existsSync(resolvedPath)) {
    console.error(`Error: path does not exist: ${resolvedPath}`);
    process.exit(1);
  }

  if (!fs.statSync(resolvedPath).isDirectory()) {
    console.error(`Error: path is not a directory: ${resolvedPath}`);
    process.exit(1);
  }

  const { command, args, repoRoot } = resolveCliInvocation();
  const label = "openez";

  const configPath = getClaudeConfigPath();
  const configDir = path.dirname(configPath);

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o755 });
  }

  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, "utf-8");
    try {
      config = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      console.error(`Warning: could not parse ${configPath}, overwriting.`);
    }
  }

  if (!config.mcpServers || typeof config.mcpServers !== "object") {
    config.mcpServers = {};
  }

  const mcpServers = config.mcpServers as Record<string, unknown>;

  mcpServers[label] = {
    command,
    args,
    startupTimeoutSec: 120
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  fs.chmodSync(configPath, 0o644);

  console.log(`Claude Code MCP server configured: '${label}'`);
  console.log("  Mode:    shared multi-workspace MCP");
  console.log(`  Repo:    ${repoRoot}`);
  console.log(`  Config:  ${configPath}`);
  console.log("");
  console.log("Restart Claude Code or open a new session for the changes to take effect.");
}
