import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMcpServer } from "../apps/mcp/src/mcp-core";
import { closeRegistryDb, createRegistryRepository } from "../packages/db/src/sqlite";

let registryRoot: string;
let stubServerPath: string;

const STUB_SERVER_CODE = `
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "stub-context7", version: "0.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "resolve-library-id", description: "resolve", inputSchema: { type: "object", properties: { libraryName: { type: "string" } }, required: ["libraryName"] } },
    { name: "query-docs", description: "query", inputSchema: { type: "object", properties: { libraryId: { type: "string" }, topic: { type: "string" }, tokens: { type: "number" } }, required: ["libraryId"] } },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "resolve-library-id") {
    const name = request.params.arguments?.libraryName;
    return { content: [{ type: "text", text: JSON.stringify({ id: "/test/" + name, name: name }) }] };
  }
  if (request.params.name === "query-docs") {
    const id = request.params.arguments?.libraryId;
    return { content: [{ type: "text", text: "# Docs for " + id + "\\n\\nSample documentation." }] };
  }
  return { content: [{ type: "text", text: "unknown" }], isError: true };
});

const transport = new StdioServerTransport();
await server.connect(transport);
`;

// The stub server must live inside the repo tree so Node's ESM module resolution
// can find @modelcontextprotocol/sdk in node_modules. The registry DB stays in
// the OS temp dir (its location is irrelevant to module resolution).
const testDir = path.dirname(fileURLToPath(import.meta.url));

beforeEach(() => {
  registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-context7-e2e-"));
  process.env.AI_MEMORY_REGISTRY_DB_PATH = path.join(registryRoot, "registry.sqlite");
  closeRegistryDb();
  stubServerPath = path.join(testDir, ".stub-context7-e2e-server.mjs");
  fs.writeFileSync(stubServerPath, STUB_SERVER_CODE);
});

afterEach(() => {
  closeRegistryDb();
  fs.rmSync(stubServerPath, { force: true });
  fs.rmSync(registryRoot, { recursive: true, force: true });
  delete process.env.AI_MEMORY_REGISTRY_DB_PATH;
});

async function enableContext7WithStub() {
  const registry = createRegistryRepository();
  await registry.setSetting("context7.enabled", "true");
  await registry.setSetting("context7.cache_ttl_days", "7");
  await registry.setSetting("context7.bin_path", process.execPath);
  await registry.setSetting("context7.bin_args", JSON.stringify([stubServerPath]));
}

async function createClient(): Promise<Client> {
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

describe("library_docs E2E", () => {
  it("returns disabled error when context7 is not enabled", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "library_docs",
      arguments: { library: "react" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("disabled");
  });

  it("fetches docs from Context7 on first call, then hits cache on second", async () => {
    await enableContext7WithStub();
    const client = await createClient();

    // First call → source should be context7
    const result1 = await client.callTool({
      name: "library_docs",
      arguments: { library: "react" },
    });
    const text1 = (result1.content as Array<{ type: string; text: string }>)[0].text;
    const parsed1 = JSON.parse(text1);
    expect(parsed1.source).toBe("context7");
    expect(parsed1.content).toContain("Docs for /test/react");

    // Second call → source should be cache
    const result2 = await client.callTool({
      name: "library_docs",
      arguments: { library: "react" },
    });
    const text2 = (result2.content as Array<{ type: string; text: string }>)[0].text;
    const parsed2 = JSON.parse(text2);
    expect(parsed2.source).toBe("cache");
  });

  it("respects noCache flag", async () => {
    await enableContext7WithStub();
    const client = await createClient();

    // First call to populate cache
    await client.callTool({ name: "library_docs", arguments: { library: "vue" } });

    // Second call with noCache → should be context7 again
    const result = await client.callTool({
      name: "library_docs",
      arguments: { library: "vue", noCache: true },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.source).toBe("context7");
  });
});
