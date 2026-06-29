import { createFileRoute, Link, useParams, useSearch } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useDeferredValue, useEffect, useState, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { documentChunksQueryOptions } from "../../../../../lib/queries";
import type { ChunkRow } from "../../../../../lib/api";
import { Pagination } from "../../../../../lib/pagination";
import { ChunkContent } from "../../../../../components/chunk-content";
import { ChunkBoundaryBar } from "../../../../../components/chunk-boundary-bar";
import { StructuredContentViewer } from "../../../../../components/structured-content-viewer";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Table,
  TableHead,
  TableHeader,
  TableRow,
  ArrowBackIcon,
} from "@openez-graph/ui";

export const CHUNK_PAGE_SIZE = 50;

export const Route = createFileRoute(
  "/workspaces/$workspaceId/documents/$documentId/chunks",
)({
  validateSearch: (search: Record<string, string | undefined>) => ({
    page: Math.max(1, parseInt(search.page ?? "", 10) || 1),
  }),
  loaderDeps: ({ search }) => ({
    page: search.page,
  }),
  loader: ({ context, params, deps }) =>
    context.queryClient.ensureQueryData(
      documentChunksQueryOptions(
        params.workspaceId,
        params.documentId,
        deps.page,
        CHUNK_PAGE_SIZE,
      ),
    ),
  component: ChunkViewerPage,
});

interface ChunkMeta {
  startLine?: number;
  endLine?: number;
  kind?: string;
  language?: string | null;
  symbolName?: string;
  symbolType?: string;
  exported?: boolean;
  fallback?: boolean;
}

function readMeta(chunk: ChunkRow): ChunkMeta {
  const meta = chunk.metadata ?? {};
  const lang = meta.language;
  return {
    startLine: typeof meta.startLine === "number" ? meta.startLine : undefined,
    endLine: typeof meta.endLine === "number" ? meta.endLine : undefined,
    kind: typeof meta.kind === "string" ? meta.kind : undefined,
    language: typeof lang === "string" ? lang : undefined,
    symbolName:
      typeof meta.symbolName === "string" ? meta.symbolName : undefined,
    symbolType:
      typeof meta.symbolType === "string" ? meta.symbolType : undefined,
    exported: typeof meta.exported === "boolean" ? meta.exported : undefined,
    fallback: typeof meta.fallback === "boolean" ? meta.fallback : undefined,
  };
}

function formatLineRange(meta: ChunkMeta): string {
  if (meta.startLine == null || meta.endLine == null) return "—";
  return `${meta.startLine}\u2013${meta.endLine}`;
}

function computeOverlap(current: ChunkMeta, previous: ChunkMeta | null): string {
  if (!previous) return "—";
  if (current.startLine == null || previous.endLine == null) return "—";
  if (current.startLine <= previous.endLine) {
    return `${previous.endLine - current.startLine + 1}`;
  }
  return "—";
}

function isStructuredChunk(chunk: ChunkRow): boolean {
  const meta = readMeta(chunk);
  if (meta.kind === "config") return true;
  const trimmed = chunk.content.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function ChunkViewerPage() {
  const queryClient = useQueryClient();
  const { workspaceId, documentId } = useParams({
    from: "/workspaces/$workspaceId/documents/$documentId/chunks",
  });
  const { page } = useSearch({
    from: "/workspaces/$workspaceId/documents/$documentId/chunks",
  });

  const { data, isLoading } = useQuery({
    ...documentChunksQueryOptions(workspaceId, documentId, page, CHUNK_PAGE_SIZE),
    placeholderData: (prev) => prev,
  });

  const totalPages = Math.max(
    1,
    Math.ceil((data?.totalCount ?? 0) / CHUNK_PAGE_SIZE),
  );

  // Deferred rendering for large chunk lists.
  const deferredItems = useDeferredValue(data?.items ?? []);

  // Track which chunk row is expanded (single-expand for MVP).
  const [expandedChunkId, setExpandedChunkId] = useState<string | null>(null);

  // Virtual scrolling for the chunk table — only renders visible rows.
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: deferredItems.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      // Expanded rows are much taller
      return deferredItems[i]?.id === expandedChunkId ? 400 : 44;
    },
    overscan: 8,
  });

  // Reset expanded state when the page or document changes (plan 05-06).
  useEffect(() => {
    setExpandedChunkId(null);
  }, [page, documentId]);

  // Prefetch the next page for smooth forward pagination.
  useEffect(() => {
    const next = page + 1;
    if (next <= totalPages) {
      queryClient.prefetchQuery(
        documentChunksQueryOptions(workspaceId, documentId, next, CHUNK_PAGE_SIZE),
      );
    }
  }, [page, totalPages, queryClient, workspaceId, documentId]);

  const chunks = deferredItems;
  const hasBoundaryInfo = chunks.some((chunk) => {
    const meta = readMeta(chunk);
    return meta.startLine != null && meta.endLine != null;
  });

  return (
    <div className="page">
      <div className="flex items-center gap-4 mb-6">
        <Link
          to="/documents"
          search={{
            page: 1,
            search: "",
            kind: "",
            language: "",
            sortBy: "",
            sortDir: "",
            workspaceId,
          }}
        >
          <button
            type="button"
            className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-md border hover:bg-muted transition-colors"
            title="Back to Documents"
          >
            <ArrowBackIcon size={14} />
          </button>
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1>Chunk Viewer</h1>
            <Badge variant="secondary">Read-only</Badge>
          </div>
          <p className="muted text-sm">
            document: <code className="text-xs">{documentId}</code>
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Chunks</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground mb-4">
                Showing {chunks.length} of {data?.totalCount ?? 0} chunks
              </p>

              {hasBoundaryInfo && chunks.length > 0 && (
                <div className="mb-4">
                  <p className="text-xs font-medium text-muted-foreground mb-2">
                    Chunk Boundaries
                  </p>
                  <ChunkBoundaryBar
                    chunks={chunks.map((chunk) => ({
                      chunkIndex: chunk.chunkIndex,
                      metadata: readMeta(chunk),
                    }))}
                  />
                </div>
              )}

              {!hasBoundaryInfo && chunks.length > 0 && (
                <p className="text-xs text-muted-foreground mb-4">
                  No boundary info available for this page.
                </p>
              )}

              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-16">#</TableHead>
                    <TableHead>Lines</TableHead>
                    <TableHead className="w-24">Tokens</TableHead>
                    <TableHead className="w-24">Chars</TableHead>
                    <TableHead className="w-24">Overlap</TableHead>
                  </TableRow>
                </TableHeader>
              </Table>

              {chunks.length === 0 ? (
                <p className="text-center text-muted-foreground py-8">
                  No chunks found for this document.
                </p>
              ) : (
                <div ref={scrollRef} className="max-h-[600px] overflow-y-auto border rounded-md">
                  <div
                    style={{
                      height: `${rowVirtualizer.getTotalSize()}px`,
                      width: "100%",
                      position: "relative",
                    }}
                  >
                    {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                      const chunk = chunks[virtualRow.index];
                      const meta = readMeta(chunk);
                      const prevMeta = virtualRow.index > 0 ? readMeta(chunks[virtualRow.index - 1]) : null;
                      const overlap = computeOverlap(meta, prevMeta);
                      const isExpanded = expandedChunkId === chunk.id;

                      return (
                        <div
                          key={chunk.id}
                          style={{
                            position: "absolute",
                            top: 0,
                            left: 0,
                            width: "100%",
                            transform: `translateY(${virtualRow.start}px)`,
                          }}
                        >
                          <div
                            className="grid grid-cols-[64px_1fr_96px_96px_96px] items-center gap-2 px-4 py-2 border-b cursor-pointer hover:bg-muted/30 text-xs font-mono"
                            onClick={() => setExpandedChunkId(isExpanded ? null : chunk.id)}
                          >
                            <span>{chunk.chunkIndex}</span>
                            <span>{formatLineRange(meta)}</span>
                            <span>{chunk.tokenCount}</span>
                            <span>{chunk.content.length}</span>
                            <span>
                              {overlap === "—" ? (
                                <span className="text-muted-foreground">—</span>
                              ) : (
                                <span className="text-amber-600 dark:text-amber-400">
                                  {overlap}
                                </span>
                              )}
                            </span>
                          </div>
                          {isExpanded && (
                            <div className="px-4 py-3 bg-muted/20 border-b">
                              <div className="max-h-96 overflow-y-auto">
                                {isStructuredChunk(chunk) ? (
                                  <StructuredContentViewer
                                    content={chunk.content}
                                    kind={meta.kind ?? "code"}
                                    language={meta.language ?? null}
                                  />
                                ) : (
                                  <ChunkContent
                                    content={chunk.content}
                                    language={meta.language ?? null}
                                    kind={meta.kind ?? "code"}
                                  />
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <Pagination
                currentPage={page}
                totalPages={totalPages}
                basePath="/workspaces/$workspaceId/documents/$documentId/chunks"
                params={{ workspaceId, documentId }}
                extraSearch={{ workspaceId }}
              />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
