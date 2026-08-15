import { z } from "zod";

const envSchema = z.object({
  EMBEDDING_PROVIDER: z.string().default("none"),
  MINIMAX_API_KEY: z.string().optional(),
  ANTHROPIC_BASE_URL: z.string().url().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  OLLAMA_BASE_URL: z.string().url().default("http://localhost:11434"),
  OLLAMA_EMBEDDING_MODEL: z.string().default("bge-m3"),
});

export type BrainEnv = z.infer<typeof envSchema>;

export function loadEnv(): BrainEnv {
  return envSchema.parse(process.env);
}
