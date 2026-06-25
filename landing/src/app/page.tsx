import {
  Search,
  Network,
  Database,
  Terminal,
  ArrowRight,
  Star,
  FileCode2,
  Layers,
  Workflow,
  Radio,
  Braces,
  AlertTriangle,
  Package,
  ShieldCheck,
  CheckCircle2,
  Server,
} from "lucide-react";
import { Reveal } from "./components/reveal";
import { Typewriter } from "./components/typewriter";
import { AnimatedCounter } from "./components/animated-counter";

const cliCommands = [
  "npm install -g @openez-graph/cli",
  "openez setup codex",
  "openez init .",
  "openez index .",
  "openez serve --mcp",
  "openez status .",
  "openez reindex .",
];

const installSteps = [
  {
    title: "Install the package",
    command: "npm install -g @openez-graph/cli",
    desc: "Published as the global openez command for Node.js 20+.",
  },
  {
    title: "Wire your agent",
    command: "openez setup codex",
    desc: "Also supports setup claude and setup opencode.",
  },
  {
    title: "Let MCP resolve the workspace",
    command: "openez serve --mcp",
    desc: "Uses workspace.json, the registry, or an explicit path.",
  },
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
    desc: "TS/JS gets full AST-level indexing via ts-morph. Python, Go, Rust get top-level symbol extraction. Docs and config files get structure-aware chunking — all stored in local SQLite.",
  },
  {
    icon: Search,
    title: "FTS + Graph Retrieval",
    desc: "Full-text search across indexed chunks, expanded through graph neighbor traversal. Embeddings are optional — no vector database required for the default path.",
  },
  {
    icon: Network,
    title: "Knowledge Graph",
    desc: "Indexed symbols, files, imports, references, and docs become graph nodes and edges you can inspect from MCP or the management UI.",
  },
  {
    icon: Workflow,
    title: "Incremental & Watch",
    desc: "Index only what changed with incremental mode. Use `openez watch` for local re-indexing, or opt into MCP watch mode when you need live sync.",
  },
  {
    icon: Radio,
    title: "MCP Server",
    desc: "Expose one or many indexed workspaces through MCP tools for Claude Code, Codex, OpenCode, and any client that can launch a stdio server.",
  },
  {
    icon: ShieldCheck,
    title: "Local-first Runtime",
    desc: "The registry and workspace indexes live in SQLite under your machine and project. No Docker, Postgres, Redis, or hosted service is required.",
  },
];

const mcpTools = [
  {
    name: "list_workspaces",
    desc: "Show registered workspaces and status.",
  },
  {
    name: "memory_query",
    desc: "Full-text retrieval with graph expansion.",
  },
  {
    name: "code_context",
    desc: "Symbol or file context with nearby graph relationships.",
  },
  {
    name: "graph_neighbors",
    desc: "Inspect raw nodes and edges by label or node ID.",
  },
  {
    name: "memory_write",
    desc: "Persist technical decisions and learned project notes.",
  },
  {
    name: "index_workspace",
    desc: "Trigger incremental or full indexing from the agent.",
  },
];

const agentSupport = [
  {
    name: "Codex",
    command: "openez setup codex",
    desc: "Writes `~/.codex/config.toml` with the OpenEZ MCP server.",
  },
  {
    name: "Claude Code",
    command: "openez setup claude",
    desc: "Writes `~/.claude/settings.json` with the same local runtime.",
  },
  {
    name: "OpenCode",
    command: "openez setup opencode",
    desc: "Writes `~/.config/opencode/opencode.json` for MCP access.",
  },
];

const installCommands = [
  "npm install -g @openez-graph/cli",
  "openez setup codex",
  "openez list",
];

const ecosystem = [
  {
    icon: Terminal,
    title: "CLI",
    items: ["openez init", "openez index", "openez status", "openez list"],
  },
  {
    icon: Server,
    title: "MCP Server",
    items: [
      "openez serve --mcp",
      "Multi-workspace reads",
      "Claude, Codex, OpenCode",
    ],
  },
  {
    icon: Database,
    title: "Web Dashboard",
    items: [
      "Workspace management",
      "Graph explorer",
      "Local SQLite inspection",
    ],
  },
];

const stats = [
  { label: "MCP Tools", target: 6, suffix: "" },
  { label: "Supported Languages", target: 9, suffix: "" },
  { label: "Agent Setups", target: 3, suffix: "" },
  { label: "External Deps", target: 0, suffix: "" },
];

const mcpConfig = `{
▸ "mcpServers": {
▸▸ "openez": {
▸▸▸ "command": "openez",
▸▸▸ "args": ["serve", "--mcp"],
▸▸▸ "startupTimeoutSec": 120
▸▸ }
▸ }
}`;

export default function LandingPage() {
  return (
    <>
      <div className="scanline" />
      <div className="min-h-svh bg-background text-foreground dot-grid overflow-hidden">
        {/* ── HERO ── */}
        <section className="relative flex min-h-[92svh] flex-col items-center justify-center px-6 py-20 text-center overflow-hidden">
          <div className="protocol-strip" />

          <div className="relative max-w-4xl mx-auto">
            <div
              className="inline-flex items-center gap-2 rounded-full border bg-accent/30 px-4 py-1.5 text-xs font-medium text-accent-foreground mb-8 tracking-wider uppercase font-mono"
              style={{
                animation: "fadeUp 0.5s ease 0.3s forwards",
                opacity: 0,
              }}
            >
              <Package className="h-3 w-3" />
              Published CLI package · MCP server included
            </div>

            <h1
              className="hero-glitch text-[clamp(2.5rem,7vw,5rem)] leading-[1.05] font-black tracking-tight mb-6 text-balance"
              data-text="Local MCP Memory for Codebases"
              style={{
                fontFamily: "'Archivo Black', sans-serif",
                animation: "fadeUp 0.6s ease 0.5s forwards",
                opacity: 0,
              }}
            >
              <span className="gradient-text">
                Local MCP Memory
                <br className="hidden sm:block" />
                {" "}for Codebases
              </span>
            </h1>

            <p
              className="text-base sm:text-lg text-muted-foreground max-w-2xl mx-auto mb-10 text-pretty leading-relaxed"
              style={{
                animation: "fadeUp 0.6s ease 0.7s forwards",
                opacity: 0,
              }}
            >
              Install <code>@openez-graph/cli</code>, run one setup command,
              and give Codex, Claude Code, or OpenCode a local SQLite-backed
              MCP server for full-text search, graph expansion, code context,
              and memory.
            </p>

            <div
              className="install-hero"
              style={{
                animation: "fadeUp 0.6s ease 0.82s forwards",
                opacity: 0,
              }}
            >
              {installCommands.map((command, index) => (
                <div key={command} className="command-line">
                  <span className="text-accent-foreground">$</span>
                  <span>{command}</span>
                  {index === 0 ? (
                    <span className="ml-auto rounded bg-primary/15 px-2 py-0.5 text-[10px] text-primary">
                      npm
                    </span>
                  ) : null}
                </div>
              ))}
            </div>

            <div
              className="flex items-center justify-center gap-4 flex-wrap"
              style={{
                animation: "fadeUp 0.6s ease 0.9s forwards",
                opacity: 0,
              }}
            >
              <a
                href="https://www.npmjs.com/package/@openez-graph/cli"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-lg bg-primary text-primary-foreground px-7 py-3 text-sm font-semibold hover:brightness-110 transition-all active:scale-[0.98]"
              >
                Install the CLI <ArrowRight className="h-4 w-4" />
              </a>
              <a
                href="https://github.com/asta-nguyen/openez-graph"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-lg border px-7 py-3 text-sm font-medium hover:bg-muted transition-colors"
              >
                <Star className="h-4 w-4" />
                GitHub
              </a>
            </div>
          </div>

          <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2">
            <span className="text-[10px] text-muted-foreground tracking-widest uppercase font-mono">
              MCP tools below
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
                  <div
                    className="text-3xl sm:text-4xl font-black text-primary mb-1"
                    style={{ fontFamily: "'Archivo Black', sans-serif" }}
                  >
                    <AnimatedCounter target={s.target} suffix={s.suffix} />
                  </div>
                  <div className="text-xs text-muted-foreground uppercase tracking-wider font-mono">
                    {s.label}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </Reveal>

        {/* ── INSTALL ── */}
        <Reveal delay={80}>
          <section className="px-6 py-18 max-w-5xl mx-auto">
            <div className="grid lg:grid-cols-[0.95fr_1.05fr] gap-8 items-start">
              <div>
                <p className="font-mono text-xs tracking-widest text-accent-foreground uppercase mb-3">
                  Package install
                </p>
                <h2
                  className="text-3xl sm:text-4xl font-black tracking-tight mb-5"
                  style={{ fontFamily: "'Archivo Black', sans-serif" }}
                >
                  Published as a real CLI, not a repo-only script
                </h2>
                <p className="text-sm text-muted-foreground leading-relaxed max-w-lg">
                  The npm package exposes the <code>openez</code> binary. Agent setup
                  commands write MCP config for the client you use, then the
                  server resolves the current workspace from local project
                  state.
                </p>
              </div>
              <div className="grid gap-4">
                {installSteps.map((step, index) => (
                  <div key={step.title} className="install-step">
                    <span className="install-index">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <CheckCircle2 className="h-4 w-4 text-primary" />
                        <h3 className="text-sm font-semibold">{step.title}</h3>
                      </div>
                      <code>{step.command}</code>
                      <p>{step.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </Reveal>

        <div className="divider-line" />

        {/* ── PROBLEM ── */}
        <Reveal delay={100}>
          <section className="px-6 py-24 max-w-4xl mx-auto text-center">
            <p className="font-mono text-xs tracking-widest text-accent-foreground uppercase mb-3">
              The Problem
            </p>
            <h2
              className="text-3xl sm:text-4xl font-black tracking-tight mb-6"
              style={{ fontFamily: "'Archivo Black', sans-serif" }}
            >
              AI agents shouldn&apos;t have to re-read everything
            </h2>
            <p className="text-base text-muted-foreground max-w-2xl mx-auto mb-10 text-pretty leading-relaxed">
              Every time an AI coding agent starts a conversation, it reads your
              source files from scratch — burning tokens, context, and time on
              the same code it already saw yesterday.
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
              style={{ fontFamily: "'Archivo Black', sans-serif" }}
            >
              Every language you use
            </h2>
            <p className="text-sm text-muted-foreground max-w-lg mx-auto mb-10 text-pretty">
              Rich AST-level indexing for TypeScript and JavaScript. Symbol
              extraction for Python, Go, and Rust. Structure-aware chunking for
              config files and documentation.
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
          <section className="px-6 py-20 max-w-5xl mx-auto text-center">
            <p className="font-mono text-xs tracking-widest text-accent-foreground uppercase mb-3">
              See it in action
            </p>
            <h2
              className="text-3xl sm:text-4xl font-black tracking-tight mb-4"
              style={{ fontFamily: "'Archivo Black', sans-serif" }}
            >
              What it looks like
            </h2>
            <p className="text-sm text-muted-foreground max-w-lg mx-auto mb-12 text-pretty">
              A 3D knowledge graph of your codebase. Symbols are nodes,
              relationships are edges. Pan, orbit, zoom — explore how your code
              fits together.
            </p>
            <div className="max-w-4xl mx-auto">
              <div
                className="screenshot-card"
                style={{
                  animation: "slideInLeft 0.6s ease 0.1s forwards",
                  opacity: 0,
                }}
              >
                <img
                  src="/graph.png"
                  alt="3D knowledge graph of indexed codebase"
                />
              </div>
            </div>
          </section>
        </Reveal>

        <div className="divider-line" />

        {/* ── HOW IT WORKS ── */}
        <Reveal delay={100}>
          <section className="px-6 py-20 max-w-5xl mx-auto text-center">
            <p className="font-mono text-xs tracking-widest text-accent-foreground uppercase mb-3">
              Architecture
            </p>
            <h2
              className="text-3xl sm:text-4xl font-black tracking-tight mb-12"
              style={{ fontFamily: "'Archivo Black', sans-serif" }}
            >
              How it works
            </h2>
            <div className="grid sm:grid-cols-3 gap-6 text-left">
              {[
                {
                  step: "01",
                  title: "Init & Index",
                  desc: "Run `openez init` to register a workspace. The indexer parses your codebase into documents, chunks, graph nodes, and edges — stored locally in SQLite (WAL mode).",
                },
                {
                  step: "02",
                  title: "Retrieve & Explore",
                  desc: "Full-text search across all chunks, expanded through graph neighbor traversal. Inspect relationships through MCP tools or the graph explorer.",
                },
                {
                  step: "03",
                  title: "Connect & Automate",
                  desc: "Expose your indexed runtime through MCP for AI agents, the CLI for scripts, or the web dashboard. All three point at the same SQLite store.",
                },
              ].map((s) => (
                <div
                  key={s.step}
                  className="card-hover rounded-xl border bg-card p-6 relative"
                >
                  <span
                    className="text-5xl font-black text-primary/20 absolute -top-1 right-4"
                    style={{ fontFamily: "'Archivo Black', sans-serif" }}
                  >
                    {s.step}
                  </span>
                  <h3 className="font-semibold text-sm mb-2 relative z-10">
                    {s.title}
                  </h3>
                  <p className="text-sm text-muted-foreground leading-relaxed relative z-10">
                    {s.desc}
                  </p>
                </div>
              ))}
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
              style={{ fontFamily: "'Archivo Black', sans-serif" }}
            >
              What you get
            </h2>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
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
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {f.desc}
                  </p>
                </div>
              ))}
            </div>
          </section>
        </Reveal>

        <div className="divider-line" />

        {/* ── CLI TYPEWRITER ── */}
        <Reveal delay={100}>
          <section className="px-6 py-20 max-w-2xl mx-auto">
            <p className="font-mono text-xs tracking-widest text-accent-foreground uppercase mb-3 text-center">
              Quick Start
            </p>
            <h2
              className="text-3xl sm:text-4xl font-black tracking-tight mb-2 text-center"
              style={{ fontFamily: "'Archivo Black', sans-serif" }}
            >
              Ship faster, type less
            </h2>
            <p className="text-sm text-muted-foreground text-center mb-10 max-w-md mx-auto">
              Seven commands to manage your entire code intelligence workflow.
            </p>
            <div
              className="rounded-xl border bg-[oklch(0.07_0_0)] p-1"
              style={{ fontFamily: "'JetBrains Mono', monospace" }}
            >
              <div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-border">
                <span className="size-2.5 rounded-full bg-destructive" />
                <span className="size-2.5 rounded-full bg-amber-500" />
                <span className="size-2.5 rounded-full bg-green-500" />
                <span className="ml-2 text-[11px] text-muted-foreground tracking-wide">
                  openez — zsh
                </span>
              </div>
              <div className="p-5 min-h-[240px]">
                <Typewriter lines={cliCommands} speed={50} />
              </div>
            </div>
          </section>
        </Reveal>

        <div className="divider-line" />

        {/* ── MCP SETUP ── */}
        <Reveal delay={100}>
          <section className="px-6 py-20 max-w-5xl mx-auto text-center">
            <p className="font-mono text-xs tracking-widest text-accent-foreground uppercase mb-3">
              MCP Server Support
            </p>
            <h2
              className="text-3xl sm:text-4xl font-black tracking-tight mb-4"
              style={{ fontFamily: "'Archivo Black', sans-serif" }}
            >
              Six tools over one local server
            </h2>
            <p className="text-sm text-muted-foreground max-w-lg mx-auto mb-10 text-pretty">
              OpenEZ exposes the same SQLite registry and workspace indexes
              through MCP. Read tools support one workspace or many workspaces;
              write and indexing operations stay scoped to one workspace.
            </p>

            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-12 text-left">
              {mcpTools.map((tool) => (
                <div key={tool.name} className="tool-card">
                  <code>{tool.name}</code>
                  <p>{tool.desc}</p>
                </div>
              ))}
            </div>

            <div className="grid sm:grid-cols-5 gap-6">
              {/* Config block */}
              <div
                className="sm:col-span-3 text-left"
                style={{
                  animation: "slideInLeft 0.6s ease forwards",
                  opacity: 0,
                }}
              >
                <p className="font-mono text-xs text-muted-foreground mb-3 uppercase tracking-wide">
                  Manual MCP entry
                </p>
                <div className="mcp-block">
                  {mcpConfig.split("\n").map((line, i) => (
                    <div key={i}>
                      <span className="line-num">{i + 1}</span>
                      {syntaxHighlight(line)}
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
                <h3 className="font-semibold text-sm mb-4">Setup commands:</h3>
                <ul className="space-y-3">
                  {agentSupport.map((item) => (
                    <li key={item.name} className="flex gap-3">
                      <Braces className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                      <div>
                        <div className="text-sm font-medium">{item.name}</div>
                        <code className="agent-command">{item.command}</code>
                        <div className="text-xs text-muted-foreground">
                          {item.desc}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </section>
        </Reveal>

        <div className="divider-line" />

        {/* ── ECOSYSTEM ── */}
        <Reveal delay={100}>
          <section className="px-6 py-20 max-w-5xl mx-auto text-center">
            <p className="font-mono text-xs tracking-widest text-accent-foreground uppercase mb-3">
              Everywhere you need it
            </p>
            <h2
              className="text-3xl sm:text-4xl font-black tracking-tight mb-12"
              style={{ fontFamily: "'Archivo Black', sans-serif" }}
            >
              Three ways to connect
            </h2>
            <div className="grid sm:grid-cols-3 gap-5">
              {ecosystem.map((ecosystem) => (
                <div
                  key={ecosystem.title}
                  className="card-hover rounded-xl border bg-card p-6 text-left"
                >
                  <div className="flex items-center gap-3 mb-4">
                    <div className="flex items-center justify-center size-9 rounded-lg bg-accent text-accent-foreground">
                      <ecosystem.icon className="h-4 w-4" />
                    </div>
                    <h3 className="font-semibold text-sm">{ecosystem.title}</h3>
                  </div>
                  <ul className="space-y-2">
                    {ecosystem.items.map((item) => (
                      <li
                        key={item}
                        className="text-sm text-muted-foreground flex items-center gap-2"
                      >
                        <span className="size-1 rounded-full bg-accent-foreground/50 shrink-0" />
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        </Reveal>

        {/* ── FOOTER ── */}
        <footer className="border-t px-6 py-10">
          <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
            <span
              className="text-sm font-black tracking-tight"
              style={{ fontFamily: "'Archivo Black', sans-serif" }}
            >
              OPEN<span className="text-accent-foreground">EZ</span>
            </span>
            <span className="text-xs text-muted-foreground">
              Open source under the MIT License &mdash; built for developers who
              care how their code fits together.
            </span>
          </div>
        </footer>
      </div>
    </>
  );
}

function syntaxHighlight(line: string) {
  const parts: React.ReactNode[] = [];
  const trimmed = line.replace("▸", "  ");
  let i = 0;

  while (i < trimmed.length) {
    // Key before colon
    const keyMatch = trimmed.slice(i).match(/^("[^"]+")(?=\s*:)/);
    if (keyMatch) {
      parts.push(
        <span key={i} className="key">
          {keyMatch[1]}
        </span>,
      );
      i += keyMatch[0].length;
      continue;
    }
    // String value
    const strMatch = trimmed.slice(i).match(/^("[^"]*")/);
    if (strMatch) {
      parts.push(
        <span key={i} className="string">
          {strMatch[1]}
        </span>,
      );
      i += strMatch[0].length;
      continue;
    }
    // Comment
    const comMatch = trimmed.slice(i).match(/^(\/\/.*)/);
    if (comMatch) {
      parts.push(
        <span key={i} className="comment">
          {comMatch[1]}
        </span>,
      );
      i += comMatch[0].length;
      continue;
    }
    // Punctuation
    if (/[{}\[\],:]/.test(trimmed[i])) {
      parts.push(
        <span key={i} className="punctuation">
          {trimmed[i]}
        </span>,
      );
      i++;
      continue;
    }
    parts.push(trimmed[i]);
    i++;
  }

  return <>{parts}</>;
}
