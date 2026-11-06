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

  it("finds a method by its bare name, in code_query and in relation questions", async () => {
    write("Cargo.toml", '[package]\nname = "demo"\nversion = "0.1.0"\n');
    fs.mkdirSync(path.join(workspaceRoot, "src"));
    write("src/lib.rs", "pub mod client;\npub mod bridge;\n");
    write(
      "src/client.rs",
      "pub struct DaemonClient;\nimpl DaemonClient {\n    pub fn connect_or_spawn() {}\n}\n",
    );
    write(
      "src/bridge.rs",
      "use crate::client::DaemonClient;\npub fn start() {\n    DaemonClient::connect_or_spawn();\n}\n",
    );
    // Mentions the name repeatedly, so plain ranking prefers it to the definition.
    write("notes.md", `# Notes\n\n${"connect_or_spawn ".repeat(30)}\n`);
    await index();

    expect((await query("connect_or_spawn"))[0]).toBe("src/client.rs");
    expect((await query("what calls connect_or_spawn"))[0]).toBe("src/bridge.rs");
  });

  it("counts calls from functions nested inside the symbol", async () => {
    write("cache.ts", "export function upsert() { return 1; }\n");
    write(
      "sync.ts",
      'import { upsert } from "./cache";\n' +
        "export function startSync() {\n  const onEvent = () => upsert();\n  return onEvent;\n}\n",
    );
    await index();

    expect((await query("what does startSync call"))[0]).toBe("cache.ts");
  });

  it("treats a component wrapped in memo or forwardRef as a symbol", async () => {
    write("tone.ts", "export function usageTone() { return 1; }\n");
    write(
      "row.tsx",
      'import { memo } from "react";\nimport { usageTone } from "./tone";\n' +
        "const Row = memo(function Row() {\n  return <b className={String(usageTone())} />;\n});\nexport default Row;\n",
    );
    write(
      "panel.tsx",
      'import { forwardRef, memo } from "react";\nimport { usageTone } from "./tone";\n' +
        "export const Panel = memo(forwardRef(() => <i>{usageTone()}</i>));\n",
    );
    await index();

    const callers = await query("what calls usageTone");
    expect(callers.slice(0, 2).sort()).toEqual(["panel.tsx", "row.tsx"]);
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
