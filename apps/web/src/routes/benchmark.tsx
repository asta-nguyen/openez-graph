import { createFileRoute } from "@tanstack/react-router";
import {
  CheckCircle2,
  Clock3,
  DatabaseZap,
  Target,
  TriangleAlert,
} from "lucide-react";
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

export const Route = createFileRoute("/benchmark")({
  component: BenchmarkPage,
});

const metrics = [
  { label: "Recall@5", value: "94.44%", detail: "17 of 18 queries", icon: Target },
  { label: "MRR", value: "0.7009", detail: "Mean reciprocal rank", icon: DatabaseZap },
  { label: "Duplicate paths", value: "0%", detail: "Unique source files", icon: CheckCircle2 },
  { label: "FTS latency", value: "17.85 ms", detail: "Average over 54 runs", icon: Clock3 },
];

const comparison = [
  ["Recall@5", "94.44%", "94.44%"],
  ["MRR", "0.7009", "0.7009"],
  ["Duplicate path rate", "0%", "0%"],
  ["Average latency", "17.85 ms", "112.88 ms"],
  ["Latency p50", "11.74 ms", "90.45 ms"],
  ["Latency p95", "51.22 ms", "272.30 ms"],
  ["Average context", "2,938 tokens", "2,938 tokens"],
] as const;

function BenchmarkPage() {
  return (
    <div className="page mx-auto w-full max-w-6xl">
      <header className="flex flex-col gap-3 border-b pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Badge className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-600">
              <CheckCircle2 className="h-3.5 w-3.5" /> Quality gate passed
            </Badge>
            <Badge variant="outline">2026-07-22</Badge>
          </div>
          <h1>Retrieval benchmark</h1>
          <p className="muted mt-1">117 files, 632 chunks, 18 queries, 3 iterations per mode.</p>
        </div>
        <div className="text-left text-sm text-muted-foreground sm:text-right">
          <div>SQLite FTS5 + graph</div>
          <div>Ollama nomic-embed-text</div>
        </div>
      </header>

      <section className="grid gap-0 overflow-hidden rounded-lg border sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map(({ label, value, detail, icon: Icon }, index) => (
          <div
            key={label}
            className={`min-w-0 p-5 ${
              index === 1 ? "border-t sm:border-l sm:border-t-0" :
              index === 2 ? "border-t sm:border-l-0 xl:border-l xl:border-t-0" :
              index === 3 ? "border-t sm:border-l xl:border-t-0" : ""
            }`}
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
            <CardTitle className="text-lg">Quality improvement</CardTitle>
            <CardDescription>Current retrieval compared with the previous baseline.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div>
              <div className="mb-2 flex items-center justify-between text-sm">
                <span>Recall@5</span>
                <span className="font-mono tabular-nums">83.33% → 94.44%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div className="h-full w-[94.44%] bg-emerald-500" />
              </div>
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between text-sm">
                <span>MRR</span>
                <span className="font-mono tabular-nums">0.6176 → 0.7009</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div className="h-full w-[70.09%] bg-cyan-500" />
              </div>
            </div>
            <div className="flex items-center justify-between border-t pt-4 text-sm">
              <span className="text-muted-foreground">Missed queries</span>
              <span className="font-medium tabular-nums">3 → 1</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Latency cost</CardTitle>
            <CardDescription>Ollama preserves quality but adds local inference time.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid grid-cols-[88px_1fr_auto] items-center gap-3 text-sm">
              <span>FTS-only</span>
              <div className="h-3 overflow-hidden rounded-full bg-muted">
                <div className="h-full w-[16%] bg-cyan-500" />
              </div>
              <span className="font-mono tabular-nums">17.85 ms</span>
            </div>
            <div className="grid grid-cols-[88px_1fr_auto] items-center gap-3 text-sm">
              <span>Ollama</span>
              <div className="h-3 overflow-hidden rounded-full bg-muted">
                <div className="h-full w-full bg-amber-500" />
              </div>
              <span className="font-mono tabular-nums">112.88 ms</span>
            </div>
            <div className="flex items-start gap-3 border-t pt-4 text-sm text-muted-foreground">
              <DatabaseZap className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
              <p>FTS-only remains the default. Ollama is used as semantic fallback when lexical search has no result.</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
          <div>
            <CardTitle className="text-lg">Mode comparison</CardTitle>
            <CardDescription>54 measured runs per mode on the same local index.</CardDescription>
          </div>
          <Badge variant="secondary">0% data leakage</Badge>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Metric</TableHead>
                <TableHead>FTS-only</TableHead>
                <TableHead>Ollama embedding</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {comparison.map(([metric, fts, ollama]) => (
                <TableRow key={metric}>
                  <TableCell className="font-medium">{metric}</TableCell>
                  <TableCell className="font-mono tabular-nums">{fts}</TableCell>
                  <TableCell className="font-mono tabular-nums">{ollama}</TableCell>
                </TableRow>
              ))}
              <TableRow>
                <TableCell className="font-medium">Quality gate</TableCell>
                <TableCell><Badge className="bg-emerald-600 text-white hover:bg-emerald-600">PASS</Badge></TableCell>
                <TableCell><Badge className="bg-emerald-600 text-white hover:bg-emerald-600">PASS</Badge></TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <section className="flex flex-col gap-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-5 sm:flex-row sm:items-start">
        <TriangleAlert className="h-5 w-5 shrink-0 text-amber-500" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold">Remaining miss</h2>
            <Badge variant="outline">Rank 7</Badge>
          </div>
          <p className="mt-2 break-words font-mono text-sm">where are TypeScript symbols extracted?</p>
          <div className="mt-3 grid gap-1 text-sm text-muted-foreground sm:grid-cols-[92px_1fr]">
            <span>Expected</span>
            <span className="break-all font-mono text-foreground">packages/indexer/src/code.ts</span>
            <span>Top result</span>
            <span className="break-all font-mono text-foreground">packages/indexer/src/languages.ts</span>
          </div>
        </div>
      </section>
    </div>
  );
}
