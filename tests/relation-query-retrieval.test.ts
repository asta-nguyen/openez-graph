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
let workspaceId: string;

beforeEach(() => {
  registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-relation-registry-"));
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-relation-workspace-"));
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

const query = async (q: string) =>
  (
    await codeQuery({ workspaceId, query: q, recordMetrics: false, ensureGraph: ensureGraphReady })
  ).sources.map((s) => s.path);

// The definition file repeats the name, so plain ranking puts it above the caller.
function writeLedger() {
  write(
    "ledger.ts",
    `// ${"settleLedger ".repeat(20)}\nimport { roundCents } from "./money";\n` +
      "export function settleLedger() { return roundCents(1); }\n",
  );
  write("money.ts", "export function roundCents(n: number) { return n; }\n");
  write(
    "checkout.ts",
    'import { settleLedger } from "./ledger";\nexport function checkout() { return settleLedger(); }\n',
  );
}

describe("relation queries", () => {
  it("puts callers first for 'what calls X'", async () => {
    writeLedger();
    await index();

    expect((await query("what calls settleLedger"))[0]).toBe("checkout.ts");
    expect((await query("who calls settleLedger?"))[0]).toBe("checkout.ts");
  });

  it("puts callees first for 'what does X call'", async () => {
    writeLedger();
    await index();

    expect((await query("what does settleLedger call"))[0]).toBe("money.ts");
  });

  it("leaves ranking alone when the symbol name is not unique", async () => {
    writeLedger();
    write(
      "ledger-copy.ts",
      'import { checkout } from "./checkout";\nexport function settleLedger() { return checkout(); }\n',
    );
    await index();

    const ranked = await query("what calls settleLedger");
    expect(ranked[0]).not.toBe("checkout.ts");
  });

  it("leaves ordinary queries alone", async () => {
    writeLedger();
    await index();

    const plain = await codeQuery({
      workspaceId,
      query: "settleLedger",
      recordMetrics: false,
      ensureGraph: ensureGraphReady,
    });
    expect(plain.sources[0]?.path).toBe("ledger.ts");
  });
});
