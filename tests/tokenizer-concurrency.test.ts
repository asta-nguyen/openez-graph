import { describe, expect, it } from "bun:test";

import { exactTokenCounter, fastTokenCounter } from "../packages/core/src/tokenizer";

describe("token counter isolation", () => {
  it("keeps the fast indexing count stable after exact retrieval counting", () => {
    const value = "function calculateTotal(price: number) { return price * 1.2; }";
    const fastBefore = fastTokenCounter.count(value);
    const exact = exactTokenCounter.count(value);
    const fastAfter = fastTokenCounter.count(value);

    expect(fastBefore).toBe(Math.ceil(value.length / 4));
    expect(fastAfter).toBe(fastBefore);
    expect(exact).toBeGreaterThan(0);
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
    for (const chunk of chunks) {
      expect(exactTokenCounter.count(chunk)).toBeLessThanOrEqual(20);
    }
  });

  it("repeated mixed counter calls keep the fast approximation stable", () => {
    const sample = "The quick brown fox jumps over the lazy dog.";
    const iterations = 50;
    const expectedFast = Math.ceil(sample.length / 4);
    for (let i = 0; i < iterations; i++) {
      if (i % 2 === 0) {
        expect(fastTokenCounter.count(sample)).toBe(expectedFast);
      } else {
        expect(exactTokenCounter.count(sample)).toBeGreaterThan(0);
      }
    }
  });
});
