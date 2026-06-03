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
} from "lucide-react";
import { Reveal } from "./components/reveal";
import { Typewriter } from "./components/typewriter";
import { AnimatedCounter } from "./components/animated-counter";

const cliCommands = [
  "openez init .",
  `openez query "find auth"`,
  "openez serve --mcp",
  "openez status .",
  "openez reindex .",
  "openez watch .",
  "openez setup claude",
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
    desc: "Full-text search across all chunks, expanded through graph neighbor traversal. Optional embedding reranking — no vector database required for the default path.",
  },
  {
    icon: Network,
    title: "Knowledge Graph",
    desc: "Every indexed symbol becomes a node. Every import, reference, and relationship becomes an edge. Explore the graph in 3D from the web dashboard.",
  },
  {
    icon: Workflow,
    title: "Incremental & Watch",
    desc: "Index only what changed with incremental mode. Or run `openez watch` and let chokidar re-index files automatically on every save.",
  },
  {
    icon: Radio,
    title: "MCP Protocol",
    desc: "Expose any indexed workspace through the Model Context Protocol. AI agents (Claude, Codex, OpenCode) can query your codebase natively through MCP tools.",
  },
  {
    icon: Puzzle,
    title: "Editor Integrations",
    desc: "One command to wire up: `openez setup claude`, `openez setup codex`, or `openez setup opencode`. No manual JSON editing.",
  },
];

const stats = [
  { label: "CLI Commands", target: 7, suffix: "" },
  { label: "Supported Languages", target: 9, suffix: "" },
  { label: "Access Points", target: 3, suffix: "" },
  { label: "External Deps", target: 0, suffix: "" },
];

const mcpConfig = `{
▸ "mcpServers": {
▸▸ "openez": {
▸▸▸ "command": "npx",
▸▸▸ "args": ["-y", "openez", "serve", "--mcp"],
▸▸▸ "env": {
▸▸▸▸ "HOME": "/Users/you"
▸▸▸ }
▸▸ }
▸ }
}`;

export default function LandingPage() {
  return (
    <>
      <div className="scanline" />
      <div className="min-h-svh bg-background text-foreground dot-grid overflow-hidden">
        {/* ── HERO ── */}
        <section className="relative flex flex-col items-center justify-center min-h-svh px-6 py-24 text-center overflow-hidden">
          <div className="glow-orb top-1/4 left-1/2 -translate-x-1/2" />
          <div className="glow-orb--alt top-3/4 left-1/4" />

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

          <div className="relative max-w-3xl mx-auto">
            <div
              className="inline-flex items-center gap-2 rounded-full border bg-accent/30 px-4 py-1.5 text-xs font-medium text-accent-foreground mb-8 tracking-wider uppercase font-mono"
              style={{
                animation: "fadeUp 0.5s ease 0.3s forwards",
                opacity: 0,
              }}
            >
              <Star className="h-3 w-3" />
              OpenEZ Graph v0.2.0
            </div>

            <h1
              className="hero-glitch text-[clamp(2.5rem,7vw,5rem)] leading-[1.05] font-black tracking-tight mb-6 text-balance"
              data-text="Understand Your Codebase"
              style={{
                fontFamily: "'Archivo Black', sans-serif",
                animation: "fadeUp 0.6s ease 0.5s forwards",
                opacity: 0,
              }}
            >
              <span className="gradient-text">
                Understand
                <br />
                Your Codebase
              </span>
            </h1>

            <p
              className="text-base sm:text-lg text-muted-foreground max-w-xl mx-auto mb-10 text-pretty leading-relaxed"
              style={{
                animation: "fadeUp 0.6s ease 0.7s forwards",
                opacity: 0,
              }}
            >
              A local-first code intelligence engine that indexes your projects
              into a searchable knowledge graph — no cloud, no Postgres, no
              setup friction.
            </p>

            <div
              className="flex items-center justify-center gap-4 flex-wrap"
              style={{
                animation: "fadeUp 0.6s ease 0.9s forwards",
                opacity: 0,
              }}
            >
              <a
                href="https://github.com/giogio/openez-graph"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-lg bg-primary text-primary-foreground px-7 py-3 text-sm font-semibold hover:brightness-110 transition-all active:scale-[0.98]"
              >
                Get Started <ArrowRight className="h-4 w-4" />
              </a>
              <a
                href="https://github.com/giogio/openez-graph"
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
                  title: "Query & Explore",
                  desc: "Full-text search across all chunks, expanded through graph neighbor traversal. Visualize relationships in the 3D graph explorer or query via the CLI.",
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
              AI Integration
            </p>
            <h2
              className="text-3xl sm:text-4xl font-black tracking-tight mb-4"
              style={{ fontFamily: "'Archivo Black', sans-serif" }}
            >
              Plug into any AI agent
            </h2>
            <p className="text-sm text-muted-foreground max-w-lg mx-auto mb-10 text-pretty">
              OpenEZ implements the Model Context Protocol — the standard for
              connecting AI coding agents to local tools. Add one entry to your
              MCP config and every Claude or Codex session gets instant codebase
              understanding.
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
                <p className="font-mono text-xs text-muted-foreground mb-3 uppercase tracking-wide">
                  ~/.config/claude/mcp.json
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
                <h3 className="font-semibold text-sm mb-4">Works with:</h3>
                <ul className="space-y-3">
                  {[
                    {
                      name: "Claude Desktop / Code",
                      desc: "MCP-native, no plugins needed",
                    },
                    {
                      name: "GitHub Codex",
                      desc: "Connect via openez setup codex",
                    },
                    {
                      name: "OpenCode / Cursor",
                      desc: "Drop-in MCP server config",
                    },
                  ].map((item) => (
                    <li key={item.name} className="flex gap-3">
                      <Braces className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                      <div>
                        <div className="text-sm font-medium">{item.name}</div>
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
              {[
                {
                  icon: Terminal,
                  title: "CLI",
                  items: ["pnpm openez init", "pnpm openez query"],
                },
                {
                  icon: Radio,
                  title: "MCP Server",
                  items: [
                    "openez serve --mcp",
                    "Connect AI agents",
                    "Claude, Codex, OpenCode",
                  ],
                },
                {
                  icon: Database,
                  title: "Web Dashboard",
                  items: [
                    "Workspace management",
                    "3D graph explorer",
                    "Settings & jobs",
                  ],
                },
              ].map((ecosystem) => (
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
