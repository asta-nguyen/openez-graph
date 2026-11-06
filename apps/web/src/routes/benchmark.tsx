import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { DatabaseZap, Files, Gauge, TrendingDown } from "lucide-react";
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@openez-graph/ui";

import { metricsQueryOptions } from "../lib/queries";
import type { QueryMetrics } from "../lib/api";

export const Route = createFileRoute("/benchmark")({
  component: BenchmarkPage,
});

// Dated snapshot from BENCHMARK.md: Recall@5 / MRR, no embeddings, Graphify 0.9.103 --code-only.
const COMPARISON = [
  { corpus: "Rust + TS desktop app", suite: "Concept", openez: ".40 / .37", graphify: ".53 / .27" },
  { corpus: "", suite: "Identifiers", openez: "1.00 / 1.00", graphify: "1.00 / 1.00" },
  { corpus: "", suite: "Relations", openez: "1.00 / .94", graphify: ".50 / .16" },
  { corpus: "", suite: "Documentation", openez: ".86 / .78", graphify: "N/A" },
  {
    corpus: "Python FastAPI service",
    suite: "Concept",
    openez: ".91 / .71",
    graphify: ".45 / .31",
  },
  { corpus: "", suite: "Identifiers", openez: "1.00 / 1.00", graphify: ".80 / .80" },
  { corpus: "", suite: "Relations", openez: ".75 / .75", graphify: ".50 / .28" },
  { corpus: "", suite: "Documentation", openez: ".50 / .50", graphify: "N/A" },
  { corpus: "TS Next.js frontend", suite: "Concept", openez: ".89 / .69", graphify: ".78 / .37" },
  { corpus: "", suite: "Identifiers", openez: "1.00 / 1.00", graphify: ".89 / .89" },
  { corpus: "", suite: "Relations", openez: ".75 / .75", graphify: ".75 / .25" },
  { corpus: "", suite: "Documentation", openez: ".80 / .80", graphify: "N/A" },
];

function BenchmarkPage() {
  const { data: metrics, isLoading, error } = useQuery(metricsQueryOptions());

  if (isLoading)
    return (
      <div className="page">
        <p className="muted">Loading measured retrieval data...</p>
      </div>
    );
  if (error)
    return (
      <div className="page">
        <p className="text-destructive">{error.message}</p>
      </div>
    );
  if (!metrics) return null;

  const cards = [
    {
      label: "Code queries",
      value: metrics.totalQueries.toLocaleString(),
      detail: "Recorded code_query calls",
      icon: Gauge,
    },
    {
      label: "Response tokens",
      value: metrics.totalTokensReturned.toLocaleString(),
      detail: "Serialized responses",
      icon: DatabaseZap,
    },
    {
      label: "Context avoided",
      value: metrics.totalTokensSaved.toLocaleString(),
      detail: "Evidence-based estimate",
      icon: TrendingDown,
    },
    {
      label: "Candidate files",
      value: metrics.totalFilesScanned.toLocaleString(),
      detail: "Ranked retrieval candidates",
      icon: Files,
    },
  ];

  return (
    <div className="page mx-auto w-full max-w-6xl">
      <header className="border-b pb-5">
        <Badge variant="secondary" className="mb-3">
          Live workspace telemetry
        </Badge>
        <h1>Agent retrieval evidence</h1>
        <p className="muted mt-1">
          Measured MCP payload size and the indexed full-file context it replaces.
        </p>
      </header>

      <section className="grid gap-0 overflow-hidden rounded-lg border sm:grid-cols-2 xl:grid-cols-4">
        {cards.map(({ label, value, detail, icon: Icon }, index) => (
          <div
            key={label}
            className={`min-w-0 p-5 ${index > 0 ? "border-t sm:border-l sm:border-t-0" : ""}`}
          >
            <div className="mb-4 flex items-center justify-between gap-3 text-sm text-muted-foreground">
              <span>{label}</span>
              <Icon className="h-4 w-4 text-foreground" />
            </div>
            <div className="text-2xl font-semibold tabular-nums">{value}</div>
            <div className="mt-1 text-xs text-muted-foreground">{detail}</div>
          </div>
        ))}
      </section>

      <div className="grid cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Measurement method</CardTitle>
            <CardDescription>{metrics.metricMethod}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>
              <strong>Response tokens</strong> are counted from the complete serialized MCP
              response.
            </p>
            <p>
              <strong>Context avoided</strong> equals all indexed tokens in selected full files
              minus response tokens, floored at zero.
            </p>
            <p>
              <strong>Candidate files</strong> means ranked retrieval candidates; it is not a claim
              about SQLite files physically scanned.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>What this does not prove</CardTitle>
            <CardDescription>
              Token efficiency and retrieval correctness are separate checks.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>These numbers do not claim that an agent completed a task correctly.</p>
            <p>
              Recall and MRR must come from a dated, reproducible retrieval run; they are no longer
              hard-coded into this dashboard.
            </p>
            <p>
              Agent task completion should be compared separately against the same tasks using
              direct file reads.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>OpenEZ and Graphify</CardTitle>
          <CardDescription>
            Recall@5 / MRR, measured 2026-11-06 without embeddings. Graphify 0.9.103 ran with
            --code-only, so it made no LLM calls and indexed no documentation.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Corpus</TableHead>
                <TableHead>Questions</TableHead>
                <TableHead className="text-right">OpenEZ</TableHead>
                <TableHead className="text-right">Graphify</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {COMPARISON.map((row, index) => (
                <TableRow key={index}>
                  <TableCell className="font-medium">{row.corpus}</TableCell>
                  <TableCell>{row.suite}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.openez}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.graphify}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>
              The Python and Next.js numbers are optimistic: OpenEZ&apos;s ranking was improved
              using those questions. The desktop app&apos;s concept questions were written first and
              never tuned against, so they are the fairest row.
            </p>
            <p>
              Suites hold 4 to 15 questions, so small differences are noise. Warm query latency is
              comparable. These numbers are a snapshot and do not come from this workspace.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent code queries</CardTitle>
          <CardDescription>Latest evidence recorded for the active workspace.</CardDescription>
        </CardHeader>
        <CardContent>
          {metrics.recentQueries.length === 0 ? (
            <p className="muted">No MCP query metrics recorded yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Query</TableHead>
                  <TableHead>Results</TableHead>
                  <TableHead>Response tokens</TableHead>
                  <TableHead>Context avoided</TableHead>
                  <TableHead>Candidates</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {metrics.recentQueries.map((query: QueryMetrics["recentQueries"][number]) => (
                  <TableRow key={query.id}>
                    <TableCell className="max-w-[320px] truncate font-medium">
                      {query.query}
                    </TableCell>
                    <TableCell>{query.resultCount}</TableCell>
                    <TableCell>{query.tokensReturned.toLocaleString()}</TableCell>
                    <TableCell>{query.tokensSaved.toLocaleString()}</TableCell>
                    <TableCell>{query.filesScanned}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
