import { REPO_URL } from "@/lib/site";

// Shared by the landing page and /docs/*; the /# links work from both
export function SiteHeader() {
  return (
    <header className="fixed inset-x-0 top-0 z-40 border-b border-border bg-background/70 backdrop-blur-md">
      <nav
        className="mx-auto flex h-14 max-w-7xl items-center justify-between px-6"
        aria-label="Primary navigation"
      >
        <a href="/#top" className="font-display text-sm font-black tracking-[-0.04em]">
          OPEN<span className="text-primary">EZ</span>
        </a>
        <div className="flex items-center gap-5 text-xs text-muted-foreground sm:gap-7">
          <a className="nav-link hidden sm:inline" href="/#how">
            How it works
          </a>
          <a className="nav-link hidden sm:inline" href="/#product">
            Product
          </a>
          <a className="nav-link" href="/#quick-start">
            Quick start
          </a>
          <a className="nav-link" href="/docs/mcp">
            Docs
          </a>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="nav-link rounded-md border border-border px-3 py-1.5 font-medium text-foreground"
          >
            GitHub ↗
          </a>
        </div>
      </nav>
    </header>
  );
}
