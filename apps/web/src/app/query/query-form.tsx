"use client";

import { useActionState } from "react";

import {
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
  error: null as string | null
};

export function QueryForm({
  defaultWorkspaceId = "",
}: {
  defaultWorkspaceId?: string;
}) {
  const [state, action, pending] = useActionState(runQuery, initialState);

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
      {state.answerContext ? <div className="code">{state.answerContext}</div> : null}

      {state.sources.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Sources</CardTitle>
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
                    <TableCell>{source.path}</TableCell>
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
    </form>
  );
}
