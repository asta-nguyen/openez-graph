import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { embeddingConfigQueryOptions, settingsEnvQueryOptions } from "../lib/queries";
import { api } from "../lib/api";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CodeBlock,
  Input,
  Label,
  Select,
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

function EmbeddingConfigForm() {
  const queryClient = useQueryClient();
  const { data: config, isLoading } = useQuery(embeddingConfigQueryOptions);

  const [provider, setProvider] = useState("none");
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [openaiBaseUrl, setOpenaiBaseUrl] = useState("");
  const [openaiModel, setOpenaiModel] = useState("text-embedding-3-small");
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState("http://localhost:11434");
  const [ollamaModel, setOllamaModel] = useState("bge-m3");
  const [initialized, setInitialized] = useState(false);

  if (config && !initialized) {
    setProvider(config.provider);
    setOpenaiApiKey(config.openaiApiKey === "****" ? "" : config.openaiApiKey);
    setOpenaiBaseUrl(config.openaiBaseUrl);
    setOpenaiModel(config.openaiModel);
    setOllamaBaseUrl(config.ollamaBaseUrl);
    setOllamaModel(config.ollamaModel);
    setInitialized(true);
  }

  const saveMutation = useMutation({
    mutationFn: (input: Record<string, string>) => api.updateEmbeddingConfig(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "embedding"] });
    },
  });

  const handleSave = () => {
    const updates: Record<string, string> = {};
    if (provider !== config?.provider) updates["embedding.provider"] = provider;
    if (provider === "openai") {
      if (openaiApiKey && openaiApiKey !== "****")
        updates["embedding.openai_api_key"] = openaiApiKey;
      if (openaiBaseUrl !== (config?.openaiBaseUrl ?? ""))
        updates["embedding.openai_base_url"] = openaiBaseUrl;
      if (openaiModel !== config?.openaiModel) updates["embedding.openai_model"] = openaiModel;
    }
    if (provider === "ollama") {
      if (ollamaBaseUrl !== config?.ollamaBaseUrl)
        updates["embedding.ollama_base_url"] = ollamaBaseUrl;
      if (ollamaModel !== config?.ollamaModel) updates["embedding.ollama_model"] = ollamaModel;
    }
    if (Object.keys(updates).length === 0) return;
    saveMutation.mutate(updates);
  };

  if (isLoading || !config) {
    return (
      <p className="text-sm text-muted-foreground">
        {isLoading ? "Loading..." : "Unable to load embedding configuration."}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="provider">Embedding Provider</Label>
        <Select id="provider" value={provider} onChange={(e) => setProvider(e.target.value)}>
          <option value="none">none (disabled — FTS only)</option>
          <option value="openai">OpenAI</option>
          <option value="ollama">Ollama (local)</option>
        </Select>
      </div>

      {provider === "openai" && (
        <div className="space-y-4 border-l-2 border-border pl-4">
          <div className="space-y-2">
            <Label htmlFor="openai-key">API Key</Label>
            <Input
              id="openai-key"
              type="password"
              placeholder={
                config?.openaiApiKey === "****" ? "•••• (stored, type to replace)" : "sk-..."
              }
              value={openaiApiKey}
              onChange={(e) => setOpenaiApiKey(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="openai-base">Base URL (optional)</Label>
            <Input
              id="openai-base"
              placeholder="https://api.openai.com/v1"
              value={openaiBaseUrl}
              onChange={(e) => setOpenaiBaseUrl(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="openai-model">Model</Label>
            <Input
              id="openai-model"
              placeholder="text-embedding-3-small"
              value={openaiModel}
              onChange={(e) => setOpenaiModel(e.target.value)}
            />
          </div>
        </div>
      )}

      {provider === "ollama" && (
        <div className="space-y-4 border-l-2 border-border pl-4">
          <div className="space-y-2">
            <Label htmlFor="ollama-url">Base URL</Label>
            <Input
              id="ollama-url"
              placeholder="http://localhost:11434"
              value={ollamaBaseUrl}
              onChange={(e) => setOllamaBaseUrl(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ollama-model">Model</Label>
            <Input
              id="ollama-model"
              placeholder="bge-m3"
              value={ollamaModel}
              onChange={(e) => setOllamaModel(e.target.value)}
            />
          </div>
        </div>
      )}

      <div className="flex items-center gap-3">
        <Button onClick={handleSave} disabled={saveMutation.isPending}>
          {saveMutation.isPending ? "Saving..." : "Save"}
        </Button>
        {saveMutation.isSuccess && (
          <span className="text-sm text-green-600">Saved! Reindex to apply.</span>
        )}
        {saveMutation.isError && (
          <span className="text-sm text-red-600">
            Error: {saveMutation.error instanceof Error ? saveMutation.error.message : "unknown"}
          </span>
        )}
        {config && config.dbOverrides.length > 0 && (
          <Badge variant="secondary" className="text-xs">
            {config.dbOverrides.length} DB override{config.dbOverrides.length > 1 ? "s" : ""}
          </Badge>
        )}
      </div>
    </div>
  );
}

function SettingsPage() {
  const { data: env } = useQuery(settingsEnvQueryOptions);

  return (
    <div className="page container mx-auto px-4 sm:px-6">
      <div>
        <h1>Settings</h1>
        <p className="text-muted-foreground text-sm">
          Configure embedding provider for vector search.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Embedding Configuration</CardTitle>
        </CardHeader>
        <CardContent>
          <EmbeddingConfigForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Environment Fallbacks</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="px-6 pb-2">
            <ConfigRow label="EMBEDDING_PROVIDER" value={env?.EMBEDDING_PROVIDER} />
            <ConfigRow label="OPENAI_BASE_URL" value={env?.OPENAI_BASE_URL ?? "default"} />
            <ConfigRow label="OPENAI_EMBEDDING_MODEL" value={env?.OPENAI_EMBEDDING_MODEL} />
            <ConfigRow label="OLLAMA_EMBEDDING_MODEL" value={env?.OLLAMA_EMBEDDING_MODEL} />
          </div>
        </CardContent>
      </Card>

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
