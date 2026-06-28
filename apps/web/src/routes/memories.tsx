import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { MemoryRow } from "../lib/api";
import { memoriesQueryOptions } from "../lib/queries";
import { MemoryDetailPanel } from "../components/memory-detail-panel";
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

export const Route = createFileRoute("/memories")({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(
      memoriesQueryOptions(context.workspace?.id ?? "", 1, PAGE_SIZE),
    ),
  component: MemoriesPage,
  validateSearch: (search: Record<string, string | undefined>) => ({
    page: Math.max(1, parseInt(search.page ?? "", 10) || 1),
  }),
});

function MemoriesPage() {
  const queryClient = useQueryClient();
  const { workspaceId } = useSearch({ from: "__root__" });
  const { page: rawPage } = useSearch({ from: "/memories" });
  const currentPage = Math.max(1, rawPage);
  const [selectedMemory, setSelectedMemory] = useState<MemoryRow | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const { data, isLoading } = useQuery({
    ...memoriesQueryOptions(workspaceId, currentPage, PAGE_SIZE),
    placeholderData: (prev) => prev,
  });

  const totalPages = Math.max(1, Math.ceil((data?.totalCount ?? 0) / PAGE_SIZE));
  const offset = (currentPage - 1) * PAGE_SIZE;
  const end = offset + (data?.items.length ?? 0);

  useEffect(() => {
    const next = currentPage + 1;
    if (next <= totalPages) {
      queryClient.prefetchQuery(
        memoriesQueryOptions(workspaceId, next, PAGE_SIZE),
      );
    }
  }, [currentPage, totalPages, queryClient, workspaceId]);

  return (
    <div className="page">
      <div>
        <h1>Memories</h1>
        <p className="muted">
          Agent-written memories via MCP. View-only — use memory_write to add memories.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Memories</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : (data?.items ?? []).length === 0 ? (
            <p className="muted">No memories recorded yet.</p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground mb-4">
                Showing {end} of {data?.totalCount ?? 0} memories
              </p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Title</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Tags</TableHead>
                    <TableHead>Updated</TableHead>
                    <TableHead>Preview</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(data?.items ?? []).map((memory) => {
                    const preview =
                      memory.content.length > 80
                        ? `${memory.content.slice(0, 80)}…`
                        : memory.content;
                    return (
                      <TableRow
                        key={memory.id}
                        className="cursor-pointer"
                        onClick={() => {
                          setSelectedMemory(memory);
                          setPanelOpen(true);
                        }}
                      >
                        <TableCell>{memory.title}</TableCell>
                        <TableCell>{memory.source}</TableCell>
                        <TableCell>
                          {memory.tags.length > 0
                            ? memory.tags.join(", ")
                            : "—"}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatDate(memory.updatedAt)}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {preview}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              <Pagination
                currentPage={currentPage}
                totalPages={totalPages}
                basePath="/memories"
              />
            </>
          )}
        </CardContent>
      </Card>

      <MemoryDetailPanel
        memory={selectedMemory}
        open={panelOpen}
        onOpenChange={setPanelOpen}
      />
    </div>
  );
}
