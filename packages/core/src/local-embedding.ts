import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

import { Tokenizer } from "@huggingface/tokenizers";
import type { EmbeddingProvider } from "./embeddings";

export const LOCAL_EMBEDDING_MODEL = "jina-code-static-256";
export const LOCAL_EMBEDDING_REVISION = "b4459b817b536239ebbf8e29ff487fea4b16f3f7";
const MODEL_REPO = "astanguyen/jina-code-static-256";
const MODEL_DIMENSIONS = 256;

const FILES = {
  "config.json": "6379cd03df475afbaa9af5eaba1e4c5f43c03f9be64c4f8eec49b1e4b97dccf0",
  "modules.json": "a68dcbed0429dcdd5bfdca92b0b03cc30d09122c0a3fcf4758787d4b244e45b2",
  "tokenizer.json": "40167c0ef833912d8e112df97e2e1aa5f79e6def47a63d2d77c9e3ea4ed0e7ae",
  "model.safetensors": "2f9e0595785330808d5bddbb4ed72e97b171073a8c93567268472f42577dd80d",
} as const;

export const LOCAL_EMBEDDING_MODELS = {
  [LOCAL_EMBEDDING_MODEL]: {
    repo: MODEL_REPO,
    revision: LOCAL_EMBEDDING_REVISION,
    dimensions: MODEL_DIMENSIONS,
    files: FILES,
  },
} as const;

const cacheLoads = new Map<string, Promise<string>>();

// Marker used as `Error.cause` to signal a non-retryable download failure.
const PERMANENT = Symbol("permanent");

export function getLocalEmbeddingCacheDir(
  model = LOCAL_EMBEDDING_MODEL,
  cacheRoot = path.join(os.homedir(), ".openez", "models"),
): string {
  const spec = LOCAL_EMBEDDING_MODELS[model as keyof typeof LOCAL_EMBEDDING_MODELS];
  if (!spec) throw new Error("Unknown local embedding model '" + model + "'");
  return path.join(cacheRoot, "astanguyen", model, spec.revision);
}

function hashBytes(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function downloadFile(url: string, target: string, expectedHash: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  try {
    const existing = await readFile(target);
    if (hashBytes(existing) === expectedHash) return;
  } catch {
    // Cache miss.
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) {
        if (![429, 500, 502, 503, 504].includes(response.status)) {
          // Non-retryable HTTP failure: exit immediately, do not consume another attempt.
          throw new Error("Model download failed (" + response.status + ") for " + url, {
            cause: PERMANENT,
          });
        }
        throw new Error("Model download retryable status " + response.status + " for " + url);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (hashBytes(bytes) !== expectedHash) {
        throw new Error("Model checksum mismatch for " + path.basename(target), {
          cause: PERMANENT,
        });
      }
      const temp = target + ".part-" + process.pid;
      await writeFile(temp, bytes);
      await rename(temp, target);
      return;
    } catch (error) {
      lastError = error;
      if ((error as { cause?: symbol })?.cause === PERMANENT) break;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function ensureLocalEmbeddingCache(
  model = LOCAL_EMBEDDING_MODEL,
  cacheRoot?: string,
): Promise<string> {
  const cacheDir = getLocalEmbeddingCacheDir(model, cacheRoot);
  const key = cacheDir;
  const existing = cacheLoads.get(key);
  if (existing) return existing;

  const load = (async () => {
    const spec = LOCAL_EMBEDDING_MODELS[model as keyof typeof LOCAL_EMBEDDING_MODELS];
    await mkdir(cacheDir, { recursive: true });
    for (const [file, checksum] of Object.entries(spec.files)) {
      await downloadFile(
        "https://huggingface.co/" + spec.repo + "/resolve/" + spec.revision + "/" + file,
        path.join(cacheDir, file),
        checksum,
      );
    }
    return cacheDir;
  })();
  cacheLoads.set(key, load);
  try {
    return await load;
  } catch (error) {
    cacheLoads.delete(key);
    throw error;
  }
}

function f16ToF32(value: number): number {
  const sign = value & 0x8000 ? -1 : 1;
  const exponent = (value >>> 10) & 0x1f;
  const fraction = value & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : Number.NaN;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

async function loadEmbeddingMatrix(filePath: string): Promise<Float32Array> {
  const bytes = await readFile(filePath);
  const headerLength = Number(
    new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true),
  );
  const headerStart = 8;
  const header = JSON.parse(
    new TextDecoder().decode(bytes.subarray(headerStart, headerStart + headerLength)),
  ) as Record<string, { dtype?: string; shape?: number[]; data_offsets?: [number, number] }>;
  const tensor = header.embeddings;
  if (!tensor || tensor.dtype !== "F16" || tensor.shape?.[1] !== MODEL_DIMENSIONS) {
    throw new Error(
      "Expected F16 256d 'embeddings' tensor; found: " + Object.keys(header).join(", "),
    );
  }
  const [start, end] = tensor.data_offsets ?? [];
  if (start === undefined || end === undefined) {
    throw new Error("Local embedding safetensors tensor has no data offsets");
  }
  const payloadStart = headerStart + headerLength + start;
  const payload = new DataView(bytes.buffer, bytes.byteOffset + payloadStart, end - start);
  const values = new Float32Array((end - start) / 2);
  for (let i = 0; i < values.length; i++) values[i] = f16ToF32(payload.getUint16(i * 2, true));
  return values;
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly provider = "local" as const;
  readonly model = LOCAL_EMBEDDING_MODEL;

  private tokenizer?: Tokenizer;
  private matrix?: Float32Array;
  private readonly cacheDir?: string;
  private loadingPromise?: Promise<void>;

  constructor(cacheDir?: string) {
    this.cacheDir = cacheDir;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.tokenizer && this.matrix) return;
    // In-flight guard: concurrent calls share the same load + conversion promise
    // instead of repeating file reads and matrix processing.
    if (this.loadingPromise) return this.loadingPromise;
    this.loadingPromise = (async () => {
      try {
        const dir = this.cacheDir ?? (await ensureLocalEmbeddingCache());
        const [tokenizerJson, matrix] = await Promise.all([
          readFile(path.join(dir, "tokenizer.json"), "utf8"),
          loadEmbeddingMatrix(path.join(dir, "model.safetensors")),
        ]);
        // Validate dimensions before assigning so a failed load leaves the
        // instance unchanged and a retry can start clean.
        if (matrix.length % MODEL_DIMENSIONS !== 0) {
          throw new Error("Local embedding matrix has invalid dimensions");
        }
        this.tokenizer = new Tokenizer(JSON.parse(tokenizerJson), {});
        this.matrix = matrix;
      } finally {
        this.loadingPromise = undefined;
      }
    })();
    return this.loadingPromise;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    await this.ensureLoaded();
    const tokenizer = this.tokenizer!;
    const matrix = this.matrix!;
    const vectors: number[][] = [];
    for (const text of texts) {
      const ids = tokenizer.encode(text).ids;
      if (ids.length === 0) throw new Error("Local embedding tokenizer returned no tokens");
      // Model2Vec is a static token lookup: mean-pool token rows, then L2-normalize for cosine search.
      const vector = new Float32Array(MODEL_DIMENSIONS);
      for (const id of ids) {
        const offset = Number(id) * MODEL_DIMENSIONS;
        if (offset < 0 || offset + MODEL_DIMENSIONS > matrix.length) {
          throw new Error("Local embedding token id " + id + " is outside the vocabulary");
        }
        for (let d = 0; d < MODEL_DIMENSIONS; d++) vector[d] += matrix[offset + d];
      }
      let squaredNorm = 0;
      for (const value of vector) squaredNorm += value * value;
      const norm = Math.sqrt(squaredNorm);
      if (!Number.isFinite(norm) || norm === 0)
        throw new Error("Local embedding produced an all-zero or non-finite vector");
      vectors.push(Array.from(vector, (value) => value / norm));
    }
    return vectors;
  }
}

export function isLocalEmbeddingModel(model: string): boolean {
  return model in LOCAL_EMBEDDING_MODELS;
}

export async function getLocalEmbeddingModel(
  model = LOCAL_EMBEDDING_MODEL,
): Promise<LocalEmbeddingProvider> {
  if (!isLocalEmbeddingModel(model)) {
    throw new Error(
      "Unsupported local embedding model '" +
        model +
        "'. Supported models: " +
        Object.keys(LOCAL_EMBEDDING_MODELS).join(", "),
    );
  }
  return new LocalEmbeddingProvider(getLocalEmbeddingCacheDir(model));
}
