import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "../lib/api";
import { documentsQueryOptions } from "../lib/queries";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@openez-graph/ui";
import { formatDate } from "../lib/utils";
import { PAGE_SIZE, Pagination } from "../lib/pagination";


export const Route = createFileRoute("/documents")({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(documentsQueryOptions(1, PAGE_SIZE)),
  component: DocumentsPage,
  validateSearch: (search: Record<string, string | undefined>) => ({
    page: Math.max(1, parseInt(search.page ?? "", 10) || 1),
  }),
});

function DocumentsPage() {
  const queryClient = useQueryClient();
  const { page: currentPage } = useSearch({ from: "/documents" });
  const { data, isLoading } = useQuery({
    ...documentsQueryOptions(currentPage, PAGE_SIZE),
    placeholderData: (prev) => prev,
  });

  const totalPages = Math.max(1, Math.ceil((data?.totalCount ?? 0) / PAGE_SIZE));
  const offset = (currentPage - 1) * PAGE_SIZE;
  const end = offset + (data?.items.length ?? 0);

  useEffect(() => {
    const next = currentPage + 1;
    if (next <= totalPages) {
      queryClient.prefetchQuery(documentsQueryOptions(next, PAGE_SIZE));
    }
  }, [currentPage, totalPages, queryClient]);

  return (
    <div className="page">
      <div>
        <h1>Documents</h1>
        <p className="muted">
          Indexed document inventory ordered by latest update.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Documents</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground mb-4">
                Showing {end} of {data?.totalCount ?? 0} documents
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
                  {(data?.items ?? []).map((document) => (
                    <TableRow key={document.id}>
                      <TableCell>{document.path}</TableCell>
                      <TableCell>{document.kind}</TableCell>
                      <TableCell>{document.language ?? "-"}</TableCell>
                      <TableCell className="text-muted-foreground">{formatDate(document.updatedAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Pagination
                currentPage={currentPage}
                totalPages={totalPages}
                basePath="/documents"
              />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
