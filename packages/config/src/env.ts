import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

import { z } from "zod";

function loadDotenvFromWorkspaceRoot() {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  let searchDir = currentDir;

  while (true) {
    const candidate = path.join(searchDir, ".env");
    if (fs.existsSync(candidate)) {
      dotenv.config({ path: candidate });
      return;
    }

    const parentDir = path.dirname(searchDir);
    if (parentDir === searchDir) {
      break;
    }

    searchDir = parentDir;
  }

  dotenv.config();
}

loadDotenvFromWorkspaceRoot();

const envSchema = z.object({
  DATABASE_URL: z.string().url().optional(),
  EMBEDDING_PROVIDER: z.string().default("none"),
  MINIMAX_API_KEY: z.string().optional(),
  ANTHROPIC_BASE_URL: z.string().url().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  OLLAMA_BASE_URL: z.string().url().default("http://localhost:11434"),
  OLLAMA_EMBEDDING_MODEL: z.string().default("nomic-embed-text")
});

export type BrainEnv = z.infer<typeof envSchema>;

export function loadEnv(): BrainEnv {
  return envSchema.parse(process.env);
}
