import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  closeAllWorkspaceDbs,
  closeRegistryDb,
  createRegistryRepository,
  createWorkspaceRepository,
} from "../packages/db/src/sqlite";
import { indexWorkspace } from "../packages/indexer/src/index-workspace";
import { ensureGraphReady } from "../packages/indexer/src/graph-service";
import { rmTempDir } from "./helpers/temp-cleanup";

/**
 * JavaScript `calls`-edge accuracy harness. Each fixture under
 * `tests/fixtures/javascript-edges/` is indexed through `indexWorkspace`, the
 * graph is built via `ensureGraphReady`, and the observed `calls` edges
 * between symbol nodes must equal the hand-written `expected-edges.json`
 * (`file#symbol` labels) exactly — zero false positives, zero misses.
 *
 * Each fixture declares a canary edge and requires a non-empty graph, so an
 * unbuilt graph cannot pass as empty.
 */

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures", "javascript-edges");

interface ExpectedEdge {
  from: string;
  to: string;
}

interface ExpectedFile {
  canary: { from: string; to: string };
  edges: ExpectedEdge[];
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  closeAllWorkspaceDbs();
  closeRegistryDb();
  for (const cleanup of cleanups.splice(0)) cleanup();
  delete process.env.AI_MEMORY_REGISTRY_DB_PATH;
  delete process.env.EMBEDDING_PROVIDER;
});

function edgeKey(from: string, to: string): string {
  return `${from} -> ${to}`;
}

/** Index a fresh copy of the fixture into a fresh registry, build the graph,
 *  and return the observed `file#symbol -> file#symbol` calls-edge set. */
async function indexFixtureAndReadEdges(fixtureName: string): Promise<Set<string>> {
  const fixtureDir = path.join(FIXTURES_DIR, fixtureName);
  const registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-jsedges-reg-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-jsedges-ws-"));
  cleanups.push(() => {
    rmTempDir(registryRoot);
    rmTempDir(workspaceRoot);
  });

  process.env.AI_MEMORY_REGISTRY_DB_PATH = path.join(registryRoot, "registry.sqlite");
  process.env.EMBEDDING_PROVIDER = "none";
  closeRegistryDb();
  closeAllWorkspaceDbs();
  fs.cpSync(fixtureDir, workspaceRoot, { recursive: true });

  const workspace = await createRegistryRepository().ensureWorkspace({
    rootPath: workspaceRoot,
  });
  await indexWorkspace({ workspaceId: workspace.id });
  await ensureGraphReady(workspace.id);

  const repo = createWorkspaceRepository(workspaceRoot);
  const symbolRows = await repo.queryRaw(
    "SELECT count(*) AS c FROM graph_nodes WHERE type = 'symbol'",
  );
  expect(
    Number(symbolRows[0]?.c ?? 0),
    "graph has no symbol nodes — the graph was not built",
  ).toBeGreaterThan(0);

  const rows = await repo.queryRaw(
    `SELECT sf.label AS fromLabel, sf.metadata AS fromMeta,
            st.label AS toLabel, st.metadata AS toMeta
       FROM graph_edges e
       JOIN graph_nodes sf ON sf.id = e.from_node_id
       JOIN graph_nodes st ON st.id = e.to_node_id
      WHERE e.type = 'calls' AND sf.type = 'symbol' AND st.type = 'symbol'`,
  );
  const edges = new Set<string>();
  for (const row of rows) {
    const fromFile = JSON.parse(row.fromMeta as string).filePath as string;
    const toFile = JSON.parse(row.toMeta as string).filePath as string;
    edges.add(edgeKey(`${fromFile}#${row.fromLabel}`, `${toFile}#${row.toLabel}`));
  }
  return edges;
}

function expectedEdgeKeys(expected: ExpectedFile): Set<string> {
  return new Set(expected.edges.map((edge) => edgeKey(edge.from, edge.to)));
}

describe("javascript edge accuracy", () => {
  test("edge fixtures are discovered (suite cannot pass vacuously)", () => {
    const fixtureDirs = fs
      .readdirSync(FIXTURES_DIR)
      .filter((entry) => fs.statSync(path.join(FIXTURES_DIR, entry)).isDirectory());
    expect(fixtureDirs.length).toBeGreaterThan(0);
  });

  for (const fixtureName of fs
    .readdirSync(FIXTURES_DIR)
    .filter((entry) => fs.statSync(path.join(FIXTURES_DIR, entry)).isDirectory())
    .sort()) {
    test(`${fixtureName}: calls edges match the expected set exactly`, async () => {
      const fixtureDir = path.join(FIXTURES_DIR, fixtureName);
      const expected = JSON.parse(
        fs.readFileSync(path.join(fixtureDir, "expected-edges.json"), "utf8"),
      ) as ExpectedFile;

      const observed = await indexFixtureAndReadEdges(fixtureName);
      expect(observed.size, "observed calls edge set is empty").toBeGreaterThan(0);
      expect(
        observed.has(edgeKey(expected.canary.from, expected.canary.to)),
        `canary edge ${expected.canary.from} -> ${expected.canary.to} was not observed`,
      ).toBe(true);

      expect(
        [...observed].sort(),
        `${fixtureName} calls edges differ from expected-edges.json`,
      ).toEqual([...expectedEdgeKeys(expected)].sort());
    });
  }
});
