import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, TrendingDown } from "lucide-react";
import { api } from "../lib/api";
import { formatDate } from "../lib/utils";
import { dashboardQueryOptions, metricsQueryOptions } from "../lib/queries";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
  Badge, Card, CardContent, CardHeader, CardTitle, buttonVariants,
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
  const { data: metrics } = useQuery(metricsQueryOptions(snapshot?.workspace?.id));

  if (isLoading) return <div className="page"><p className="muted">Loading...</p></div>;
  if (error) return <div className="page"><p className="text-destructive">{error.message}</p></div>;
  if (!snapshot) return null;

  return (
    <div className="page">
      <div>
        <h1>{snapshot.workspace.name}</h1>
        <p className="muted">{snapshot.workspace.root}</p>
      </div>

      <section className="-mx-6 border-y bg-muted/20 px-6 py-5">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <Badge className="mb-3 gap-1.5 bg-emerald-600 text-white hover:bg-emerald-600">
              <CheckCircle2 className="h-3.5 w-3.5" /> Retrieval benchmark passed
            </Badge>
            <h2 className="text-lg font-semibold">Measured retrieval quality</h2>
            <p className="muted mt-1 text-sm">18 queries, 3 iterations, 54 measured runs per mode.</p>
          </div>

          <div className="grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-4">
            <div>
              <div className="text-xs text-muted-foreground">Recall@5</div>
              <div className="mt-1 text-xl font-semibold tabular-nums">94.44%</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">MRR</div>
              <div className="mt-1 text-xl font-semibold tabular-nums">0.6565</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Queries hit</div>
              <div className="mt-1 text-xl font-semibold tabular-nums">17/18</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">FTS average</div>
              <div className="mt-1 text-xl font-semibold tabular-nums">38.68 ms</div>
            </div>
          </div>

          <Link to="/benchmark" className={buttonVariants({ variant: "outline", className: "shrink-0" })}>
            Full benchmark <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>

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

      {metrics && metrics.totalQueries > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingDown className="h-4 w-4 text-emerald-600" />
              Token savings
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-4">
              <div>
                <div className="text-xs text-muted-foreground">Total queries</div>
                <div className="mt-1 text-xl font-semibold tabular-nums">{metrics.totalQueries}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Tokens returned</div>
                <div className="mt-1 text-xl font-semibold tabular-nums">{metrics.totalTokensReturned.toLocaleString()}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Tokens saved</div>
                <div className="mt-1 text-xl font-semibold tabular-nums text-emerald-600">{metrics.totalTokensSaved.toLocaleString()}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Avg tokens/query</div>
                <div className="mt-1 text-xl font-semibold tabular-nums">{metrics.avgTokensPerQuery.toLocaleString()}</div>
              </div>
            </div>
            {metrics.recentQueries.length > 0 && (
              <Table className="mt-4">
                <TableHeader>
                  <TableRow>
                    <TableHead>Query</TableHead>
                    <TableHead>Results</TableHead>
                    <TableHead>Tokens</TableHead>
                    <TableHead>Saved</TableHead>
                    <TableHead>Files</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {metrics.recentQueries.map((q) => (
                    <TableRow key={q.id}>
                      <TableCell className="font-medium max-w-[200px] truncate">{q.query}</TableCell>
                      <TableCell>{q.resultCount}</TableCell>
                      <TableCell>{q.tokensReturned.toLocaleString()}</TableCell>
                      <TableCell className="text-emerald-600">{q.tokensSaved.toLocaleString()}</TableCell>
                      <TableCell>{q.filesScanned}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
