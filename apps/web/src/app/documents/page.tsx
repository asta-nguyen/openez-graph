import { getRecentDocuments } from "../../lib/dashboard";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@openez-graph/ui";
import { Card, CardContent, CardHeader, CardTitle } from "@openez-graph/ui";

export default async function DocumentsPage() {
  const documents = await getRecentDocuments();

  return (
    <div className="page">
      <div>
        <h1>Documents</h1>
        <p className="muted">Indexed document inventory ordered by latest update.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Documents</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Path</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Language</TableHead>
                <TableHead>Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {documents.map((document) => (
                <TableRow key={document.id}>
                  <TableCell>{document.path}</TableCell>
                  <TableCell>{document.kind}</TableCell>
                  <TableCell>{document.language ?? "-"}</TableCell>
                  <TableCell>{document.updatedAt ? new Date(document.updatedAt).toISOString() : "-"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}