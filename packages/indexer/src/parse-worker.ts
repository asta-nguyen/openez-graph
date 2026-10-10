import { isMainThread, parentPort, workerData } from "node:worker_threads";

import { fastTokenCounter } from "@openez-graph/core";

import { parseSingleTask, type ParseTask } from "./index-workspace";

export type ParseWorkerTask = Omit<ParseTask, "counter">;

/**
 * Worker entry for parallel parsing — spawned by `parseInline` via
 * `node:worker_threads` with a slice of files in `workerData.tasks`.
 *
 * Each file is parsed through `parseSingleTask`, the same function the serial
 * loop uses, so chunk output is identical either way. Indexing always uses
 * `fastTokenCounter` (chars/4 — see indexWorkspace), so the counter is
 * reattached here rather than crossing the worker boundary.
 *
 * One `result` message per file lets the parent merge into its results map
 * and drive progress identically to the serial path. `done` fires once at the
 * end; an uncaught failure posts `error` and lets the process die, which the
 * parent treats as "re-run the rest of this slice serially".
 */
async function runParseWorker(): Promise<void> {
  const { tasks } = workerData as { tasks: ParseWorkerTask[] };
  for (const task of tasks) {
    const result = await parseSingleTask({ ...task, counter: fastTokenCounter });
    parentPort?.postMessage({ type: "result", id: task.id, result });
  }
  parentPort?.postMessage({ type: "done" });
}

if (!isMainThread && parentPort) {
  const port = parentPort;
  runParseWorker().catch((err) => {
    try {
      port.postMessage({
        type: "error",
        message: String(err?.stack ?? err),
      });
    } catch {
      // Parent already gone.
    }
  });
}
