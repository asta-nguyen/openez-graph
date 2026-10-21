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
 * Python `calls`-edge accuracy harness. Each fixture under
 * `tests/fixtures/python-edges/` is indexed through `indexWorkspace`, the
 * graph is built via `ensureGraphReady`, and every observed `calls` edge
 * between symbol nodes is compared EXACTLY against the hand-written
 * `expected-edges.json` (`file#symbol` labels): TP/FN/FP are reported in the
 * failure diff and a mismatch fails — Python never uses the global
 * first-match fallback, so the true edge set is deterministic.
 *
 * Each fixture declares a canary edge that must resolve under both the old
 * and new code paths, so an unbuilt or empty graph cannot pass. When a
 * native binding loads, the whole sequence repeats with `OPENEZ_NATIVE=0`
 * and must yield an identical edge set.
 */

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures", "python-edges");

interface ExpectedEdge {
  from: string;
  to: string;
}

interface ExpectedFile {
  canary: { from: string; to: string };
  edges: ExpectedEdge[];
  counts?: Record<string, { symbols?: number; maxCallsOut?: number }>;
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

async function indexFixtureAndReadGraph(fixtureName: string): Promise<{
  edges: Set<string>;
  repo: ReturnType<typeof createWorkspaceRepository>;
}> {
  const fixtureDir = path.join(FIXTURES_DIR, fixtureName);
  const registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-pyedges-reg-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-pyedges-ws-"));
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
  return { edges, repo };
}

/** Exact-match scoring with a TP/FN/FP summary for failure output. */
function diffObserved(observed: Set<string>, expected: ExpectedFile): string {
  const expectedKeys = expected.edges.map((edge) => edgeKey(edge.from, edge.to));
  const expectedSet = new Set(expectedKeys);
  const missing = expectedKeys.filter((key) => !observed.has(key));
  const extra = [...observed].filter((key) => !expectedSet.has(key));
  return [
    `TP=${expectedKeys.length - missing.length} FN=${missing.length} FP=${extra.length}`,
    ...missing.map((key) => `  missing: ${key}`),
    ...extra.map((key) => `  unexpected: ${key}`),
  ].join("\n");
}

describe("python edge accuracy", () => {
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
    test(`${fixtureName}: calls edges exactly match the expected set`, async () => {
      const fixtureDir = path.join(FIXTURES_DIR, fixtureName);
      const expected = JSON.parse(
        fs.readFileSync(path.join(fixtureDir, "expected-edges.json"), "utf8"),
      ) as ExpectedFile;

      const { edges: observed, repo } = await indexFixtureAndReadGraph(fixtureName);
      expect(observed.size, "observed calls edge set is empty").toBeGreaterThan(0);
      expect(
        observed.has(edgeKey(expected.canary.from, expected.canary.to)),
        `canary edge ${expected.canary.from} -> ${expected.canary.to} was not observed`,
      ).toBe(true);

      const expectedKeys = expected.edges.map((edge) => edgeKey(edge.from, edge.to)).sort();
      expect(
        [...observed].sort(),
        `calls-edge mismatch\n${diffObserved(observed, expected)}`,
      ).toEqual(expectedKeys);

      if (expected.counts) {
        for (const [file, want] of Object.entries(expected.counts)) {
          if (want.symbols !== undefined) {
            const rows = await repo.queryRaw(
              `SELECT count(*) AS c FROM graph_nodes
                WHERE type = 'symbol' AND json_extract(metadata, '$.filePath') = ?`,
              [file],
            );
            expect(Number(rows[0]?.c ?? 0), `${file} symbol node count`).toBe(want.symbols);
          }
          if (want.maxCallsOut !== undefined) {
            const rows = await repo.queryRaw(
              `SELECT count(*) AS c FROM graph_edges e
                JOIN graph_nodes sf ON sf.id = e.from_node_id
               WHERE e.type = 'calls'
                 AND json_extract(sf.metadata, '$.filePath') = ?`,
              [file],
            );
            expect(
              Number(rows[0]?.c ?? 0),
              `${file} outgoing calls edges exceeded the retained cap`,
            ).toBeLessThanOrEqual(want.maxCallsOut);
          }
        }
      }

      // When a native binding loads, the fallback path must produce the
      // identical edge set for this fixture.
      if (resolveNativeParser()) {
        process.env.OPENEZ_NATIVE = "0";
        const { edges: observedFallback } = await indexFixtureAndReadGraph(fixtureName);
        delete process.env.OPENEZ_NATIVE;
        resetNativeParserCache();
        expect(
          [...observedFallback].sort(),
          `fallback edge set differs from native\n${diffObserved(observedFallback, expected)}`,
        ).toEqual([...observed].sort());
      }
    });
  }
});
