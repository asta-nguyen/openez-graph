import type { Metadata } from "next";
import { ArrowRight } from "lucide-react";
import { AgentTabs } from "../../components/agent-tabs";
import { Footer } from "../../components/footer";
import { mcpToolCount, mcpToolGroups } from "../../components/mcp-tools";
import type { McpTool } from "../../components/mcp-reference";
import { SiteHeader } from "../../components/site-header";
import { REPO_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: "MCP tools reference",
  description: `All ${mcpToolCount} OpenEZ MCP tools: what each one does, when an agent should call it, its parameters, and a real example.`,
  alternates: { canonical: "/docs/mcp" },
};

const scopeLabel: Record<McpTool["scope"], string> = {
  read: "one or many workspaces",
  single: "one workspace",
  none: "no workspace needed",
};

const requestExample = `{
  "query": "where is the workspace registry created and how are workspaces resolved",
  "path": "/abs/path/to/project",
  "limit": 4,
  "maxTokens": 1200
}`;

const responseExample = `{
  "answerContext": "[source: apps/mcp/src/mcp-core.ts:186-215 | score: 0.020]\\n  async function resolveDefaultWorkspace(): Promise<WorkspaceLike> { … }\\n\\n[source: packages/db/src/sqlite/registry-db.ts:32-116 | score: 0.020]\\n  export function migrateRegistrySchema(sqlite: SqliteLike): void { … }",
  "sources": [
    {
      "path": "apps/mcp/src/mcp-core.ts",
      "startLine": 186,
      "endLine": 215,
      "score": 0.0205,
      "reason": "retrieved-context",
      "workspaceId": "openez"
    }
  ],
  "metrics": {
    "candidateFiles": 20,
    "selectedFiles": 4,
    "selectedFullFileTokens": 24620,
    "tokenBudget": 1200,
    "truncated": true,
    "responseTokens": 1120
  }
}`;

function Code({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg border bg-[oklch(0.08_0.012_260)] p-4 font-mono text-xs leading-relaxed text-foreground/90">
      {children}
    </pre>
  );
}

function Tool({ tool }: { tool: McpTool }) {
  return (
    <article id={tool.name} className="rounded-xl border bg-card p-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="font-mono text-base font-semibold">
          <a href={`#${tool.name}`} className="hover:text-primary">
            {tool.name}
          </a>
        </h3>
        {tool.needsConfirm && <span className="mcp-tool__tag">destructive</span>}
        <span className="font-mono text-[11px] text-muted-foreground sm:ml-auto">
          {scopeLabel[tool.scope]}
        </span>
      </div>
      <p className="mt-3 text-sm leading-relaxed">{tool.summary}</p>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">Call it when </span>
        {tool.when}
      </p>

      {tool.params.length > 0 && (
        <div className="mt-4">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">Parameters of {tool.name}</caption>
            <thead className="hidden text-muted-foreground sm:table-header-group">
              <tr className="border-b">
                <th className="w-48 py-2 pr-4 font-medium">Parameter</th>
                <th className="w-40 py-2 pr-4 font-medium">Type</th>
                <th className="py-2 font-medium">Description</th>
              </tr>
            </thead>
            {/* stacked on phones so the description is never off-screen, a table from sm up */}
            <tbody className="block divide-y divide-border sm:table-row-group">
              {tool.params.map((p) => (
                <tr key={p.name} className="block py-2.5 align-top sm:table-row sm:py-0">
                  <td className="mr-2 inline font-mono text-foreground sm:table-cell sm:py-2 sm:pr-4">
                    {p.name}
                    {p.required && (
                      <span className="ml-1 text-primary" title="required">
                        *
                      </span>
                    )}
                  </td>
                  <td className="inline font-mono text-muted-foreground sm:table-cell sm:py-2 sm:pr-4">
                    {p.type}
                  </td>
                  <td className="mt-1 block leading-relaxed text-muted-foreground sm:table-cell sm:py-2">
                    {p.desc}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </article>
  );
}

export default function McpDocsPage() {
  return (
    <div className="min-h-svh overflow-x-clip bg-background text-foreground dot-grid">
      <SiteHeader />

      <main className="mx-auto max-w-6xl px-6 pb-24 pt-28">
        <header className="mb-14 max-w-2xl">
          <p className="mb-3 font-mono text-xs uppercase tracking-widest text-accent-foreground">
            Reference
          </p>
          <h1 className="text-balance text-4xl font-black tracking-tight sm:text-5xl">MCP tools</h1>
          <p className="mt-4 text-pretty leading-relaxed text-muted-foreground">
            OpenEZ exposes {mcpToolCount} tools over MCP, all backed by the same local SQLite index.
            This page says what each one does, when an agent should reach for it, and what it
            accepts.
          </p>
        </header>

        <div className="lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-14">
          <nav aria-label="On this page" className="hidden lg:block">
            <div className="sticky top-20 max-h-[calc(100svh-6rem)] space-y-5 overflow-y-auto pb-6 text-xs">
              <ul className="space-y-1.5 text-muted-foreground">
                <li>
                  <a className="nav-link" href="#connect">
                    Connect an agent
                  </a>
                </li>
                <li>
                  <a className="nav-link" href="#scope">
                    Workspace scope
                  </a>
                </li>
                <li>
                  <a className="nav-link" href="#example">
                    Example
                  </a>
                </li>
              </ul>
              {mcpToolGroups.map((group) => (
                <div key={group.label}>
                  <p
                    className="mb-1.5 flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-muted-foreground"
                    style={{ color: group.color }}
                  >
                    <group.icon className="h-3 w-3" aria-hidden="true" />
                    {group.label}
                  </p>
                  <ul className="space-y-1.5 font-mono text-muted-foreground">
                    {group.tools.map((tool) => (
                      <li key={tool.name}>
                        <a className="nav-link" href={`#${tool.name}`}>
                          {tool.name}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </nav>

          <div className="min-w-0 space-y-16">
            <section id="connect">
              <h2 className="mb-3 text-2xl font-black tracking-tight">Connect an agent</h2>
              <p className="mb-4 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                One command writes the agent&apos;s config, registers the project, and indexes it.
                The agent then starts{" "}
                <code className="font-mono text-foreground">openez serve --mcp</code> over stdio and
                sees the tools below.
              </p>
              <div className="max-w-xl">
                <AgentTabs prefix="openez setup" suffix=" ." />
              </div>
            </section>

            <section id="scope">
              <h2 className="mb-3 text-2xl font-black tracking-tight">Workspace scope</h2>
              <ul className="max-w-2xl list-disc space-y-2 pl-5 text-sm leading-relaxed text-muted-foreground marker:text-primary">
                <li>
                  <span className="text-foreground">Read tools</span> (
                  <code className="font-mono">code_query</code>,{" "}
                  <code className="font-mono">code_context</code>,{" "}
                  <code className="font-mono">graph_neighbors</code>,{" "}
                  <code className="font-mono">diff_context</code>,{" "}
                  <code className="font-mono">memory_recall</code>) take{" "}
                  <code className="font-mono">workspaceIds</code> or{" "}
                  <code className="font-mono">paths</code> for several workspaces, or{" "}
                  <code className="font-mono">workspaceId</code> /{" "}
                  <code className="font-mono">path</code> for one.
                </li>
                <li>
                  <span className="text-foreground">Single-workspace tools</span> (
                  <code className="font-mono">code_outline</code>,{" "}
                  <code className="font-mono">memory_write</code>,{" "}
                  <code className="font-mono">index_workspace</code>,{" "}
                  <code className="font-mono">remove_workspace</code>) take one{" "}
                  <code className="font-mono">workspaceId</code> or{" "}
                  <code className="font-mono">path</code>.
                </li>
                <li>
                  With no scope, OpenEZ reads{" "}
                  <code className="font-mono">.openez/workspace.json</code> from the current project
                  or a parent folder. Failing that it uses the workspace registered at that path,
                  then the only registered workspace; with several it returns an error asking for{" "}
                  <code className="font-mono">workspaceId</code> or{" "}
                  <code className="font-mono">path</code>.{" "}
                  <code className="font-mono">remove_workspace</code> is the exception: it always
                  needs an explicit one.
                </li>
                <li>
                  <code className="font-mono">maxTokens</code> bounds the whole serialized response;
                  across several workspaces the budget is split between them.
                </li>
              </ul>
            </section>

            {mcpToolGroups.map((group) => (
              <section key={group.label} id={group.label.toLowerCase()}>
                <div className="mb-5 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  <h2 className="flex items-center gap-2.5 text-2xl font-black tracking-tight">
                    <group.icon
                      className="h-5 w-5"
                      style={{ color: group.color }}
                      aria-hidden="true"
                    />
                    {group.label}
                  </h2>
                  <p className="text-sm text-muted-foreground">{group.blurb}</p>
                </div>
                <div className="space-y-4">
                  {group.tools.map((tool) => (
                    <Tool key={tool.name} tool={tool} />
                  ))}
                </div>
              </section>
            ))}

            <section id="example">
              <h2 className="mb-3 text-2xl font-black tracking-tight">
                Example: <code className="font-mono text-xl">code_query</code>
              </h2>
              <p className="mb-4 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                A real call against this repository, abbreviated. Four of the twenty candidate files
                were selected: they are 24,620 tokens in full, and the response is 1,120.
              </p>
              <div className="space-y-3">
                <p className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                  Request
                </p>
                <Code>{requestExample}</Code>
                <p className="pt-2 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                  Response
                </p>
                <Code>{responseExample}</Code>
              </div>
            </section>

            <p className="border-t pt-8 text-sm text-muted-foreground">
              The tools are defined in{" "}
              <a
                className="text-primary hover:underline"
                href={`${REPO_URL}/blob/main/apps/mcp/src/mcp-core.ts`}
                target="_blank"
                rel="noopener noreferrer"
              >
                apps/mcp/src/mcp-core.ts
              </a>
              .{" "}
              <a className="inline-flex items-center gap-1 text-primary hover:underline" href="/">
                Back to the overview <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            </p>
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
}
