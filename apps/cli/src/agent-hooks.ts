import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SEARCH_HOOK_FILE = "claude-search-reminder.mjs";
const SESSION_HOOK_FILE = "session-start-reminder.mjs";

// Shared by both hook scripts. They run inside the agent's tool loop, so they use Node built-ins
// only and start fast, and they never block: unindexed projects and bad input print nothing.
const SCRIPT_PRELUDE = `import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function indexed(dir) {
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, ".openez", "workspace.json"))) return true;
    if (path.dirname(current) === current) return false;
  }
}

function remind(hookEventName, additionalContext) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } }));
}
`;

const SEARCH_HOOK_SCRIPT = `// Written by \`openez setup claude\`. Claude Code PreToolUse hook: once per session, before a
// content search in an OpenEZ-indexed project, remind the agent that code_query exists.
${SCRIPT_PRELUDE}
try {
  const event = JSON.parse(fs.readFileSync(0, "utf8"));
  const command = String(event.tool_input?.command ?? "");
  const search =
    event.tool_name === "Grep" || (event.tool_name === "Bash" && /^\\s*(grep|rg)\\b/.test(command));
  if (search && indexed(event.cwd ?? process.cwd())) {
    const session = String(event.session_id).replace(/[^\\w-]/g, "_");
    // "wx" fails once this session has been reminded, which ends the hook silently.
    fs.writeFileSync(path.join(os.tmpdir(), "openez-reminded-" + session), "", { flag: "wx" });
    remind(
      "PreToolUse",
      "[OpenEZ] This project is indexed. For questions about concepts or behavior (where is X " +
        "handled, how does Y work), call the openez code_query MCP tool before grepping; use " +
        "code_context for callers and callees. Grep is still the right tool for exact strings and regex.",
    );
  }
} catch {}
`;

const SESSION_HOOK_SCRIPT = `// Written by \`openez setup codex|devin\`. SessionStart hook: in an OpenEZ-indexed project,
// add a reminder to use the OpenEZ MCP tools. Their PreToolUse hooks cannot add context without
// blocking, so session start is the closest point to the agent's first search.
${SCRIPT_PRELUDE}
try {
  const event = JSON.parse(fs.readFileSync(0, "utf8"));
  if (indexed(event.cwd ?? process.cwd())) {
    remind(
      "SessionStart",
      "[OpenEZ] This project is indexed. Before grepping for concepts or behavior, call the openez " +
        "code_query MCP tool; use code_context for callers and callees and memory_recall for earlier " +
        "decisions. Grep is still the right tool for exact strings and regex.",
    );
  }
} catch {}
`;

function writeHookScript(homeDir: string, fileName: string, script: string): string {
  const scriptPath = path.join(homeDir, ".openez", "hooks", fileName);
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, script, "utf-8");
  return scriptPath;
}

function readJsonConfig(configPath: string): Record<string, any> {
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    throw new Error(`Could not parse ${configPath}; fix or remove it, then rerun setup.`);
  }
}

// The event's hook groups without the ones OpenEZ wrote before, so re-running setup replaces them.
function withoutOurs(groups: unknown, fileName: string): unknown[] {
  return (Array.isArray(groups) ? groups : []).filter(
    (group: any) =>
      !(
        Array.isArray(group?.hooks) &&
        group.hooks.some((hook: any) => String(hook?.command ?? "").includes(fileName))
      ),
  );
}

function writeJsonConfig(configPath: string, config: Record<string, any>): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  // Owner-only when created; an existing file keeps the permissions its owner chose.
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/**
 * Installs the search reminder for one project: the script under ~/.openez/hooks and a PreToolUse
 * entry in <project>/.claude/settings.local.json, which is personal and kept out of Git because it
 * holds this machine's absolute paths. Re-running replaces the previous OpenEZ entry.
 */
export function installClaudeSearchHook(
  projectPath: string,
  homeDir = os.homedir(),
  runtime = process.execPath,
): string {
  const scriptPath = writeHookScript(homeDir, SEARCH_HOOK_FILE, SEARCH_HOOK_SCRIPT);
  const settingsPath = path.join(projectPath, ".claude", "settings.local.json");
  const settings = readJsonConfig(settingsPath);
  const handler = { type: "command", command: `"${runtime}" "${scriptPath}"`, timeout: 5 };
  settings.hooks ??= {};
  settings.hooks.PreToolUse = [
    ...withoutOurs(settings.hooks.PreToolUse, SEARCH_HOOK_FILE),
    { matcher: "Grep", hooks: [handler] },
    // `if` (permission-rule syntax) keeps Claude Code from starting the hook for other Bash
    // commands; versions without `if` still start it, and the script filters the command itself.
    {
      matcher: "Bash",
      hooks: [
        { ...handler, if: "Bash(grep *)" },
        { ...handler, if: "Bash(rg *)" },
      ],
    },
  ];
  writeJsonConfig(settingsPath, settings);

  // Keep the machine-specific file out of commits without editing the tracked .gitignore.
  const exclude = path.join(projectPath, ".git", "info", "exclude");
  const entry = ".claude/settings.local.json";
  if (fs.existsSync(path.dirname(exclude))) {
    const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf-8") : "";
    if (!current.split("\n").includes(entry)) {
      fs.appendFileSync(exclude, `${current && !current.endsWith("\n") ? "\n" : ""}${entry}\n`);
    }
  }
  return settingsPath;
}

/**
 * Installs the SessionStart reminder into a user-level hooks config shared by every project:
 * `~/.codex/hooks.json` for Codex, `~/.config/devin/config.json` for Devin CLI. Both use
 * `{ hooks: { SessionStart: [{ hooks: [handler] }] } }`. The script stays silent outside indexed
 * projects. Re-running replaces the previous OpenEZ entry.
 */
export function installSessionStartHook(
  configPath: string,
  homeDir = os.homedir(),
  runtime = process.execPath,
): string {
  const scriptPath = writeHookScript(homeDir, SESSION_HOOK_FILE, SESSION_HOOK_SCRIPT);
  const config = readJsonConfig(configPath);
  config.hooks ??= {};
  config.hooks.SessionStart = [
    ...withoutOurs(config.hooks.SessionStart, SESSION_HOOK_FILE),
    { hooks: [{ type: "command", command: `"${runtime}" "${scriptPath}"`, timeout: 5 }] },
  ];
  writeJsonConfig(configPath, config);
  return configPath;
}
