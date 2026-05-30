"use client";

import { useActionState } from "react";
import { Network, FileText, ArrowRight } from "lucide-react";

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea
} from "@openez-graph/ui";

import { runQuery } from "./actions";

const initialState = {
  answerContext: "",
  sources: [] as Array<{ path: string; startLine?: number; endLine?: number; score: number; reason: string }>,
  graphNodes: [] as Array<{ id: string; type: string; label: string; metadata: Record<string, unknown> }>,
  graphEdges: [] as Array<{ from_node_id: string; to_node_id: string; type: string }>,
  error: null as string | null
};

function nodeTypeColor(type: string): string {
  switch (type) {
    case "file": return "bg-blue-500/15 text-blue-400 border-blue-500/30";
    case "chunk": return "bg-purple-500/15 text-purple-400 border-purple-500/30";
    case "symbol": return "bg-green-500/15 text-green-400 border-green-500/30";
    case "entity": return "bg-amber-500/15 text-amber-400 border-amber-500/30";
    default: return "bg-muted text-muted-foreground border-border";
  }
}

export function QueryForm({
  defaultWorkspaceId = "",
}: {
  defaultWorkspaceId?: string;
}) {
  const [state, action, pending] = useActionState(runQuery, initialState);

  const fileNodes = state.graphNodes.filter((n) => n.type === "file");
  const symbolNodes = state.graphNodes.filter((n) => n.type === "symbol");
  const chunkNodes = state.graphNodes.filter((n) => n.type === "chunk");

  return (
    <form action={action} className="query-form">
      <div className="field">
        <Label htmlFor="workspaceId">Workspace ID</Label>
        <Input
          id="workspaceId"
          name="workspaceId"
          defaultValue={defaultWorkspaceId}
          placeholder="openez"
        />
      </div>

      <div className="field">
        <Label htmlFor="query">Query</Label>
        <Textarea
          id="query"
          name="query"
          placeholder="login session flow, auth design, createSession"
        />
      </div>

      <Button type="submit" disabled={pending}>
        {pending ? "Running..." : "Run query"}
      </Button>

      {state.error ? <p className="text-destructive">{state.error}</p> : null}

      {state.answerContext ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Context</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="code">{state.answerContext}</div>
          </CardContent>
        </Card>
      ) : null}

      {state.sources.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Sources</CardTitle>
          </CardHeader>
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
                    <TableCell>
                      {source.startLine ?? "?"}-{source.endLine ?? "?"}
                    </TableCell>
                    <TableCell>{source.score.toFixed(3)}</TableCell>
                    <TableCell>{source.reason}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      {state.graphNodes.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Network className="h-4 w-4" />
              Graph Relationships
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            {fileNodes.length > 0 ? (
              <div>
                <h4 className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wider">Files</h4>
                <div className="flex flex-wrap gap-1.5">
                  {fileNodes.map((node) => (
                    <Badge key={node.id} variant="outline" className={nodeTypeColor("file")}>
                      <FileText className="h-3 w-3 mr-1" />
                      {node.label}
                    </Badge>
                  ))}
                </div>
              </div>
            ) : null}

            {symbolNodes.length > 0 ? (
              <div>
                <h4 className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wider">Symbols</h4>
                <div className="flex flex-wrap gap-1.5">
                  {symbolNodes.map((node) => (
                    <Badge key={node.id} variant="outline" className={nodeTypeColor("symbol")}>
                      {node.label}
                    </Badge>
                  ))}
                </div>
              </div>
            ) : null}

            {state.graphEdges.length > 0 ? (
              <div>
                <h4 className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wider">Edges</h4>
                <div className="flex flex-col gap-1">
                  {state.graphEdges.slice(0, 20).map((edge, i) => {
                    const fromNode = state.graphNodes.find((n) => n.id === edge.from_node_id);
                    const toNode = state.graphNodes.find((n) => n.id === edge.to_node_id);
                    return (
                      <div key={i} className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="truncate max-w-[200px] font-mono">{fromNode?.label ?? edge.from_node_id.slice(0, 8)}</span>
                        <ArrowRight className="h-3 w-3 shrink-0" />
                        <Badge variant="outline" className="text-[10px] px-1 py-0 h-4">{edge.type}</Badge>
                        <ArrowRight className="h-3 w-3 shrink-0" />
                        <span className="truncate max-w-[200px] font-mono">{toNode?.label ?? edge.to_node_id.slice(0, 8)}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </form>
  );
}
