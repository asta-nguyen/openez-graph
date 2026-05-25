import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function getOpenCodeConfigPath(): string {
  return path.join(os.homedir(), ".config", "opencode", "opencode.json");
}

export async function setupOpenCode(rootPath: string): Promise<void> {
  const resolvedPath = path.resolve(rootPath);

  if (!fs.existsSync(resolvedPath)) {
    console.error(`Error: path does not exist: ${resolvedPath}`);
    process.exit(1);
  }

  if (!fs.statSync(resolvedPath).isDirectory()) {
    console.error(`Error: path is not a directory: ${resolvedPath}`);
    process.exit(1);
  }

  const repoRoot = path.resolve(import.meta.dirname, "../../..");
  const label = "openez";
  const tsxPath = path.join(repoRoot, "node_modules", ".bin", "tsx");
  const cliPath = path.resolve(import.meta.dirname, "./cli.ts");

  const configPath = getOpenCodeConfigPath();
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

  if (!config.mcp || typeof config.mcp !== "object") {
    config.mcp = {};
  }

  const mcp = config.mcp as Record<string, unknown>;

  mcp[label] = {
    command: tsxPath,
    args: [cliPath, "serve", "--mcp"]
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  fs.chmodSync(configPath, 0o644);

  console.log(`OpenCode MCP server configured: '${label}'`);
  console.log("  Mode:    shared multi-workspace MCP");
  console.log(`  Repo:    ${repoRoot}`);
  console.log(`  Config:  ${configPath}`);
  console.log("");
  console.log("Restart OpenCode or open a new session for the changes to take effect.");
}
