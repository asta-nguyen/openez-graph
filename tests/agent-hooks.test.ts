import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { installClaudeSearchHook, installSessionStartHook } from "../apps/cli/src/agent-hooks";

let root: string;
let home: string;
let project: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "openez-claude-hook-"));
  home = path.join(root, "home");
  project = path.join(root, "project");
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(project, ".openez"), { recursive: true });
  fs.writeFileSync(path.join(project, ".openez", "workspace.json"), "{}\n");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function settings() {
  return JSON.parse(fs.readFileSync(path.join(project, ".claude", "settings.local.json"), "utf8"));
}

// Runs the installed hook the way Claude Code does: event JSON on stdin, JSON (or nothing) on stdout.
function runHook(event: Record<string, unknown>): { stdout: string; exitCode: number } {
  const { command } = settings().hooks.PreToolUse.at(-1).hooks[0];
  const result = Bun.spawnSync(["sh", "-c", command], {
    stdin: new TextEncoder().encode(JSON.stringify(event)),
    env: { ...process.env, TMPDIR: root },
  });
  return { stdout: result.stdout.toString(), exitCode: result.exitCode };
}

const grep = (session: string, cwd = project) => ({
  session_id: session,
  cwd,
  hook_event_name: "PreToolUse",
  tool_name: "Grep",
  tool_input: { pattern: "foo" },
});

describe("Claude search reminder hook", () => {
  it("reminds once per session before a content search, without blocking", () => {
    installClaudeSearchHook(project, home);

    const first = runHook(grep("s1"));
    expect(first.exitCode).toBe(0);
    const output = JSON.parse(first.stdout);
    expect(output.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(output.hookSpecificOutput.additionalContext).toContain("code_query");
    expect(output.hookSpecificOutput.permissionDecision).toBeUndefined();

    expect(runHook(grep("s1")).stdout).toBe("");
    expect(runHook(grep("s2")).stdout).not.toBe("");
  });

  it("covers grep and rg through Bash but not other commands", () => {
    installClaudeSearchHook(project, home);
    const bash = (session: string, command: string) =>
      runHook({ ...grep(session), tool_name: "Bash", tool_input: { command } });

    expect(bash("b1", "rg -n codeQuery packages").stdout).not.toBe("");
    expect(bash("b2", "  grep -rn foo .").stdout).not.toBe("");
    expect(bash("b3", "bun test").stdout).toBe("");
  });

  it("stays silent outside an indexed project and on malformed input", () => {
    installClaudeSearchHook(project, home);
    const elsewhere = path.join(root, "not-indexed");
    fs.mkdirSync(elsewhere);

    expect(runHook(grep("n1", elsewhere)).stdout).toBe("");
    const { command } = settings().hooks.PreToolUse.at(-1).hooks[0];
    const garbage = Bun.spawnSync(["sh", "-c", command], { stdin: new TextEncoder().encode("{") });
    expect(garbage.exitCode).toBe(0);
    expect(garbage.stdout.toString()).toBe("");
  });

  it("registers once and keeps the user's other hooks", () => {
    fs.mkdirSync(path.join(project, ".claude"));
    const own = { matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] };
    fs.writeFileSync(
      path.join(project, ".claude", "settings.local.json"),
      JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, hooks: { PreToolUse: [own] } }),
    );

    installClaudeSearchHook(project, home);
    installClaudeSearchHook(project, home);

    const saved = settings();
    expect(saved.permissions).toEqual({ allow: ["Bash(ls)"] });
    expect(saved.hooks.PreToolUse).toHaveLength(3);
    expect(saved.hooks.PreToolUse[0]).toEqual(own);
    expect(saved.hooks.PreToolUse.slice(1).map((entry: any) => entry.matcher)).toEqual([
      "Grep",
      "Bash",
    ]);
    // Other Bash commands never start the hook process.
    expect(saved.hooks.PreToolUse[2].hooks.map((hook: any) => hook.if)).toEqual([
      "Bash(grep *)",
      "Bash(rg *)",
    ]);
  });
});

describe("SessionStart reminder hook (Codex, Devin)", () => {
  const configPath = () => path.join(home, ".config", "devin", "config.json");
  const sessionStart = (cwd: string) => {
    const { command } = JSON.parse(fs.readFileSync(configPath(), "utf8")).hooks.SessionStart.at(-1)
      .hooks[0];
    const result = Bun.spawnSync(["sh", "-c", command], {
      stdin: new TextEncoder().encode(JSON.stringify({ hook_event_name: "SessionStart", cwd })),
    });
    return { stdout: result.stdout.toString(), exitCode: result.exitCode };
  };

  it("adds the reminder at session start in an indexed project only", () => {
    installSessionStartHook(configPath(), home);

    const inside = sessionStart(path.join(project, ".openez"));
    expect(inside.exitCode).toBe(0);
    const output = JSON.parse(inside.stdout);
    expect(output.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(output.hookSpecificOutput.additionalContext).toContain("code_query");

    const elsewhere = path.join(root, "not-indexed");
    fs.mkdirSync(elsewhere);
    expect(sessionStart(elsewhere).stdout).toBe("");
  });

  it("registers once and keeps the rest of the config", () => {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    const own = { hooks: [{ type: "command", command: "echo mine" }] };
    fs.writeFileSync(
      configPath(),
      JSON.stringify({ mcpServers: { openez: { command: "x" } }, hooks: { SessionStart: [own] } }),
    );

    installSessionStartHook(configPath(), home);
    installSessionStartHook(configPath(), home);

    const saved = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    expect(saved.mcpServers).toEqual({ openez: { command: "x" } });
    expect(saved.hooks.SessionStart).toHaveLength(2);
    expect(saved.hooks.SessionStart[0]).toEqual(own);
  });
});
