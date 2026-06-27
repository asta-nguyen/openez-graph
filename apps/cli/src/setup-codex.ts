import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveCliInvocation } from "./resolve-cli";
import { parse, stringify } from "smol-toml";

function getCodexConfigPath(): string {
  return path.join(os.homedir(), ".codex", "config.toml");
}

export async function setupCodex(rootPath: string): Promise<void> {
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

  const configPath = getCodexConfigPath();
  const configDir = path.dirname(configPath);

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o755 });
  }

  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, "utf-8");
    try {
      config = parse(raw) as Record<string, unknown>;
    } catch {
      console.error(`Warning: could not parse ${configPath}, overwriting.`);
    }
  }

  if (!config.mcp_servers || typeof config.mcp_servers !== "object") {
    config.mcp_servers = {};
  }

  const mcpServers = config.mcp_servers as Record<string, unknown>;

  const entry = {
    command,
    args,
    startup_timeout_sec: 120
  };

  mcpServers[label] = entry;

  const output = stringify(config);

  fs.writeFileSync(configPath, output, "utf-8");
  fs.chmodSync(configPath, 0o644);

  console.log(`Codex MCP server configured: '${label}'`);
  console.log("  Mode:    shared multi-workspace MCP");
  console.log(`  Repo:    ${repoRoot}`);
  console.log(`  Config:  ${configPath}`);
  console.log("");
  console.log("Restart Codex or open a new session for the changes to take effect.");
}
