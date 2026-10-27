"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { LayoutDashboard, Network, Search } from "lucide-react";

// the graph (d3-force + canvas) loads only when the Graph tab is first opened
const GraphExplorer = dynamic(
  () => import("./graph-explorer").then((m) => ({ default: m.GraphExplorer })),
  {
    ssr: false,
    loading: () => (
      <div className="grid h-full place-items-center text-xs text-muted-foreground">
        Loading graph…
      </div>
    ),
  },
);

const tabs = [
  {
    id: "overview",
    label: "Overview",
    icon: LayoutDashboard,
    note: "Snapshot: openez repo, indexed 2026-10-27",
  },
  {
    id: "query",
    label: "Query",
    icon: Search,
    note: "Real code_query result on the openez repo",
  },
  {
    id: "graph",
    label: "Graph",
    icon: Network,
    note: "Real graph sample from the openez repo",
  },
] as const;

type TabId = (typeof tabs)[number]["id"];

// Totals read from the openez workspace's own index.sqlite on 2026-10-27
const measured = [
  { label: "Queries", value: "444" },
  { label: "Response tokens", value: "1,987,329" },
  { label: "Context avoided (est.)", value: "6,163,858" },
  { label: "Candidate files", value: "9,798" },
];

const indexState = [
  { label: "Documents", value: "312" },
  { label: "Chunks", value: "1,803" },
  { label: "Graph nodes", value: "1,393" },
  { label: "Graph edges", value: "1,921" },
  { label: "Memories", value: "24" },
];

const results = [
  {
    path: "apps/mcp/src/mcp-core.ts",
    lines: "186-215",
    code: `async function resolveDefaultWorkspace(): Promise<WorkspaceLike> {
  const registry = createRegistryRepository();
  const searchRoot = defaultPath ?? process.cwd();
  const localConfig = await findLocalWorkspaceConfig(searchRoot);
  …`,
  },
  {
    path: "packages/db/src/sqlite/registry-db.ts",
    lines: "32-116",
    code: `export function migrateRegistrySchema(sqlite: SqliteLike): void {
  const getColumns = () =>
    new Set(
  …`,
  },
];

function Overview() {
  return (
    <div className="space-y-6 p-5 sm:p-6">
      <div>
        <span className="mb-2 inline-block rounded-full bg-accent px-2.5 py-0.5 font-mono text-[11px] text-accent-foreground">
          Live code_query telemetry
        </span>
        <h3 className="text-base font-semibold">Measured agent context</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Actual serialized MCP responses compared with the indexed full files they replace.
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
        {measured.map((m) => (
          <div key={m.label} className="flex flex-col-reverse">
            <dt className="text-xs text-muted-foreground">{m.label}</dt>
            <dd className="mb-1 text-xl font-semibold tabular-nums">{m.value}</dd>
          </div>
        ))}
      </dl>

      <div className="rounded-xl border bg-card/60">
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <h4 className="text-sm font-semibold">Index state</h4>
          <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-[oklch(0.72_0.08_155)]">
            <span className="size-1.5 rounded-full bg-current" />
            incremental · completed
          </span>
        </div>
        <dl className="divide-y divide-border text-xs">
          {indexState.map((row) => (
            <div key={row.label} className="flex justify-between px-4 py-1.5">
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className="font-medium tabular-nums">{row.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

function Query() {
  return (
    <div className="space-y-4 p-5 sm:p-6">
      <div className="flex items-center gap-2.5 rounded-lg border bg-card/60 px-3 py-2.5">
        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 text-xs">
          where is the workspace registry created and how are workspaces resolved
        </span>
        <code className="shrink-0 rounded bg-accent px-1.5 py-0.5 font-mono text-[11px] text-accent-foreground">
          code_query
        </code>
      </div>

      <ul className="space-y-3">
        {results.map((r) => (
          <li key={r.path} className="overflow-hidden rounded-lg border bg-card/60">
            <div className="border-b px-3 py-1.5 font-mono text-[11px] text-primary [overflow-wrap:anywhere]">
              {r.path}:{r.lines}
            </div>
            <pre className="overflow-x-auto px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
              {r.code}
            </pre>
          </li>
        ))}
      </ul>

      <p className="text-xs leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">20</span> candidate files →{" "}
        <span className="font-medium text-foreground">4</span> selected ·{" "}
        <span className="font-medium text-foreground">1,120</span> response tokens, against 24,620
        for the full files.
      </p>
    </div>
  );
}

export function DashboardPreview() {
  const [tab, setTab] = useState<TabId>("graph");
  const current = tabs.find((t) => t.id === tab) ?? tabs[0];

  return (
    <div className="flex flex-col bg-background">
      {/* window chrome */}
      <div className="flex items-center gap-1.5 border-b border-border bg-card/60 px-4 py-2.5">
        <span className="size-2.5 rounded-full bg-red-500" />
        <span className="size-2.5 rounded-full bg-amber-500" />
        <span className="size-2.5 rounded-full bg-green-500" />
        <span className="ml-3 font-mono text-[11px] text-muted-foreground">
          openez — local dashboard
        </span>
      </div>

      <div className="flex flex-col sm:flex-row">
        <div
          role="group"
          aria-label="Dashboard view"
          className="flex shrink-0 gap-1 border-b border-border bg-card/30 p-2 sm:w-44 sm:flex-col sm:border-b-0 sm:border-r"
        >
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={t.id === tab}
              onClick={() => setTab(t.id)}
              className="flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground aria-pressed:bg-accent aria-pressed:font-semibold aria-pressed:text-accent-foreground sm:flex-none sm:justify-start"
            >
              <t.icon className="h-3.5 w-3.5" aria-hidden="true" />
              {t.label}
            </button>
          ))}
        </div>

        <div className="relative h-[32rem] min-w-0 overflow-y-auto sm:h-[28rem] sm:flex-1">
          {tab === "overview" && <Overview />}
          {tab === "query" && <Query />}
          {tab === "graph" && <GraphExplorer />}
        </div>
      </div>

      <p className="border-t border-border px-4 py-2 font-mono text-[11px] text-muted-foreground">
        {current.note}
      </p>
    </div>
  );
}
