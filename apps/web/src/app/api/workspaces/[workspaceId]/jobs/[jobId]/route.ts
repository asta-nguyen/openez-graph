import { NextResponse } from "next/server";

import { requestJobCancellation } from "@openez-graph/queue";
import { syncWorkspaceIndexingState, updateWorkspaceStatus } from "../../../../../workspaces/actions";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string; jobId: string }> }
) {
  const { workspaceId, jobId } = await params;

  try {
    const result = await requestJobCancellation(jobId);

    if (!result.ok) {
      const status = result.reason === "not_found" ? 404 : 409;
      return NextResponse.json({ error: result.message }, { status });
    }

    if (result.status === "cancelled") {
      await updateWorkspaceStatus(workspaceId, {
        indexingStatus: "pending",
        status: "pending",
        lastError: null
      });
    } else {
      await updateWorkspaceStatus(workspaceId, {
        indexingStatus: "running",
        status: "indexing"
      });
    }

    await syncWorkspaceIndexingState(workspaceId);

    return NextResponse.json(result);
  } catch (error) {
    console.error("Failed to cancel job:", error);
    return NextResponse.json(
      { error: "Failed to cancel job" },
      { status: 500 }
    );
  }
}
