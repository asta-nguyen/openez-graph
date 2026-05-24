import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";

import { updateWorkspaceStatus, syncWorkspaceIndexingState } from "../../../../workspaces/actions";
import { getBlockingJobStatus, getIndexQueue, getJobStatus } from "@openez-graph/queue";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;

  try {
    const status = await getJobStatus(workspaceId);
    if (status?.status === "completed" || status?.status === "failed") {
      await syncWorkspaceIndexingState(workspaceId);
    }
    return NextResponse.json(status);
  } catch (error) {
    console.error("Failed to get job status:", error);
    return NextResponse.json(
      { error: "Failed to get job status" },
      { status: 500 }
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;

  try {
    const body = await request.json().catch(() => ({}));
    const mode = body.mode ?? "incremental";
    const jobId = crypto.randomUUID();
    const existingJob = await getBlockingJobStatus(workspaceId);

    if (existingJob) {
      return NextResponse.json(
        {
          error: `An indexing job is already ${existingJob.status} for workspace '${workspaceId}'`,
          existingJob
        },
        { status: 409 }
      );
    }

    // Update workspace status to indicate indexing is queued
    await updateWorkspaceStatus(workspaceId, {
      indexingStatus: "running",
      status: "indexing",
      lastError: null
    });

    const queue = getIndexQueue();
    await queue.add("index", {
      workspaceId,
      mode,
      jobId
    });

    return NextResponse.json({
      jobId,
      status: "queued"
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    await updateWorkspaceStatus(workspaceId, {
      indexingStatus: "failed",
      status: "error",
      lastError: errorMessage
    });

    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}
