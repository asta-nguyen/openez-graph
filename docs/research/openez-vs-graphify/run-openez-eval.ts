import fs from "node:fs";
import path from "node:path";

import { codeQuery } from "../../../packages/core/src/retrieval";
import {
  evaluateRetrieval,
  parseRetrievalCases,
  summarizeQuality,
} from "../../../packages/indexer/src/retrieval-eval";
import { ensureGraphReady } from "../../../packages/indexer/src";

const EVAL_ROOT = import.meta.dir;
const SUITES = ["concept", "identifiers", "relations", "docs"] as const;

type WorkspaceSpec = { workspaceId: string; evalDir: string };

const workspaces: WorkspaceSpec[] = [
  { workspaceId: "goko", evalDir: path.join(EVAL_ROOT, "eval", "goko") },
  { workspaceId: "wy-ask-api", evalDir: path.join(EVAL_ROOT, "eval", "wy-ask-api") },
  { workspaceId: "wyask-fe", evalDir: path.join(EVAL_ROOT, "eval", "wyask-fe") },
  {
    workspaceId: "openez",
    evalDir: path.resolve(EVAL_ROOT, "../../../tests/fixtures"),
  },
];

function loadSuites(dir: string, forOpenezFixtures: boolean) {
  if (forOpenezFixtures) {
    return {
      concept: parseRetrievalCases(
        JSON.parse(fs.readFileSync(path.join(dir, "retrieval-eval.json"), "utf-8")),
      ),
      identifiers: parseRetrievalCases(
        JSON.parse(fs.readFileSync(path.join(dir, "retrieval-eval-identifiers.json"), "utf-8")),
      ),
      relations: parseRetrievalCases(
        JSON.parse(fs.readFileSync(path.join(dir, "retrieval-eval-relations.json"), "utf-8")),
      ),
      docs: parseRetrievalCases(
        JSON.parse(fs.readFileSync(path.join(dir, "retrieval-eval-docs.json"), "utf-8")),
      ),
    };
  }
  const out: Record<string, ReturnType<typeof parseRetrievalCases>> = {};
  for (const suite of SUITES) {
    const file = path.join(dir, `${suite}.json`);
    if (fs.existsSync(file)) {
      out[suite] = parseRetrievalCases(JSON.parse(fs.readFileSync(file, "utf-8")));
    }
  }
  return out;
}

async function runCase(
  workspaceId: string,
  query: string,
  expectedPaths: string[] | undefined,
  graph: boolean,
) {
  const startedAt = performance.now();
  const result = await codeQuery({
    workspaceId,
    query,
    limit: 10,
    recordMetrics: false,
    ...(graph ? { ensureGraph: ensureGraphReady } : { skipGraphExpand: true as const }),
  });
  const latencyMs = performance.now() - startedAt;
  const sourcePaths = result.sources.map((source) => source.path);
  const quality = evaluateRetrieval(sourcePaths, expectedPaths);
  return { quality, latencyMs, sourcePaths };
}

const report: Record<string, unknown> = {};
for (const ws of workspaces) {
  if (process.env.EVAL_ONLY && ws.workspaceId !== process.env.EVAL_ONLY) continue;
  const suites = loadSuites(ws.evalDir, ws.workspaceId === "openez");
  const wsReport: Record<string, unknown> = {};
  for (const graphMode of [false, true]) {
    const mode = graphMode ? "lexical+graph" : "lexical";
    for (const [suiteName, cases] of Object.entries(suites)) {
      const qualities = [];
      const details = [];
      const latencies: number[] = [];
      // Untimed pass first: builds the lazy graph and warms caches, like a running MCP server.
      for (const item of cases)
        await runCase(ws.workspaceId, item.query, item.expectedPaths, graphMode);
      for (const item of cases) {
        const { quality, latencyMs, sourcePaths } = await runCase(
          ws.workspaceId,
          item.query,
          item.expectedPaths,
          graphMode,
        );
        qualities.push(quality);
        latencies.push(latencyMs);
        details.push({
          query: item.query,
          firstRelevantRank: quality.firstRelevantRank,
          latencyMs,
          top5: sourcePaths.slice(0, 5),
        });
      }
      wsReport[`${mode}/${suiteName}`] = {
        ...summarizeQuality(qualities),
        medianLatencyMs: latencies.sort((a, b) => a - b)[Math.floor(latencies.length / 2)] ?? 0,
        details,
      };
    }
  }
  report[ws.workspaceId] = wsReport;
}

console.log(JSON.stringify(report, null, 2));
