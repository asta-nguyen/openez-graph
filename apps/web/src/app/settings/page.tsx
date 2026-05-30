import { loadEnv } from "@openez-graph/config";

import { Badge, Card, CardContent, CardHeader, CardTitle, CodeBlock } from "@openez-graph/ui";

const claudeCodeConfig = `{
  "mcpServers": {
    "openez-graph": {
      "command": "pnpm",
      "args": ["--dir", "/path/to/openez", "mcp"]
    }
  }
}`;

const claudeDesktopConfig = `{
  "mcpServers": {
    "openez-graph": {
      "command": "pnpm",
      "args": ["--dir", "/path/to/openez", "mcp"]
    }
  }
}`;

const clineConfig = `{
  "mcpServers": {
    "openez-graph": {
      "command": "pnpm",
      "args": ["--dir", "/path/to/openez", "mcp"]
    }
  }
}`;

const openCodeConfig = `{
  "mcp": {
    "servers": {
      "openez-graph": {
        "type": "local",
        "command": ["pnpm", "--dir", "/path/to/openez", "mcp"]
      }
    }
  }
}`;

function ConfigRow({ label, value }: { label: string; value: string | undefined }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3 border-b border-border last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium text-foreground text-right truncate max-w-[70%] font-mono">
        {value ?? <span className="text-muted-foreground italic">not set</span>}
      </span>
    </div>
  );
}

function InlineCode({ children }: { children: string }) {
  return (
    <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono text-foreground border border-border">
      {children}
    </code>
  );
}

function McpProviderCard({ name, configPath, config }: { name: string; configPath: string; config: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2 mb-2">
        <h3 className="text-sm font-semibold text-foreground">{name}</h3>
        <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">
          stdio
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Add to <InlineCode>{configPath}</InlineCode>
      </p>
      <CodeBlock>{config}</CodeBlock>
    </div>
  );
}

export default function SettingsPage() {
  const env = loadEnv();

  return (
    <div className="page">
      <div>
        <h1>Settings</h1>
        <p className="text-muted-foreground text-sm">
          Environment-backed provider configuration.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Configuration</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="px-6 pb-2">
            <ConfigRow label="Database URL" value={env.DATABASE_URL} />
            <ConfigRow label="Redis URL" value="Not used (SQLite is default)" />
            <ConfigRow label="Embedding provider" value={env.EMBEDDING_PROVIDER} />
            <ConfigRow label="OpenAI base URL" value={env.OPENAI_BASE_URL ?? "default"} />
            <ConfigRow label="OpenAI model" value={env.OPENAI_EMBEDDING_MODEL} />
            <ConfigRow label="Ollama model" value={env.OLLAMA_EMBEDDING_MODEL} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>MCP Server Setup</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <McpProviderCard
            name="Claude Code"
            configPath="~/.claude/settings.json"
            config={claudeCodeConfig}
          />
          <McpProviderCard
            name="Claude Desktop"
            configPath="claude_desktop_config.json"
            config={claudeDesktopConfig}
          />
          <McpProviderCard
            name="Cline / VS Code"
            configPath="VS Code settings or Cline MCP config"
            config={clineConfig}
          />
          <McpProviderCard
            name="OpenCode"
            configPath="~/.config/opencode/opencode.json"
            config={openCodeConfig}
          />
        </CardContent>
      </Card>
    </div>
  );
}
