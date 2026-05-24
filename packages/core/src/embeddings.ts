import OpenAI from "openai";
import { Ollama } from "ollama";

import { loadEnv } from "@openez-graph/config";
import { truncateToTokenLimit } from "./tokenizer";

const OLLAMA_EMBED_MAX_TOKENS = 1800;

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  model: string;
  provider: "openai" | "ollama";
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly provider = "openai" as const;

  private readonly client: OpenAI;
  readonly model: string;

  constructor(apiKey: string, model: string, baseURL?: string) {
    this.client = new OpenAI({
      apiKey,
      baseURL
    });
    this.model = model;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: texts
    });

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
    const results = await Promise.all(
      texts.map(async (text) => {
        const truncatedInput = truncateToTokenLimit(text, OLLAMA_EMBED_MAX_TOKENS);
        const response = await this.client.embed({
          model: this.model,
          input: truncatedInput
        });

        return Array.isArray(response.embeddings[0]) ? response.embeddings[0] : [];
      })
    );

    return results;
  }
}

export function getEmbeddingProvider(): EmbeddingProvider | null {
  const env = loadEnv();

  if (env.EMBEDDING_PROVIDER === "none" || !env.EMBEDDING_PROVIDER) {
    return null;
  }

  if (env.EMBEDDING_PROVIDER === "openai" && env.OPENAI_API_KEY) {
    return new OpenAIEmbeddingProvider(
      env.OPENAI_API_KEY,
      env.OPENAI_EMBEDDING_MODEL,
      env.OPENAI_BASE_URL
    );
  }

  if (env.EMBEDDING_PROVIDER === "ollama") {
    return new OllamaEmbeddingProvider(env.OLLAMA_BASE_URL, env.OLLAMA_EMBEDDING_MODEL);
  }

  return null;
}
