import { createFileRoute, Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useDeferredValue, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  ArrowBackIcon,
  MagnifierIcon,
} from "@openez-graph/ui";
import { PAGE_SIZE, Pagination } from "../../../lib/pagination";
import {
  workspaceQueryOptions,
  workspaceSymbolsQueryOptions,
} from "../../../lib/queries";
import { SYMBOL_TYPES, NODE_TYPES } from "../../../lib/constants";

const FALLBACK_TYPES = [...SYMBOL_TYPES];

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const Route = createFileRoute("/workspaces/$workspaceId/symbols")({
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(
        workspaceQueryOptions(params.workspaceId),
      ),
      context.queryClient.ensureQueryData(
        workspaceSymbolsQueryOptions(params.workspaceId, NODE_TYPES.SYMBOL, 1, PAGE_SIZE, ""),
      ),
    ]);
  },
  validateSearch: (search: Record<string, string | undefined>) => ({
    type: search.type ?? NODE_TYPES.SYMBOL,
    page: Math.max(1, parseInt(search.page ?? "", 10) || 1),
    q: search.q ?? "",
  }),
  component: SymbolBrowserPage,
});

function SymbolBrowserPage() {
  const { workspaceId } = useParams({ from: "/workspaces/$workspaceId/symbols" });
  const { type: activeType, page: currentPage, q } = useSearch({ from: "/workspaces/$workspaceId/symbols" });
  const navigate = useNavigate();

  const [searchInput, setSearchInput] = useState(q);
  const deferredQuery = useDeferredValue(searchInput);

  useEffect(() => {
    if (deferredQuery === q) return;
    navigate({
      to: "/workspaces/$workspaceId/symbols",
      params: { workspaceId },
      search: { workspaceId, type: activeType, page: 1, q: deferredQuery },
    });
  }, [deferredQuery, navigate, workspaceId, activeType, q]);

  const { data: workspaceResult } = useQuery(workspaceQueryOptions(workspaceId));
  const { data, isLoading } = useQuery({
    ...workspaceSymbolsQueryOptions(workspaceId, activeType, currentPage, PAGE_SIZE, q),
    placeholderData: (prev) => prev,
  });

  const types = data?.types ?? FALLBACK_TYPES;
  const totalPages = Math.max(1, Math.ceil((data?.totalCount ?? 0) / PAGE_SIZE));
  const offset = (currentPage - 1) * PAGE_SIZE;
  const end = offset + (data?.items.length ?? 0);

  const workspace = workspaceResult?.ok ? workspaceResult.data : null;
  const isSearching = q.length > 0;

  return (
    <div className="page">
      <div className="flex items-center gap-4 mb-4">
        <Link to="/workspaces/$workspaceId" params={{ workspaceId }} search={{ workspaceId }}>
          <Button variant="ghost" size="icon">
            <ArrowBackIcon size={16} />
          </Button>
        </Link>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold">Symbols</h1>
            {workspace && <Badge variant="outline">{workspace.name}</Badge>}
          </div>
          <p className="text-xs text-muted-foreground">
            Browse indexed symbols grouped by type.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        {types.map((t) => (
          <Link
            key={t}
            to="/workspaces/$workspaceId/symbols"
            params={{ workspaceId }}
            search={{ workspaceId, type: t, page: 1, q }}
          >
            <Button variant={activeType === t ? "default" : "outline"} size="sm">
              {capitalize(t)}
            </Button>
          </Link>
        ))}
      </div>

      <div className="relative mb-4 max-w-sm">
        <MagnifierIcon size={16} className="absolute left-2.5 top-2.5 text-muted-foreground" />
        <Input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search symbols..."
          className="pl-8"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{capitalize(activeType)} Symbols</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : (data?.items ?? []).length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12">
              <p className="text-sm text-muted-foreground">
                {isSearching
                  ? `No symbols matching '${q}' found in this workspace.`
                  : `No symbols of type '${activeType}' found in this workspace.`}
              </p>
            </div>
          ) : (
            <>
              <p className="text-sm text-muted-foreground mb-4">
                {isSearching
                  ? `Showing ${end} of ${data?.totalCount ?? 0} symbols matching '${q}'`
                  : `Showing ${end} of ${data?.totalCount ?? 0} symbols`}
              </p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>File</TableHead>
                    <TableHead>Line</TableHead>
                    <TableHead>Signature</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(data?.items ?? []).map((symbol) => {
                    const lineText =
                      symbol.startLine != null && symbol.endLine != null && symbol.startLine !== symbol.endLine
                        ? `${symbol.startLine}\u2013${symbol.endLine}`
                        : symbol.startLine != null
                          ? `${symbol.startLine}`
                          : "\u2014";
                    const clickable = !!symbol.refId;
                    const rowContent = (
                      <>
                        <TableCell>{symbol.label}</TableCell>
                        <TableCell>
                          <Badge variant="outline">{capitalize(symbol.type)}</Badge>
                        </TableCell>
                        <TableCell>
                          {symbol.path ? (
                            <span
                              title={symbol.path}
                              className="text-muted-foreground truncate max-w-[200px] inline-block"
                            >
                              {symbol.path}
                            </span>
                          ) : (
                            "\u2014"
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground">{lineText}</TableCell>
                        <TableCell>
                          {symbol.signature ? (
                            <code
                              title={symbol.signature}
                              className="font-mono text-xs"
                            >
                              {symbol.signature}
                            </code>
                          ) : (
                            "\u2014"
                          )}
                        </TableCell>
                      </>
                    );
                    if (clickable && symbol.refId) {
                      return (
                        <TableRow
                          key={symbol.id}
                          className="cursor-pointer hover:bg-muted/50"
                          onClick={() =>
                            navigate({
                              to: "/workspaces/$workspaceId/documents/$documentId/chunks",
                              params: { workspaceId, documentId: symbol.refId! },
                              search: { page: 1, workspaceId },
                            })
                          }
                        >
                          {rowContent}
                        </TableRow>
                      );
                    }
                    return (
                      <TableRow key={symbol.id} className="cursor-default">
                        {rowContent}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              <Pagination
                currentPage={currentPage}
                totalPages={totalPages}
                basePath="/workspaces/$workspaceId/symbols"
                params={{ workspaceId }}
                extraSearch={{ workspaceId, type: activeType, q }}
              />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
