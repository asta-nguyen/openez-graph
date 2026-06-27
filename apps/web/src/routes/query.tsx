import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Network, FileText, ArrowRight, Search, Loader2, Sparkles, Code2, History, ChevronDown, ChevronRight } from "lucide-react";
import {
  Badge, Button, Card, CardContent, CardHeader, CardTitle,
  Label, Textarea,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@openez-graph/ui";
import { api } from "../lib/api";
import type { QueryResult, QueryLogRow } from "../lib/api";
import { queryLogsQueryOptions } from "../lib/queries";
import { formatDate } from "../lib/utils";
import { PAGE_SIZE } from "../lib/pagination";
import { NODE_TYPES, QUERY_SORT } from "../lib/constants";

export const Route = createFileRoute("/query")({
  component: QueryPage,
});

const initialState = {
  answerContext: "",
  sources: [] as Array<{ path: string; startLine?: number; endLine?: number; score: number; reason: string }>,
  graphNodes: [] as Array<{ id: string; type: string; label: string; metadata: Record<string, unknown> }>,
  graphEdges: [] as Array<{ from_node_id: string; to_node_id: string; type: string }>,
  error: null as string | null,
};

const EXAMPLE_QUERIES = [
  "MCP server setup",
  "graph expansion",
  "workspace registry",
  "indexing",
  "retrieval",
];

function nodeTypeColor(type: string): string {
  switch (type) {
    case NODE_TYPES.FILE: return "bg-chart-1/15 text-chart-1 border-chart-1/30";
    case NODE_TYPES.CHUNK: return "bg-chart-2/15 text-chart-2 border-chart-2/30";
    case NODE_TYPES.SYMBOL: return "bg-chart-3/15 text-chart-3 border-chart-3/30";
    case NODE_TYPES.ENTITY: return "bg-chart-4/15 text-chart-4 border-chart-4/30";
    default: return "bg-muted text-muted-foreground border-border";
  }
}

function nodeTypeIcon(type: string) {
  switch (type) {
    case NODE_TYPES.FILE: return <FileText className="h-3 w-3 mr-1" />;
    case NODE_TYPES.SYMBOL: return <Code2 className="h-3 w-3 mr-1" />;
    default: return null;
  }
}

function parseContextBlocks(raw: string): Array<{ path: string; lines: string; score: string; content: string }> {
  if (!raw) return [];
  const blocks = raw.split("\n\n---\n\n");
  return blocks.map((block) => {
    const match = block.match(/^\[source:\s*(.+?):(\d+)-(\d+)\s*\|\s*score:\s*([\d.]+)\]/);
    if (match) {
      return {
        path: match[1],
        lines: `${match[2]}-${match[3]}`,
        score: match[4],
        content: block.slice(match[0].length).trim(),
      };
    }
    return { path: "", lines: "", score: "", content: block.trim() };
  }).filter((b) => b.content);
}

function QueryPage() {
  const { workspaceId } = useSearch({ from: "__root__" });
  const queryClient = useQueryClient();
  const [state, setState] = useState<QueryResult & { error: string | null }>(initialState);
  const [pending, setPending] = useState(false);
  const [hasQueried, setHasQueried] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [historySort, setHistorySort] = useState<string>(QUERY_SORT.NEWEST);
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);

  useEffect(() => {
    setState(initialState);
    setHasQueried(false);
  }, [workspaceId]);

  const { data: historyData, isLoading: historyLoading } = useQuery({
    ...queryLogsQueryOptions(workspaceId, {
      page: 1,
      pageSize: PAGE_SIZE,
      sort: historySort,
    }),
    enabled: showHistory && !!workspaceId,
  });

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!workspaceId) {
      setState({ ...initialState, error: "No workspace available. Register a workspace first using the CLI: openez init <path>" });
      return;
    }
    setPending(true);
    setState({ ...initialState, error: null });
    try {
      const formData = new FormData(e.currentTarget);
      const result = await api.runQuery({
        workspaceId,
        query: String(formData.get("query") ?? "").trim(),
      });
      setState({ ...result, error: null });
      setHasQueried(true);
      // Refresh history after a query runs
      void queryClient.invalidateQueries({ queryKey: ["query-logs"] });
    } catch (err) {
      setState({ ...initialState, error: err instanceof Error ? err.message : "Query failed" });
      setHasQueried(true);
    } finally {
      setPending(false);
    }
  }

  function handleExampleClick(query: string) {
    const textarea = document.getElementById("query") as HTMLTextAreaElement | null;
    if (textarea) {
      textarea.value = query;
      textarea.focus();
    }
  }

  const fileNodes = state.graphNodes.filter((n) => n.type === NODE_TYPES.FILE);
  const symbolNodes = state.graphNodes.filter((n) => n.type === NODE_TYPES.SYMBOL);
  const chunkNodes = state.graphNodes.filter((n) => n.type === NODE_TYPES.CHUNK);
  const contextBlocks = parseContextBlocks(state.answerContext);
  const hasResults = state.sources.length > 0 || state.graphNodes.length > 0 || contextBlocks.length > 0;

  return (
    <div className="page">
      <div>
        <h1>Query</h1>
        <p className="muted">Search your indexed codebase — type a question, function name, or concept.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Search className="h-4 w-4" /> Ask a question
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="query-form">
            <div className="field">
              <Label htmlFor="query">Your query</Label>
              <Textarea
                id="query"
                name="query"
                placeholder="e.g. how does workspace indexing work?"
                rows={3}
                className="resize-y"
              />
            </div>

            <div className="flex flex-wrap gap-2">
              <span className="text-xs text-muted-foreground self-center mr-1">Try:</span>
              {EXAMPLE_QUERIES.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => handleExampleClick(q)}
                  className="text-xs px-2.5 py-1 rounded-full border border-border bg-muted/50 hover:bg-muted hover:border-primary/30 transition-colors text-muted-foreground hover:text-foreground"
                >
                  {q}
                </button>
              ))}
            </div>

            <Button type="submit" disabled={pending} className="mt-2">
              {pending ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Searching...</>
              ) : (
                <><Search className="h-4 w-4 mr-2" /> Run query</>
              )}
            </Button>
            {state.error && <p className="text-destructive text-sm mt-2">{state.error}</p>}
          </form>
        </CardContent>
      </Card>

      {/* Empty state — before any query is run */}
      {hasQueried && !hasResults && !state.error && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Search className="h-8 w-8 text-muted-foreground mb-3" />
            <p className="text-muted-foreground">No results found. Try a different query or make sure the workspace is indexed.</p>
          </CardContent>
        </Card>
      )}

      {/* Loading state */}
      {pending && (
        <Card>
          <CardContent className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin mr-2 text-muted-foreground" />
            <span className="text-muted-foreground">Searching the codebase...</span>
          </CardContent>
        </Card>
      )}

      {/* Results */}
      {!pending && hasResults && (
        <>
          {/* Context — retrieved code chunks */}
          {contextBlocks.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Sparkles className="h-4 w-4" /> Retrieved context
                  <Badge variant="secondary" className="text-xs">{contextBlocks.length} chunks</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {contextBlocks.map((block, i) => (
                  <div key={i} className="border-l-2 border-primary/20 pl-4">
                    <div className="flex items-center gap-2 mb-1.5 text-xs text-muted-foreground">
                      <FileText className="h-3 w-3" />
                      <span className="font-mono">{block.path}</span>
                      {block.lines && <span>:{block.lines}</span>}
                      {block.score && <Badge variant="outline" className="text-xs h-4 px-1">score {block.score}</Badge>}
                    </div>
                    <pre className="text-xs bg-muted/30 rounded p-3 overflow-x-auto whitespace-pre-wrap font-mono">{block.content}</pre>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Sources — clickable file references */}
          {state.sources.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <FileText className="h-4 w-4" /> Sources
                  <Badge variant="secondary" className="text-xs">{state.sources.length}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-1.5">
                  {state.sources.map((source, i) => (
                    <div key={i} className="flex items-center gap-3 text-sm py-1.5 px-2 rounded hover:bg-muted/50 transition-colors">
                      <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <span className="font-mono text-xs truncate">{source.path}</span>
                      {source.startLine != null && (
                        <span className="text-xs text-muted-foreground shrink-0">:{source.startLine}{source.endLine != null ? `-${source.endLine}` : ""}</span>
                      )}
                      <span className="ml-auto text-xs text-muted-foreground shrink-0">{source.score.toFixed(3)}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Graph Relationships */}
          {state.graphNodes.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Network className="h-4 w-4" /> Related graph nodes
                  <Badge variant="secondary" className="text-xs">{state.graphNodes.length} nodes</Badge>
                </CardTitle>
                <p className="text-xs text-muted-foreground mt-1">Files, symbols, and chunks connected to your query results.</p>
              </CardHeader>
              <CardContent className="grid gap-4">
                {fileNodes.length > 0 && (
                  <div>
                    <h4 className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wider">Files ({fileNodes.length})</h4>
                    <div className="flex flex-wrap gap-1.5">
                      {fileNodes.map((node) => (
                        <Badge key={node.id} variant="outline" className={nodeTypeColor(NODE_TYPES.FILE)}>
                          {nodeTypeIcon(NODE_TYPES.FILE)} {node.label}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
                {symbolNodes.length > 0 && (
                  <div>
                    <h4 className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wider">Symbols ({symbolNodes.length})</h4>
                    <div className="flex flex-wrap gap-1.5">
                      {symbolNodes.map((node) => (
                        <Badge key={node.id} variant="outline" className={nodeTypeColor(NODE_TYPES.SYMBOL)}>
                          {nodeTypeIcon(NODE_TYPES.SYMBOL)} {node.label}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
                {chunkNodes.length > 0 && (
                  <div>
                    <h4 className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wider">Chunks ({chunkNodes.length})</h4>
                    <div className="flex flex-wrap gap-1.5">
                      {chunkNodes.slice(0, 30).map((node) => (
                        <Badge key={node.id} variant="outline" className={nodeTypeColor(NODE_TYPES.CHUNK)}>
                          {node.label}
                        </Badge>
                      ))}
                      {chunkNodes.length > 30 && <span className="text-xs text-muted-foreground self-center">+{chunkNodes.length - 30} more</span>}
                    </div>
                  </div>
                )}
                {state.graphEdges.length > 0 && (
                  <div>
                    <h4 className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wider">Relationships ({Math.min(state.graphEdges.length, 20)} of {state.graphEdges.length})</h4>
                    <div className="flex flex-col gap-1">
                      {state.graphEdges.slice(0, 20).map((edge, i) => {
                        const fromNode = state.graphNodes.find((n) => n.id === edge.from_node_id);
                        const toNode = state.graphNodes.find((n) => n.id === edge.to_node_id);
                        return (
                          <div key={i} className="flex items-center gap-2 text-xs text-muted-foreground">
                            <span className="truncate max-w-50 font-mono">{fromNode?.label ?? edge.from_node_id.slice(0, 8)}</span>
                            <ArrowRight className="h-3 w-3 shrink-0" />
                            <Badge variant="outline" className="text-xs px-1 py-0 h-4">{edge.type}</Badge>
                            <ArrowRight className="h-3 w-3 shrink-0" />
                            <span className="truncate max-w-50 font-mono">{toNode?.label ?? edge.to_node_id.slice(0, 8)}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}

      {/* Query History — collapsible section at the bottom */}
      <Card>
        <CardHeader>
          <button
            onClick={() => setShowHistory(!showHistory)}
            className="flex items-center gap-2 w-full text-left"
          >
            {showHistory ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            <History className="h-4 w-4" />
            <CardTitle className="text-base">Query History</CardTitle>
            {historyData && (
              <Badge variant="secondary" className="text-xs">{historyData.totalCount} queries</Badge>
            )}
          </button>
        </CardHeader>
        {showHistory && (
          <CardContent>
            {/* Sort control */}
            <div className="flex items-center gap-3 mb-4">
              <label className="text-xs text-muted-foreground">Sort</label>
              <Select value={historySort} onValueChange={setHistorySort}>
                <SelectTrigger size="sm" className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={QUERY_SORT.NEWEST}>Newest</SelectItem>
                  <SelectItem value={QUERY_SORT.OLDEST}>Oldest</SelectItem>
                  <SelectItem value={QUERY_SORT.LATENCY_DESC}>Latency: high→low</SelectItem>
                  <SelectItem value={QUERY_SORT.LATENCY_ASC}>Latency: low→high</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {historyLoading ? (
              <p className="text-sm text-muted-foreground">Loading...</p>
            ) : (historyData?.items ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No queries logged yet. Run a query above or via MCP{" "}
                <code className="font-mono">memory_query</code>.
              </p>
            ) : (
              <>
                <p className="text-sm text-muted-foreground mb-4">
                  Showing {historyData!.items.length} of {historyData!.totalCount} queries
                </p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-8" />
                      <TableHead>Query</TableHead>
                      <TableHead>Results</TableHead>
                      <TableHead>Latency</TableHead>
                      <TableHead>Timestamp</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(historyData?.items ?? []).map((row) => (
                      <QueryLogRowItem
                        key={row.id}
                        row={row}
                        isExpanded={expandedRowId === row.id}
                        onToggle={setExpandedRowId}
                      />
                    ))}
                  </TableBody>
                </Table>
              </>
            )}
          </CardContent>
        )}
      </Card>
    </div>
  );
}

function QueryLogRowItem({
  row,
  isExpanded,
  onToggle,
}: {
  row: QueryLogRow;
  isExpanded: boolean;
  onToggle: (id: string) => void;
}) {
  const sortedChunks = [...row.retrievedChunks].sort((a, b) => b.score - a.score);

  return (
    <>
      <TableRow
        className="cursor-pointer"
        onClick={() => onToggle(isExpanded ? "" : row.id)}
      >
        <TableCell className="w-8">
          {isExpanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
        </TableCell>
        <TableCell className="font-mono text-sm max-w-md truncate">
          {row.query}
        </TableCell>
        <TableCell>{row.resultCount}</TableCell>
        <TableCell>
          {row.latencyMs != null ? `${row.latencyMs} ms` : "—"}
        </TableCell>
        <TableCell className="text-muted-foreground">
          {formatDate(row.createdAt)}
        </TableCell>
      </TableRow>

      {isExpanded && (
        <TableRow className="bg-muted/30 hover:bg-muted/30">
          <TableCell colSpan={5}>
            <div className="py-3 px-2">
              <pre className="font-mono text-sm whitespace-pre-wrap break-words mb-4">
                {row.query}
              </pre>
              {sortedChunks.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No retrieved chunks recorded for this query.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Score</TableHead>
                      <TableHead>Document Path</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sortedChunks.map((chunk) => (
                      <TableRow key={chunk.chunkId}>
                        <TableCell className="font-mono text-sm">
                          {chunk.score.toFixed(3)}
                        </TableCell>
                        <TableCell className="font-mono text-sm max-w-md truncate">
                          {chunk.path}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
