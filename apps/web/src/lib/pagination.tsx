import { Link } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";

export const PAGE_SIZE = 10;

export function paginate<T>(items: T[], currentPage: number): { paged: T[]; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const paged = items.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE
  );
  return { paged, totalPages };
}

interface PaginationProps {
  currentPage: number;
  totalPages: number;
  basePath: string;
}

export function Pagination({ currentPage, totalPages, basePath }: PaginationProps) {
  if (totalPages <= 1) return null;

  return (
    <div className="flex items-center justify-center gap-2 mt-6">
      {currentPage > 1 ? (
        <Link
          to={basePath}
          search={{ page: currentPage - 1 }}
          className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-md border hover:bg-muted transition-colors"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          Previous
        </Link>
      ) : (
        <span className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-md border text-muted-foreground opacity-50 cursor-not-allowed">
          <ChevronLeft className="h-3.5 w-3.5" />
          Previous
        </span>
      )}

      <span className="text-sm text-muted-foreground px-2">
        Page {currentPage} of {totalPages}
      </span>

      {currentPage < totalPages ? (
        <Link
          to={basePath}
          search={{ page: currentPage + 1 }}
          className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-md border hover:bg-muted transition-colors"
        >
          Next
          <ChevronRight className="h-3.5 w-3.5" />
        </Link>
      ) : (
        <span className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-md border text-muted-foreground opacity-50 cursor-not-allowed">
          Next
          <ChevronRight className="h-3.5 w-3.5" />
        </span>
      )}
    </div>
  );
}
