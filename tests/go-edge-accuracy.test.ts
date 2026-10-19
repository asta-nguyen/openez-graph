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

/**
 * Go `calls`-edge accuracy harness. Each fixture under
 * `tests/fixtures/go-edges/` is indexed through `indexWorkspace`, the graph is
 * built via `ensureGraphReady`, and every observed `calls` edge between symbol
 * nodes is scored against hand-written `expected-edges.json` (`file#symbol`
 * labels): true positives and false negatives per tier (`package`, `type`),
 * false positives overall. Counts are enforced as a ratchet against the
 * committed `baseline.json`; `OPENEZ_UPDATE_BASELINE=1` rewrites it.
 *
 * Each fixture declares a canary edge the current code already resolves and
 * requires a non-empty graph, so an unbuilt graph cannot pass as empty.
 * When a native binding loads, the whole sequence repeats with
 * `OPENEZ_NATIVE=0` and must yield identical edge sets.
 */

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures", "go-edges");
const TIERS = ["package", "type"] as const;
type Tier = (typeof TIERS)[number];

interface ExpectedEdge {
  from: string;
  to: string;
  tier: Tier;
}

interface ExpectedFile {
  canary: { from: string; to: string };
  edges: ExpectedEdge[];
}

interface Baseline {
  truePositives: Record<Tier, number>;
  falseNegatives: Record<Tier, number>;
  falsePositives: number;
}

interface Counts {
  truePositives: Record<Tier, number>;
  falseNegatives: Record<Tier, number>;
  falsePositives: number;
}

const cleanups: Array<() => void> = [];
const updateBaseline = process.env.OPENEZ_UPDATE_BASELINE === "1";

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

/** Index a fresh copy of the fixture into a fresh registry, build the graph,
 *  and return the observed `file#symbol -> file#symbol` calls-edge set. */
async function indexFixtureAndReadEdges(fixtureName: string): Promise<Set<string>> {
  const fixtureDir = path.join(FIXTURES_DIR, fixtureName);
  const registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-edges-reg-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-edges-ws-"));
  cleanups.push(() => {
    fs.rmSync(registryRoot, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
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
  return edges;
}

function scoreObserved(observed: Set<string>, expected: ExpectedFile): Counts {
  const counts: Counts = {
    truePositives: { package: 0, type: 0 },
    falseNegatives: { package: 0, type: 0 },
    falsePositives: 0,
  };
  const expectedKeys = new Map<string, Tier>();
  for (const edge of expected.edges) expectedKeys.set(edgeKey(edge.from, edge.to), edge.tier);
  for (const [key, tier] of expectedKeys) {
    if (observed.has(key)) counts.truePositives[tier] += 1;
    else counts.falseNegatives[tier] += 1;
  }
  for (const key of observed) {
    if (!expectedKeys.has(key)) counts.falsePositives += 1;
  }
  return counts;
}

describe("go edge accuracy", () => {
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
    test(`${fixtureName}: calls edges score at or above the committed baseline`, async () => {
      const fixtureDir = path.join(FIXTURES_DIR, fixtureName);
      const expected = JSON.parse(
        fs.readFileSync(path.join(fixtureDir, "expected-edges.json"), "utf8"),
      ) as ExpectedFile;
      const baselinePath = path.join(fixtureDir, "baseline.json");

      const observed = await indexFixtureAndReadEdges(fixtureName);
      expect(observed.size, "observed calls edge set is empty").toBeGreaterThan(0);
      expect(
        observed.has(edgeKey(expected.canary.from, expected.canary.to)),
        `canary edge ${expected.canary.from} -> ${expected.canary.to} was not observed`,
      ).toBe(true);

      const counts = scoreObserved(observed, expected);

      if (updateBaseline) {
        const baseline: Baseline = {
          truePositives: counts.truePositives,
          falseNegatives: counts.falseNegatives,
          falsePositives: counts.falsePositives,
        };
        fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
      } else {
        const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8")) as Baseline;
        for (const tier of TIERS) {
          expect(
            counts.truePositives[tier],
            `${fixtureName} tier "${tier}" true positives ${counts.truePositives[tier]} < baseline ${baseline.truePositives[tier]}`,
          ).toBeGreaterThanOrEqual(baseline.truePositives[tier]);
        }
        expect(
          counts.falsePositives,
          `${fixtureName} false positives ${counts.falsePositives} > baseline ${baseline.falsePositives}`,
        ).toBeLessThanOrEqual(baseline.falsePositives);
      }

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
