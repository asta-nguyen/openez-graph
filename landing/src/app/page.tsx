import { Fragment } from "react";
import type { ReactNode } from "react";
import {
  Search,
  Network,
  Database,
  Terminal,
  Puzzle,
  ArrowRight,
  FileCode2,
  Layers,
  Workflow,
  Radio,
  AlertTriangle,
} from "lucide-react";
import { Reveal } from "./components/reveal";
import { AnimatedCounter } from "./components/animated-counter";
import { GitHubStars } from "./components/github-stars";
import { DashboardPreview } from "./components/dashboard-preview";
import { AgentTabs } from "./components/agent-tabs";
import { CommandBox } from "./components/command-box";
import { RetrievalStage } from "./components/retrieval-stage";
import { mcpToolCount } from "./components/mcp-tools";
import { Footer } from "./components/footer";
import { SiteHeader } from "./components/site-header";
import { REPO, REPO_URL } from "@/lib/site";

const stats = [
  { label: "MCP tools", target: mcpToolCount },
  { label: "Indexed formats", target: 20 },
  { label: "Agent setups", target: 5 },
  { label: "Local database", target: 1 },
];

const problems = [
  {
    icon: Terminal,
    title: "Wasted token budget",
    desc: "50–200K tokens per session spent re-parsing files your agent has already analyzed. That's your context window — and your budget — gone before real work begins.",
  },
  {
    icon: AlertTriangle,
    title: "No persistent understanding",
    desc: "Your agent's 'memory' resets every conversation. Without a durable code index, it can't build on past queries, track relationships, or produce consistently accurate results.",
  },
  {
    icon: Database,
    title: "Cloud dependency risk",
    desc: "Most code intelligence tools send your source code to cloud APIs. That's a non-starter for proprietary codebases, regulated environments, or anyone who values data privacy.",
  },
  {
    icon: Network,
    title: "Shallow indexing",
    desc: "Simple text search isn't enough. Understanding code requires AST-level parsing, symbol graphs, and cross-file relationship tracking — capabilities most tools don't localize.",
  },
];

const steps: { title: string; desc: ReactNode }[] = [
  {
    title: "Init & Index",
    desc: (
      <>
        Run <code className="font-mono text-xs text-foreground">openez init</code> to register a
        workspace. The indexer parses your codebase into documents, chunks, graph nodes, and edges —
        stored locally in SQLite (WAL mode).
      </>
    ),
  },
  {
    title: "Query & Explore",
    desc: "Full-text search across indexed chunks, expanded through graph neighbor traversal. Inspect relationships in the graph explorer or retrieve focused context through MCP.",
  },
  {
    title: "Connect & Automate",
    desc: "Expose your indexed runtime through MCP for AI agents, the CLI for scripts, or the web dashboard. All three point at the same SQLite store.",
  },
];

const surfaces = [
  {
    icon: Terminal,
    label: "CLI",
    desc: "init, index, status, watch, serve, setup",
  },
  {
    icon: Radio,
    label: "SQLite Runtime",
    desc: "registry + workspace DBs, FTS + graph + memory",
    via: "local state",
  },
  {
    icon: Database,
    label: "MCP + Dashboard",
    desc: "agent tools, telemetry, graph inspection",
    via: "shared by",
  },
];

const features = [
  {
    icon: Layers,
    title: "Semantic Indexing",
    desc: "TS/JS get full AST-level indexing via oxc-parser. Python, Go, Rust, Ruby, C++, C#, and Java get language-aware AST parsing with native acceleration where available. Docs and config files get structure-aware chunking — all stored in local SQLite.",
  },
  {
    icon: Search,
    title: "Hybrid RAG Retrieval",
    desc: "Full-text search with graph expansion along call and import edges, plus optional vector embeddings (bge-m3 / OpenAI) fused via Reciprocal Rank Fusion. 76.47% recall@5 on our own benchmark (FTS only, 17 queries) — no external vector DB required.",
  },
  {
    icon: Network,
    title: "Knowledge Graph",
    desc: "Indexed symbols become nodes connected by imports, references, and other code relationships. Inspect the workspace graph from the local dashboard.",
  },
  {
    icon: Workflow,
    title: "Automatic sync",
    desc: "The MCP runtime auto-registers and indexes a project, then keeps it current as files change. Manual incremental, watch, and full reindex commands remain available.",
  },
  {
    icon: Radio,
    title: `${mcpToolCount} MCP tools`,
    desc: "Give agents ranked retrieval, file outlines, graph context, git-diff impact, durable memory, and workspace controls through a focused MCP tool surface.",
  },
  {
    icon: Puzzle,
    title: "Five agent integrations",
    desc: "One setup command connects Codex, Claude Code, OpenCode, Windsurf, or Devin. OpenEZ writes the right config, so you do not have to.",
  },
];

const tiers = [
  {
    title: "Rich AST",
    desc: "Symbols and binding-resolved call edges via oxc-parser.",
    langs: [
      { name: "TypeScript", color: "text-blue-400" },
      { name: "JavaScript", color: "text-yellow-400" },
    ],
  },
  {
    title: "Language-aware AST",
    desc: "Tree-sitter symbols with native acceleration where available. Python, Go, Rust, and Ruby also fall back to regex.",
    langs: [
      { name: "Python", color: "text-green-400" },
      { name: "Go", color: "text-cyan-400" },
      { name: "Rust", color: "text-orange-400" },
      { name: "Ruby", color: "text-red-400" },
      { name: "C++", color: "text-sky-400" },
      { name: "C#", color: "text-violet-400" },
      { name: "Java", color: "text-orange-300" },
    ],
  },
  {
    title: "Scanned & chunked",
    desc: "Searchable through fallback chunking, without symbol extraction.",
    langs: [
      { name: "CoffeeScript", color: "text-amber-400" },
      { name: "Slim", color: "text-fuchsia-400" },
      { name: "CSS", color: "text-pink-400" },
      { name: "SCSS", color: "text-pink-300" },
      { name: "SASS", color: "text-rose-400" },
      { name: "LESS", color: "text-indigo-300" },
      { name: "Haml", color: "text-violet-400" },
    ],
  },
  {
    title: "Structure-aware",
    desc: "Config and docs are chunked by their keys and sections.",
    langs: [
      { name: "YAML", color: "text-red-400" },
      { name: "JSON", color: "text-emerald-400" },
      { name: "TOML", color: "text-purple-400" },
      { name: "Markdown", color: "text-sky-400" },
    ],
  },
];

function SectionHead({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="mx-auto mb-12 max-w-2xl text-center">
      <p className="mb-3 font-mono text-xs uppercase tracking-widest text-accent-foreground">
        {eyebrow}
      </p>
      <h2 className="text-balance text-3xl font-black tracking-tight sm:text-4xl">{title}</h2>
      {children && (
        <p className="mt-4 text-pretty text-sm leading-relaxed text-muted-foreground sm:text-base">
          {children}
        </p>
      )}
    </div>
  );
}

function IconTile({ icon: Icon }: { icon: typeof Layers }) {
  return (
    <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
      <Icon className="h-4 w-4" aria-hidden="true" />
    </div>
  );
}

export default async function LandingPage() {
  let starCount: number | null = null;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}`, {
      next: { revalidate: 3600 },
    });
    if (res.ok) {
      const data = await res.json();
      if (typeof data.stargazers_count === "number") {
        starCount = data.stargazers_count;
      }
    }
  } catch {}

  let cliVersion = "1.5.0";
  try {
    const res = await fetch("https://registry.npmjs.org/@openez-graph/cli/latest", {
      next: { revalidate: 3600 },
    });
    if (res.ok) {
      const data = await res.json();
      if (typeof data.version === "string") {
        cliVersion = data.version;
      }
    }
  } catch {}

  return (
    <div className="min-h-svh overflow-x-clip bg-background text-foreground dot-grid">
      <SiteHeader />

      <main>
        {/* ── HERO ── */}
        <section id="top" className="relative overflow-hidden px-6 pb-20 pt-28 lg:pb-24 lg:pt-32">
          <div className="glow-orb -right-24 top-16" />
          <div className="glow-orb glow-orb--violet -left-56 top-64" />
          <div className="glow-orb glow-orb--amber right-1/4 top-[28rem]" />

          <div className="relative mx-auto grid w-full max-w-7xl items-center gap-14 lg:grid-cols-2">
            <div className="fade-up">
              <a
                href={`${REPO_URL}/releases`}
                target="_blank"
                rel="noopener noreferrer"
                className="mb-8 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3.5 py-1.5 font-mono text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
              >
                <span className="size-1.5 rounded-full bg-primary" aria-hidden="true" />v
                {cliVersion}
                <span className="text-white/20" aria-hidden="true">
                  ·
                </span>
                local-first RAG
                <ArrowRight className="h-3 w-3" aria-hidden="true" />
              </a>

              <h1 className="mb-6 text-balance text-[clamp(2.4rem,4.2vw,3.6rem)] font-bold leading-[1.06] tracking-[-0.04em]">
                Durable context
                <br className="hidden sm:block" />{" "}
                <span className="accent-text">for coding agents</span>
              </h1>

              <p className="mb-9 max-w-xl text-pretty text-base leading-relaxed text-muted-foreground sm:text-lg">
                Index code once. Let Codex, Claude, OpenCode, Windsurf, and Devin retrieve ranked
                code, graph context, and project memory from local SQLite.
              </p>

              <div className="mb-6 max-w-xl">
                <AgentTabs prefix="npx @openez-graph/cli setup" />
              </div>

              <div className="flex flex-wrap items-center gap-4">
                <a
                  href="#quick-start"
                  className="inline-flex items-center gap-2 rounded-lg bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground transition-all hover:brightness-110 active:scale-[0.98]"
                >
                  Connect your agent <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </a>
                <GitHubStars repo={REPO} initialCount={starCount} />
              </div>
            </div>

            <RetrievalStage />
          </div>
        </section>

        {/* ── STATS ── */}
        <Reveal>
          <section className="border-y border-border bg-card/40" aria-label="At a glance">
            <dl className="mx-auto grid max-w-5xl grid-cols-2 gap-y-8 px-6 py-10 sm:grid-cols-4">
              {stats.map((s) => (
                <div key={s.label} className="flex flex-col-reverse items-center gap-1 text-center">
                  <dt className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
                    {s.label}
                  </dt>
                  <dd className="font-display text-3xl font-black text-primary sm:text-4xl">
                    <AnimatedCounter target={s.target} />
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        </Reveal>

        {/* ── PROBLEM ── */}
        <Reveal>
          <section className="mx-auto max-w-5xl px-6 py-20">
            <SectionHead
              eyebrow="The Problem"
              title="AI agents shouldn't have to re-read everything"
            >
              Every time an AI coding agent starts a conversation, it reads your source files from
              scratch — burning tokens, context, and time on the same code it already saw yesterday.
            </SectionHead>
            <div className="grid gap-4 sm:grid-cols-2">
              {problems.map((p) => (
                <div key={p.title} className="card-hover rounded-xl border bg-card p-6">
                  <div className="mb-3 flex items-center gap-3">
                    <IconTile icon={p.icon} />
                    <h3 className="text-sm font-semibold">{p.title}</h3>
                  </div>
                  <p className="text-sm leading-relaxed text-muted-foreground">{p.desc}</p>
                </div>
              ))}
            </div>
          </section>
        </Reveal>

        {/* ── HOW IT WORKS ── */}
        <Reveal>
          <section id="how" className="mx-auto max-w-6xl px-6 py-20">
            <SectionHead eyebrow="Architecture" title="How it works" />
            <ol className="grid gap-4 md:grid-cols-3">
              {steps.map((s, i) => (
                <li key={s.title} className="card-hover rounded-xl border bg-card p-6">
                  <div className="mb-4 flex size-8 items-center justify-center rounded-full bg-accent font-mono text-xs font-bold text-accent-foreground">
                    0{i + 1}
                  </div>
                  <h3 className="mb-2 text-sm font-semibold">{s.title}</h3>
                  <p className="text-sm leading-relaxed text-muted-foreground">{s.desc}</p>
                </li>
              ))}
            </ol>

            <div className="mt-12 flex flex-col md:flex-row">
              {surfaces.map((n) => (
                <Fragment key={n.label}>
                  {n.via && (
                    <div className="flex flex-col items-center justify-center gap-1 py-3 md:px-4 md:py-0">
                      <ArrowRight
                        className="h-4 w-4 rotate-90 text-primary/70 md:rotate-0"
                        aria-hidden="true"
                      />
                      <span className="font-mono text-[11px] text-muted-foreground">{n.via}</span>
                    </div>
                  )}
                  <div className="card-hover flex flex-1 flex-col items-center gap-2 rounded-xl border bg-card p-6 text-center">
                    <div className="flex size-10 items-center justify-center rounded-xl bg-accent text-accent-foreground">
                      <n.icon className="h-4 w-4" aria-hidden="true" />
                    </div>
                    <div className="text-sm font-semibold">{n.label}</div>
                    <div className="text-xs leading-relaxed text-muted-foreground">{n.desc}</div>
                  </div>
                </Fragment>
              ))}
            </div>
          </section>
        </Reveal>

        {/* ── PRODUCT ── */}
        <Reveal>
          <section id="product" className="mx-auto max-w-6xl px-6 py-20">
            <SectionHead eyebrow="See it in action" title="What it looks like">
              Inspect workspace state, measured MCP query telemetry, memories, documents, and symbol
              relationships from one local management UI.
            </SectionHead>
            <div className="screenshot-card">
              <DashboardPreview />
            </div>
          </section>
        </Reveal>

        {/* ── FEATURES ── */}
        <Reveal>
          <section className="mx-auto max-w-6xl px-6 py-20">
            <SectionHead eyebrow="Capabilities" title="What you get" />
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {features.map((f) => (
                <div key={f.title} className="card-hover rounded-xl border bg-card p-6">
                  <div className="mb-3 flex items-center gap-3">
                    <IconTile icon={f.icon} />
                    <h3 className="text-sm font-semibold">{f.title}</h3>
                  </div>
                  <p className="text-sm leading-relaxed text-muted-foreground">{f.desc}</p>
                </div>
              ))}
            </div>
          </section>
        </Reveal>

        {/* ── LANGUAGES ── */}
        <Reveal>
          <section className="mx-auto max-w-5xl px-6 py-20">
            <SectionHead eyebrow="Index Anything" title="Every language you use">
              Twenty formats, indexed at the depth each one supports.
            </SectionHead>
            <div className="grid gap-4 md:grid-cols-2">
              {tiers.map((t) => (
                <div key={t.title} className="rounded-xl border bg-card p-6">
                  <h3 className="text-sm font-semibold">{t.title}</h3>
                  <p className="mb-4 mt-1 text-xs leading-relaxed text-muted-foreground">
                    {t.desc}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {t.langs.map((lang) => (
                      <span key={lang.name} className="lang-badge">
                        <FileCode2 className={`h-3 w-3 ${lang.color}`} aria-hidden="true" />
                        {lang.name}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </Reveal>

        {/* ── QUICK START ── */}
        <Reveal>
          <section id="quick-start" className="mx-auto max-w-3xl px-6 py-20">
            <SectionHead eyebrow="Quick Start" title="Install once. Pick your agent.">
              Setup writes the agent config, registers the current project, indexes it, and keeps
              the workspace synced while MCP is running.
            </SectionHead>
            <ol className="space-y-8">
              <li className="flex gap-4">
                <span className="mt-1 flex size-7 shrink-0 items-center justify-center rounded-full bg-accent font-mono text-xs font-bold text-accent-foreground">
                  1
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="mb-2 text-sm font-semibold">Install the CLI</h3>
                  <CommandBox command="npm install -g @openez-graph/cli" />
                </div>
              </li>
              <li className="flex gap-4">
                <span className="mt-1 flex size-7 shrink-0 items-center justify-center rounded-full bg-accent font-mono text-xs font-bold text-accent-foreground">
                  2
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="mb-2 text-sm font-semibold">Connect your agent</h3>
                  <AgentTabs prefix="openez setup" suffix=" ." />
                </div>
              </li>
              <li className="flex gap-4">
                <span className="mt-1 flex size-7 shrink-0 items-center justify-center rounded-full bg-accent font-mono text-xs font-bold text-accent-foreground">
                  3
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="mb-2 text-sm font-semibold">Check the index</h3>
                  <CommandBox command="openez status ." />
                </div>
              </li>
            </ol>
          </section>
        </Reveal>

        {/* ── FINAL CTA ── */}
        <Reveal>
          <section className="mx-auto max-w-4xl px-6 pb-28">
            <div className="cta-panel rounded-2xl border p-8 text-center sm:p-12">
              <h2 className="mb-3 text-balance text-3xl font-black tracking-tight sm:text-4xl">
                Give your agent durable context
              </h2>
              <p className="mx-auto mb-8 max-w-md text-sm leading-relaxed text-muted-foreground">
                Index once, query forever. Everything stays on your machine in local SQLite.
              </p>
              <div className="mx-auto mb-6 max-w-md text-left">
                <CommandBox command="npx @openez-graph/cli setup codex" />
              </div>
              <div className="flex flex-wrap items-center justify-center gap-4">
                <a
                  href={`${REPO_URL}#readme`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 rounded-lg bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground transition-all hover:brightness-110 active:scale-[0.98]"
                >
                  Read the docs <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </a>
                <GitHubStars repo={REPO} initialCount={starCount} />
              </div>
            </div>
          </section>
        </Reveal>
      </main>

      <Footer />
    </div>
  );
}
