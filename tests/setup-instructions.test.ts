import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

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
    },
    {
      name: "claude",
      module: "./apps/cli/src/setup-claude.ts",
      exported: "setupClaude",
      instructions: "CLAUDE.md",
      config: path.join(".claude", "settings.json"),
      parse: JSON.parse,
    },
    {
      name: "opencode",
      module: "./apps/cli/src/setup-opencode.ts",
      exported: "setupOpenCode",
      instructions: "AGENTS.md",
      config: path.join(".config", "opencode", "opencode.json"),
      parse: JSON.parse,
    },
    {
      name: "windsurf",
      module: "./apps/cli/src/setup-windsurf.ts",
      exported: "setupWindsurf",
      instructions: "AGENTS.md",
      config: path.join(".codeium", "windsurf", "mcp_config.json"),
      parse: JSON.parse,
    },
    {
      name: "devin",
      module: "./apps/cli/src/setup-devin.ts",
      exported: "setupDevin",
      instructions: "AGENTS.md",
      config: path.join(".config", "devin", "config.json"),
      parse: JSON.parse,
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

  for (const setupCase of cases) {
    it(`installs ${setupCase.name} project instructions and keeps MCP config valid`, async () => {
      await runSetup(setupCase);

      const instructions = fs.readFileSync(path.join(projectPath, setupCase.instructions), "utf-8");
      expect(instructions).toContain(START_MARKER);
      expect(instructions).toContain("call `memory_recall`");
      expect(instructions).toContain(END_MARKER);

      const config = fs.readFileSync(path.join(homePath, setupCase.config), "utf-8");
      expect(() => setupCase.parse(config)).not.toThrow();
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
});
