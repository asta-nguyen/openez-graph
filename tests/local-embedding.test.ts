import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as fsPromises from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";

import {
  LOCAL_EMBEDDING_MODEL,
  LOCAL_EMBEDDING_MODELS,
  LOCAL_EMBEDDING_REVISION,
  LocalEmbeddingProvider,
  ensureLocalEmbeddingCache,
  getLocalEmbeddingCacheDir,
  getLocalEmbeddingModel,
  isLocalEmbeddingModel,
} from "../packages/core/src/local-embedding";

// ── Helpers for building a minimal offline Model2Vec fixture ──────────────────

const FIXTURE_DIMS = 256;

function f32ToF16(value: number): number {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, value, true);
  const f32 = new Uint32Array(buf)[0];
  const sign = (f32 >>> 31) & 1;
  const exp = (f32 >>> 23) & 0xff;
  const frac = f32 & 0x7fffff;
  if (exp === 0xff) return (sign << 15) | 0x7c00 | (frac ? 0x200 : 0);
  const newExp = exp - 127 + 15;
  if (newExp >= 0x1f) return (sign << 15) | 0x7c00;
  if (newExp <= 0) return (sign << 15) | (frac >> 13);
  return (sign << 15) | (newExp << 10) | (frac >> 13);
}

function buildSafetensors(rows: number, fillRow: (row: number) => number[]): Buffer {
  const header = JSON.stringify({
    embeddings: {
      dtype: "F16",
      shape: [rows, FIXTURE_DIMS],
      data_offsets: [0, rows * FIXTURE_DIMS * 2],
    },
  });
  const headerBytes = Buffer.from(header, "utf8");
  const headerLen = Buffer.alloc(8);
  headerLen.writeBigUInt64LE(BigInt(headerBytes.length), 0);
  const payload = Buffer.alloc(rows * FIXTURE_DIMS * 2);
  for (let r = 0; r < rows; r++) {
    const values = fillRow(r);
    for (let d = 0; d < FIXTURE_DIMS; d++) {
      payload.writeUInt16LE(f32ToF16(values[d]), (r * FIXTURE_DIMS + d) * 2);
    }
  }
  return Buffer.concat([headerLen, headerBytes, payload]);
}

// Minimal WordLevel tokenizer: ids 0-4 map to known words.
// The matrix below only has 2 rows, so ids 2+ (e.g. "foo") are out-of-bounds —
// this lets us exercise the vocabulary-bounds error path.
const MINIMAL_TOKENIZER = JSON.stringify({
  version: "1.0",
  truncation: null,
  padding: null,
  added_tokens: [],
  normalizer: null,
  pre_tokenizer: { type: "Whitespace" },
  post_processor: null,
  decoder: null,
  model: {
    type: "WordLevel",
    vocab: { hello: 0, world: 1, foo: 2, bar: 3, "<unk>": 4 },
    unk_token: "<unk>",
  },
});

function writeOfflineFixture(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "tokenizer.json"), MINIMAL_TOKENIZER);
  // 2 rows: row 0 = all 1.0, row 1 = all 2.0. ids 2+ are out-of-bounds.
  fs.writeFileSync(
    path.join(dir, "model.safetensors"),
    buildSafetensors(2, (row) =>
      Array.from({ length: FIXTURE_DIMS }, () => (row === 0 ? 1.0 : 2.0)),
    ),
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("local embedding provider", () => {
  it("exposes the pinned public model catalog", () => {
    const spec = LOCAL_EMBEDDING_MODELS[LOCAL_EMBEDDING_MODEL];
    expect(spec.repo).toBe("astanguyen/jina-code-static-256");
    expect(spec.revision).toBe(LOCAL_EMBEDDING_REVISION);
    expect(spec.dimensions).toBe(256);
    expect(Object.keys(spec.files)).toEqual([
      "config.json",
      "modules.json",
      "tokenizer.json",
      "model.safetensors",
    ]);
    const cacheDir = getLocalEmbeddingCacheDir();
    expect(cacheDir).toContain(path.join(".openez", "models", "astanguyen", LOCAL_EMBEDDING_MODEL));
    // The pinned revision must be the final cache-path segment.
    expect(cacheDir.endsWith(LOCAL_EMBEDDING_REVISION)).toBe(true);
  });

  describe("LocalEmbeddingProvider embedding (offline fixture)", () => {
    let fixtureDir: string;

    beforeEach(() => {
      fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "openez-embed-fix-"));
      writeOfflineFixture(fixtureDir);
    });

    afterEach(() => {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    });

    it("decodes F16, mean-pools, and returns normalized 256d vectors", async () => {
      const provider = new LocalEmbeddingProvider(fixtureDir);
      const vectors = await provider.embed(["hello world"]);
      expect(vectors).toHaveLength(1);
      expect(vectors[0]).toHaveLength(256);
      // mean of row 0 (1.0) and row 1 (2.0) = 1.5 per dim; norm = 1.5*sqrt(256) = 24
      // normalized = 1.5/24 = 0.0625 per dim
      expect(vectors[0][0]).toBeCloseTo(0.0625, 4);
      expect(Math.hypot(...vectors[0])).toBeCloseTo(1, 5);
      expect(vectors.flat().every(Number.isFinite)).toBe(true);
    });

    it("rejects token ids outside the matrix vocabulary", async () => {
      const provider = new LocalEmbeddingProvider(fixtureDir);
      // "foo" is vocab id 2, but the matrix only has rows 0-1
      expect(provider.embed(["foo"])).rejects.toThrow(/outside the vocabulary/);
    });

    it("shares a single load across concurrent embed calls (in-flight guard)", async () => {
      const provider = new LocalEmbeddingProvider(fixtureDir);
      const readSpy = spyOn(fsPromises, "readFile");
      const results = await Promise.all([
        provider.embed(["hello"]),
        provider.embed(["world"]),
        provider.embed(["hello world"]),
      ]);
      const loadedFiles = readSpy.mock.calls.map(([filePath]) => path.basename(String(filePath)));
      readSpy.mockRestore();
      expect(results).toHaveLength(3);
      expect(loadedFiles.filter((file) => file === "tokenizer.json")).toHaveLength(1);
      expect(loadedFiles.filter((file) => file === "model.safetensors")).toHaveLength(1);
      for (const vec of results) {
        expect(vec[0]).toHaveLength(256);
        expect(Math.hypot(...vec[0])).toBeCloseTo(1, 5);
      }
    });
  });
});

describe("getLocalEmbeddingModel", () => {
  it("reuses the provider instance across factory calls", async () => {
    expect(await getLocalEmbeddingModel()).toBe(await getLocalEmbeddingModel());
  });

  it("rejects inherited names that are not catalog entries", () => {
    expect(isLocalEmbeddingModel(LOCAL_EMBEDDING_MODEL)).toBe(true);
    expect(isLocalEmbeddingModel("toString")).toBe(false);
    expect(() => getLocalEmbeddingCacheDir("toString")).toThrow(/Unknown local embedding model/);
  });

  it("rejects an unknown model and lists supported models", async () => {
    expect(getLocalEmbeddingModel("unknown-model")).rejects.toThrow(
      /Unsupported local embedding model/,
    );
    expect(getLocalEmbeddingModel("unknown-model")).rejects.toThrow(
      new RegExp(LOCAL_EMBEDDING_MODEL),
    );
  });
});

describe("ensureLocalEmbeddingCache", () => {
  let cacheRoot: string;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-cache-"));
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  });

  it("rejects on checksum mismatch (permanent, no retry)", async () => {
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return Promise.resolve(
        new Response(new Uint8Array([0xde, 0xad, 0xbe, 0xef]), { status: 200 }),
      );
    }) as unknown as typeof fetch;

    await expect(ensureLocalEmbeddingCache(LOCAL_EMBEDDING_MODEL, cacheRoot)).rejects.toThrow(
      /checksum mismatch|Model download failed/,
    );
    // The first file fails checksum on the first attempt; permanent errors exit
    // without consuming remaining attempts.
    expect(calls).toBe(1);
  });

  it("retries retryable HTTP statuses then gives up", async () => {
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return Promise.resolve(new Response(null, { status: 503 }));
    }) as unknown as typeof fetch;

    await expect(ensureLocalEmbeddingCache(LOCAL_EMBEDDING_MODEL, cacheRoot)).rejects.toThrow(
      /503/,
    );
    expect(calls).toBe(3);
  });

  it("exits immediately on a non-retryable HTTP status", async () => {
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as unknown as typeof fetch;

    await expect(ensureLocalEmbeddingCache(LOCAL_EMBEDDING_MODEL, cacheRoot)).rejects.toThrow(
      /404/,
    );
    expect(calls).toBe(1);
  });
});
