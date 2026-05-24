import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";

import { createRegistryRepository } from "@openez-graph/db";
import { indexWorkspace } from "@openez-graph/indexer";
import type { IndexWorkspaceJobData } from "@openez-graph/queue";

type IndexWorkspaceJob = IndexWorkspaceJobData;

async function main() {
  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
  const connection = new IORedis(redisUrl, {
    maxRetriesPerRequest: null
  });

  const queue = new Queue<IndexWorkspaceJob>("index-workspace", { connection });

  const worker = new Worker<IndexWorkspaceJob>(
    "index-workspace",
    async (job) => {
      await job.updateProgress({ message: "Starting index...", progress: 0 });

      const result = await indexWorkspace({
        workspaceId: job.data.workspaceId,
        mode: job.data.mode ?? "incremental",
        onProgress: async (progress) => {
          await job.updateProgress(progress);
        }
      });

      return result;
    },
    { connection }
  );

  worker.on("completed", (job) => {
    console.log(`Completed job ${job.id}`);
  });

  worker.on("failed", (job, error) => {
    console.error(`Failed job ${job?.id ?? "unknown"}:`, error);
  });

  await queue.waitUntilReady();
  console.log("Index worker ready. Queue name: index-workspace");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
