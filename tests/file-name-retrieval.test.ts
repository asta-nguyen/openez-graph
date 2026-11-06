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
import { indexWorkspace } from "../packages/indexer/src/index-workspace";

let registryRoot: string;
let workspaceRoot: string;
let workspaceId: string;

beforeEach(() => {
  registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-filename-registry-"));
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-filename-workspace-"));
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
  fs.mkdirSync(path.dirname(path.join(workspaceRoot, file)), { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, file), content);
}

async function ranked(query: string) {
  const workspace = await createRegistryRepository().ensureWorkspace({ rootPath: workspaceRoot });
  workspaceId = workspace.id;
  await indexWorkspace({ workspaceId });
  const result = await codeQuery({
    workspaceId,
    query,
    recordMetrics: false,
    skipGraphExpand: true,
  });
  return result.sources.map((source) => source.path);
}

// Files whose text repeats the question's words, so plain FTS prefers them to the answer.
function writeNoise(words = "react query client configured") {
  for (const n of [1, 2, 3, 4]) {
    write(
      `components/Widget${n}.tsx`,
      `export function Widget${n}() { return "${`${words} `.repeat(6)}"; }\n`,
    );
  }
}

describe("file name stage", () => {
  it("ranks a file named after the question's words first", async () => {
    writeNoise();
    write("lib/query/queryClient.ts", "export function makeClient() { return new Map(); }\n");

    expect((await ranked("where is the React Query client configured?"))[0]).toBe(
      "lib/query/queryClient.ts",
    );
  });

  it("matches word stems and prefixes across the file name", async () => {
    writeNoise("where authentication state provided react client app");
    write("providers/AuthProvider.tsx", "export function Shell() { return null; }\n");

    expect((await ranked("where is authentication state provided to the react client"))[0]).toBe(
      "providers/AuthProvider.tsx",
    );
  });

  it("counts a common file name only when its directory matches too", async () => {
    for (const dir of ["home", "about", "pricing", "settings", "account", "blog", "checkout"]) {
      write(`app/${dir}/page.tsx`, `export default function Page() { return "${dir} page"; }\n`);
    }

    const results = await ranked("where is the checkout page");
    expect(results[0]).toBe("app/checkout/page.tsx");
  });

  it("leaves ranking alone when no file name matches", async () => {
    writeNoise();
    write("lib/query/queryClient.ts", "export function makeClient() { return new Map(); }\n");

    const results = await ranked("where are widgets rendered");
    expect(results).not.toContain("lib/query/queryClient.ts");
  });
});
