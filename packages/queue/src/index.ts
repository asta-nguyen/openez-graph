import { Job, Queue } from "bullmq";
import IORedis from "ioredis";

import { loadEnv } from "@openez-graph/config";

let connection: IORedis | null = null;
const INDEX_QUEUE_NAME = "index-workspace";
const INDEX_JOB_STATES = ["waiting", "active", "completed", "failed", "delayed"] as const;
const BLOCKING_JOB_STATES = ["waiting", "active", "delayed"] as const;
const CANCEL_KEY_PREFIX = `${INDEX_QUEUE_NAME}:cancel:`;

export type IndexWorkspaceJobData = {
  workspaceId: string;
  mode?: "incremental" | "full";
  jobId: string;
};

export function getRedisConnection(): IORedis {
  if (!connection) {
    const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
    connection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
    });
  }
  return connection;
}

export type IndexJobStatus = {
  jobId: string;
  status: "waiting" | "active" | "completed" | "failed" | "delayed";
  workspaceId: string;
  mode?: string;
  progress?: number;
  progressMessage?: string;
  result?: {
    filesScanned: number;
    filesUpdated: number;
    chunksWritten: number;
    embeddingsWritten: number;
  };
  error?: string;
  cancelRequested: boolean;
  createdAt: Date;
  processedAt?: Date;
};

export type CancelJobResult =
  | { ok: true; jobId: string; status: "cancelled" | "cancellation_requested"; previousStatus: IndexJobStatus["status"] }
  | { ok: false; reason: "not_found" | "not_cancellable"; message: string; status?: string };

export function getIndexQueue(): Queue<IndexWorkspaceJobData> {
  return new Queue<IndexWorkspaceJobData>(INDEX_QUEUE_NAME, {
    connection: getRedisConnection()
  });
}

function getCancelKey(jobId: string): string {
  return `${CANCEL_KEY_PREFIX}${jobId}`;
}

async function serializeJob(job: Job<IndexWorkspaceJobData>): Promise<IndexJobStatus> {
  const state = await job.getState();
  const progress = job.progress;
  const cancelRequested = await isJobCancellationRequested(String(job.id ?? ""));

  return {
    jobId: job.id || "",
    status: state as IndexJobStatus["status"],
    workspaceId: job.data.workspaceId,
    mode: job.data.mode,
    progress: typeof progress === "number" ? progress : undefined,
    progressMessage:
      typeof progress === "object"
        ? (progress as { message?: string })?.message
        : undefined,
    result: job.returnvalue,
    error: job.failedReason,
    cancelRequested,
    createdAt: new Date(job.timestamp || Date.now()),
    processedAt: job.processedOn
      ? new Date(job.processedOn)
      : undefined,
  };
}

async function getWorkspaceJobs(
  workspaceId: string,
  states: readonly ("waiting" | "active" | "completed" | "failed" | "delayed")[]
): Promise<Job<IndexWorkspaceJobData>[]> {
  const queue = getIndexQueue();
  const jobs = await queue.getJobs([...states]);
  return jobs
    .filter((job) => job.data.workspaceId === workspaceId)
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

export async function getJobStatus(workspaceId: string): Promise<IndexJobStatus | null> {
  const workspaceJob = (await getWorkspaceJobs(workspaceId, INDEX_JOB_STATES))[0];
  if (!workspaceJob) {
    return null;
  }
  return serializeJob(workspaceJob);
}

export async function getBlockingJobStatus(workspaceId: string): Promise<IndexJobStatus | null> {
  const blockingJob = (await getWorkspaceJobs(workspaceId, BLOCKING_JOB_STATES))[0];
  if (!blockingJob) {
    return null;
  }
  return serializeJob(blockingJob);
}

export async function getJobStatuses(workspaceId?: string, limit = 20): Promise<IndexJobStatus[]> {
  const queue = getIndexQueue();
  const jobs = await queue.getJobs([...INDEX_JOB_STATES]);
  const filtered = workspaceId
    ? jobs.filter((job) => job.data.workspaceId === workspaceId)
    : jobs;

  const statuses = await Promise.all(
    filtered
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, limit)
      .map((job) => serializeJob(job))
  );

  return statuses;
}

export async function requestJobCancellation(jobId: string): Promise<CancelJobResult> {
  const queue = getIndexQueue();
  const job = await queue.getJob(jobId);

  if (!job) {
    return {
      ok: false,
      reason: "not_found",
      message: `Job '${jobId}' was not found`
    };
  }

  const state = await job.getState();

  if (state === "waiting" || state === "delayed") {
    await clearJobCancellationRequested(jobId);
    await job.remove();
    return {
      ok: true,
      jobId,
      status: "cancelled",
      previousStatus: state as IndexJobStatus["status"]
    };
  }

  if (state === "active") {
    await getRedisConnection().set(getCancelKey(jobId), "1", "EX", 60 * 60 * 24);
    return {
      ok: true,
      jobId,
      status: "cancellation_requested",
      previousStatus: "active"
    };
  }

  return {
    ok: false,
    reason: "not_cancellable",
    message: `Job '${jobId}' is already ${state}`,
    status: state
  };
}

export async function isJobCancellationRequested(jobId: string): Promise<boolean> {
  if (!jobId) {
    return false;
  }
  const value = await getRedisConnection().get(getCancelKey(jobId));
  return value === "1";
}

export async function clearJobCancellationRequested(jobId: string): Promise<void> {
  if (!jobId) {
    return;
  }
  await getRedisConnection().del(getCancelKey(jobId));
}
