import module from "node:module";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { createRegistryRepository } from "@openez-graph/db";

export interface ResolvedLibrary {
  id: string;
  name: string;
}

export interface FetchedDocs {
  content: string;
}

export interface Context7ClientOptions {
  binPath?: string;
  binArgs?: string[];
  apiKey?: string;
  callTimeoutMs?: number;
}

// ESM-safe require.resolve — createRequire needs a file URL.
const _require =
  typeof require === "function"
    ? require
    : module.createRequire(
        typeof import.meta !== "undefined" && import.meta.url
          ? import.meta.url
          : `file://${__filename}`,
      );

// Candidate tool names for each known role, in preference order. The first
// name returned by the server's tools/list is used; if none match we fall back
// to the canonical name so the call still proceeds and fails with a clear error.
const RESOLVE_LIBRARY_ID_CANDIDATES = ["resolve-library-id", "get-library-id", "resolve-library"];
const QUERY_DOCS_CANDIDATES = ["query-docs", "get-library-docs", "get-docs"];

const DEFAULT_CALL_TIMEOUT_MS = 30_000;

export class Context7Client {
  private client: Client | null = null;
  private startPromise: Promise<void> | null = null;
  private started = false;
  private readonly options: Context7ClientOptions;
  private resolveLibraryIdToolName = RESOLVE_LIBRARY_ID_CANDIDATES[0];
  private queryDocsToolName = QUERY_DOCS_CANDIDATES[0];

  constructor(options: Context7ClientOptions = {}) {
    this.options = options;
  }

  async ensureStarted(): Promise<void> {
    if (this.started && this.client) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.start();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async start(): Promise<void> {
    const { bin, args, env } = await this.resolveBinary();

    this.client = new Client({ name: "openez", version: "0.10.0" }, { capabilities: {} });

    const transport = new StdioClientTransport({
      command: bin,
      args,
      env: { ...process.env, ...env } as Record<string, string>,
      stderr: "pipe",
    });

    this.client.onclose = () => {
      this.started = false;
      this.client = null;
    };

    await this.client.connect(transport);
    await this.discoverToolNames();
    this.started = true;
  }

  private async discoverToolNames(): Promise<void> {
    if (!this.client) return;
    let availableNames: string[] = [];
    try {
      const { tools } = await this.client.listTools();
      availableNames = (tools ?? []).map((t) => t.name);
    } catch (err) {
      console.error("[context7] tools/list failed; falling back to canonical tool names:", err);
      return;
    }

    this.resolveLibraryIdToolName = this.pickToolName(
      availableNames,
      RESOLVE_LIBRARY_ID_CANDIDATES,
    );
    this.queryDocsToolName = this.pickToolName(availableNames, QUERY_DOCS_CANDIDATES);

    if (!RESOLVE_LIBRARY_ID_CANDIDATES.includes(this.resolveLibraryIdToolName)) {
      console.error(
        `[context7] expected a resolve-library-id tool (tried ${RESOLVE_LIBRARY_ID_CANDIDATES.join(", ")}) but server did not list it; available tools: ${availableNames.join(", ") || "(none)"}`,
      );
    }
    if (!QUERY_DOCS_CANDIDATES.includes(this.queryDocsToolName)) {
      console.error(
        `[context7] expected a query-docs tool (tried ${QUERY_DOCS_CANDIDATES.join(", ")}) but server did not list it; available tools: ${availableNames.join(", ") || "(none)"}`,
      );
    }
  }

  private pickToolName(available: string[], candidates: string[]): string {
    for (const candidate of candidates) {
      if (available.includes(candidate)) return candidate;
    }
    // Fall back to the canonical (first) candidate so the call proceeds and
    // fails naturally with a clear error from the server.
    return candidates[0];
  }

  private async resolveBinary(): Promise<{
    bin: string;
    args: string[];
    env: Record<string, string>;
  }> {
    const binPath = this.options.binPath ?? (await this.resolveBinFromConfig());
    const binArgs = this.options.binArgs ?? (await this.resolveBinArgsFromConfig());
    const apiKey = this.options.apiKey ?? (await this.resolveApiKeyFromConfig());

    const env: Record<string, string> = {};
    if (apiKey) env.CONTEXT7_API_KEY = apiKey;

    return { bin: binPath, args: binArgs, env };
  }

  private async resolveBinFromConfig(): Promise<string> {
    const registry = createRegistryRepository();
    const configured = await registry.getSetting("context7.bin_path");
    if (configured) return configured;

    try {
      const resolved = _require.resolve("@upstash/context7-mcp/bin/context7-mcp.mjs");
      return resolved;
    } catch {
      throw new Error(
        "Context7 binary not found. Run 'openez setup context7' to install and configure it.",
      );
    }
  }

  private async resolveBinArgsFromConfig(): Promise<string[]> {
    const registry = createRegistryRepository();
    const configured = await registry.getSetting("context7.bin_args");
    if (configured) {
      try {
        const parsed = JSON.parse(configured);
        return Array.isArray(parsed) ? parsed.map(String) : [];
      } catch {
        return [];
      }
    }
    return [];
  }

  private async resolveApiKeyFromConfig(): Promise<string | undefined> {
    const registry = createRegistryRepository();
    return (await registry.getSetting("context7.api_key")) ?? undefined;
  }

  async resolveLibraryId(libraryName: string): Promise<ResolvedLibrary | null> {
    await this.ensureStarted();
    if (!this.client) throw new Error("Context7 client not connected");

    const result = await this.callToolWithTimeout({
      name: this.resolveLibraryIdToolName,
      arguments: { libraryName },
    });

    const text = this.extractText(result);
    if (!text) return null;

    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return { id: String(parsed[0].id), name: String(parsed[0].name ?? libraryName) };
      }
      if (parsed.id) {
        return { id: String(parsed.id), name: String(parsed.name ?? libraryName) };
      }
      return null;
    } catch {
      return null;
    }
  }

  async getLibraryDocs(input: {
    libraryId: string;
    topic?: string;
    tokens?: number;
  }): Promise<FetchedDocs | null> {
    await this.ensureStarted();
    if (!this.client) throw new Error("Context7 client not connected");

    const args: Record<string, unknown> = { libraryId: input.libraryId };
    if (input.topic) args.topic = input.topic;
    if (input.tokens) args.tokens = input.tokens;

    const result = await this.callToolWithTimeout({
      name: this.queryDocsToolName,
      arguments: args,
    });

    if (result.isError) return null;

    const text = this.extractText(result);
    if (!text) return null;

    return {
      content: text,
    };
  }

  private async callToolWithTimeout(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<ReturnType<Client["callTool"]>> {
    if (!this.client) throw new Error("Context7 client not connected");

    const timeoutMs = this.options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Context7 call '${params.name}' timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });

    try {
      return await Promise.race([this.client.callTool(params), timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private extractText(result: unknown): string | null {
    const r = result as { content?: Array<{ type: string; text?: string }> };
    if (!r.content || !Array.isArray(r.content)) return null;
    return (
      r.content
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text!)
        .join("\n") || null
    );
  }

  async stop(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // ignore
      }
      this.client = null;
    }
    this.started = false;
  }
}
