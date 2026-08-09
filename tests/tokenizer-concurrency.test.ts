import { describe, expect, it } from "bun:test";

import { countTokens, exactTokenCounter, fastTokenCounter } from "../packages/core/src/tokenizer";

describe("token counter isolation", () => {
  it("keeps fast indexing counts isolated from exact retrieval counts", async () => {
    const value = "function calculateTotal(price: number) { return price * 1.2; }";
    const [fast, exact] = await Promise.all([
      Promise.resolve(fastTokenCounter.count(value)),
      Promise.resolve(exactTokenCounter.count(value)),
    ]);

    expect(fast).toBe(Math.ceil(value.length / 4));
    expect(exact).toBe(countTokens(value));
  });

  it("fastTokenCounter splits by approximate character budget", () => {
    const value = "a".repeat(1000);
    const chunks = fastTokenCounter.split(value, 50, 5);
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should be roughly within the token budget
    for (const chunk of chunks) {
      expect(fastTokenCounter.count(chunk)).toBeLessThanOrEqual(60); // some slack for overlap
    }
  });

  it("exactTokenCounter splits using real token counts", () => {
    const value = "function foo() { return 1; } ".repeat(50);
    const chunks = exactTokenCounter.split(value, 20, 5);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("concurrent fast and exact counts do not interfere (no shared mutable state)", async () => {
    const sample = "The quick brown fox jumps over the lazy dog.";
    // Run many interleaved fast/exact counts concurrently.
    const iterations = 50;
    const results = await Promise.all(
      Array.from({ length: iterations }, (_, i) =>
        i % 2 === 0
          ? Promise.resolve(fastTokenCounter.count(sample))
          : Promise.resolve(exactTokenCounter.count(sample)),
      ),
    );

    const expectedFast = Math.ceil(sample.length / 4);
    const expectedExact = countTokens(sample);
    for (let i = 0; i < iterations; i++) {
      if (i % 2 === 0) {
        expect(results[i]).toBe(expectedFast);
      } else {
        expect(results[i]).toBe(expectedExact);
      }
    }
  });
});
