import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { formatDate } from "../../../lib/utils";
import { workspaceQueryOptions, workspaceGraphQueryOptions } from "../../../lib/queries";
import { StatusBadge } from "../../../components/status-badge";
import {
  Button, Card, CardContent, CardHeader, CardTitle,
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@openez-graph/ui";
import {
  ChevronLeft, Layers, Database, FileText, GitBranch, MessageSquare, Clock,
  AlertCircle, AlertTriangle, CheckCircle2, Loader2,
} from "lucide-react";

export const Route = createFileRoute("/workspaces/$workspaceId/")({
  loader: async ({ context, params }) => {
    // Critical: Workspace detail (blocks render)
    await context.queryClient.ensureQueryData(workspaceQueryOptions(params.workspaceId));
    
    // Secondary: Pre-warm Graph data in background
    context.queryClient.prefetchQuery(workspaceGraphQueryOptions(params.workspaceId));
  },
  component: WorkspaceDetailPage,
});

function RunStatusIcon({ status }: { status: string }) {
  if (status === "running") return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
  if (status === "completed") return <CheckCircle2 className="h-4 w-4 text-primary" />;
  if (status === "failed") return <AlertCircle className="h-4 w-4 text-destructive" />;
  return <Clock className="h-4 w-4 text-muted-foreground" />;
}

function formatDuration(start: Date | string, end: Date | string | null | undefined): string {
  if (!end) return "Running...";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return "<1s";
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function WorkspaceDetailPage() {
  const { workspaceId } = useParams({ from: "/workspaces/$workspaceId" });
  const queryClient = useQueryClient();
  const { data: result, isLoading } = useQuery(workspaceQueryOptions(workspaceId));

  const handlePrefetchQuery = () => {
    // Prefetching a POST request is not possible via standard GET prefetch,
    // but we can prefetch the workspace data to ensure the page transitions smoothly.
    queryClient.prefetchQuery(workspaceQueryOptions(workspaceId));
  };

  const handlePrefetchGraph = () => {
    queryClient.prefetchQuery(workspaceGraphQueryOptions(workspaceId));
  };

  if (isLoading) return <div className="page"><p className="muted">Loading...</p></div>;

  if (!result || !result.ok) {
    return (
      <div className="page">
        <Card className="border-destructive">
          <CardContent className="flex flex-col items-center justify-center py-16">
            <AlertTriangle className="h-12 w-12 text-destructive mb-4" />
            <h2 className="text-lg font-medium mb-2">Registry unavailable</h2>
            <p className="muted text-center mb-4 max-w-md">
              Could not open the registry database.
            </p>
            <p className="text-sm text-destructive text-center max-w-md">
              {result && 'error' in result ? (result as { error: string }).error : "Unknown error"}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const workspace = result.data;
  if (!workspace) {
    return (
      <div className="page">
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <h2 className="text-lg font-medium mb-2">Not Found</h2>
            <p className="muted">Workspace not found.</p>
            <Link to="/workspaces" search={{ page: 1 }}><Button variant="secondary" className="mt-4">Back to workspaces</Button></Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  const hasGraphData = workspace.nodeCount > 0 || workspace.edgeCount > 0;

  return (
    <div className="page">
      <div className="flex items-center gap-4 mb-6">
        <Link to="/workspaces" search={{ page: 1 }}>
          <Button variant="ghost" size="icon">
            <ChevronLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1>{workspace.name}</h1>
            <StatusBadge status={workspace.status} />
          </div>
          <p className="muted text-sm">{workspace.rootPath}</p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4 mb-6">
        <Card><CardContent className="p-4">
          <div className="flex items-center gap-3">
            <FileText className="h-5 w-5 text-muted-foreground" />
            <div><p className="text-2xl font-semibold">{workspace.documentCount}</p><p className="text-xs text-muted-foreground">Documents</p></div>
          </div>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <div className="flex items-center gap-3">
            <Layers className="h-5 w-5 text-muted-foreground" />
            <div><p className="text-2xl font-semibold">{workspace.chunkCount}</p><p className="text-xs text-muted-foreground">Chunks</p></div>
          </div>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <div className="flex items-center gap-3">
            <GitBranch className="h-5 w-5 text-muted-foreground" />
            <div><p className="text-2xl font-semibold">{workspace.nodeCount}</p><p className="text-xs text-muted-foreground">Graph Nodes</p></div>
          </div>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <div className="flex items-center gap-3">
            <Database className="h-5 w-5 text-muted-foreground" />
            <div><p className="text-2xl font-semibold">{workspace.edgeCount}</p><p className="text-xs text-muted-foreground">Graph Edges</p></div>
          </div>
        </CardContent></Card>
      </div>

       <div className="flex flex-wrap gap-4 mb-6">
         <Link to="/query" search={{ workspaceId }} onMouseEnter={handlePrefetchQuery}>
           <Button variant="outline"><MessageSquare className="h-4 w-4" /> Try Query</Button>
         </Link>
         {hasGraphData && (
           <Link to="/workspaces/$workspaceId/graph" params={{ workspaceId }} onMouseEnter={handlePrefetchGraph}>
             <Button variant="secondary">Open Graph Explorer</Button>
           </Link>
         )}
       </div>


      <Card className="mb-6">
        <CardHeader className="pb-3"><CardTitle className="text-base">Indexing Control</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">The default local workflow uses the CLI to index a workspace.</p>
          <div className="rounded-md border bg-muted/30 p-3 font-mono text-sm">
            <div>pnpm openez index {workspace.rootPath}</div>
            <div>pnpm openez status {workspace.rootPath}</div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2 mb-6">
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Indexing</CardTitle>
              <StatusBadge status={workspace.indexingStatus} />
            </div>
          </CardHeader>
          <CardContent>
            {workspace.latestIndexRun ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <RunStatusIcon status={workspace.latestIndexRun.status} />
                  <span className="text-sm">{workspace.latestIndexRun.mode} — {workspace.latestIndexRun.status}</span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div><span className="text-muted-foreground">Files scanned:</span> <span className="font-medium">{workspace.latestIndexRun.filesScanned}</span></div>
                  <div><span className="text-muted-foreground">Files updated:</span> <span className="font-medium">{workspace.latestIndexRun.filesUpdated}</span></div>
                  <div><span className="text-muted-foreground">Chunks written:</span> <span className="font-medium">{workspace.latestIndexRun.chunksWritten ?? 0}</span></div>
                  <div><span className="text-muted-foreground">Embeddings:</span> <span className="font-medium">{workspace.latestIndexRun.embeddingsWritten ?? 0}</span></div>
                </div>
                <div className="text-xs text-muted-foreground">
                  Started: {formatDate(workspace.latestIndexRun.startedAt)}
                  {workspace.latestIndexRun.finishedAt && (
                    <> · Duration: {formatDuration(workspace.latestIndexRun.startedAt, workspace.latestIndexRun.finishedAt)}</>
                  )}
                </div>
                {workspace.latestIndexRun.errorMessage && (
                  <p className="text-xs text-destructive">{workspace.latestIndexRun.errorMessage}</p>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No indexing runs yet.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Graph</CardTitle>
              <StatusBadge status={workspace.graphStatus} />
            </div>
          </CardHeader>
          <CardContent>
            {workspace.latestGraphRun ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <RunStatusIcon status={workspace.latestGraphRun.status} />
                  <span className="text-sm">{workspace.latestGraphRun.mode} — {workspace.latestGraphRun.status}</span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div><span className="text-muted-foreground">Nodes:</span> <span className="font-medium">{workspace.latestGraphRun.nodesCreated ?? 0}</span></div>
                  <div><span className="text-muted-foreground">Edges:</span> <span className="font-medium">{workspace.latestGraphRun.edgesCreated ?? 0}</span></div>
                </div>
                <div className="text-xs text-muted-foreground">
                  Started: {formatDate(workspace.latestGraphRun.startedAt)}
                  {workspace.latestGraphRun.finishedAt && (
                    <> · Duration: {formatDuration(workspace.latestGraphRun.startedAt, workspace.latestGraphRun.finishedAt)}</>
                  )}
                </div>
                {workspace.latestGraphRun.errorMessage && (
                  <p className="text-xs text-destructive">{workspace.latestGraphRun.errorMessage}</p>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {workspace.indexingStatus === "completed"
                  ? "Graph data is derived during indexing."
                  : "Index workspace first to populate graph data."}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">Recent Index Runs</CardTitle></CardHeader>
          <CardContent>
            {workspace.recentIndexRuns.length === 0 ? (
              <p className="text-sm text-muted-foreground">No index runs yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Mode</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Files</TableHead>
                    <TableHead>Started</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {workspace.recentIndexRuns.map((run) => (
                    <TableRow key={run.id}>
                      <TableCell>{run.mode}</TableCell>
                      <TableCell><StatusBadge status={run.status} /></TableCell>
                      <TableCell>{run.filesUpdated}/{run.filesScanned}</TableCell>
                      <TableCell className="text-muted-foreground">{formatDate(run.startedAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Recent Graph Runs</CardTitle></CardHeader>
          <CardContent>
            {workspace.recentGraphRuns.length === 0 ? (
              <p className="text-sm text-muted-foreground">No graph runs yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Mode</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Nodes</TableHead>
                    <TableHead>Started</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {workspace.recentGraphRuns.map((run) => (
                    <TableRow key={run.id}>
                      <TableCell>{run.mode}</TableCell>
                      <TableCell><StatusBadge status={run.status} /></TableCell>
                      <TableCell>{run.nodesCreated}</TableCell>
                      <TableCell className="text-muted-foreground">{formatDate(run.startedAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      {workspace.lastError && (
        <Card className="mt-4 border-destructive">
          <CardContent className="p-4">
            <div className="flex items-start gap-2">
              <AlertCircle className="h-4 w-4 text-destructive mt-0.5" />
              <div>
                <p className="text-sm font-medium text-destructive">Last Error</p>
                <p className="text-sm text-muted-foreground">{workspace.lastError}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
