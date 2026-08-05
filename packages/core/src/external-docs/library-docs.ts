import { createRegistryRepository } from "@openez-graph/db";

import { countTokens, truncateToTokenLimit } from "../tokenizer";
import { Context7Client } from "./context7-client";
import { createDocsCache, type DocsCache } from "./docs-cache";

const DEFAULT_MAX_TOKENS = 8000;

export class Context7DisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Context7DisabledError";
  }
}

export interface LibraryDocsResult {
  library: string;
  version: string;
  topic?: string;
  source: "context7" | "cache" | "cache-stale" | "empty";
  content: string;
  tokensReturned: number;
  fetchedAt?: number;
  warning?: string;
  hint?: string;
}

interface Context7Settings {
  enabled: boolean;
  cacheTtlDays: number;
}

async function getContext7Settings(): Promise<Context7Settings> {
  const registry = createRegistryRepository();
  const enabled = await registry.getSetting("context7.enabled");
  const ttlDays = await registry.getSetting("context7.cache_ttl_days");
  return {
    enabled: enabled === "true",
    cacheTtlDays: ttlDays ? Number(ttlDays) : 7,
  };
}

let sharedClient: Context7Client | null = null;

function getSharedClient(): Context7Client {
  if (!sharedClient) {
    sharedClient = new Context7Client();
  }
  return sharedClient;
}

export async function disposeSharedClient(): Promise<void> {
  if (sharedClient) {
    await sharedClient.stop();
    sharedClient = null;
  }
}

export async function libraryDocs(input: {
  library: string;
  topic?: string;
  version?: string;
  maxTokens?: number;
  noCache?: boolean;
  cache?: DocsCache;
  client?: Context7Client;
}): Promise<LibraryDocsResult> {
  const settings = await getContext7Settings();
  if (!settings.enabled) {
    throw new Context7DisabledError(
      "Context7 integration is disabled. Run `openez setup context7` to enable.",
    );
  }

  const version = input.version ?? "latest";
  const ttlMs = settings.cacheTtlDays * 86_400_000;
  const now = Date.now();
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;

  const cache = input.cache ?? createDocsCache();
  const client = input.client ?? getSharedClient();

  // 1. Cache lookup via name→ID map
  if (!input.noCache) {
    const cached = await cache.findAnyByQuery({
      query: input.library,
      topic: input.topic,
      version,
    });
    if (cached && !cached.stale) {
      return formatResult(cached.content, {
        library: input.library,
        version,
        topic: input.topic,
        source: "cache",
        maxTokens,
        fetchedAt: cached.fetchedAt,
      });
    }
  }

  // 2. Resolve library ID via Context7
  // Check negative cache first to avoid repeated round-trips for bad names
  if (!input.noCache && (await cache.isNegativeCached(input.library))) {
    return {
      library: input.library,
      version,
      topic: input.topic,
      source: "empty",
      content: "",
      tokensReturned: 0,
      hint: `No library found for '${input.library}' (cached). Try the npm package name or a GitHub path like '/facebook/react'.`,
    };
  }

  await client.ensureStarted();
  const resolved = await client.resolveLibraryId(input.library, input.topic);
  if (!resolved) {
    // Store negative cache entry (sentinel: empty library_id)
    if (!input.noCache) {
      await cache.recordNameMapping(input.library, "");
    }
    return {
      library: input.library,
      version,
      topic: input.topic,
      source: "empty",
      content: "",
      tokensReturned: 0,
      hint: `No library found for '${input.library}'. Try the npm package name or a GitHub path like '/facebook/react'.`,
    };
  }

  // 3. Cache lookup by resolved ID
  if (!input.noCache) {
    const cached = await cache.getDocs({
      libraryId: resolved.id,
      version,
      topic: input.topic,
      now,
    });
    if (cached && !cached.stale) {
      await cache.recordNameMapping(input.library, resolved.id);
      return formatResult(cached.content, {
        library: input.library,
        version,
        topic: input.topic,
        source: "cache",
        maxTokens,
        fetchedAt: cached.fetchedAt,
      });
    }
  }

  // 4. Fetch from Context7
  try {
    const fetched = await client.getLibraryDocs({
      libraryId: resolved.id,
      topic: input.topic,
      tokens: maxTokens,
    });
    if (!fetched) {
      return {
        library: input.library,
        version,
        topic: input.topic,
        source: "empty",
        content: "",
        tokensReturned: 0,
      };
    }

    const tokens = countTokens(fetched.content);

    // 5. Store in cache
    await cache.storeDocs({
      libraryId: resolved.id,
      libraryName: resolved.name,
      version,
      topic: input.topic,
      content: fetched.content,
      tokens,
      ttlMs,
    });
    await cache.recordNameMapping(input.library, resolved.id);

    return formatResult(fetched.content, {
      library: input.library,
      version,
      topic: input.topic,
      source: "context7",
      maxTokens,
      fetchedAt: now,
    });
  } catch (err) {
    // 6. Network/fetch failure → fall back to stale cache
    console.warn("[context7] fetch failed, falling back to stale cache:", err);
    const stale = await cache.getDocs({
      libraryId: resolved.id,
      version,
      topic: input.topic,
      now,
    });
    if (stale) {
      return formatResult(stale.content, {
        library: input.library,
        version,
        topic: input.topic,
        source: "cache-stale",
        maxTokens,
        fetchedAt: stale.fetchedAt,
        warning: "Context7 fetch failed; returning cached (possibly outdated) docs.",
      });
    }
    throw err;
  }
}

function formatResult(
  content: string,
  opts: {
    library: string;
    version: string;
    topic?: string;
    source: LibraryDocsResult["source"];
    maxTokens: number;
    fetchedAt?: number;
    warning?: string;
  },
): LibraryDocsResult {
  const truncated = truncateToTokenLimit(content, opts.maxTokens);
  return {
    library: opts.library,
    version: opts.version,
    topic: opts.topic,
    source: opts.source,
    content: truncated,
    tokensReturned: countTokens(truncated),
    fetchedAt: opts.fetchedAt,
    warning: opts.warning,
  };
}
