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
 * Ruby `calls`/`imports`-edge accuracy harness. Each fixture under
 * `tests/fixtures/ruby-edges/` is indexed through `indexWorkspace`, the graph
 * is built via `ensureGraphReady`, and every observed `calls` edge between
 * symbol nodes and `imports` edge between file nodes is compared against
 * hand-written `expected-edges.json` (`file#symbol` / `file` labels).
 *
 * The suite asserts the exact expected edge sets (TP/FN/FP are also scored
 * and ratcheted against the committed `baseline.json`, which records the
 * pre-implementation counts; `OPENEZ_UPDATE_BASELINE=1` rewrites it). Until
 * the scope-aware Ruby resolver and `.rb`-only import lookup land, the exact
 * assertions fail on the current global/lexical resolution.
 *
 * Each fixture declares a canary edge the current code may or may not already
 * resolve and requires a non-empty graph, so an unbuilt graph cannot pass as
 * empty. When a native binding loads, the whole sequence repeats with
 * `OPENEZ_NATIVE=0` and must yield identical edge sets.
 */

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures", "ruby-edges");

interface ExpectedEdge {
  from: string;
  to: string;
}

interface ExpectedFile {
  canary: { type: "calls" | "imports"; from: string; to: string };
  calls: ExpectedEdge[];
  imports: ExpectedEdge[];
}

interface EdgeCounts {
  truePositives: number;
  falseNegatives: number;
  falsePositives: number;
}

interface Baseline {
  calls: EdgeCounts;
  imports: EdgeCounts;
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
 *  and return the observed edge sets: `file#symbol -> file#symbol` for calls
 *  and `file -> file` for imports. */
async function indexFixtureAndReadEdges(
  fixtureName: string,
): Promise<{ calls: Set<string>; imports: Set<string> }> {
  const fixtureDir = path.join(FIXTURES_DIR, fixtureName);
  const registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-rbedges-reg-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-rbedges-ws-"));
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

  const callRows = await repo.queryRaw(
    `SELECT sf.label AS fromLabel, sf.metadata AS fromMeta,
            st.label AS toLabel, st.metadata AS toMeta
       FROM graph_edges e
       JOIN graph_nodes sf ON sf.id = e.from_node_id
       JOIN graph_nodes st ON st.id = e.to_node_id
      WHERE e.type = 'calls' AND sf.type = 'symbol' AND st.type = 'symbol'`,
  );
  const calls = new Set<string>();
  for (const row of callRows) {
    const fromFile = JSON.parse(row.fromMeta as string).filePath as string;
    const toFile = JSON.parse(row.toMeta as string).filePath as string;
    calls.add(edgeKey(`${fromFile}#${row.fromLabel}`, `${toFile}#${row.toLabel}`));
  }

  const importRows = await repo.queryRaw(
    `SELECT sf.label AS fromLabel, st.label AS toLabel
       FROM graph_edges e
       JOIN graph_nodes sf ON sf.id = e.from_node_id
       JOIN graph_nodes st ON st.id = e.to_node_id
      WHERE e.type = 'imports' AND sf.type = 'file' AND st.type = 'file'`,
  );
  const imports = new Set<string>();
  for (const row of importRows) {
    imports.add(edgeKey(row.fromLabel as string, row.toLabel as string));
  }

  return { calls, imports };
}

function scoreObserved(observed: Set<string>, expected: ExpectedEdge[]): EdgeCounts {
  const counts: EdgeCounts = { truePositives: 0, falseNegatives: 0, falsePositives: 0 };
  const expectedKeys = new Set(expected.map((e) => edgeKey(e.from, e.to)));
  for (const key of expectedKeys) {
    if (observed.has(key)) counts.truePositives += 1;
    else counts.falseNegatives += 1;
  }
  for (const key of observed) {
    if (!expectedKeys.has(key)) counts.falsePositives += 1;
  }
  return counts;
}

describe("ruby edge accuracy", () => {
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
    test(`${fixtureName}: calls/imports edges match the expected sets`, async () => {
      const fixtureDir = path.join(FIXTURES_DIR, fixtureName);
      const expected = JSON.parse(
        fs.readFileSync(path.join(fixtureDir, "expected-edges.json"), "utf8"),
      ) as ExpectedFile;
      const baselinePath = path.join(fixtureDir, "baseline.json");

      const observed = await indexFixtureAndReadEdges(fixtureName);
      const expectedCalls = new Set(expected.calls.map((e) => edgeKey(e.from, e.to)));
      const expectedImports = new Set(expected.imports.map((e) => edgeKey(e.from, e.to)));

      const callCounts = scoreObserved(observed.calls, expected.calls);
      const importCounts = scoreObserved(observed.imports, expected.imports);

      if (updateBaseline) {
        const baseline: Baseline = { calls: callCounts, imports: importCounts };
        fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
      } else {
        const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8")) as Baseline;
        for (const [kind, counts, base] of [
          ["calls", callCounts, baseline.calls],
          ["imports", importCounts, baseline.imports],
        ] as const) {
          expect(
            counts.truePositives,
            `${fixtureName} ${kind} true positives ${counts.truePositives} < baseline ${base.truePositives}`,
          ).toBeGreaterThanOrEqual(base.truePositives);
          expect(
            counts.falsePositives,
            `${fixtureName} ${kind} false positives ${counts.falsePositives} > baseline ${base.falsePositives}`,
          ).toBeLessThanOrEqual(base.falsePositives);
        }
      }

      const canarySet = expected.canary.type === "calls" ? observed.calls : observed.imports;
      const totalExpected = expectedCalls.size + expectedImports.size;
      expect(
        totalExpected > 0 ? observed.calls.size + observed.imports.size : 1,
        "observed edge set is empty",
      ).toBeGreaterThan(0);
      expect(
        canarySet.has(edgeKey(expected.canary.from, expected.canary.to)),
        `canary ${expected.canary.type} edge ${expected.canary.from} -> ${expected.canary.to} was not observed`,
      ).toBe(true);

      // Exact expected edge sets: scope-aware resolution must produce every
      // expected edge and nothing else.
      expect([...observed.calls].sort(), "calls edges differ from expected").toEqual(
        [...expectedCalls].sort(),
      );
      expect([...observed.imports].sort(), "imports edges differ from expected").toEqual(
        [...expectedImports].sort(),
      );

      // When a native binding loads, the fallback path must produce the
      // identical edge sets for this fixture.
      if (resolveNativeParser()) {
        process.env.OPENEZ_NATIVE = "0";
        const observedFallback = await indexFixtureAndReadEdges(fixtureName);
        delete process.env.OPENEZ_NATIVE;
        resetNativeParserCache();
        expect([...observedFallback.calls].sort()).toEqual([...observed.calls].sort());
        expect([...observedFallback.imports].sort()).toEqual([...observed.imports].sort());
      }
    });
  }
});
