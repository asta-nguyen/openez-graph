import {
  listRegistryWorkspaces,
  getRecentIndexRuns,
} from "../../server/sqlite";
import type { WebRunRow } from "../../server/sqlite";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@openez-graph/ui";
import { Card, CardContent, CardHeader, CardTitle } from "@openez-graph/ui";
import { PAGE_SIZE, Pagination, paginate } from "../../components/pagination";

import { formatDate } from "../../lib/utils";

function getAllIndexRuns(): WebRunRow[] {
  const workspaces = listRegistryWorkspaces();
  const runs: WebRunRow[] = [];
  for (const ws of workspaces) {
    const workspaceRuns = getRecentIndexRuns(ws.rootPath, 100);
    runs.push(...workspaceRuns);
  }
  runs.sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );
  return runs;
}

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { page: pageStr } = await searchParams;
  const allRuns = getAllIndexRuns();
  const totalPages = Math.max(1, Math.ceil(allRuns.length / PAGE_SIZE));
  const currentPage = Math.min(Math.max(1, Number(pageStr) || 1), totalPages);
  const { paged } = paginate(allRuns, currentPage);

  return (
    <div className="page">
      <div>
        <h1>Jobs</h1>
        <p className="muted">Recent indexing activity from `index_runs`.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Index runs</CardTitle>
        </CardHeader>
        <CardContent>
          {allRuns.length > 0 ? (
            <>
              <p className="text-sm text-muted-foreground mb-4">
                Showing {paged.length} of {allRuns.length} runs
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
              <Pagination currentPage={currentPage} totalPages={totalPages} basePath="/jobs" />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No index runs found.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
