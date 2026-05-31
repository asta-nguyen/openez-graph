import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { Network, FileText, ArrowRight } from "lucide-react";
import {
  Badge, Button, Card, CardContent, CardHeader, CardTitle,
  Input, Label, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea,
} from "@openez-graph/ui";
import { api } from "../lib/api";
import type { QueryResult } from "../lib/api";

export const Route = createFileRoute("/query")({
  component: QueryPage,
  validateSearch: (search: Record<string, string | undefined>) => ({
    workspaceId: search.workspaceId ?? "",
  }),
});

const initialState = {
  answerContext: "",
  sources: [] as Array<{ path: string; startLine?: number; endLine?: number; score: number; reason: string }>,
  graphNodes: [] as Array<{ id: string; type: string; label: string; metadata: Record<string, unknown> }>,
  graphEdges: [] as Array<{ from_node_id: string; to_node_id: string; type: string }>,
  error: null as string | null,
};

function nodeTypeColor(type: string): string {
  switch (type) {
    case "file": return "bg-chart-1/15 text-chart-1 border-chart-1/30";
    case "chunk": return "bg-chart-2/15 text-chart-2 border-chart-2/30";
    case "symbol": return "bg-chart-3/15 text-chart-3 border-chart-3/30";
    case "entity": return "bg-chart-4/15 text-chart-4 border-chart-4/30";
    default: return "bg-muted text-muted-foreground border-border";
  }
}

function QueryPage() {
  const { workspaceId: defaultWorkspaceId } = useSearch({ from: "/query" });
  const [state, setState] = useState<QueryResult & { error: string | null }>(initialState);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setState({ ...initialState, error: null });
    try {
      const formData = new FormData(e.currentTarget);
      const result = await api.runQuery({
        workspaceId: String(formData.get("workspaceId") ?? "").trim(),
        query: String(formData.get("query") ?? "").trim(),
      });
      setState({ ...result, error: null });
    } catch (err) {
      setState({ ...initialState, error: err instanceof Error ? err.message : "Query failed" });
    } finally {
      setPending(false);
    }
  }

  const fileNodes = state.graphNodes.filter((n) => n.type === "file");
  const symbolNodes = state.graphNodes.filter((n) => n.type === "symbol");
  const chunkNodes = state.graphNodes.filter((n) => n.type === "chunk");

  return (
    <div className="page">
      <div>
        <h1>Query</h1>
        <p className="muted">Test the retrieval flow against the indexed workspace.</p>
      </div>

      <Card>
        <CardHeader><CardTitle>Query interface</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="query-form">
            <div className="field">
              <Label htmlFor="workspaceId">Workspace ID</Label>
              <Input id="workspaceId" name="workspaceId" defaultValue={defaultWorkspaceId} placeholder="openez" />
            </div>
            <div className="field">
              <Label htmlFor="query">Query</Label>
              <Textarea id="query" name="query" placeholder="login session flow, auth design, createSession" />
            </div>
            <Button type="submit" disabled={pending}>{pending ? "Running..." : "Run query"}</Button>
            {state.error && <p className="text-destructive">{state.error}</p>}
          </form>
        </CardContent>
      </Card>

      {state.answerContext && (
        <Card>
          <CardHeader><CardTitle className="text-base">Context</CardTitle></CardHeader>
          <CardContent><div className="code">{state.answerContext}</div></CardContent>
        </Card>
      )}

      {state.sources.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Sources</CardTitle></CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Path</TableHead>
                  <TableHead>Lines</TableHead>
                  <TableHead>Score</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.sources.map((source) => (
                  <TableRow key={`${source.path}-${source.startLine}-${source.endLine}`}>
                    <TableCell className="font-mono text-xs">{source.path}</TableCell>
                    <TableCell>{source.startLine ?? "?"}-{source.endLine ?? "?"}</TableCell>
                    <TableCell>{source.score.toFixed(3)}</TableCell>
                    <TableCell>{source.reason}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {state.graphNodes.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2">
            <Network className="h-4 w-4" /> Graph Relationships
          </CardTitle></CardHeader>
          <CardContent className="grid gap-4">
            {fileNodes.length > 0 && (
              <div>
                <h4 className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wider">Files</h4>
                <div className="flex flex-wrap gap-1.5">
                  {fileNodes.map((node) => (
                    <Badge key={node.id} variant="outline" className={nodeTypeColor("file")}>
                      <FileText className="h-3 w-3 mr-1" /> {node.label}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
            {symbolNodes.length > 0 && (
              <div>
                <h4 className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wider">Symbols</h4>
                <div className="flex flex-wrap gap-1.5">
                  {symbolNodes.map((node) => (
                    <Badge key={node.id} variant="outline" className={nodeTypeColor("symbol")}>{node.label}</Badge>
                  ))}
                </div>
              </div>
            )}
            {state.graphEdges.length > 0 && (
              <div>
                <h4 className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wider">Edges</h4>
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
    </div>
  );
}
