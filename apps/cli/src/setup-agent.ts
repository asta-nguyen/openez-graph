import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { JsonValue } from "@openez-graph/db";
import { resolveCliInvocation } from "./resolve-cli";
import { installAgentInstructions } from "./setup-instructions";
import { parse, stringify } from "smol-toml";

type AgentType = "claude" | "codex" | "devin" | "opencode" | "windsurf" | "zed";

interface McpServerEntry {
  command: string | string[];
  args?: string[];
  startupTimeoutSec?: number;
  startup_timeout_sec?: number;
  type?: string;
  enabled?: boolean;
  env?: Record<string, string>;
}

interface AgentConfig {
  configPath: string;
  format: "json" | "toml";
  mcpKey: string;
  instructionsFile: "AGENTS.md" | "CLAUDE.md";
  displayName: string;
  buildEntry: (command: string, args: string[]) => McpServerEntry;
}

const AGENT_CONFIGS = {
  claude: {
    configPath: path.join(os.homedir(), ".claude", "settings.json"),
    format: "json",
    mcpKey: "mcpServers",
    instructionsFile: "CLAUDE.md",
    displayName: "Claude Code",
    buildEntry: (command, args) => ({ command, args, startupTimeoutSec: 120 }),
  },
  codex: {
    configPath: path.join(os.homedir(), ".codex", "config.toml"),
    format: "toml",
    mcpKey: "mcp_servers",
    instructionsFile: "AGENTS.md",
    displayName: "Codex",
    buildEntry: (command, args) => ({ command, args, startup_timeout_sec: 120 }),
  },
  devin: {
    configPath: path.join(os.homedir(), ".config", "devin", "config.json"),
    format: "json",
    mcpKey: "mcpServers",
    instructionsFile: "AGENTS.md",
    displayName: "Devin CLI",
    buildEntry: (command, args) => ({ command, args }),
  },
  opencode: {
    configPath: path.join(os.homedir(), ".config", "opencode", "opencode.json"),
    format: "json",
    mcpKey: "mcp",
    instructionsFile: "AGENTS.md",
    displayName: "OpenCode",
    buildEntry: (command, args) => ({ type: "local", command: [command, ...args], enabled: true }),
  },
  windsurf: {
    configPath: path.join(os.homedir(), ".codeium", "windsurf", "mcp_config.json"),
    format: "json",
    mcpKey: "mcpServers",
    instructionsFile: "AGENTS.md",
    displayName: "Windsurf",
    buildEntry: (command, args) => ({ command, args }),
  },
  zed: {
    configPath: path.join(os.homedir(), ".config", "zed", "settings.json"),
    format: "json",
    mcpKey: "context_servers",
    instructionsFile: "AGENTS.md",
    displayName: "Zed Editor",
    buildEntry: (command, args) => ({ command, args }),
  },
} satisfies Record<AgentType, AgentConfig>;

export async function setupAgent(agent: AgentType, rootPath: string): Promise<void> {
  const cfg = AGENT_CONFIGS[agent];
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

  const configDir = path.dirname(cfg.configPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o755 });
  }

  let config: Record<string, JsonValue> = {};
  if (fs.existsSync(cfg.configPath)) {
    const raw = fs.readFileSync(cfg.configPath, "utf-8");
    try {
      // SAFETY: smol-toml parse returns a TOML value tree; we assert the top-level is a table (object).
      config = cfg.format === "toml" ? (parse(raw) as Record<string, JsonValue>) : JSON.parse(raw);
    } catch {
      console.error(`Warning: could not parse ${cfg.configPath}, overwriting.`);
    }
  }

  if (!config[cfg.mcpKey] || !(config[cfg.mcpKey] instanceof Object)) {
    config[cfg.mcpKey] = {};
  }

  // SAFETY: the branch above guarantees config[cfg.mcpKey] is an object (JsonValue record).
  (config[cfg.mcpKey] as Record<string, JsonValue>)[label] = cfg.buildEntry(command, args);

  const output = cfg.format === "toml" ? stringify(config) : JSON.stringify(config, null, 2) + "\n";
  fs.writeFileSync(cfg.configPath, output, "utf-8");
  fs.chmodSync(cfg.configPath, 0o644);

  const instructionsPath = installAgentInstructions(resolvedPath, cfg.instructionsFile);

  console.log(`${cfg.displayName} MCP server configured: '${label}'`);
  console.log("  Mode:    shared multi-workspace MCP");
  console.log(`  Repo:    ${repoRoot}`);
  console.log(`  Config:  ${cfg.configPath}`);
  console.log(`  Rules:   ${instructionsPath}`);
  console.log("");
  console.log(`Restart ${cfg.displayName} or open a new session for the changes to take effect.`);
}
