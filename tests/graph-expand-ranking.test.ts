import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { codeQuery, graphExpand } from "../packages/core/src/retrieval";
import {
  closeAllWorkspaceDbs,
  closeRegistryDb,
  createRegistryRepository,
  createWorkspaceRepository,
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

// The single graph neighbor (limit 1) of the `start` symbol in seed.ts.
async function oneNeighborQuery() {
  const workspace = await createRegistryRepository().ensureWorkspace({ rootPath: workspaceRoot });
  await indexWorkspace({ workspaceId: workspace.id });
  await ensureGraphReady(workspace.id);
  const [seed] = await createWorkspaceRepository(workspaceRoot).queryRaw(
    "SELECT ref_id FROM graph_nodes WHERE type = 'symbol' AND label = 'start'",
  );
  const neighbors = await graphExpand(workspaceRoot, [String(seed!.ref_id)], 1, 1);
  return neighbors.map((hit) => hit.path);
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

  it("keeps a document's pre-graph rank when graph neighbors are boosted", async () => {
    // guide.md leads the text ranking; four code files fill the seed slots; helper.ts matches
    // weakly (rank 6) but is called by a seed, so the graph boost lifts it above the guide.
    write("guide.md", `# Ledger settlement guide\n\n${"ledger settlement guide ".repeat(8)}\n`);
    write(
      "c1.ts",
      'import { helperStep } from "./helper";\nexport function c1() { return helperStep() + "ledger settlement ledger settlement"; }\n',
    );
    for (const n of [2, 3, 4]) {
      write(
        `c${n}.ts`,
        `export function c${n}() { return "ledger settlement ledger settlement ${n}"; }\n`,
      );
    }
    write("helper.ts", 'export function helperStep() { return "ledger"; }\n');
    const workspace = await createRegistryRepository().ensureWorkspace({ rootPath: workspaceRoot });
    await indexWorkspace({ workspaceId: workspace.id });
    const run = (graph: boolean) =>
      codeQuery({
        workspaceId: workspace.id,
        query: "ledger settlement guide",
        recordMetrics: false,
        ...(graph ? { ensureGraph: ensureGraphReady } : { skipGraphExpand: true as const }),
      });

    const before = (await run(false)).sources.map((s) => s.path);
    const after = (await run(true)).sources.map((s) => s.path);
    expect(before).toEqual(["guide.md", "c2.ts", "c3.ts", "c4.ts", "c1.ts", "helper.ts"]);
    expect(after[0]).toBe("guide.md");
    expect(after[1]).toBe("helper.ts"); // the graph still lifts code, just not above the guide
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
