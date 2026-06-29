import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type SortingState,
} from "@tanstack/react-table";
import { useNavigate } from "@tanstack/react-router";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@openez-graph/ui";
import { useMemo } from "react";
import { documentsColumns } from "./documents-columns";
import type { DocumentRow } from "../../lib/api";

interface DocumentsDataTableProps {
  data: DocumentRow[];
  totalCount: number;
  currentPage: number;
  pageSize: number;
  workspaceId?: string;
  sortBy?: string;
  sortDir?: "asc" | "desc" | "";
  onSortChange?: (next: { sortBy: string; sortDir: "asc" | "desc" | "" }) => void;
}

export function DocumentsDataTable({
  data,
  totalCount,
  currentPage,
  pageSize,
  workspaceId,
  sortBy = "",
  sortDir = "",
  onSortChange,
}: DocumentsDataTableProps) {
  const sorting = useMemo<SortingState>(() => {
    if (sortBy && sortDir) {
      return [{ id: sortBy, desc: sortDir === "desc" }];
    }
    return [];
  }, [sortBy, sortDir]);

  const navigate = useNavigate();

  const pageCount = Math.max(1, Math.ceil(totalCount / pageSize));

  const table = useReactTable({
    data,
    columns: documentsColumns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    pageCount,
    state: {
      sorting,
      pagination: { pageIndex: currentPage - 1, pageSize },
    },
  });

  const handleHeaderClick = (columnId: string) => {
    if (!onSortChange) return;
    if (sortBy === columnId) {
      if (sortDir === "asc") {
        onSortChange({ sortBy: columnId, sortDir: "desc" });
      } else if (sortDir === "desc") {
        onSortChange({ sortBy: "", sortDir: "" });
      } else {
        onSortChange({ sortBy: columnId, sortDir: "asc" });
      }
    } else {
      onSortChange({ sortBy: columnId, sortDir: "asc" });
    }
  };

  return (
    <Table>
      <TableHeader>
        {table.getHeaderGroups().map((headerGroup) => (
          <TableRow key={headerGroup.id}>
            {headerGroup.headers.map((header) => {
              const columnId = header.column.id;
              const isSorted = sortBy === columnId;
              const sortIcon = isSorted
                ? sortDir === "asc"
                  ? " ↑"
                  : sortDir === "desc"
                    ? " ↓"
                    : ""
                : "";
              return (
                <TableHead key={header.id}>
                  {header.isPlaceholder ? null : (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 text-left font-medium text-muted-foreground hover:text-foreground transition-colors"
                      onClick={() => handleHeaderClick(columnId)}
                    >
                      {flexRender(
                        header.column.columnDef.header,
                        header.getContext(),
                      )}
                      <span className="text-xs">{sortIcon}</span>
                    </button>
                  )}
                </TableHead>
              );
            })}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {data.length === 0 ? (
          <TableRow>
            <TableCell
              colSpan={documentsColumns.length}
              className="h-24 text-center text-muted-foreground"
            >
              No documents found
            </TableCell>
          </TableRow>
        ) : (
          table.getRowModel().rows.map((row) => {
            const rowContent = row.getVisibleCells().map((cell) => (
              <TableCell key={cell.id}>
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </TableCell>
            ));
            if (workspaceId) {
              return (
                <TableRow
                  key={row.id}
                  className="cursor-pointer"
                  onClick={() =>
                    navigate({
                      to: "/workspaces/$workspaceId/documents/$documentId/chunks",
                      params: {
                        workspaceId,
                        documentId: row.original.id,
                      },
                      search: { page: 1, workspaceId },
                    })
                  }
                >
                  {rowContent}
                </TableRow>
              );
            }
            return <TableRow key={row.id}>{rowContent}</TableRow>;
          })
        )}
      </TableBody>
    </Table>
  );
}
