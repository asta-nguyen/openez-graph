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
import { PAGE_SIZE, Pagination } from "../../components/pagination";

export default async function DocumentsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { page: pageStr } = await searchParams;
  const currentPage = Math.max(1, Number(pageStr) || 1);

  const { items, totalCount } = await getRecentDocuments({
    limit: PAGE_SIZE,
    offset: (currentPage - 1) * PAGE_SIZE,
  });
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

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
          <p className="text-sm text-muted-foreground mb-4">
            Showing {items.length} of {totalCount} documents
          </p>
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
              {items.map((document) => (
                <TableRow key={document.id}>
                  <TableCell>{document.path}</TableCell>
                  <TableCell>{document.kind}</TableCell>
                  <TableCell>{document.language ?? "-"}</TableCell>
                  <TableCell>{document.updatedAt ? new Date(document.updatedAt).toISOString() : "-"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pagination currentPage={currentPage} totalPages={totalPages} basePath="/documents" />
        </CardContent>
      </Card>
    </div>
  );
}