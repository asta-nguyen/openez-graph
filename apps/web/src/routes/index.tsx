import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { formatDate } from "../lib/utils";
import { dashboardQueryOptions } from "../lib/queries";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
  Card, CardContent, CardHeader, CardTitle,
} from "@openez-graph/ui";

export const Route = createFileRoute("/")({
  loader: async ({ context }) => {
    // Critical: Dashboard summary
    await context.queryClient.ensureQueryData(dashboardQueryOptions);
  },
  component: OverviewPage,
});


function OverviewPage() {
  const { data: snapshot, isLoading, error } = useQuery(dashboardQueryOptions);

  if (isLoading) return <div className="page"><p className="muted">Loading...</p></div>;
  if (error) return <div className="page"><p className="text-destructive">{error.message}</p></div>;
  if (!snapshot) return null;

  return (
    <div className="page">
      <div>
        <h1>{snapshot.workspace.name}</h1>
        <p className="muted">{snapshot.workspace.root}</p>
      </div>

      <div className="grid cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Index state</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="stat"><span>Documents</span><strong>{snapshot.stats.documents}</strong></div>
            <div className="stat"><span>Chunks</span><strong>{snapshot.stats.chunks}</strong></div>
            <div className="stat"><span>Graph nodes</span><strong>{snapshot.stats.graphNodes}</strong></div>
            <div className="stat"><span>Graph edges</span><strong>{snapshot.stats.graphEdges}</strong></div>
            <div className="stat"><span>Memories</span><strong>{snapshot.stats.memories}</strong></div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Latest runs</CardTitle>
          </CardHeader>
          <CardContent>
            {snapshot.recentRuns.length === 0 ? (
              <p className="muted">No index runs recorded yet.</p>
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
                  {snapshot.recentRuns.map((run) => (
                    <TableRow key={run.id}>
                      <TableCell>{run.mode}</TableCell>
                      <TableCell>{run.status}</TableCell>
                      <TableCell>{run.filesUpdated}/{run.filesScanned}</TableCell>
                      <TableCell>{formatDate(run.startedAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Recent documents</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Path</TableHead>
                  <TableHead>Kind</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {snapshot.recentDocuments.map((doc) => (
                  <TableRow key={doc.id}>
                    <TableCell>{doc.path}</TableCell>
                    <TableCell>{doc.kind}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent memories</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Source</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {snapshot.recentMemories.map((memory) => (
                  <TableRow key={memory.id}>
                    <TableCell>{memory.title}</TableCell>
                    <TableCell>{memory.source}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
