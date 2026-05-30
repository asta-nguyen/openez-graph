// Server component - gets data and renders client component
import Link from "next/link";
import { notFound } from "next/navigation";

import { getWorkspace } from "../../actions";
import { getWorkspaceGraphCached } from "./actions";
import { GraphClient } from "./GraphClient";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle
} from "@openez-graph/ui";
import {
  ChevronLeft
} from "lucide-react";

// Graph data should be fresh per-request
export const dynamic = "force-dynamic";

function StatusBadge({ status }: { status: string }) {
  const variants: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
    pending: "outline",
    running: "secondary",
    completed: "default",
    failed: "destructive"
  };

  return (
    <Badge variant={variants[status] ?? "outline"} className="uppercase">
      {status}
    </Badge>
  );
}

interface PageProps {
  params: Promise<{ workspaceId: string }>;
}

export default async function WorkspaceGraphPage({ params }: PageProps) {
  const { workspaceId } = await params;
  const [workspaceResult, graphData] = await Promise.all([
    getWorkspace(workspaceId),
    getWorkspaceGraphCached(workspaceId)
  ]);

  if (!workspaceResult.ok) {
    return (
      <div className="page">
        <Card className="border-destructive">
          <CardContent className="flex flex-col items-center justify-center py-16">
            <h2 className="text-lg font-medium mb-2">Registry unavailable</h2>
            <p className="muted text-center mb-4 max-w-md">
              Could not open the registry database.
            </p>
            <p className="text-sm text-destructive text-center max-w-md">
              {workspaceResult.error}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const workspace = workspaceResult.data;

  if (!workspace) {
    notFound();
  }

  const hasGraphData = !!graphData && graphData.nodes.length > 0;

  return (
    <div className="h-screen flex flex-col">
      {/* Header */}
      <div className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-4">
            <Link href={`/workspaces/${workspaceId}`}>
              <Button variant="ghost" size="icon">
                <ChevronLeft className="h-4 w-4" />
              </Button>
            </Link>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-semibold">Graph Explorer</h1>
                <Badge variant="outline">{workspace.name}</Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                {graphData ? (
                  <>{graphData.totalNodes.toLocaleString()} nodes · {graphData.totalEdges.toLocaleString()} edges</>
                ) : (
                  <>No graph data</>
                )}
              </p>
            </div>
          </div>

          <StatusBadge status={workspace.graphStatus} />
        </div>
      </div>

      {/* Main content */}
      {!hasGraphData ? (
        <div className="flex-1 flex items-center justify-center">
          <Card className="max-w-md">
            <CardHeader>
              <CardTitle>No Graph Data</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                No graph data was found for this workspace. Index the workspace to extract relationships between files, symbols, and chunks.
              </p>
              <Link href={`/workspaces/${workspaceId}`}>
                <Button variant="secondary">Go to Workspace</Button>
              </Link>
              {workspace.indexingStatus !== "completed" && (
                <p className="text-xs text-muted-foreground">
                  Index the workspace first to enable graph explorer.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      ) : graphData && graphData.nodes.length > 0 ? (
        <GraphClient graphData={graphData} />
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <Card className="max-w-md">
            <CardHeader>
              <CardTitle>Empty Graph</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                No graph data found for this workspace. Try re-indexing the workspace to extract graph relationships.
              </p>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
