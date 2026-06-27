import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { Command } from "commander";

import { getBrainSettings } from "@openez-graph/config";
import { countTokens, memoryQuery } from "@openez-graph/core";
import { createRegistryRepository } from "@openez-graph/db";
import { indexWorkspace } from "@openez-graph/indexer";

const program = new Command();
const DEFAULT_BENCHMARK_QUERIES = [
  "where is workspace indexing implemented?",
  "how does the retrieval pipeline work?",
  "how does memoryQuery work?",
  "what starts the queue worker?",
  "where is the MCP server implemented?"
] as const;

interface BenchmarkRun {
  query: string;
  latencyMs: number;
  contextTokens: number;
  sourceCount: number;
  sourcePaths: string[];
}

async function resolveWorkspaceByPath(targetPath?: string): Promise<string> {
  const registry = createRegistryRepository();
  const resolvedPath = targetPath ? path.resolve(targetPath) : process.cwd();
  const workspace = await registry.getWorkspaceByPath(resolvedPath);
  if (workspace) return workspace.id;

  const all = await registry.listWorkspaces();
  if (all.length === 1) return all[0].id;

  throw new Error(
    "Workspace not found. Run 'brain init <path>' or pass --workspace flag."
  );
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index] ?? 0;
}

async function loadBenchmarkQueries(inputPath?: string): Promise<string[]> {
  if (!inputPath) return [...DEFAULT_BENCHMARK_QUERIES];

  const content = await fs.readFile(inputPath, "utf8");
  const parsed = JSON.parse(content) as unknown;

  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string" && item.trim().length > 0)) {
    throw new Error("Benchmark input file must be a JSON array of non-empty strings.");
  }

  return parsed;
}

program
  .name("brain-legacy")
  .description("OpenEZ Graph indexing CLI (legacy)")
  .option("-w, --workspace <workspaceId>", "workspace id")
  .option("-p, --path <path>", "workspace path");

program
  .command("index")
  .description("Run incremental indexing for a workspace")
  .action(async (_, command) => {
    const opts = command.parent?.opts() ?? {};
    const workspaceId = opts.workspace || await resolveWorkspaceByPath(opts.path);
    try {
      const summary = await indexWorkspace({ workspaceId, mode: "incremental" });
      console.log(JSON.stringify(summary, null, 2));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program
  .command("reindex")
  .description("Run a full reindex for a workspace")
  .action(async (_, command) => {
    const opts = command.parent?.opts() ?? {};
    const workspaceId = opts.workspace || await resolveWorkspaceByPath(opts.path);
    try {
      const summary = await indexWorkspace({ workspaceId, mode: "full" });
      console.log(JSON.stringify(summary, null, 2));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program
  .command("benchmark-query")
  .description("Benchmark retrieval latency, context size, and source counts for memory_query")
  .option("-i, --input <path>", "path to a JSON file containing an array of query strings")
  .option("-o, --output <path>", "write the benchmark report to a JSON file")
  .option("--iterations <count>", "run each query multiple times", "1")
  .option("--limit <count>", "override memory_query final result limit")
  .option("--max-tokens <count>", "override memory_query max context tokens")
  .action(async (options, command) => {
    const opts = command.parent?.opts() ?? {};
    const workspaceId = opts.workspace || await resolveWorkspaceByPath(opts.path);
    const iterations = Number.parseInt(String(options.iterations), 10);
    const limit = options.limit == null ? undefined : Number.parseInt(String(options.limit), 10);
    const maxTokens = options.maxTokens == null ? undefined : Number.parseInt(String(options.maxTokens), 10);

    if (!Number.isInteger(iterations) || iterations <= 0) {
      throw new Error("--iterations must be a positive integer.");
    }

    if (limit != null && (!Number.isInteger(limit) || limit <= 0)) {
      throw new Error("--limit must be a positive integer.");
    }

    if (maxTokens != null && (!Number.isInteger(maxTokens) || maxTokens <= 0)) {
      throw new Error("--max-tokens must be a positive integer.");
    }

    try {
      const queries = await loadBenchmarkQueries(options.input);
      const runs: BenchmarkRun[] = [];

      for (let iteration = 0; iteration < iterations; iteration += 1) {
        for (const query of queries) {
          const startedAt = performance.now();
          const result = await memoryQuery({ workspaceId, query, limit, maxTokens });
          const latencyMs = performance.now() - startedAt;

          runs.push({
            query,
            latencyMs,
            contextTokens: countTokens(result.answerContext),
            sourceCount: result.sources.length,
            sourcePaths: result.sources.map((source) => source.path)
          });
        }
      }

      const latencyValues = runs.map((run) => run.latencyMs);
      const tokenValues = runs.map((run) => run.contextTokens);
      const sourceCountValues = runs.map((run) => run.sourceCount);

      const report = {
        workspaceId,
        queryCount: queries.length,
        iterations,
        totalRuns: runs.length,
        options: { limit: limit ?? null, maxTokens: maxTokens ?? null, input: options.input ?? null },
        summary: {
          latencyMs: {
            min: latencyValues.length === 0 ? 0 : Math.min(...latencyValues),
            avg: latencyValues.length === 0 ? 0 : latencyValues.reduce((sum, value) => sum + value, 0) / latencyValues.length,
            p50: percentile(latencyValues, 0.5),
            p95: percentile(latencyValues, 0.95),
            max: latencyValues.length === 0 ? 0 : Math.max(...latencyValues)
          },
          contextTokens: {
            min: tokenValues.length === 0 ? 0 : Math.min(...tokenValues),
            avg: tokenValues.length === 0 ? 0 : tokenValues.reduce((sum, value) => sum + value, 0) / tokenValues.length,
            p50: percentile(tokenValues, 0.5),
            p95: percentile(tokenValues, 0.95),
            max: tokenValues.length === 0 ? 0 : Math.max(...tokenValues)
          },
          sourceCount: {
            min: sourceCountValues.length === 0 ? 0 : Math.min(...sourceCountValues),
            avg: sourceCountValues.length === 0 ? 0 : sourceCountValues.reduce((sum, value) => sum + value, 0) / sourceCountValues.length,
            p50: percentile(sourceCountValues, 0.5),
            p95: percentile(sourceCountValues, 0.95),
            max: sourceCountValues.length === 0 ? 0 : Math.max(...sourceCountValues)
          }
        },
        runs
      };

      if (options.output) {
        await fs.writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      }

      console.log(JSON.stringify(report, null, 2));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program.parseAsync(process.argv);
