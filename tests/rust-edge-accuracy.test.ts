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
import {
  indexWorkspace,
  resetNativeParserCache,
  resolveNativeParser,
} from "../packages/indexer/src/index-workspace";
import { ensureGraphReady } from "../packages/indexer/src/graph-service";
import { rmTempDir } from "./helpers/temp-cleanup";

/**
 * Rust `calls`-edge accuracy harness. Each fixture under
 * `tests/fixtures/rust-edges/` is indexed through `indexWorkspace`, the graph
 * is built via `ensureGraphReady`, and the observed `calls` edges between
 * symbol nodes are compared to the hand-written `expected-edges.json`
 * (`file#symbol` labels). The match is exact: every expected edge must be
 * observed and every observed edge must be expected (TP/FN/FP reported in the
 * failure message), so glob imports, external crates, shadowed locals,
 * unknown receivers, and ambiguous targets all assert FP=0.
 *
 * Each fixture declares a canary edge the current code already resolves and
 * requires a non-empty graph, so an unbuilt graph cannot pass as empty.
 * `symbolCounts` pins exact per-file symbol-node counts (the >30 Rust cap is
 * lifted). When a native binding loads, the whole sequence repeats with
 * `OPENEZ_NATIVE=0` and must yield identical edge sets.
 */

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures", "rust-edges");

interface ExpectedEdge {
  from: string;
  to: string;
}

interface ExpectedFile {
  canary: { from: string; to: string };
  symbolCounts?: Record<string, number>;
  edges: ExpectedEdge[];
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  closeAllWorkspaceDbs();
  closeRegistryDb();
  for (const cleanup of cleanups.splice(0)) cleanup();
  delete process.env.AI_MEMORY_REGISTRY_DB_PATH;
  delete process.env.EMBEDDING_PROVIDER;
  delete process.env.OPENEZ_NATIVE;
  resetNativeParserCache();
});

function edgeKey(from: string, to: string): string {
  return `${from} -> ${to}`;
}

async function indexFixtureAndReadEdges(fixtureName: string): Promise<Set<string>> {
  const fixtureDir = path.join(FIXTURES_DIR, fixtureName);
  const registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-redges-reg-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-redges-ws-"));
  cleanups.push(() => {
    rmTempDir(registryRoot);
    rmTempDir(workspaceRoot);
  });

  process.env.AI_MEMORY_REGISTRY_DB_PATH = path.join(registryRoot, "registry.sqlite");
  process.env.EMBEDDING_PROVIDER = "none";
  closeRegistryDb();
  closeAllWorkspaceDbs();
  resetNativeParserCache();
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

  const expected = JSON.parse(
    fs.readFileSync(path.join(fixtureDir, "expected-edges.json"), "utf8"),
  ) as ExpectedFile;
  for (const [file, count] of Object.entries(expected.symbolCounts ?? {})) {
    const rows = await repo.queryRaw(
      `SELECT count(*) AS c FROM graph_nodes
        WHERE type = 'symbol' AND json_extract(metadata, '$.filePath') = ?`,
      [file],
    );
    expect(Number(rows[0]?.c ?? 0), `symbol node count for ${file} (graph cap regression)`).toBe(
      count,
    );
  }

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

describe("rust edge accuracy", () => {
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

      const expectedKeys = new Set(expected.edges.map((e) => edgeKey(e.from, e.to)));
      const missing = [...expectedKeys].filter((key) => !observed.has(key));
      const unexpected = [...observed].filter((key) => !expectedKeys.has(key));
      const tp = expectedKeys.size - missing.length;
      expect(
        { truePositives: tp, falseNegatives: missing, falsePositives: unexpected },
        `${fixtureName}: TP=${tp} FN=${missing.length} FP=${unexpected.length}`,
      ).toEqual({
        truePositives: expectedKeys.size,
        falseNegatives: [],
        falsePositives: [],
      });

      // When a native binding loads, the fallback path must produce the
      // identical edge set for this fixture.
      if (resolveNativeParser()) {
        process.env.OPENEZ_NATIVE = "0";
        const observedFallback = await indexFixtureAndReadEdges(fixtureName);
        delete process.env.OPENEZ_NATIVE;
        resetNativeParserCache();
        expect([...observedFallback].sort()).toEqual([...observed].sort());
      }
    });
  }
});
