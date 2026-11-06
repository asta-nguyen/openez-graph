import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { codeQuery } from "../packages/core/src/retrieval";
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
let workspaceId: string;

beforeEach(() => {
  registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-exact-registry-"));
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-exact-workspace-"));
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

async function index() {
  const workspace = await createRegistryRepository().ensureWorkspace({ rootPath: workspaceRoot });
  workspaceId = workspace.id;
  await indexWorkspace({ workspaceId });
}

const fts = (query: string) =>
  codeQuery({ workspaceId, query, recordMetrics: false, skipGraphExpand: true });
const withGraph = (query: string) =>
  codeQuery({ workspaceId, query, recordMetrics: false, ensureGraph: ensureGraphReady });
const paths = (result: { sources: Array<{ path: string }> }) => result.sources.map((s) => s.path);

// Mentions repeat the other words too, so BM25 alone prefers them to the lone definition.
const QUERY = "ledger report computeLedgerTotal";
const mention = (n: number) =>
  [
    `// ${"computeLedgerTotal ledger report ".repeat(30)}${n}`,
    `export function report${n}() {`,
    `  return "computeLedgerTotal is used by report${n}";`,
    "}",
    "",
  ].join("\n");

describe("exact-symbol stage", () => {
  it("ranks the defining file above files that only mention the identifier", async () => {
    const filler = Array.from({ length: 400 }, (_, i) => `// unrelated filler line ${i}`).join(
      "\n",
    );
    write("defines-target.ts", `${filler}\nexport function computeLedgerTotal() { return 1; }\n`);
    for (const n of [1, 2, 3]) write(`mentions-${n}.ts`, mention(n));
    await index();

    expect(paths(await fts(QUERY))[0]).not.toBe("defines-target.ts");
    expect(paths(await withGraph(QUERY))[0]).toBe("defines-target.ts");
  });

  it("ignores labels carried by more than 5 symbol nodes", async () => {
    for (let n = 1; n <= 7; n++) write(`run-${n}.ts`, `export function run() { return ${n}; }\n`);
    await index();

    const before = paths(await fts("run"));
    expect(paths(await withGraph("run"))).toEqual(before);
  });

  it("resolves :: and . alternates to the same TS member label", async () => {
    write("billing.ts", "export class Billing {\n  total() { return 1; }\n}\n");
    for (const n of [1, 2, 3]) write(`mentions-${n}.ts`, `// Billing total Billing total ${n}\n`);
    await index();

    expect(paths(await withGraph("Billing::total"))[0]).toBe("billing.ts");
    expect(paths(await withGraph("Billing.total"))[0]).toBe("billing.ts");
  });

  it("changes nothing without a graph", async () => {
    write("defines-target.ts", "export function computeLedgerTotal() { return 1; }\n");
    write("mentions-1.ts", mention(1));
    await index();

    const result = await fts(QUERY);
    expect(paths(result)).toEqual(paths(await fts(QUERY)));
    const rows = await createWorkspaceRepository(workspaceRoot).queryRaw(
      "SELECT count(*) AS c FROM graph_nodes",
    );
    expect(Number(rows[0]?.c)).toBe(0);
  });

  it("does not change ranking for a query without matching symbol labels", async () => {
    write("store.ts", "// how are things stored\nexport function persist() {}\n");
    write("other.ts", "// things stored elsewhere\nexport function save() {}\n");
    await index();

    const before = paths(await fts("how are things stored"));
    await withGraph("warm");
    expect(paths(await fts("how are things stored"))).toEqual(before);
  });

  it("ignores a symbol node whose chunk was deleted", async () => {
    write("defines-target.ts", "export function computeLedgerTotal() { return 1; }\n");
    write("mentions-1.ts", mention(1));
    await index();
    await withGraph("warm");
    const repo = createWorkspaceRepository(workspaceRoot);
    await repo.queryRaw("PRAGMA foreign_keys = OFF");
    await repo.queryRaw(
      "DELETE FROM chunks WHERE id IN (SELECT ref_id FROM graph_nodes WHERE label = 'computeLedgerTotal')",
    );
    await repo.queryRaw("PRAGMA foreign_keys = ON");

    expect(paths(await fts(QUERY))).not.toContain("defines-target.ts");
  });

  it("does not boost plain words that equal a symbol label", async () => {
    const filler = Array.from({ length: 5 }, (_, i) => `// notes ${i}`).join("\n");
    write("other.ts", `${filler}\nexport function local() { return 1; }\n`);
    write(
      "hint.ts",
      '// where is the local workspace hint written\nexport function writeHint() { return "local workspace hint written"; }\n',
    );
    await index();

    const query = "where is the local workspace hint written?";
    const before = paths(await fts(query));
    expect(paths(await withGraph(query))).toEqual(before);
  });

  it("does not boost a plain word from a sentence (index)", async () => {
    write("other.ts", "export function index() { return 1; }\n");
    write(
      "hint.ts",
      '// the search index is rebuilt here\nexport function rebuildSearch() { return "search index rebuilt"; }\n',
    );
    await index();

    const query = "how is the search index rebuilt?";
    const before = paths(await fts(query));
    expect(paths(await withGraph(query))).toEqual(before);
  });

  it("still boosts a bare single-word query", async () => {
    write("other.ts", "export function local() { return 1; }\n");
    for (const n of [1, 2, 3])
      write(`m${n}.ts`, `// ${"local ".repeat(30)}\nexport const v${n} = 1;\n`);
    await index();

    expect(paths(await withGraph("local"))[0]).toBe("other.ts");
  });
});
