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
  it("returns the core diff scope error for ref and staged changes", async () => {
    const { client, server } = await connectClient(tempRoot);
    try {
      const result = await client.callTool({
        name: "diff_context",
        arguments: { ref: "HEAD", staged: true },
      });

      expect(toolJson(result)).toEqual({
        error: "Cannot combine a git ref with staged changes",
        ref: "HEAD",
        staged: true,
      });
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
        formattedSummary: string;
      };
      expect(body.formattedSummary).toContain("caller");
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
