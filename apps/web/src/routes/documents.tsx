import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { documentsQueryOptions } from "../lib/queries";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@openez-graph/ui";
import { PAGE_SIZE, Pagination } from "../lib/pagination";
import { DocumentsDataTable } from "../components/documents/documents-data-table";
import { DocumentsFilters } from "../components/documents/documents-filters";


export const Route = createFileRoute("/documents")({
  loaderDeps: ({ search }) => ({
    workspaceId: search.workspaceId,
    page: search.page,
    search: search.search,
    kind: search.kind,
    language: search.language,
    sortBy: search.sortBy,
    sortDir: (search.sortDir === "asc" || search.sortDir === "desc"
      ? search.sortDir
      : "") as "asc" | "desc" | "",
  }),
  loader: ({ context, deps }) =>
    context.queryClient.ensureQueryData(
      documentsQueryOptions(
        context.workspace?.id ?? "",
        deps.page,
        PAGE_SIZE,
        deps.search ?? "",
        deps.kind ?? "",
        deps.language ?? "",
        deps.sortBy ?? "",
        deps.sortDir,
      ),
    ),
  component: DocumentsPage,
  validateSearch: (search: Record<string, string | undefined>) => ({
    page: Math.max(1, parseInt(search.page ?? "", 10) || 1),
    search: search.search ?? "",
    kind: search.kind ?? "",
    language: search.language ?? "",
    sortBy: search.sortBy ?? "",
    sortDir:
      search.sortDir === "asc" || search.sortDir === "desc"
        ? search.sortDir
        : "",
  }),
});

function DocumentsPage() {
  const queryClient = useQueryClient();
  const { workspaceId } = useSearch({ from: "__root__" });
  const { page: currentPage, search, kind, language, sortBy, sortDir: rawSortDir } =
    useSearch({ from: "/documents" });
  const sortDir: "asc" | "desc" | "" =
    rawSortDir === "asc" || rawSortDir === "desc" ? rawSortDir : "";
  const navigate = useNavigate({ from: "/documents" });
  const { data, isLoading } = useQuery({
    ...documentsQueryOptions(
      workspaceId,
      currentPage,
      PAGE_SIZE,
      search,
      kind,
      language,
      sortBy,
      sortDir,
    ),
    placeholderData: (prev) => prev,
  });

  const totalPages = Math.max(1, Math.ceil((data?.totalCount ?? 0) / PAGE_SIZE));
  const offset = (currentPage - 1) * PAGE_SIZE;
  const end = offset + (data?.items.length ?? 0);

  // Page clamping (Pitfall 4b): when a filter reduces the result set, the
  // current page may exceed totalPages. Clamp after data loads — never during
  // loading (totalCount is 0 then). totalCount === 0 clamps to page 1.
  useEffect(() => {
    if (isLoading) return;
    if (currentPage > totalPages) {
      navigate({
        search: (prev) => ({ ...prev, page: Math.max(1, totalPages) }),
      });
    }
  }, [currentPage, totalPages, isLoading, navigate]);

  useEffect(() => {
    const next = currentPage + 1;
    if (next <= totalPages) {
      queryClient.prefetchQuery(
        documentsQueryOptions(
          workspaceId,
          next,
          PAGE_SIZE,
          search,
          kind,
          language,
          sortBy,
          sortDir,
        ),
      );
    }
  }, [currentPage, totalPages, queryClient, workspaceId, search, kind, language, sortBy, sortDir]);

  const handleFilterChange = (next: { search?: string; kind?: string; language?: string }) => {
    navigate({
      search: (prev) => ({ ...prev, ...next, page: 1 }),
    });
  };

  const handleSortChange = (next: { sortBy: string; sortDir: "asc" | "desc" | "" }) => {
    navigate({
      search: (prev) => ({
        ...prev,
        sortBy: next.sortBy,
        sortDir: next.sortDir,
        page: 1,
      }),
    });
  };

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
              <DocumentsFilters
                currentSearch={search}
                currentKind={kind}
                currentLanguage={language}
                kinds={data?.kinds ?? []}
                languages={data?.languages ?? []}
                onFilterChange={handleFilterChange}
              />
              <p className="text-sm text-muted-foreground mb-4">
                Showing {end} of {data?.totalCount ?? 0} documents
              </p>
              <DocumentsDataTable
                data={data?.items ?? []}
                totalCount={data?.totalCount ?? 0}
                currentPage={currentPage}
                pageSize={PAGE_SIZE}
                workspaceId={workspaceId}
                sortBy={sortBy}
                sortDir={sortDir}
                onSortChange={handleSortChange}
              />
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
