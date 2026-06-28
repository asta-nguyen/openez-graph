import { createFileRoute } from "@tanstack/react-router";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CodeBlock,
} from "@openez-graph/ui";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

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

function InlineCode({ children }: { children: string }) {
  return (
    <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono text-foreground border border-border">
      {children}
    </code>
  );
}

function McpProviderCard({
  name,
  configPath,
  config,
}: {
  name: string;
  configPath: string;
  config: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2 mb-2">
        <h3 className="text-sm font-semibold text-foreground">{name}</h3>
        <Badge variant="secondary" className="text-xs px-1.5 py-0 h-4">
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

function SettingsPage() {
  return (
    <div className="page container mx-auto px-4 sm:px-6">
      <div>
        <h1>Settings</h1>
        <p className="text-muted-foreground text-sm">
          MCP server configuration for AI coding agents.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>MCP Server Setup</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
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
