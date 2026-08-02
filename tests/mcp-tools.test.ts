import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMcpServer } from "../apps/mcp/src/mcp-core";
import { countTokens } from "../packages/core/src/tokenizer";
import { closeAllWorkspaceDbs, closeRegistryDb, createRegistryRepository, createWorkspaceRepository } from "../packages/db/src/sqlite";
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
  fs.writeFileSync(path.join(rootPath, "src", "target.ts"), "export function target(value: string) { return value.toUpperCase(); }\n");
  fs.writeFileSync(
    path.join(rootPath, "src", "caller.ts"),
    `import { target } from './target';\n${Array.from({ length: 24 }, (_, index) =>
      `export function caller${index || ""}() { return target('hello-${index}'); }`
    ).join("\n")}\n`
  );
  fs.writeFileSync(path.join(rootPath, "README.md"), "# Target workflow\n\nThe caller invokes the target transformation.\n");

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
  const client = new Client({ name: "startup-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: path.join(process.cwd(), "node_modules", ".bin", "tsx"),
    args: ["apps/mcp/src/server.ts", "--path", defaultPath],
    cwd: process.cwd(),
    env: Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    ),
    stderr: "pipe"
  });
  await client.connect(transport);
  await client.close();
}

function textResult(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((item) => item.type === "text");
  if (!text || text.type !== "text") throw new Error("Expected text tool response");
  return text.text ?? "";
}

describe("MCP agent contracts", () => {
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
      await expect(client.callTool({
        name: "code_query",
        arguments: { query: "target", maxTokens: 1 }
      })).rejects.toThrow();
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
        const text = textResult(await client.callTool({
          name: "code_query",
          arguments: { workspaceIds: [first.id, second.id, third.id], query: "target transformation", maxTokens: 300 }
        }));
        const body = JSON.parse(text) as { metrics: { responseTokens: number; tokenBudget: number } };

        expect(countTokens(text)).toBeLessThanOrEqual(300);
        expect(body.metrics).toMatchObject({ responseTokens: countTokens(text), tokenBudget: 300 });
        const firstLog = await createWorkspaceRepository(tempRoot).queryRaw("SELECT tokens_returned FROM query_logs ORDER BY created_at DESC LIMIT 1");
        const secondLog = await createWorkspaceRepository(secondRoot).queryRaw("SELECT tokens_returned FROM query_logs ORDER BY created_at DESC LIMIT 1");
        const thirdLog = await createWorkspaceRepository(thirdRoot).queryRaw("SELECT tokens_returned FROM query_logs ORDER BY created_at DESC LIMIT 1");
        expect(
          Number(firstLog[0]?.tokens_returned)
          + Number(secondLog[0]?.tokens_returned)
          + Number(thirdLog[0]?.tokens_returned)
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
      const text = textResult(await client.callTool({
        name: "graph_neighbors",
        arguments: { label: "target", depth: 2, limit: 20, maxTokens: 500 }
      }));
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
    await createIndexedWorkspace("context", tempRoot);
    const { client, server } = await connectClient(tempRoot);
    try {
      const text = textResult(await client.callTool({
        name: "code_context",
        arguments: { symbolOrPath: "target", maxTokens: 1200 }
      }));
      const body = JSON.parse(text) as {
        results: Array<{ result: { symbol?: { snippet?: string }; callers: Array<{ symbol?: string; path?: string }> } }>;
      };
      const context = body.results[0]?.result;

      expect(context?.symbol?.snippet).toContain("function target");
      expect(context?.callers).toContainEqual(expect.objectContaining({ symbol: "caller", path: "src/caller.ts" }));
      expect(countTokens(text)).toBeLessThanOrEqual(1200);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
