import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";

import {
  closeAllWorkspaceDbs,
  closeRegistryDb,
  createRegistryRepository,
  createWorkspaceRepository,
} from "../packages/db/src/sqlite";
import * as embeddings from "../packages/core/src/embeddings";
import { codeQuery } from "../packages/core/src/retrieval";
import { embedWorkspace, indexWorkspace } from "../packages/indexer/src";

const provider = {
  provider: "ollama" as const,
  model: "embed-workspace-test",
  embed: mock(async (texts: string[]) => texts.map(() => [1, 0])),
};
let configuredProvider: typeof provider | null = null;
const getEmbeddingProviderSpy = spyOn(embeddings, "getEmbeddingProvider").mockImplementation(
  async () => configuredProvider,
);

describe("embedWorkspace", () => {
  let registryRoot: string;
  let workspaceRoot: string;

  beforeEach(() => {
    configuredProvider = null;
    provider.embed.mockClear();
    registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-embed-registry-"));
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-embed-workspace-"));
    process.env.AI_MEMORY_REGISTRY_DB_PATH = path.join(registryRoot, "registry.sqlite");
    closeRegistryDb();
    closeAllWorkspaceDbs();
  });

  afterEach(() => {
    closeAllWorkspaceDbs();
    closeRegistryDb();
    fs.rmSync(registryRoot, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    delete process.env.AI_MEMORY_REGISTRY_DB_PATH;
  });

  it("requires an explicit configured provider", async () => {
    fs.writeFileSync(path.join(workspaceRoot, "a.ts"), "export function a() { return 1; }\n");
    const workspace = await createRegistryRepository().ensureWorkspace({ rootPath: workspaceRoot });
    await indexWorkspace({ workspaceId: workspace.id });
    await expect(embedWorkspace({ workspaceId: workspace.id })).rejects.toThrow(
      "No embedding provider configured",
    );
  });

  it("resumes missing chunks without rewriting existing vectors", async () => {
    fs.writeFileSync(path.join(workspaceRoot, "a.ts"), "export function a() { return 1; }\n");
    const workspace = await createRegistryRepository().ensureWorkspace({ rootPath: workspaceRoot });
    configuredProvider = provider;
    await indexWorkspace({ workspaceId: workspace.id });

    const first = await embedWorkspace({ workspaceId: workspace.id });
    const second = await embedWorkspace({ workspaceId: workspace.id });
    const rows = await createWorkspaceRepository(workspaceRoot).queryRaw(
      "SELECT count(*) AS c FROM embeddings",
    );

    expect(first.embeddingsWritten).toBe(first.chunksConsidered);
    expect(second.embeddingsWritten).toBe(0);
    expect(Number(rows[0]?.c ?? 0)).toBe(first.chunksConsidered);
  });

  it("rebuilds only the active provider/model vectors with force", async () => {
    fs.writeFileSync(path.join(workspaceRoot, "a.ts"), "export function a() { return 1; }\n");
    const workspace = await createRegistryRepository().ensureWorkspace({ rootPath: workspaceRoot });
    configuredProvider = provider;
    await indexWorkspace({ workspaceId: workspace.id });
    const first = await embedWorkspace({ workspaceId: workspace.id });

    const forced = await embedWorkspace({ workspaceId: workspace.id, force: true });
    const rows = await createWorkspaceRepository(workspaceRoot).queryRaw(
      "SELECT count(*) AS c FROM embeddings WHERE provider = ?",
      [provider.provider],
    );

    expect(forced.embeddingsWritten).toBe(first.chunksConsidered);
    expect(Number(rows[0]?.c ?? 0)).toBe(first.chunksConsidered);
  });

  it("makes indexed chunks available to vector retrieval after embedding", async () => {
    fs.writeFileSync(
      path.join(workspaceRoot, "semantic.ts"),
      "export function indexed() { return 'stored only in vectors'; }\n",
    );
    const workspace = await createRegistryRepository().ensureWorkspace({ rootPath: workspaceRoot });
    configuredProvider = provider;
    await indexWorkspace({ workspaceId: workspace.id });
    await embedWorkspace({ workspaceId: workspace.id });
    const repo = createWorkspaceRepository(workspaceRoot);
    expect(await repo.fullTextSearch("qzjxk", 5)).toEqual([]);

    const result = await codeQuery({
      workspaceId: workspace.id,
      query: "qzjxk",
      limit: 5,
      skipGraphExpand: true,
    });

    expect(result.sources.map((source) => source.path)).toContain("semantic.ts");
  });
});

afterAll(() => {
  getEmbeddingProviderSpy.mockRestore();
});
