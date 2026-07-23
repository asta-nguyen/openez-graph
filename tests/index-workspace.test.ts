import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeAllWorkspaceDbs, closeRegistryDb, createRegistryRepository, createWorkspaceRepository } from "../packages/db/src/sqlite";
import { indexWorkspace } from "../packages/indexer/src/index-workspace";
import { codeContext } from "../packages/core/src/graph";

let registryRoot: string;
let workspaceRoot: string;

beforeEach(() => {
  registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-index-registry-"));
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-index-workspace-"));
  process.env.AI_MEMORY_REGISTRY_DB_PATH = path.join(registryRoot, "registry.sqlite");
  process.env.EMBEDDING_PROVIDER = "none";
  closeRegistryDb();
  closeAllWorkspaceDbs();
});

afterEach(() => {
  closeAllWorkspaceDbs();
  closeRegistryDb();
  fs.rmSync(registryRoot, { recursive: true, force: true });
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.AI_MEMORY_REGISTRY_DB_PATH;
  delete process.env.EMBEDDING_PROVIDER;
});

describe("indexWorkspace", () => {
  it("removes deleted files and bounds large code chunks", async () => {
    const sourcePath = path.join(workspaceRoot, "large.ts");
    fs.writeFileSync(sourcePath, `export function helper() { return 1; }\nexport function caller() { return large(); }\nexport function large() {\n  helper();\n${"console.log('bounded');\n".repeat(1000)}}`);
    const workspace = await createRegistryRepository().ensureWorkspace({ rootPath: workspaceRoot });

    await indexWorkspace({ workspaceId: workspace.id });
    const repo = createWorkspaceRepository(workspaceRoot);
    const document = await repo.getDocumentByPath("large.ts");
    const chunks = await repo.getChunksByDocument(document!.id);
    expect(chunks.length).toBeGreaterThan(1);
    expect(Math.max(...chunks.map((chunk) => chunk.tokenCount))).toBeLessThanOrEqual(700);

    const context = await codeContext({ workspaceId: workspace.id, symbolOrPath: "large", hops: 1 });
    expect(context.symbol?.label).toBe("large");
    expect(context.callers).toHaveLength(1);
    expect(context.callees).toHaveLength(1);

    await indexWorkspace({ workspaceId: workspace.id, mode: "full" });
    expect(await repo.queryRaw("SELECT status FROM index_runs")).toEqual([{ status: "completed" }]);

    fs.unlinkSync(sourcePath);
    await indexWorkspace({ workspaceId: workspace.id });
    expect(await repo.getDocumentByPath("large.ts")).toBeNull();
    expect(await repo.getChunkCount()).toBe(0);
    expect(await repo.getNodeCount()).toBe(0);
  });
});
