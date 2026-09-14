import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { autoIndexAndSync, createMcpServer } from "../apps/mcp/src/mcp-core";
import { countTokens } from "../packages/core/src/tokenizer";
import {
  closeAllWorkspaceDbs,
  closeRegistryDb,
  createRegistryRepository,
  createWorkspaceRepository,
} from "../packages/db/src/sqlite";
import { indexWorkspace } from "../packages/indexer/src";

let tempRoot: string;
let registryRoot: string;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-mcp-workspace-"));
  registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-mcp-registry-"));
  process.env.AI_MEMORY_REGISTRY_DB_PATH = path.join(registryRoot, "registry.sqlite");
  closeRegistryDb();
  closeAllWorkspaceDbs();
});

afterEach(() => {
  closeAllWorkspaceDbs();
  closeRegistryDb();
  fs.rmSync(tempRoot, { recursive: true, force: true });
  fs.rmSync(registryRoot, { recursive: true, force: true });
  delete process.env.AI_MEMORY_REGISTRY_DB_PATH;
});

async function createIndexedWorkspace(id: string, rootPath: string) {
  fs.mkdirSync(path.join(rootPath, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(rootPath, "src", "target.ts"),
    "export function target(value: string) { return value.toUpperCase(); }\n",
  );
  fs.writeFileSync(
    path.join(rootPath, "src", "caller.ts"),
    `import { target } from './target';\n${Array.from(
      { length: 24 },
      (_, index) => `export function caller${index || ""}() { return target('hello-${index}'); }`,
    ).join("\n")}\n`,
  );
  fs.writeFileSync(
    path.join(rootPath, "README.md"),
    "# Target workflow\n\nThe caller invokes the target transformation.\n",
  );

  const workspace = await createRegistryRepository().createWorkspace({ id, name: id, rootPath });
  await indexWorkspace({ workspaceId: workspace.id, mode: "full" });
  return workspace;
}

async function connectClient(defaultPath: string) {
  const server = createMcpServer({ defaultPath, version: "test", build: "test" });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

async function startSourceMcp(defaultPath: string) {
  // Run the auto-index + sync logic in-process instead of spawning a tsx
  // child process. The tsx spawn crashes under Node because drizzle-orm
  // statically imports bun:sqlite, which doesn't exist outside Bun.
  await autoIndexAndSync(defaultPath);
}

function textResult(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((item) => item.type === "text");
  if (!text || text.type !== "text") throw new Error("Expected text tool response");
  return text.text ?? "";
}

describe("MCP agent contracts", () => {
  it("advertises workspace_context as a session-start read tool", async () => {
    const { client, server } = await connectClient(tempRoot);
    try {
      const tool = (await client.listTools()).tools.find(
        (item) => item.name === "workspace_context",
      );
      expect(tool?.description).toContain("session start");
      expect(
        (tool?.inputSchema as { properties?: Record<string, unknown> }).properties,
      ).toHaveProperty("workspaceIds");
      expect(
        (tool?.inputSchema as { properties?: { maxTokens?: Record<string, unknown> } }).properties
          ?.maxTokens,
      ).toMatchObject({ type: "integer", minimum: 128, maximum: 100_000 });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rejects empty workspace selectors instead of treating them as absent", async () => {
    const workspace = await createIndexedWorkspace("selector-target", tempRoot);
    const { client, server } = await connectClient(tempRoot);
    try {
      await expect(
        client.callTool({ name: "workspace_context", arguments: { workspaceIds: [] } }),
      ).rejects.toThrow(/empty/i);
      await expect(
        client.callTool({ name: "workspace_context", arguments: { workspaceIds: [""] } }),
      ).rejects.toThrow(/empty/i);
      await expect(
        client.callTool({ name: "workspace_context", arguments: { workspaceIds: ["  "] } }),
      ).rejects.toThrow(/empty/i);
      await expect(
        client.callTool({
          name: "workspace_context",
          arguments: { workspaceIds: [], workspaceId: workspace.id },
        }),
      ).rejects.toThrow(/empty/i);
      await expect(
        client.callTool({ name: "workspace_context", arguments: { workspaceId: "" } }),
      ).rejects.toThrow(/empty/i);
      await expect(
        client.callTool({ name: "workspace_context", arguments: { paths: [] } }),
      ).rejects.toThrow(/empty/i);
      await expect(
        client.callTool({ name: "workspace_context", arguments: { paths: [""] } }),
      ).rejects.toThrow(/empty/i);
      await expect(
        client.callTool({ name: "workspace_context", arguments: { paths: ["  "] } }),
      ).rejects.toThrow(/empty/i);
      await expect(
        client.callTool({ name: "workspace_context", arguments: { path: "" } }),
      ).rejects.toThrow(/empty/i);
      await expect(
        client.callTool({ name: "workspace_context", arguments: { workspaceId: "  " } }),
      ).rejects.toThrow(/empty/i);
      await expect(
        client.callTool({ name: "workspace_context", arguments: { path: "  " } }),
      ).rejects.toThrow(/empty/i);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns default and explicit multi-workspace context", async () => {
    const first = await createIndexedWorkspace("context-first", tempRoot);
    fs.writeFileSync(path.join(tempRoot, "AGENTS.md"), "Use the first workspace.\n");
    fs.writeFileSync(
      path.join(tempRoot, ".openez", "workspace.json"),
      JSON.stringify({
        workspaceId: first.id,
        rootPath: tempRoot,
        name: first.name,
        updatedAt: "2026-09-14T00:00:00.000Z",
      }),
    );
    const nestedPath = path.join(tempRoot, "src", "nested");
    fs.mkdirSync(nestedPath, { recursive: true });
    const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-context-second-"));
    try {
      const second = await createIndexedWorkspace("context-second", secondRoot);
      const { client, server } = await connectClient(nestedPath);
      try {
        const defaultBody = toolJson(
          await client.callTool({ name: "workspace_context", arguments: {} }),
        ) as {
          workspaces: Array<{ workspaceId: string }>;
          metrics: { tokenBudget: number };
        };
        expect(defaultBody.workspaces.map((item) => item.workspaceId)).toEqual([first.id]);
        expect(defaultBody.metrics.tokenBudget).toBe(800);

        const multiBody = toolJson(
          await client.callTool({
            name: "workspace_context",
            arguments: { workspaceIds: [first.id, second.id], maxTokens: 2_000 },
          }),
        ) as { workspaces: Array<{ workspaceId: string }> };
        expect(multiBody.workspaces.map((item) => item.workspaceId)).toEqual([first.id, second.id]);

        const byId = toolJson(
          await client.callTool({
            name: "workspace_context",
            arguments: { workspaceId: first.id, maxTokens: 2_000 },
          }),
        ) as { workspaces: Array<{ workspaceId: string }> };
        expect(byId.workspaces.map((item) => item.workspaceId)).toEqual([first.id]);

        const byPath = toolJson(
          await client.callTool({
            name: "workspace_context",
            arguments: { path: tempRoot, maxTokens: 2_000 },
          }),
        ) as { workspaces: Array<{ workspaceId: string }> };
        expect(byPath.workspaces.map((item) => item.workspaceId)).toEqual([first.id]);

        const byPaths = toolJson(
          await client.callTool({
            name: "workspace_context",
            arguments: { paths: [tempRoot, secondRoot], maxTokens: 2_000 },
          }),
        ) as { workspaces: Array<{ workspaceId: string }> };
        expect(byPaths.workspaces.map((item) => item.workspaceId)).toEqual([first.id, second.id]);
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      closeAllWorkspaceDbs();
      fs.rmSync(secondRoot, { recursive: true, force: true });
    }
  });

  it("keeps successful workspace context when a sibling snapshot fails", async () => {
    const good = await createIndexedWorkspace("context-good", tempRoot);
    const brokenRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-context-broken-"));
    const broken = await createRegistryRepository().createWorkspace({
      id: "context-broken",
      name: "context-broken",
      rootPath: brokenRoot,
    });
    closeAllWorkspaceDbs();
    fs.rmSync(brokenRoot, { recursive: true, force: true });
    fs.writeFileSync(brokenRoot, "not a directory\n");
    try {
      const { client, server } = await connectClient(tempRoot);
      try {
        const body = toolJson(
          await client.callTool({
            name: "workspace_context",
            arguments: { workspaceIds: [good.id, broken.id], maxTokens: 2_000 },
          }),
        ) as { workspaces: Array<{ workspaceId: string; context?: unknown; error?: string }> };
        expect(body.workspaces.find((item) => item.workspaceId === good.id)?.context).toBeTruthy();
        expect(body.workspaces.find((item) => item.workspaceId === broken.id)?.error).toBeTruthy();
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      fs.rmSync(brokenRoot, { force: true });
    }
  });

  it("fits workspace_context to maxTokens before dropping core identity", async () => {
    await createIndexedWorkspace("context-budget", tempRoot);
    fs.writeFileSync(path.join(tempRoot, "AGENTS.md"), "Primary instruction.\n");
    fs.writeFileSync(path.join(tempRoot, "CLAUDE.md"), "Secondary instruction. ".repeat(200));
    const repo = createWorkspaceRepository(tempRoot);
    await repo.insertMemory({
      title: "Decision",
      content: "Keep SQLite local-first.",
      source: "agent",
    });

    const { client, server } = await connectClient(tempRoot);
    try {
      const text = textResult(
        await client.callTool({
          name: "workspace_context",
          arguments: { maxTokens: 300 },
        }),
      );
      const body = JSON.parse(text) as {
        workspaces: Array<{
          workspaceId: string;
          context?: {
            instructions: Array<{ path: string }>;
            memories: unknown[];
            activity: unknown;
          };
        }>;
        metrics: { tokenBudget: number; responseTokens: number; truncated: boolean };
      };

      expect(countTokens(text)).toBeLessThanOrEqual(300);
      expect(body.metrics).toMatchObject({
        tokenBudget: 300,
        responseTokens: countTokens(text),
        truncated: true,
      });
      expect(body.workspaces[0]?.workspaceId).toBe("context-budget");
      expect(body.workspaces[0]?.context?.instructions.map((item) => item.path)).toEqual([
        "AGENTS.md",
      ]);
      expect(body.workspaces[0]?.context?.memories).toHaveLength(1);
      expect(body.workspaces[0]?.context?.activity).toBeTruthy();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("removes the globally oldest memory across workspace contexts", async () => {
    const first = await createIndexedWorkspace("memory-old", tempRoot);
    const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-memory-new-"));
    try {
      const second = await createIndexedWorkspace("memory-new", secondRoot);
      const oldId = await createWorkspaceRepository(tempRoot).insertMemory({
        title: "Old",
        content: "old",
        source: "agent",
      });
      const newId = await createWorkspaceRepository(secondRoot).insertMemory({
        title: "New",
        content: "new ".repeat(80),
        source: "agent",
      });
      await createWorkspaceRepository(tempRoot).executeRaw(
        "UPDATE memories SET updated_at = ? WHERE id = ?",
        ["2020-01-01T00:00:00.000Z", oldId],
      );
      await createWorkspaceRepository(secondRoot).executeRaw(
        "UPDATE memories SET updated_at = ? WHERE id = ?",
        ["2021-01-01T00:00:00.000Z", newId],
      );

      const { client, server } = await connectClient(tempRoot);
      try {
        const fullText = textResult(
          await client.callTool({
            name: "workspace_context",
            arguments: { workspaceIds: [first.id, second.id], maxTokens: 100_000 },
          }),
        );
        const text = textResult(
          await client.callTool({
            name: "workspace_context",
            arguments: {
              workspaceIds: [first.id, second.id],
              maxTokens: countTokens(fullText) - 10,
            },
          }),
        );
        const body = JSON.parse(text) as {
          workspaces: Array<{ context?: { memories: Array<{ id: string }> } }>;
        };
        expect(
          body.workspaces.flatMap((item) => item.context?.memories ?? []).map((item) => item.id),
        ).toEqual([newId]);
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      closeAllWorkspaceDbs();
      fs.rmSync(secondRoot, { recursive: true, force: true });
    }
  });

  it("returns the core diff scope error for ref and staged changes", async () => {
    const { client, server } = await connectClient(tempRoot);
    try {
      const result = await client.callTool({
        name: "diff_context",
        arguments: { ref: "HEAD", staged: true },
      });

      const body = toolJson(result) as {
        workspaces: Array<{ error: string; ref: string; staged: boolean }>;
        metrics?: unknown;
      };
      expect(body.workspaces).toEqual([
        {
          error: "Cannot combine a git ref with staged changes",
          ref: "HEAD",
          staged: true,
        },
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("keeps structured diff errors within the minimum response budget", async () => {
    const { client, server } = await connectClient(tempRoot);
    try {
      const text = textResult(
        await client.callTool({
          name: "diff_context",
          arguments: { ref: "HEAD", staged: true, maxTokens: 32 },
        }),
      );

      expect(countTokens(text)).toBeLessThanOrEqual(32);
      expect(
        (JSON.parse(text) as { workspaces: Array<{ error?: string }> }).workspaces[0]?.error,
      ).toContain("Cannot");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rejects diff_context maxTokens outside the advertised integer bounds", async () => {
    const { client, server } = await connectClient(tempRoot);
    try {
      const diffTool = (await client.listTools()).tools.find(
        (tool) => tool.name === "diff_context",
      );
      const maxTokens = (
        diffTool?.inputSchema as {
          properties?: { maxTokens?: Record<string, unknown> };
        }
      ).properties?.maxTokens;

      expect(maxTokens).toMatchObject({
        type: "integer",
        minimum: 32,
        maximum: 100_000,
      });
      await expect(
        client.callTool({ name: "diff_context", arguments: { maxTokens: 31 } }),
      ).rejects.toThrow();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("prepares caller graph context before analyzing a diff", async () => {
    execSync("git init", { cwd: tempRoot, stdio: "ignore" });
    execSync("git config user.name 'Tester'", { cwd: tempRoot, stdio: "ignore" });
    execSync("git config user.email 'tester@example.com'", { cwd: tempRoot, stdio: "ignore" });
    await createIndexedWorkspace("diff-context", tempRoot);
    execSync("git add . && git commit -m initial", { cwd: tempRoot, stdio: "ignore" });
    fs.writeFileSync(
      path.join(tempRoot, "src", "target.ts"),
      "export function target(value: string) { return value.trim().toUpperCase(); }\n",
    );

    const { client, server } = await connectClient(tempRoot);
    try {
      const body = toolJson(await client.callTool({ name: "diff_context", arguments: {} })) as {
        workspaces: Array<{
          workspaceId: string;
          workspaceName: string;
          report: { formattedSummary: string };
        }>;
      };
      expect(body.workspaces).toHaveLength(1);
      expect(body.workspaces[0]?.workspaceId).toBe("diff-context");
      expect(body.workspaces[0]?.workspaceName).toBe("diff-context");
      expect(body.workspaces[0]?.report.formattedSummary).toContain("caller");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("always wraps diff_context results in a workspaces array", async () => {
    execSync("git init", { cwd: tempRoot, stdio: "ignore" });
    execSync("git config user.name 'Tester'", { cwd: tempRoot, stdio: "ignore" });
    execSync("git config user.email 'tester@example.com'", { cwd: tempRoot, stdio: "ignore" });
    const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-mcp-second-"));
    try {
      const first = await createIndexedWorkspace("single", tempRoot);
      const second = await createIndexedWorkspace("multi", secondRoot);
      execSync("git init", { cwd: secondRoot, stdio: "ignore" });
      execSync("git config user.name 'Tester'", { cwd: secondRoot, stdio: "ignore" });
      execSync("git config user.email 'tester@example.com'", { cwd: secondRoot, stdio: "ignore" });
      execSync("git add . && git commit -m initial", { cwd: tempRoot, stdio: "ignore" });
      execSync("git add . && git commit -m initial", { cwd: secondRoot, stdio: "ignore" });
      fs.writeFileSync(
        path.join(tempRoot, "src", "target.ts"),
        "export function target(value: string) { return value.trim().toUpperCase(); }\n",
      );
      fs.writeFileSync(
        path.join(secondRoot, "src", "target.ts"),
        "export function target(value: string) { return value.trim().toUpperCase(); }\n",
      );

      const { client, server } = await connectClient(tempRoot);
      try {
        const singleBody = toolJson(
          await client.callTool({
            name: "diff_context",
            arguments: { workspaceId: first.id },
          }),
        ) as { workspaces: unknown[] };
        expect(Array.isArray(singleBody.workspaces)).toBe(true);
        expect(singleBody.workspaces).toHaveLength(1);

        const multiBody = toolJson(
          await client.callTool({
            name: "diff_context",
            arguments: { workspaceIds: [first.id, second.id] },
          }),
        ) as { workspaces: unknown[] };
        expect(Array.isArray(multiBody.workspaces)).toBe(true);
        expect(multiBody.workspaces).toHaveLength(2);
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      closeAllWorkspaceDbs();
      fs.rmSync(secondRoot, { recursive: true, force: true });
    }
  });

  it("bounds diff_context responses to maxTokens and drops formattedSummary first", async () => {
    execSync("git init", { cwd: tempRoot, stdio: "ignore" });
    execSync("git config user.name 'Tester'", { cwd: tempRoot, stdio: "ignore" });
    execSync("git config user.email 'tester@example.com'", { cwd: tempRoot, stdio: "ignore" });
    await createIndexedWorkspace("budget", tempRoot);
    execSync("git add . && git commit -m initial", { cwd: tempRoot, stdio: "ignore" });
    fs.writeFileSync(
      path.join(tempRoot, "src", "target.ts"),
      "export function target(value: string) { return value.trim().toUpperCase(); }\n",
    );

    const { client, server } = await connectClient(tempRoot);
    try {
      const text = textResult(
        await client.callTool({
          name: "diff_context",
          arguments: { maxTokens: 200 },
        }),
      );
      expect(countTokens(text)).toBeLessThanOrEqual(200);
      const body = JSON.parse(text) as {
        workspaces: Array<{
          report: {
            formattedSummary?: string;
            files: Array<{ filePath: string; affectedSymbols: unknown[] }>;
          };
        }>;
      };
      // formattedSummary is dropped before structured files/symbols
      expect(body.workspaces[0]?.report.formattedSummary).toBeUndefined();
      expect(Array.isArray(body.workspaces[0]?.report.files)).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns a structured error for an unregistered diff_context path", async () => {
    const { client, server } = await connectClient(tempRoot);
    try {
      const body = toolJson(
        await client.callTool({
          name: "diff_context",
          arguments: { path: "/definitely/not/a/registered/workspace" },
        }),
      ) as { workspaces: Array<{ error: string }> };
      // Top-level errors are wrapped in { workspaces: [{ error }] }
      expect(body.workspaces).toHaveLength(1);
      expect(body.workspaces[0]?.error).toBeTruthy();
      expect(body.workspaces[0]?.error).not.toBe("");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns a structured top-level error for a syntactically invalid git ref (no workspaceId)", async () => {
    execSync("git init", { cwd: tempRoot, stdio: "ignore" });
    execSync("git config user.name 'Tester'", { cwd: tempRoot, stdio: "ignore" });
    execSync("git config user.email 'tester@example.com'", { cwd: tempRoot, stdio: "ignore" });
    await createIndexedWorkspace("bad-ref", tempRoot);
    execSync("git add . && git commit -m initial", { cwd: tempRoot, stdio: "ignore" });

    const { client, server } = await connectClient(tempRoot);
    try {
      const body = toolJson(
        await client.callTool({
          name: "diff_context",
          arguments: { ref: "HEAD; echo pwned" },
        }),
      ) as {
        workspaces: Array<{
          workspaceId?: string;
          error: string;
          ref: string;
        }>;
        metrics?: unknown;
      };
      expect(body.workspaces).toHaveLength(1);
      // Syntactically invalid ref is a top-level error — no workspace was
      // resolved, so workspaceId must be absent per AGENTS.md contract.
      expect(body.workspaces[0]?.workspaceId).toBeUndefined();
      expect(body.workspaces[0]?.error).toBeTruthy();
      expect(body.workspaces[0]?.ref).toBe("HEAD; echo pwned");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns a per-workspace error for a nonexistent but syntactically valid git ref", async () => {
    execSync("git init", { cwd: tempRoot, stdio: "ignore" });
    execSync("git config user.name 'Tester'", { cwd: tempRoot, stdio: "ignore" });
    execSync("git config user.email 'tester@example.com'", { cwd: tempRoot, stdio: "ignore" });
    await createIndexedWorkspace("missing-ref", tempRoot);
    execSync("git add . && git commit -m initial", { cwd: tempRoot, stdio: "ignore" });

    const { client, server } = await connectClient(tempRoot);
    try {
      const body = toolJson(
        await client.callTool({
          name: "diff_context",
          arguments: { ref: "not-a-real-ref" },
        }),
      ) as {
        workspaces: Array<{
          workspaceId?: string;
          error: string;
          ref: string;
        }>;
        metrics?: unknown;
      };
      expect(body.workspaces).toHaveLength(1);
      // Nonexistent ref is a per-workspace error — workspace was resolved
      // (workspaceId present) but git diff failed against the missing ref.
      expect(body.workspaces[0]?.workspaceId).toBe("missing-ref");
      expect(body.workspaces[0]?.error).toBeTruthy();
      expect(body.workspaces[0]?.ref).toBe("not-a-real-ref");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns a structured error for an option-injection git ref", async () => {
    execSync("git init", { cwd: tempRoot, stdio: "ignore" });
    execSync("git config user.name 'Tester'", { cwd: tempRoot, stdio: "ignore" });
    execSync("git config user.email 'tester@example.com'", { cwd: tempRoot, stdio: "ignore" });
    await createIndexedWorkspace("injection-ref", tempRoot);
    execSync("git add . && git commit -m initial", { cwd: tempRoot, stdio: "ignore" });

    const { client, server } = await connectClient(tempRoot);
    try {
      const body = toolJson(
        await client.callTool({
          name: "diff_context",
          arguments: { ref: "--output=/tmp/evil" },
        }),
      ) as {
        workspaces: Array<{
          workspaceId?: string;
          error: string;
          ref: string;
        }>;
      };
      expect(body.workspaces).toHaveLength(1);
      // Option-injection ref is a top-level validation error — no workspaceId
      expect(body.workspaces[0]?.workspaceId).toBeUndefined();
      expect(body.workspaces[0]?.error).toMatch(/invalid.*ref|ref.*invalid/i);
      expect(body.workspaces[0]?.ref).toBe("--output=/tmp/evil");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("advertises when agents should recall and write memory", async () => {
    const { client, server } = await connectClient(tempRoot);
    try {
      const tools = (await client.listTools()).tools;
      expect(tools.find((tool) => tool.name === "memory_recall")?.description).toContain(
        "Before code work",
      );
      expect(tools.find((tool) => tool.name === "memory_write")?.description).toContain(
        "architectural decision",
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("does not re-index an already indexed empty workspace on restart", async () => {
    await startSourceMcp(tempRoot);
    const workspace = await createRegistryRepository().getWorkspaceByPath(tempRoot);
    expect(workspace?.lastIndexedAt).toBeTruthy();
    const repo = createWorkspaceRepository(tempRoot);
    expect(await repo.queryRaw("SELECT id FROM index_runs")).toHaveLength(1);

    await startSourceMcp(tempRoot);

    expect(await repo.queryRaw("SELECT id FROM index_runs")).toHaveLength(1);
  });

  it("rejects response budgets too small for a valid metrics envelope", async () => {
    await createIndexedWorkspace("minimum-budget", tempRoot);
    const { client, server } = await connectClient(tempRoot);
    try {
      await expect(
        client.callTool({
          name: "code_query",
          arguments: { query: "target", maxTokens: 1 },
        }),
      ).rejects.toThrow();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("enforces code_query maxTokens across multiple workspaces", async () => {
    const first = await createIndexedWorkspace("first", tempRoot);
    const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-mcp-second-"));
    const thirdRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-mcp-third-"));
    try {
      const second = await createIndexedWorkspace("second", secondRoot);
      const third = await createIndexedWorkspace("third", thirdRoot);
      const { client, server } = await connectClient(tempRoot);
      try {
        expect(client.getServerVersion()?.version).toBe("test+test");
        const text = textResult(
          await client.callTool({
            name: "code_query",
            arguments: {
              workspaceIds: [first.id, second.id, third.id],
              query: "target transformation",
              maxTokens: 300,
            },
          }),
        );
        const body = JSON.parse(text) as {
          metrics: { responseTokens: number; tokenBudget: number };
        };

        expect(countTokens(text)).toBeLessThanOrEqual(300);
        expect(body.metrics).toMatchObject({ responseTokens: countTokens(text), tokenBudget: 300 });
        const firstLog = await createWorkspaceRepository(tempRoot).queryRaw(
          "SELECT tokens_returned FROM query_logs ORDER BY created_at DESC LIMIT 1",
        );
        const secondLog = await createWorkspaceRepository(secondRoot).queryRaw(
          "SELECT tokens_returned FROM query_logs ORDER BY created_at DESC LIMIT 1",
        );
        const thirdLog = await createWorkspaceRepository(thirdRoot).queryRaw(
          "SELECT tokens_returned FROM query_logs ORDER BY created_at DESC LIMIT 1",
        );
        expect(
          Number(firstLog[0]?.tokens_returned) +
            Number(secondLog[0]?.tokens_returned) +
            Number(thirdLog[0]?.tokens_returned),
        ).toBe(countTokens(text));
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      closeAllWorkspaceDbs();
      fs.rmSync(secondRoot, { recursive: true, force: true });
      fs.rmSync(thirdRoot, { recursive: true, force: true });
    }
  });

  it("returns compact, budgeted graph neighbors", async () => {
    await createIndexedWorkspace("graph", tempRoot);
    const { client, server } = await connectClient(tempRoot);
    try {
      const text = textResult(
        await client.callTool({
          name: "graph_neighbors",
          arguments: { label: "target", depth: 2, limit: 20, maxTokens: 500 },
        }),
      );
      const body = JSON.parse(text) as {
        metrics: { truncated: boolean };
        results: Array<{ result: { nodes: Array<Record<string, unknown>> } }>;
      };

      expect(countTokens(text)).toBeLessThanOrEqual(500);
      expect(body.metrics.truncated).toBe(true);
      expect(body.results[0]?.result.nodes[0]).not.toHaveProperty("created_at");
      expect(body.results[0]?.result.nodes[0]).not.toHaveProperty("updated_at");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("resolves code_context callers and source snippets", async () => {
    const workspace = await createIndexedWorkspace("context", tempRoot);
    const { client, server } = await connectClient(tempRoot);
    try {
      const text = textResult(
        await client.callTool({
          name: "code_context",
          arguments: { symbolOrPath: "target", maxTokens: 1200 },
        }),
      );
      const body = JSON.parse(text) as {
        results: Array<{
          result: {
            symbol?: { snippet?: string };
            callers: Array<{ symbol?: string; path?: string }>;
          };
        }>;
      };
      const context = body.results[0]?.result;

      expect(context?.symbol?.snippet).toContain("function target");
      expect(context?.callers).toContainEqual(
        expect.objectContaining({ symbol: "caller", path: "src/caller.ts" }),
      );
      expect(countTokens(text)).toBeLessThanOrEqual(1200);
      expect((await createRegistryRepository().getWorkspace(workspace.id))?.graphStatus).toBe(
        "completed",
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("keeps context and structured sources paired under token truncation", async () => {
    // Create two workspaces so code_context returns multiple result entries
    // that can be truncated by fitToTokenBudget.
    const secondRoot = path.join(tempRoot, "second");
    fs.mkdirSync(secondRoot, { recursive: true });
    await createIndexedWorkspace("context-a", tempRoot);
    await createIndexedWorkspace("context-b", secondRoot);
    const { client, server } = await connectClient(tempRoot);
    try {
      const text = textResult(
        await client.callTool({
          name: "code_context",
          arguments: {
            symbolOrPath: "target",
            paths: [tempRoot, secondRoot],
            maxTokens: 300,
          },
        }),
      );
      const body = JSON.parse(text) as {
        metrics: { truncated: boolean };
        results: Array<{
          result: {
            symbol?: { snippet?: string };
            callers: Array<Record<string, unknown>>;
            callees: Array<Record<string, unknown>>;
          };
        }>;
      };

      expect(countTokens(text)).toBeLessThanOrEqual(300);
      expect(body.metrics.truncated).toBe(true);
      // Every remaining result entry must have its structured source arrays
      // intact — truncation drops whole entries, not inner arrays.
      for (const entry of body.results) {
        expect(Array.isArray(entry.result.callers)).toBe(true);
        expect(Array.isArray(entry.result.callees)).toBe(true);
      }
    } finally {
      await client.close();
      await server.close();
      closeAllWorkspaceDbs();
      fs.rmSync(secondRoot, { recursive: true, force: true });
    }
  });
});

function toolJson(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

describe("code_outline", () => {
  it("returns symbols and outlineText for an indexed file", async () => {
    const workspace = await createIndexedWorkspace("outline-success", tempRoot);
    const { client, server } = await connectClient(tempRoot);
    try {
      const result = await client.callTool({
        name: "code_outline",
        arguments: { path: "src/target.ts" },
      });
      const body = toolJson(result) as {
        path: string;
        language: string;
        symbols: Array<{ name: string }>;
        outlineText: string;
      };

      expect(body.path).toBe("src/target.ts");
      expect(body.language).toBe("typescript");
      expect(Array.isArray(body.symbols)).toBe(true);
      expect(body.symbols.length).toBeGreaterThan(0);
      expect(body.symbols.map((s) => s.name)).toContain("target");
      expect(body.outlineText).toContain("target");
      expect(await createRegistryRepository().getWorkspace(workspace.id)).not.toBeNull();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns { error, path } when the file is not in the index", async () => {
    await createIndexedWorkspace("outline-missing", tempRoot);
    const { client, server } = await connectClient(tempRoot);
    try {
      const result = await client.callTool({
        name: "code_outline",
        arguments: { path: "src/does-not-exist.ts" },
      });
      const body = toolJson(result) as { error: string; path: string };

      expect(body.error).toBeTruthy();
      expect(body.error).toContain("src/does-not-exist.ts");
      expect(body.path).toBe("src/does-not-exist.ts");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("resolves an explicit workspaceId instead of defaulting to cwd", async () => {
    const workspace = await createIndexedWorkspace("outline-explicit", tempRoot);
    const { client, server } = await connectClient(tempRoot);
    try {
      const result = await client.callTool({
        name: "code_outline",
        arguments: { workspaceId: workspace.id, path: "src/target.ts" },
      });
      const body = toolJson(result) as { path: string; symbols: Array<{ name: string }> };

      expect(body.path).toBe("src/target.ts");
      expect(body.symbols.map((s) => s.name)).toContain("target");
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("remove_workspace", () => {
  it("refuses when confirm is not true", async () => {
    const rootPath = path.join(tempRoot, "victim");
    await createIndexedWorkspace("victim", rootPath);
    const { client } = await connectClient(tempRoot);

    const result = await client.callTool({
      name: "remove_workspace",
      arguments: { workspaceId: "victim" },
    });

    expect(String(toolJson(result).error)).toMatch(/confirm/i);
    expect(await createRegistryRepository().getWorkspace("victim")).not.toBeNull();
    expect(fs.existsSync(path.join(rootPath, ".openez"))).toBe(true);
  });

  it("removes registry entry and .openez dir when confirm is true", async () => {
    const rootPath = path.join(tempRoot, "victim2");
    await createIndexedWorkspace("victim2", rootPath);
    const { client } = await connectClient(tempRoot);

    const result = await client.callTool({
      name: "remove_workspace",
      arguments: { workspaceId: "victim2", confirm: true },
    });

    expect(toolJson(result)).toMatchObject({
      workspaceId: "victim2",
      unregistered: true,
      dataDirRemoved: true,
    });
    expect(await createRegistryRepository().getWorkspace("victim2")).toBeNull();
    expect(fs.existsSync(path.join(rootPath, ".openez"))).toBe(false);
  });

  it("errors without an explicit workspaceId or path", async () => {
    const { client } = await connectClient(tempRoot);

    const result = await client.callTool({
      name: "remove_workspace",
      arguments: { confirm: true },
    });

    expect(toolJson(result).error).toBeTruthy();
  });
});
