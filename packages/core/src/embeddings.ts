import OpenAI from "openai";
import { Ollama } from "ollama";

import { loadEnv } from "@openez-graph/config";
import { createRegistryRepository } from "@openez-graph/db";
import { truncateToTokenLimit } from "./tokenizer";
import { getLocalEmbeddingModel } from "./local-embedding";

const OLLAMA_EMBED_MAX_TOKENS = 1800;

const RETRYABLE_PATTERNS = [
  "rate",
  "timeout",
  "network",
  "ECONN",
  "ETIMED",
  "429",
  "503",
  "5xx",
  "overloaded",
  "capacity",
];

function isRetryableError(message: string, status: number): boolean {
  return (
    RETRYABLE_PATTERNS.some((pattern) => message.toLowerCase().includes(pattern.toLowerCase())) ||
    status === 429 ||
    (status >= 500 && status < 600) ||
    /\b5\d{2}\b/.test(message)
  );
}

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3, baseDelayMs = 1000): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (rawError) {
      // SAFETY: thrown values from embedding providers are Error instances (optionally carrying a numeric `.status`); non-Error throws fall through to String() below.
      const error = rawError as Error & { status?: unknown };
      const message = error instanceof Error ? error.message : String(rawError ?? "");
      const status = Number(error.status);
      if (attempt === maxAttempts || !isRetryableError(message, status)) {
        throw rawError;
      }
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      console.warn(
        `Embedding attempt ${attempt}/${maxAttempts} failed, retrying in ${delay}ms: ${message}`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  // Unreachable: the loop always returns or throws on every attempt.
  throw new Error("withRetry: exhausted retries (unreachable)");
}

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  model: string;
  provider: "openai" | "ollama" | "local";
}

export function embeddingStorageModel(provider: Pick<EmbeddingProvider, "model">): string {
  return `${provider.model}:openez-code-v1`;
}

export function formatEmbeddingInput(
  provider: Pick<EmbeddingProvider, "provider" | "model">,
  input: { content: string; path?: string; heading?: string | null },
  task: "document" | "query",
): string {
  const text =
    task === "query"
      ? input.content
      : [
          `path: ${input.path ?? ""}`,
          input.heading ? `heading: ${input.heading}` : "",
          input.content,
        ]
          .filter(Boolean)
          .join("\n");
  const nomicPrefix =
    provider.provider === "ollama" && provider.model.includes("nomic-embed-text")
      ? task === "query"
        ? "search_query: "
        : "search_document: "
      : "";
  const bgePrefix =
    provider.provider === "ollama" && provider.model.includes("bge")
      ? task === "query"
        ? "Represent this sentence for searching relevant passages: "
        : ""
      : "";
  return `${nomicPrefix}${bgePrefix}${text}`;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly provider = "openai" as const;

  private readonly client: OpenAI;
  readonly model: string;

  constructor(apiKey: string, model: string, baseURL?: string) {
    this.client = new OpenAI({
      apiKey,
      baseURL,
    });
    this.model = model;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const response = await withRetry(() =>
      this.client.embeddings.create({
        model: this.model,
        input: texts,
      }),
    );

    return response.data.map((item) => item.embedding);
  }
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly provider = "ollama" as const;

  private readonly client: Ollama;
  readonly model: string;

  constructor(host: string, model: string) {
    this.client = new Ollama({ host });
    this.model = model;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const CONCURRENCY = 4;
    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += CONCURRENCY) {
      const batch = texts.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.allSettled(
        batch.map(async (text) => {
          const truncatedInput = truncateToTokenLimit(text, OLLAMA_EMBED_MAX_TOKENS);
          return withRetry(async () => {
            const response = await this.client.embed({
              model: this.model,
              input: truncatedInput,
            });

            return Array.isArray(response.embeddings[0]) ? response.embeddings[0] : [];
          });
        }),
      );
      results.push(
        ...batchResults.map((result) => (result.status === "fulfilled" ? result.value : [])),
      );
    }

    return results;
  }
}

export interface EmbeddingConfig {
  provider: string;
  openaiApiKey: string;
  openaiBaseUrl: string | undefined;
  openaiModel: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  localModel: string;
}

export async function getEmbeddingConfig(): Promise<EmbeddingConfig> {
  const env = loadEnv();
  let dbSettings: Record<string, string> = {};
  try {
    const registry = createRegistryRepository();
    dbSettings = await registry.getAllSettings();
  } catch {
    // DB not available — fall back to env only
  }

  const db = (key: string): string | undefined => {
    const v = dbSettings[key];
    return v && v.trim() !== "" ? v : undefined;
  };

  return {
    provider: db("embedding.provider") ?? env.EMBEDDING_PROVIDER ?? "none",
    openaiApiKey: db("embedding.openai_api_key") ?? env.OPENAI_API_KEY ?? "",
    openaiBaseUrl: db("embedding.openai_base_url") ?? env.OPENAI_BASE_URL,
    openaiModel:
      db("embedding.openai_model") ?? env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small",
    ollamaBaseUrl:
      db("embedding.ollama_base_url") ?? env.OLLAMA_BASE_URL ?? "http://localhost:11434",
    ollamaModel: db("embedding.ollama_model") ?? env.OLLAMA_EMBEDDING_MODEL ?? "bge-m3",
    localModel:
      db("embedding.local_model") ??
      process.env.OPENEZ_LOCAL_EMBEDDING_MODEL ??
      "jina-code-static-256",
  };
}

export async function getEmbeddingProvider(): Promise<EmbeddingProvider | null> {
  const config = await getEmbeddingConfig();

  if (config.provider === "none" || !config.provider) {
    return null;
  }

  if (config.provider === "openai" && config.openaiApiKey) {
    return new OpenAIEmbeddingProvider(
      config.openaiApiKey,
      config.openaiModel,
      config.openaiBaseUrl,
    );
  }

  if (config.provider === "ollama") {
    return new OllamaEmbeddingProvider(config.ollamaBaseUrl, config.ollamaModel);
  }

  if (config.provider === "local") {
    return getLocalEmbeddingModel(config.localModel);
  }

  return null;
}
