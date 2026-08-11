import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { installAgentInstructions } from "../apps/cli/src/setup-instructions";

const START_MARKER = "<!-- openez:start -->";
const END_MARKER = "<!-- openez:end -->";

describe("agent setup instructions", () => {
  let testRoot: string;
  let homePath: string;
  let projectPath: string;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-setup-"));
    homePath = path.join(testRoot, "home");
    projectPath = path.join(testRoot, "project");
    fs.mkdirSync(homePath);
    fs.mkdirSync(projectPath);
  });

  afterEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  const cases = [
    {
      name: "codex",
      module: "./apps/cli/src/setup-codex.ts",
      exported: "setupCodex",
      instructions: "AGENTS.md",
      config: path.join(".codex", "config.toml"),
      parse: Bun.TOML.parse,
      serverKey: "mcp_servers",
    },
    {
      name: "claude",
      module: "./apps/cli/src/setup-claude.ts",
      exported: "setupClaude",
      instructions: "CLAUDE.md",
      config: path.join(".claude", "settings.json"),
      parse: JSON.parse,
      serverKey: "mcpServers",
    },
    {
      name: "opencode",
      module: "./apps/cli/src/setup-opencode.ts",
      exported: "setupOpenCode",
      instructions: "AGENTS.md",
      config: path.join(".config", "opencode", "opencode.json"),
      parse: JSON.parse,
      serverKey: "mcp",
    },
    {
      name: "windsurf",
      module: "./apps/cli/src/setup-windsurf.ts",
      exported: "setupWindsurf",
      instructions: "AGENTS.md",
      config: path.join(".codeium", "windsurf", "mcp_config.json"),
      parse: JSON.parse,
      serverKey: "mcpServers",
    },
    {
      name: "devin",
      module: "./apps/cli/src/setup-devin.ts",
      exported: "setupDevin",
      instructions: "AGENTS.md",
      config: path.join(".config", "devin", "config.json"),
      parse: JSON.parse,
      serverKey: "mcpServers",
    },
  ] as const;

  async function runSetup(setupCase: (typeof cases)[number]): Promise<void> {
    const script = `const module = await import("${setupCase.module}"); await module.${setupCase.exported}(process.argv[1]);`;
    const childProcess = Bun.spawn([Bun.argv[0]!, "-e", script, projectPath], {
      cwd: path.resolve(import.meta.dir, ".."),
      env: { ...process.env, HOME: homePath },
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await childProcess.exited;
    if (exitCode !== 0) {
      throw new Error(await new Response(childProcess.stderr).text());
    }
  }

  // Extract the args array that launches the openez MCP server from a parsed
  // config. opencode stores `[command, ...args]` in a single `command` array;
  // every other agent stores a separate `args` field.
  function getOpenEZArgs(parsed: Record<string, unknown>, serverKey: string): string[] {
    const servers = parsed[serverKey] as Record<string, Record<string, unknown>>;
    const entry = servers?.openez;
    if (!entry) throw new Error("openez server entry missing from " + serverKey);
    if (Array.isArray(entry.command)) return entry.command as string[];
    if (Array.isArray(entry.args)) return entry.args as string[];
    throw new Error("openez entry has no command/args array");
  }

  for (const setupCase of cases) {
    it(`installs ${setupCase.name} project instructions and keeps MCP config valid`, async () => {
      await runSetup(setupCase);

      const instructions = fs.readFileSync(path.join(projectPath, setupCase.instructions), "utf-8");
      expect(instructions).toContain(START_MARKER);
      expect(instructions).toContain("call `memory_recall`");
      expect(instructions).toContain(END_MARKER);

      const config = fs.readFileSync(path.join(homePath, setupCase.config), "utf-8");
      const parsed = setupCase.parse(config) as Record<string, unknown>;
      // The openez MCP server entry must exist and launch `serve --mcp`.
      const args = getOpenEZArgs(parsed, setupCase.serverKey);
      expect(args.length).toBeGreaterThanOrEqual(2);
      expect(args.slice(-2)).toEqual(["serve", "--mcp"]);
    });
  }

  it("preserves user-authored AGENTS.md content and remains idempotent", async () => {
    const instructionsPath = path.join(projectPath, "AGENTS.md");
    const userContent = "# Project rules\n\nKeep this byte-for-byte.\n";
    fs.writeFileSync(instructionsPath, userContent);

    await runSetup(cases[0]);
    await runSetup(cases[0]);

    const instructions = fs.readFileSync(instructionsPath, "utf-8");
    expect(instructions.startsWith(userContent)).toBe(true);
    expect(instructions.match(new RegExp(START_MARKER, "g"))).toHaveLength(1);
    expect(instructions.match(new RegExp(END_MARKER, "g"))).toHaveLength(1);
  });

  it("replaces an existing managed block in place", async () => {
    const instructionsPath = path.join(projectPath, "AGENTS.md");
    const existing = `before\n${START_MARKER}\nold policy\n${END_MARKER}\nafter\n`;
    fs.writeFileSync(instructionsPath, existing);

    await runSetup(cases[0]);

    const instructions = fs.readFileSync(instructionsPath, "utf-8");
    expect(instructions.startsWith("before\n")).toBe(true);
    expect(instructions.endsWith("\nafter\n")).toBe(true);
    expect(instructions).not.toContain("old policy");
    expect(instructions).toContain("call `memory_recall`");
  });

  it("rejects a symlinked AGENTS.md pointing outside the project root", () => {
    const outsideTarget = path.join(testRoot, "outside-target.md");
    const outsideContent = "outside content\n";
    fs.writeFileSync(outsideTarget, outsideContent);
    const symlinkPath = path.join(projectPath, "AGENTS.md");
    fs.symlinkSync(outsideTarget, symlinkPath);

    expect(() => installAgentInstructions(projectPath, "AGENTS.md")).toThrow(/symlink/);
    // The symlink target must be unchanged.
    expect(fs.readFileSync(outsideTarget, "utf-8")).toBe(outsideContent);
  });

  it("rejects a symlinked CLAUDE.md pointing outside the project root", () => {
    const outsideTarget = path.join(testRoot, "outside-claude.md");
    const outsideContent = "claude outside\n";
    fs.writeFileSync(outsideTarget, outsideContent);
    const symlinkPath = path.join(projectPath, "CLAUDE.md");
    fs.symlinkSync(outsideTarget, symlinkPath);

    expect(() => installAgentInstructions(projectPath, "CLAUDE.md")).toThrow(/symlink/);
    expect(fs.readFileSync(outsideTarget, "utf-8")).toBe(outsideContent);
  });

  it("errors without modifying the file when only START_MARKER is present", () => {
    const instructionsPath = path.join(projectPath, "AGENTS.md");
    const content = `header\n${START_MARKER}\norphan\n`;
    fs.writeFileSync(instructionsPath, content);

    expect(() => installAgentInstructions(projectPath, "AGENTS.md")).toThrow(/Unmatched/);
    // File must be unchanged.
    expect(fs.readFileSync(instructionsPath, "utf-8")).toBe(content);
  });

  it("errors without modifying the file when only END_MARKER is present", () => {
    const instructionsPath = path.join(projectPath, "AGENTS.md");
    const content = `header\n${END_MARKER}\norphan\n`;
    fs.writeFileSync(instructionsPath, content);

    expect(() => installAgentInstructions(projectPath, "AGENTS.md")).toThrow(/Unmatched/);
    expect(fs.readFileSync(instructionsPath, "utf-8")).toBe(content);
  });
});
