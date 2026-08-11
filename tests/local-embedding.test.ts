import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "bun:test";

import {
  LOCAL_EMBEDDING_MODEL,
  LOCAL_EMBEDDING_MODELS,
  LOCAL_EMBEDDING_REVISION,
  LocalEmbeddingProvider,
  getLocalEmbeddingCacheDir,
} from "../packages/core/src/local-embedding";

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
    expect(getLocalEmbeddingCacheDir()).toContain(
      path.join(".openez", "models", "astanguyen", LOCAL_EMBEDDING_MODEL),
    );
  });

  const fixtureDir = path.resolve(
    import.meta.dir,
    "../jina-code-static-build/jina-code-static-256",
  );
  it.skipIf(!fs.existsSync(path.join(fixtureDir, "model.safetensors")))(
    "loads the Model2Vec tokenizer and returns normalized 256d vectors",
    async () => {
      const provider = new LocalEmbeddingProvider(fixtureDir);
      const vectors = await provider.embed(["function hello() { return 1; }", "graph_neighbors"]);
      expect(vectors).toHaveLength(2);
      expect(vectors[0]).toHaveLength(256);
      expect(Math.hypot(...vectors[0])).toBeCloseTo(1, 5);
      expect(vectors.flat().every(Number.isFinite)).toBe(true);
    },
  );
});
