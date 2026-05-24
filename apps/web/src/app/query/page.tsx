import { QueryForm } from "./query-form";

import { Card, CardContent, CardHeader, CardTitle } from "@openez-graph/ui";

export default async function QueryPage({
  searchParams,
}: {
  searchParams: Promise<{ workspaceId?: string }>;
}) {
  const { workspaceId } = await searchParams;

  return (
    <div className="page">
      <div>
        <h1>Query</h1>
        <p className="muted">Test the `memory_query` retrieval flow against the indexed workspace.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Query interface</CardTitle>
        </CardHeader>
        <CardContent>
          <QueryForm defaultWorkspaceId={workspaceId ?? ""} />
        </CardContent>
      </Card>
    </div>
  );
}
