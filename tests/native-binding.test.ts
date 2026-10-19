import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { loadNativeBinding, resetNativeBindingCache } from "../packages/indexer/src/native-binding";
import {
  resetNativeParserCache,
  resolveNativeParser,
} from "../packages/indexer/src/index-workspace";

const FIXTURES = path.join(import.meta.dir, "fixtures", "native-binding");
const THROWING = path.join(FIXTURES, "throwing-binding.cjs");
const STUB = path.join(FIXTURES, "stub-binding.cjs");

afterEach(() => {
  resetNativeParserCache();
  resetNativeBindingCache();
  delete process.env.OPENEZ_NATIVE;
});

describe("loadNativeBinding", () => {
  test("OPENEZ_NATIVE=0 disables the binding and the native parser", () => {
    process.env.OPENEZ_NATIVE = "0";
    expect(loadNativeBinding()).toBeNull();
    expect(resolveNativeParser()).toBeNull();
  });

  test("a candidate that throws on load resolves to null without throwing", () => {
    expect(() => loadNativeBinding([THROWING])).not.toThrow();
    expect(loadNativeBinding([THROWING])).toBeNull();
  });

  test("a stub candidate is returned, and a second call returns the same object", () => {
    const binding = loadNativeBinding([STUB]);
    expect(binding).not.toBeNull();
    expect(typeof (binding as { parseCodeBatch?: unknown }).parseCodeBatch).toBe("function");
    expect(loadNativeBinding([STUB])).toBe(binding);
  });

  test("falls through a throwing candidate to a later working one", () => {
    const binding = loadNativeBinding([THROWING, STUB]);
    expect(binding).not.toBeNull();
    expect(typeof (binding as { scanWorkspaceFast?: unknown }).scanWorkspaceFast).toBe("function");
  });

  test("OPENEZ_NATIVE=0 wins even when a working candidate is supplied", () => {
    process.env.OPENEZ_NATIVE = "0";
    expect(loadNativeBinding([STUB])).toBeNull();
  });
});
