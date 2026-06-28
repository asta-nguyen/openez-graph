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
import { GitHubStars } from "./components/github-stars";
import { HeroGraph } from "./components/graph-loader";
import { DashboardPreview } from "./components/dashboard-preview";
import { Footer } from "./components/footer";


const cliCommands = [
  "openez init .",
  `openez query "find auth"`,
  "openez serve --mcp",
  "openez status .",
  "openez reindex .",
  "openez watch .",
  "openez setup claude",
];

const terminalOutput = [
  "> openez query \"route handler\"",
  "  src/api/routes/auth.ts         AuthRoute     function",
  "  src/api/routes/users.ts        UserRoute     function",
  "  src/api/middleware/guard.ts     AuthGuard     class",
  "  src/core/router/index.ts       Router        class",
  "  ─────────────────────────────────────────────",
  "  4 results | 2 files | 0.23s",
  "",
  "> openez query \"Database\\|sqlite\"",
  "  src/core/db/connection.ts       SQLiteClient  class",
  "  src/core/db/migration.ts        Migration     class",
  "  src/core/db/repository.ts       Repository    class",
  "  ─────────────────────────────────────────────",
  "  3 results | 1 file | 0.12s",
  "",
  "> openez status .",
  "  workspace: openez-graph",
  "  last index: 2 minutes ago",
  "  files: 1,247 | symbols: 8,432",
  "  db size: 12.4 MB (WAL)",
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

export default async function LandingPage() {
  let starCount: number | null = null;
  try {
    const res = await fetch(
      "https://api.github.com/repos/asta-nguyen/openez-graph",
      { next: { revalidate: 3600 } },
    );
    if (res.ok) {
      const data = await res.json();
      if (typeof data.stargazers_count === "number") {
        starCount = data.stargazers_count;
      }
    }
  } catch {}

  return (
    <>
      <div className="scanline" />
      <div className="min-h-svh bg-background text-foreground dot-grid overflow-hidden">
        {/* ── HERO ── */}
        <section className="relative flex flex-col items-center justify-center min-h-[110svh] px-6 py-32 text-center overflow-hidden">
          <div className="glow-orb top-1/4 left-1/2 -translate-x-1/2" />
          <div className="glow-orb--alt top-3/4 left-1/4" />

          {/* 3D graph background (auto-rotating) */}
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
                fontFamily: "var(--font-heading), sans-serif",
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
              className="text-base sm:text-lg text-muted-foreground max-w-xl mx-auto mb-8 text-pretty leading-relaxed"
              style={{
                animation: "fadeUp 0.6s ease 0.7s forwards",
                opacity: 0,
              }}
            >
              A local-first code intelligence engine that indexes your projects
              into a searchable knowledge graph — no cloud, no Postgres, no
              setup friction.
            </p>

            {/* Signal wave indicator */}
            <div
              className="signal-wave"
              style={{
                animation: "fadeUp 0.6s ease 0.8s forwards",
                opacity: 0,
              }}
            />

            <div
              className="flex items-center justify-center gap-4 flex-wrap"
              style={{
                animation: "fadeUp 0.6s ease 0.9s forwards",
                opacity: 0,
              }}
            >
              <a
                href="https://github.com/asta-nguyen/openez-graph"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-lg bg-primary text-primary-foreground px-7 py-3 text-sm font-semibold hover:brightness-110 transition-all active:scale-[0.98]"
              >
                Get Started <ArrowRight className="h-4 w-4" />
              </a>
              <GitHubStars repo="asta-nguyen/openez-graph" initialCount={starCount} />
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
              style={{ fontFamily: "var(--font-heading), sans-serif" }}
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
          <section className="section-full px-6 py-20 text-center">
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
              A familiar dashboard interface with the full 3D knowledge graph
              right where you need it — explore symbols, relationships, and
              references by orbiting through your codebase.
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
                  desc: "Full-text search across all chunks, expanded through graph neighbor traversal. Visualize relationships in the 3D graph explorer or query via the CLI.",
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
                    <p className="text-sm text-muted-foreground leading-relaxed">
                      {s.desc}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </Reveal>

        <div className="divider-line" />

        {/* ── CLI TYPEWRITER (expanded) ── */}
        <Reveal delay={100}>
          <section className="section-full px-6 py-20">
            <p className="font-mono text-xs tracking-widest text-accent-foreground uppercase mb-3 text-center">
              Quick Start
            </p>
            <h2
              className="text-3xl sm:text-4xl font-black tracking-tight mb-2 text-center"
              style={{ fontFamily: "var(--font-heading), sans-serif" }}
            >
              Ship faster, type less
            </h2>
            <p className="text-sm text-muted-foreground text-center mb-10 max-w-md mx-auto">
              Seven commands to manage your entire code intelligence workflow.
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

        {/* ── MCP SETUP ── */}
        <Reveal delay={100}>
          <section className="section-full px-6 py-20 text-center">
            <p className="font-mono text-xs tracking-widest text-accent-foreground uppercase mb-3">
              AI Integration
            </p>
            <h2
              className="text-3xl sm:text-4xl font-black tracking-tight mb-4"
              style={{ fontFamily: "var(--font-heading), sans-serif" }}
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
              Three ways to connect
            </h2>
            <div className="diagram-flow">
              <div className="diagram-node">
                <div className="diagram-node-icon">
                  <Terminal className="h-4 w-4" />
                </div>
                <div className="diagram-node-label">CLI</div>
                <div className="diagram-node-desc">
                  pnpm openez init<br />
                  pnpm openez query
                </div>
              </div>

              <div className="diagram-arrow">
                <div className="diagram-arrow-line" />
                <span className="diagram-arrow-label">serve</span>
              </div>

              <div className="diagram-node">
                <div className="diagram-node-icon">
                  <Radio className="h-4 w-4" />
                </div>
                <div className="diagram-node-label">MCP Server</div>
                <div className="diagram-node-desc">
                  Claude, Codex, OpenCode<br />
                  AI agent integration
                </div>
              </div>

              <div className="diagram-arrow">
                <div className="diagram-arrow-line" />
                <span className="diagram-arrow-label">browse</span>
              </div>

              <div className="diagram-node">
                <div className="diagram-node-icon">
                  <Database className="h-4 w-4" />
                </div>
                <div className="diagram-node-label">Web Dashboard</div>
                <div className="diagram-node-desc">
                  Workspace management<br />
                  3D graph explorer
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
