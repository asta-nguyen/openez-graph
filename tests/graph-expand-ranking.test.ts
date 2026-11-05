import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { codeQuery } from "../packages/core/src/retrieval";
import {
  closeAllWorkspaceDbs,
  closeRegistryDb,
  createRegistryRepository,
} from "../packages/db/src/sqlite";
import { ensureGraphReady } from "../packages/indexer/src/graph-service";
import { indexWorkspace } from "../packages/indexer/src/index-workspace";

let registryRoot: string;
let workspaceRoot: string;

beforeEach(() => {
  registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-expand-registry-"));
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-expand-workspace-"));
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

function write(file: string, content: string) {
  fs.writeFileSync(path.join(workspaceRoot, file), content);
}

async function oneNeighborQuery() {
  write(
    "brain.config.js",
    "export default { retrieval: { vectorLimit: 20, textLimit: 20, graphHops: 1, maxGraphNeighbors: 1, finalLimit: 10, maxContextTokens: 8000 } };\n",
  );
  const workspace = await createRegistryRepository().ensureWorkspace({ rootPath: workspaceRoot });
  await indexWorkspace({ workspaceId: workspace.id });
  const result = await codeQuery({
    workspaceId: workspace.id,
    query: "start",
    recordMetrics: false,
    ensureGraph: ensureGraphReady,
  });
  return result.sources.map((source) => source.path).filter((p) => p !== "seed.ts");
}

describe("graphExpand neighbor ordering", () => {
  it("prefers a leaf neighbor over a high-degree hub", async () => {
    write(
      "seed.ts",
      'import { sharedUtil } from "./hub";\nimport { specificStep } from "./leaf";\n' +
        "export function start() { sharedUtil(); specificStep(); }\n",
    );
    write("hub.ts", "export function sharedUtil() { return 1; }\n");
    write("leaf.ts", "export function specificStep() { return 2; }\n");
    for (let n = 1; n <= 6; n++) {
      write(
        `caller-${n}.ts`,
        `import { sharedUtil } from "./hub";\nexport function use${n}() { return sharedUtil(); }\n`,
      );
    }

    expect(await oneNeighborQuery()).toEqual(["leaf.ts"]);
  });

  it("breaks equal-degree ties by path", async () => {
    write(
      "seed.ts",
      'import { stepB } from "./b-file";\nimport { stepA } from "./a-file";\n' +
        "export function start() { stepB(); stepA(); }\n",
    );
    write("b-file.ts", "export function stepB() { return 1; }\n");
    write("a-file.ts", "export function stepA() { return 2; }\n");

    expect(await oneNeighborQuery()).toEqual(["a-file.ts"]);
    expect(await oneNeighborQuery()).toEqual(["a-file.ts"]);
  });
});
