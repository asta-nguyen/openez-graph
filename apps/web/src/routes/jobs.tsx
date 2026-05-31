import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { formatDate } from "../lib/utils";
import { jobsQueryOptions } from "../lib/queries";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
  Card, CardContent, CardHeader, CardTitle,
} from "@openez-graph/ui";
import { PAGE_SIZE, Pagination, paginate } from "../lib/pagination";

export const Route = createFileRoute("/jobs")({
  loader: ({ context }) => context.queryClient.ensureQueryData(jobsQueryOptions),
  component: JobsPage,
  validateSearch: (search: Record<string, string | undefined>) => ({
    page: Math.max(1, parseInt(search.page ?? "", 10) || 1),
  }),
});

function JobsPage() {
  const { page: currentPage } = useSearch({ from: "/jobs" });
  const { data: allRuns, isLoading } = useQuery(jobsQueryOptions);

  const runs = allRuns ?? [];
  const totalPages = Math.max(1, Math.ceil(runs.length / PAGE_SIZE));
  const safePage = Math.min(currentPage, totalPages);
  const { paged } = paginate(runs, safePage);

  return (
    <div className="page">
      <div>
        <h1>Jobs</h1>
        <p className="muted">Recent indexing activity from `index_runs`.</p>
      </div>

      <Card>
        <CardHeader><CardTitle>Index runs</CardTitle></CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : runs.length > 0 ? (
            <>
              <p className="text-sm text-muted-foreground mb-4">
                Showing {paged.length} of {runs.length} runs
              </p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Started</TableHead>
                    <TableHead>Mode</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Updated files</TableHead>
                    <TableHead>Error</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paged.map((run) => (
                    <TableRow key={run.id}>
                      <TableCell>{formatDate(run.startedAt)}</TableCell>
                      <TableCell>{run.mode}</TableCell>
                      <TableCell>{run.status}</TableCell>
                      <TableCell>{run.filesUpdated}</TableCell>
                      <TableCell>{run.errorMessage ?? "-"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Pagination currentPage={safePage} totalPages={totalPages} basePath="/jobs" />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No index runs found.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
