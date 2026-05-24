import { getDashboardSnapshot } from "../../lib/dashboard";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@openez-graph/ui";
import { Card, CardContent, CardHeader, CardTitle } from "@openez-graph/ui";

export default async function JobsPage() {
  const snapshot = await getDashboardSnapshot();

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
              {snapshot.recentRuns.map((run) => (
                <TableRow key={run.id}>
                  <TableCell>{run.startedAt}</TableCell>
                  <TableCell>{run.mode}</TableCell>
                  <TableCell>{run.status}</TableCell>
                  <TableCell>{run.filesUpdated}</TableCell>
                  <TableCell>{run.errorMessage ?? "-"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
