import { NextResponse } from "next/server";

import { getJobStatuses } from "@openez-graph/queue";
import { syncWorkspaceIndexingState } from "../../../../workspaces/actions";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;

  try {
    const jobs = await getJobStatuses(workspaceId, 20);
    const latestJob = jobs[0];

    if (latestJob?.status === "completed" || latestJob?.status === "failed") {
      await syncWorkspaceIndexingState(workspaceId);
    }

    return NextResponse.json(jobs);
  } catch (error) {
    console.error("Failed to get job list:", error);
    return NextResponse.json(
      { error: "Failed to get job list" },
      { status: 500 }
    );
  }
}
