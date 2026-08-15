import {
  Search,
  Network,
  Database,
  Terminal,
  Puzzle,
  ArrowRight,
  Star,
  FileCode2,
  Layers,
  Workflow,
  Radio,
  Braces,
  AlertTriangle,
  Check,
} from "lucide-react";
import { Reveal } from "./components/reveal";
import { Typewriter } from "./components/typewriter";
import { AnimatedCounter } from "./components/animated-counter";
import { GitHubStars } from "./components/github-stars";
import { HeroGraph } from "./components/graph-loader";
import { DashboardPreview } from "./components/dashboard-preview";
import { Footer } from "./components/footer";

const cliCommands = [
  "npm install -g @openez-graph/cli",
  "openez setup codex .",
  "openez setup claude .",
  "openez setup opencode .",
  "openez setup windsurf .",
  "openez setup devin .",
  "openez status .",
];

const terminalOutput = [
  "MCP  code_query      ranked code + documentation",
  "MCP  code_context    graph-adjacent context",
  "MCP  graph_neighbors inspect nodes and edges",
  "MCP  memory_recall   durable project decisions",
  "",
  "STORE  ~/.openez/registry.sqlite",
  "STORE  .openez/index.sqlite",
  "",
  "> openez status .",
  "  workspace: openez-graph",
  "  index: completed",
  "  documents: 126 | chunks: 833",
  "  nodes: 1,520 | edges: 2,530",
];

const mcpTools = [
  "code_query",
  "code_context",
  "graph_neighbors",
  "list_workspaces",
  "memory_recall",
  "memory_write",
  "index_workspace",
];

const languages = [
  { name: "TypeScript", color: "text-blue-400" },
  { name: "JavaScript", color: "text-yellow-400" },
  { name: "Python", color: "text-green-400" },
  { name: "Go", color: "text-cyan-400" },
  { name: "Rust", color: "text-orange-400" },
  { name: "YAML", color: "text-red-400" },
  { name: "JSON", color: "text-emerald-400" },
  { name: "TOML", color: "text-purple-400" },
  { name: "Markdown", color: "text-sky-400" },
];

const features = [
  {
    icon: Layers,
    title: "Semantic Indexing",
    desc: "TS/JS gets full AST-level indexing via ts-morph. Python, Go, Rust get tree-sitter AST parsing with regex fallback. Docs and config files get structure-aware chunking — all stored in local SQLite.",
  },
  {
    icon: Search,
    title: "Hybrid RAG Retrieval",
    desc: "Full-text search fused with optional vector embeddings (bge-m3 / OpenAI) via Reciprocal Rank Fusion. 95.65% recall@5. Graph expansion follows call/import edges — no external vector DB required.",
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
    title: "Seven MCP tools",
    desc: "Give agents ranked retrieval, graph context, workspace inventory, durable memory, and indexing controls through a focused MCP tool surface.",
  },
  {
    icon: Puzzle,
    title: "Five agent integrations",
    desc: "One setup command connects Codex, Claude Code, OpenCode, Windsurf, or Devin. OpenEZ writes the right config, so you do not have to.",
  },
];

const stats = [
  { label: "MCP tools", target: 7, suffix: "" },
  { label: "Indexed formats", target: 9, suffix: "" },
  { label: "Agent setups", target: 5, suffix: "" },
  { label: "Local database", target: 1, suffix: "" },
];

export default async function LandingPage() {
  let starCount: number | null = null;
  try {
    const res = await fetch("https://api.github.com/repos/asta-nguyen/openez-graph", {
      next: { revalidate: 3600 },
    });
    if (res.ok) {
      const data = await res.json();
      if (Number.isFinite(data.stargazers_count)) {
        starCount = data.stargazers_count;
      }
    }
  } catch {}

  let cliVersion = "0.11.1";
  try {
    const res = await fetch("https://registry.npmjs.org/@openez-graph/cli/latest", {
      next: { revalidate: 3600 },
    });
    if (res.ok) {
      const data = await res.json();
      if (Object.prototype.toString.call(data.version) === "[object String]") {
        cliVersion = data.version;
      }
    }
  } catch {}

  return (
    <>
      <div className="scanline" />
      <div className="min-h-svh bg-background text-foreground dot-grid overflow-hidden">
        <header className="absolute inset-x-0 top-0 z-30 px-6 py-5">
          <nav
            className="mx-auto flex max-w-7xl items-center justify-between"
            aria-label="Primary navigation"
          >
            <a href="#top" className="font-heading text-sm font-black tracking-[-0.04em]">
              OPEN<span className="text-primary">EZ</span>
            </a>
            <div className="hidden items-center gap-7 text-xs text-muted-foreground sm:flex">
              <a className="nav-link" href="#product">
                Product
              </a>
              <a className="nav-link" href="#quick-start">
                Quick start
              </a>
              <a className="nav-link" href="#agents">
                MCP
              </a>
            </div>
            <a
              href="https://github.com/asta-nguyen/openez-graph"
              target="_blank"
              rel="noopener noreferrer"
              className="nav-link text-xs font-medium text-foreground"
            >
              GitHub ↗
            </a>
          </nav>
        </header>

        {/* ── HERO ── */}
        <section
          id="top"
          className="relative flex min-h-svh items-center overflow-hidden px-6 py-32"
        >
          <div className="glow-orb top-1/4 left-1/2 -translate-x-1/2" />
          <div className="glow-orb--alt top-3/4 left-1/4" />

          {/* Abstract graph background */}
          <HeroGraph />

          {/* Floating particles */}
          <div className="absolute inset-0 overflow-hidden pointer-events-none">
            {[...Array(12)].map((_, i) => (
              <div
                key={i}
                className="particle"
                style={{
                  top: `${15 + Math.random() * 70}%`,
                  left: `${10 + Math.random() * 80}%`,
                  animationDelay: `${Math.random() * 5}s`,
                  animationDuration: `${6 + Math.random() * 8}s`,
                  width: `${2 + Math.random() * 3}px`,
                  height: `${2 + Math.random() * 3}px`,
                  opacity: 0.15 + Math.random() * 0.25,
                }}
              />
            ))}
          </div>

          {/* Terminal background overlay */}
          <div className="hero-terminal-bg">
            <div>
              {terminalOutput.join("\n")}
              {"\n"}
              {terminalOutput.join("\n")}
            </div>
          </div>

          <div className="relative mx-auto grid w-full max-w-7xl items-center gap-14 lg:grid-cols-[1.08fr_0.92fr]">
            <div className="text-left">
              <div
                className="mb-8 inline-flex items-center gap-2 border-l-2 border-primary bg-accent/30 px-3 py-1.5 font-mono text-xs font-medium tracking-wider text-accent-foreground"
                style={{
                  animation: "fadeUp 0.5s ease 0.3s forwards",
                  opacity: 0,
                }}
              >
                <Star className="h-3 w-3" />
                OpenEZ Graph v{cliVersion} · local-first RAG
              </div>

              <h1
                className="hero-glitch mb-6 text-[clamp(2.8rem,6.5vw,5.8rem)] font-black leading-[0.96] tracking-[-0.065em] text-balance"
                data-text="Durable context for coding agents"
                style={{
                  fontFamily: "var(--font-heading), sans-serif",
                  animation: "fadeUp 0.6s ease 0.5s forwards",
                  opacity: 0,
                }}
              >
                <span className="gradient-text">
                  Durable context
                  <br />
                  for coding agents
                </span>
              </h1>

              <p
                className="mb-7 max-w-xl text-base leading-relaxed text-muted-foreground text-pretty sm:text-lg"
                style={{
                  animation: "fadeUp 0.6s ease 0.7s forwards",
                  opacity: 0,
                }}
              >
                Index code once. Let Codex, Claude, OpenCode, Windsurf, and Devin retrieve ranked
                code, graph context, and project memory from local SQLite.
              </p>

              <div
                className="hero-install"
                style={{
                  animation: "fadeUp 0.6s ease 0.8s forwards",
                  opacity: 0,
                }}
              >
                <span className="select-none text-primary">$</span>
                <code>npx @openez-graph/cli setup codex</code>
                <Terminal
                  className="ml-auto h-3.5 w-3.5 text-muted-foreground"
                  aria-hidden="true"
                />
              </div>

              <div
                className="flex flex-wrap items-center gap-4"
                style={{
                  animation: "fadeUp 0.6s ease 0.9s forwards",
                  opacity: 0,
                }}
              >
                <a
                  href="#quick-start"
                  className="inline-flex items-center gap-2 rounded-lg bg-primary text-primary-foreground px-7 py-3 text-sm font-semibold hover:brightness-110 transition-all active:scale-[0.98]"
                >
                  Connect your agent <ArrowRight className="h-4 w-4" />
                </a>
                <GitHubStars repo="asta-nguyen/openez-graph" initialCount={starCount} />
              </div>
            </div>

            <aside className="mcp-surface" aria-label="OpenEZ MCP tool surface">
              <div className="mcp-surface__header">
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-primary">
                    MCP server
                  </p>
                  <h2 className="mt-1 text-base font-semibold">Tools exposed to your agent</h2>
                </div>
                <span className="mcp-live">
                  <span />
                  ready
                </span>
              </div>
              <div className="mcp-tool-list">
                {mcpTools.map((tool, index) => (
                  <div className="mcp-tool" key={tool}>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      0{index + 1}
                    </span>
                    <code>{tool}</code>
                    <Check className="ml-auto h-3.5 w-3.5 text-primary" />
                  </div>
                ))}
              </div>
              <div className="mcp-surface__footer">
                <span>stdio transport</span>
                <span>SQLite · WAL</span>
                <span>multi-workspace</span>
              </div>
            </aside>
          </div>

          <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2">
            <span className="text-[10px] text-muted-foreground tracking-widest uppercase font-mono">
              Scroll
            </span>
            <div className="w-px h-8 bg-linear-to-b from-muted-foreground/50 to-transparent" />
          </div>
        </section>

        {/* ── STATS ── */}
        <Reveal>
          <section className="px-6 py-16 max-w-4xl mx-auto">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-6">
              {stats.map((s) => (
                <div key={s.label} className="text-center">
                  <div className="stat-number">
                    <div className="stat-number-glow" />
                    <div
                      className="text-3xl sm:text-4xl font-black text-primary mb-1"
                      style={{ fontFamily: "var(--font-heading), sans-serif" }}
                    >
                      <AnimatedCounter target={s.target} suffix={s.suffix} />
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground uppercase tracking-wider font-mono">
                    {s.label}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </Reveal>

        {/* ── PROBLEM ── */}
        <Reveal delay={100}>
          <section className="px-6 py-24 section-full max-w-5xl mx-auto text-center">
            <p className="font-mono text-xs tracking-widest text-accent-foreground uppercase mb-3">
              The Problem
            </p>
            <h2
              className="text-3xl sm:text-4xl font-black tracking-tight mb-6"
              style={{ fontFamily: "var(--font-heading), sans-serif" }}
            >
              AI agents shouldn&apos;t have to re-read everything
            </h2>
            <p className="text-base text-muted-foreground max-w-2xl mx-auto mb-10 text-pretty leading-relaxed">
              Every time an AI coding agent starts a conversation, it reads your source files from
              scratch — burning tokens, context, and time on the same code it already saw yesterday.
            </p>

            <div className="grid sm:grid-cols-2 gap-5 text-left">
              {[
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
              ].map((p) => (
                <div key={p.title} className="problem-block card-hover">
                  <div className="flex items-center gap-3 mb-3 relative z-10">
                    <div className="flex items-center justify-center size-9 rounded-lg bg-accent text-accent-foreground">
                      <p.icon className="h-4 w-4" />
                    </div>
                    <h3 className="font-semibold text-sm">{p.title}</h3>
                  </div>
                  <p className="text-sm text-muted-foreground leading-relaxed relative z-10">
                    {p.desc}
                  </p>
                </div>
              ))}
            </div>
          </section>
        </Reveal>

        <div className="divider-line" />

        {/* ── LANGUAGES ── */}
        <Reveal delay={100}>
          <section className="px-6 py-20 max-w-5xl mx-auto text-center">
            <p className="font-mono text-xs tracking-widest text-accent-foreground uppercase mb-3">
              Index Anything
            </p>
            <h2
              className="text-3xl sm:text-4xl font-black tracking-tight mb-4"
              style={{ fontFamily: "var(--font-heading), sans-serif" }}
            >
              Every language you use
            </h2>
            <p className="text-sm text-muted-foreground max-w-lg mx-auto mb-10 text-pretty">
              Rich AST-level indexing for TypeScript and JavaScript. Tree-sitter AST parsing for
              Python, Go, and Rust. Structure-aware chunking for config files and documentation.
            </p>
            <div className="flex flex-wrap justify-center gap-2.5">
              {languages.map((lang) => (
                <span key={lang.name} className="lang-badge">
                  <FileCode2 className={`h-3 w-3 ${lang.color}`} />
                  {lang.name}
                </span>
              ))}
            </div>
          </section>
        </Reveal>

        <div className="divider-line" />

        {/* ── SCREENSHOTS ── */}
        <Reveal delay={100}>
          <section id="product" className="section-full px-6 py-20 text-center">
            <p className="font-mono text-xs tracking-widest text-accent-foreground uppercase mb-3">
              See it in action
            </p>
            <h2
              className="text-3xl sm:text-4xl font-black tracking-tight mb-4"
              style={{ fontFamily: "var(--font-heading), sans-serif" }}
            >
              What it looks like
            </h2>
            <p className="text-sm text-muted-foreground max-w-lg mx-auto mb-12 text-pretty">
              Inspect workspace state, measured MCP query telemetry, memories, documents, and symbol
              relationships from one local management UI.
            </p>
            <div className="max-w-5xl mx-auto">
              <div
                className="screenshot-card"
                style={{
                  animation: "slideInLeft 0.6s ease 0.1s forwards",
                  opacity: 0,
                  height: "460px",
                }}
              >
                <DashboardPreview />
              </div>
            </div>
          </section>
        </Reveal>

        {/* ── HOW IT WORKS ── */}
        <Reveal delay={100}>
          <section className="px-6 py-20 max-w-7xl mx-auto">
            <p className="font-mono text-xs tracking-widest text-accent-foreground uppercase mb-3 text-center">
              Architecture
            </p>
            <h2
              className="text-3xl sm:text-4xl font-black tracking-tight mb-16 text-center"
              style={{ fontFamily: "var(--font-heading), sans-serif" }}
            >
              How it works
            </h2>
            <div className="timeline">
              <div className="timeline-line" />
              {[
                {
                  step: "01",
                  alt: false,
                  title: "Init & Index",
                  desc: "Run `openez init` to register a workspace. The indexer parses your codebase into documents, chunks, graph nodes, and edges — stored locally in SQLite (WAL mode).",
                },
                {
                  step: "02",
                  alt: true,
                  title: "Query & Explore",
                  desc: "Full-text search across indexed chunks, expanded through graph neighbor traversal. Inspect relationships in the graph explorer or retrieve focused context through MCP.",
                },
                {
                  step: "03",
                  alt: false,
                  title: "Connect & Automate",
                  desc: "Expose your indexed runtime through MCP for AI agents, the CLI for scripts, or the web dashboard. All three point at the same SQLite store.",
                },
              ].map((s) => (
                <div key={s.step} className="timeline-step">
                  <div className={`timeline-dot ${s.alt ? "timeline-dot--alt" : ""}`} />
                  <div className="timeline-body">
                    <div className="timeline-step-num">{s.step}</div>
                    <h3 className="font-semibold text-sm mb-2">{s.title}</h3>
                    <p className="text-sm text-muted-foreground leading-relaxed">{s.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </Reveal>

        <div className="divider-line" />

        {/* ── CLI TYPEWRITER (expanded) ── */}
        <Reveal delay={100}>
          <section id="quick-start" className="section-full px-6 py-20">
            <p className="font-mono text-xs tracking-widest text-accent-foreground uppercase mb-3 text-center">
              Quick Start
            </p>
            <h2
              className="text-3xl sm:text-4xl font-black tracking-tight mb-2 text-center"
              style={{ fontFamily: "var(--font-heading), sans-serif" }}
            >
              Install once. Pick your agent.
            </h2>
            <p className="text-sm text-muted-foreground text-center mb-10 max-w-md mx-auto">
              Setup writes the agent config, registers the current project, indexes it, and keeps
              the workspace synced while MCP is running.
            </p>
            <div className="max-w-3xl mx-auto">
              <div
                className="rounded-xl border bg-[oklch(0.07_0_0)]"
                style={{ fontFamily: "var(--font-mono), monospace" }}
              >
                <div className="flex items-center gap-1.5 px-5 py-3 border-b border-border">
                  <span className="size-2.5 rounded-full bg-destructive" />
                  <span className="size-2.5 rounded-full bg-amber-500" />
                  <span className="size-2.5 rounded-full bg-green-500" />
                  <span className="ml-3 text-[11px] text-muted-foreground tracking-wide">
                    openez — zsh
                  </span>
                </div>
                <div className="p-6 min-h-[260px]">
                  <Typewriter lines={cliCommands} speed={50} />
                </div>
              </div>
            </div>
          </section>
        </Reveal>

        <div className="divider-line" />

        {/* ── FEATURES ── */}
        <Reveal delay={100}>
          <section className="px-6 py-20 max-w-5xl mx-auto">
            <p className="font-mono text-xs tracking-widest text-accent-foreground uppercase mb-3 text-center">
              Capabilities
            </p>
            <h2
              className="text-3xl sm:text-4xl font-black tracking-tight mb-12 text-center"
              style={{ fontFamily: "var(--font-heading), sans-serif" }}
            >
              What you get
            </h2>
            <div className="grid gap-5 sm:grid-cols-2">
              {features.map((f, i) => (
                <div
                  key={f.title}
                  className="card-hover rounded-xl border bg-card p-6"
                  style={{
                    animation: `fadeUp 0.5s ease ${0.1 + i * 0.08}s forwards`,
                    opacity: 0,
                  }}
                >
                  <div className="flex items-center gap-3 mb-3">
                    <div className="flex items-center justify-center size-9 rounded-lg bg-accent text-accent-foreground">
                      <f.icon className="h-4 w-4" />
                    </div>
                    <h3 className="font-semibold text-sm">{f.title}</h3>
                  </div>
                  <p className="text-sm text-muted-foreground leading-relaxed">{f.desc}</p>
                </div>
              ))}
            </div>
          </section>
        </Reveal>

        {/* ── MCP SETUP ── */}
        <Reveal delay={100}>
          <section id="agents" className="section-full px-6 py-20 text-center">
            <p className="font-mono text-xs tracking-widest text-accent-foreground uppercase mb-3">
              AI Integration
            </p>
            <h2
              className="text-3xl sm:text-4xl font-black tracking-tight mb-4"
              style={{ fontFamily: "var(--font-heading), sans-serif" }}
            >
              A focused tool surface for agents
            </h2>
            <p className="text-sm text-muted-foreground max-w-lg mx-auto mb-10 text-pretty">
              OpenEZ exposes seven workspace-aware tools over MCP. Read tools can search one or many
              workspaces; memory writes and indexing stay scoped to a single workspace.
            </p>

            <div className="grid sm:grid-cols-5 gap-6">
              {/* Config block */}
              <div
                className="sm:col-span-3 text-left"
                style={{
                  animation: "slideInLeft 0.6s ease forwards",
                  opacity: 0,
                }}
              >
                <p className="mb-3 font-mono text-xs uppercase tracking-wide text-muted-foreground">
                  Choose one
                </p>
                <div className="agent-commands">
                  {["codex", "claude", "opencode", "windsurf", "devin"].map((agent) => (
                    <div key={agent}>
                      <span>$</span>
                      <code>openez setup {agent} .</code>
                    </div>
                  ))}
                </div>
              </div>

              {/* Integration checklist */}
              <div
                className="sm:col-span-2 text-left flex flex-col justify-center"
                style={{
                  animation: "slideInRight 0.6s ease 0.15s forwards",
                  opacity: 0,
                }}
              >
                <h3 className="font-semibold text-sm mb-4">Works with:</h3>
                <ul className="space-y-3">
                  {[
                    {
                      name: "Retrieval",
                      desc: "Ranked FTS, graph expansion, and optional vector reranking",
                    },
                    {
                      name: "Durable context",
                      desc: "Recall and write technical decisions between sessions",
                    },
                    {
                      name: "Workspace control",
                      desc: "List, resolve, and index local workspaces",
                    },
                  ].map((item) => (
                    <li key={item.name} className="flex gap-3">
                      <Braces className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                      <div>
                        <div className="text-sm font-medium">{item.name}</div>
                        <div className="text-xs text-muted-foreground">{item.desc}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </section>
        </Reveal>

        {/* ── ECOSYSTEM (flow diagram) ── */}
        <Reveal delay={100}>
          <section className="px-6 py-20 max-w-5xl mx-auto text-center">
            <p className="font-mono text-xs tracking-widest text-accent-foreground uppercase mb-3">
              Everywhere you need it
            </p>
            <h2
              className="text-3xl sm:text-4xl font-black tracking-tight mb-12"
              style={{ fontFamily: "var(--font-heading), sans-serif" }}
            >
              One runtime, three surfaces
            </h2>
            <div className="diagram-flow">
              <div className="diagram-node">
                <div className="diagram-node-icon">
                  <Terminal className="h-4 w-4" />
                </div>
                <div className="diagram-node-label">CLI</div>
                <div className="diagram-node-desc">
                  init, index, status
                  <br />
                  watch, serve, setup
                </div>
              </div>

              <div className="diagram-arrow">
                <div className="diagram-arrow-line" />
                <span className="diagram-arrow-label">local state</span>
              </div>

              <div className="diagram-node">
                <div className="diagram-node-icon">
                  <Radio className="h-4 w-4" />
                </div>
                <div className="diagram-node-label">SQLite Runtime</div>
                <div className="diagram-node-desc">
                  registry + workspace DBs
                  <br />
                  FTS + graph + memory
                </div>
              </div>

              <div className="diagram-arrow">
                <div className="diagram-arrow-line" />
                <span className="diagram-arrow-label">shared by</span>
              </div>

              <div className="diagram-node">
                <div className="diagram-node-icon">
                  <Database className="h-4 w-4" />
                </div>
                <div className="diagram-node-label">MCP + Dashboard</div>
                <div className="diagram-node-desc">
                  agent tools + telemetry
                  <br />
                  graph inspection
                </div>
              </div>
            </div>
          </section>
        </Reveal>

        {/* ── FOOTER ── */}
        <Footer />
      </div>
    </>
  );
}
