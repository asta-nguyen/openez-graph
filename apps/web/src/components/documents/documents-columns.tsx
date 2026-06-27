import type { ColumnDef } from "@tanstack/react-table";
import { formatDate, formatBytes } from "../../lib/utils";
import type { DocumentRow } from "../../lib/api";

export const documentsColumns: ColumnDef<DocumentRow>[] = [
  {
    accessorKey: "path",
    header: "Path",
    cell: ({ row }) => (
      <span className="font-mono text-sm">{row.original.path}</span>
    ),
    enableSorting: true,
  },
  {
    accessorKey: "kind",
    header: "Kind",
    cell: ({ row }) => <span className="text-sm">{row.original.kind}</span>,
    enableSorting: true,
  },
  {
    accessorKey: "language",
    header: "Language",
    cell: ({ row }) => (
      <span className="text-sm">{row.original.language ?? "-"}</span>
    ),
    enableSorting: true,
  },
  {
    accessorKey: "sizeBytes",
    id: "size",
    header: "Size",
    cell: ({ row }) => (
      <span className="text-sm text-muted-foreground">
        {formatBytes(row.original.sizeBytes)}
      </span>
    ),
    enableSorting: true,
  },
  {
    accessorKey: "chunkCount",
    id: "chunkCount",
    header: "Chunks",
    cell: ({ row }) => (
      <span className="text-sm text-muted-foreground">
        {row.original.chunkCount}
      </span>
    ),
    enableSorting: true,
  },
  {
    accessorKey: "symbolCount",
    id: "symbolCount",
    header: "Symbols",
    cell: ({ row }) => (
      <span className="text-sm text-muted-foreground">
        {row.original.symbolCount}
      </span>
    ),
    enableSorting: true,
  },
  {
    accessorKey: "lastIndexedAt",
    id: "lastIndexed",
    header: "Last Indexed",
    cell: ({ row }) => (
      <span className="text-sm text-muted-foreground">
        {formatDate(row.original.lastIndexedAt ?? row.original.updatedAt)}
      </span>
    ),
    enableSorting: true,
  },
];
