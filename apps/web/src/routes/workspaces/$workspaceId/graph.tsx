import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { GraphClient } from "../../../components/graph/GraphClient";
import { StatusBadge } from "../../../components/status-badge";
import { workspaceQueryOptions, workspaceGraphQueryOptions } from "../../../lib/queries";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "@openez-graph/ui";
import { ChevronLeft } from "lucide-react";

export const Route = createFileRoute("/workspaces/$workspaceId/graph")({
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(workspaceQueryOptions(params.workspaceId)),
      context.queryClient.ensureQueryData(workspaceGraphQueryOptions(params.workspaceId)),
    ]);
  },
  component: WorkspaceGraphPage,
});

function WorkspaceGraphPage() {
  const { workspaceId } = useParams({ from: "/workspaces/$workspaceId/graph" });
  const { data: workspaceResult } = useQuery(workspaceQueryOptions(workspaceId));
  const { data: graphData } = useQuery(workspaceGraphQueryOptions(workspaceId));

  if (!workspaceResult?.ok) {
    return (
      <div className="page">
        <Card className="border-destructive">
          <CardContent className="flex flex-col items-center justify-center py-16">
            <h2 className="text-lg font-medium mb-2">Registry unavailable</h2>
          </CardContent>
        </Card>
      </div>
    );
  }

  const workspace = workspaceResult.data;
  if (!workspace) {
    return (
      <div className="page">
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <h2 className="text-lg font-medium mb-2">Not Found</h2>
          </CardContent>
        </Card>
      </div>
    );
  }

  const hasGraphData = !!graphData && graphData.nodes.length > 0;

  return (
    <div className="-m-6 flex h-svh flex-col overflow-hidden bg-[#171717]">
      <div className="z-20 border-b border-white/10 bg-[#202020]/95 backdrop-blur-xl">
        <div className="flex items-center justify-between px-3 py-2">
          <div className="flex items-center gap-4">
            <Link to="/workspaces/$workspaceId" params={{ workspaceId }}>
              <Button variant="ghost" size="icon">
                <ChevronLeft className="h-4 w-4" />
              </Button>
            </Link>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-sm font-semibold">Graph view</h1>
                <Badge variant="outline">{workspace.name}</Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                {graphData ? (
                  <>
                    {graphData.totalNodes.toLocaleString()} nodes ·{" "}
                    {graphData.totalEdges.toLocaleString()} edges
                  </>
                ) : (
                  <>No graph data</>
                )}
              </p>
            </div>
          </div>
          <StatusBadge status={workspace.graphStatus} />
        </div>
      </div>

      {!hasGraphData ? (
        <div className="flex-1 flex items-center justify-center">
          <Card className="max-w-md">
            <CardHeader>
              <CardTitle>No Graph Data</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                No graph data was found for this workspace.
              </p>
              <Link to="/workspaces/$workspaceId" params={{ workspaceId }}>
                <Button variant="secondary">Go to Workspace</Button>
              </Link>
            </CardContent>
          </Card>
        </div>
      ) : graphData && graphData.nodes.length > 0 ? (
        <GraphClient graphData={graphData} />
      ) : null}
    </div>
  );
}
