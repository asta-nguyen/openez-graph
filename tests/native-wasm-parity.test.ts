import fs from "node:fs";
import path from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import {
  resetNativeParserCache,
  resolveNativeParser,
} from "../packages/indexer/src/index-workspace";
import {
  cppConfig,
  goConfig,
  parseWithTreeSitter,
  pythonConfig,
  rubyConfig,
  rustConfig,
  type LanguageConfig,
} from "../packages/indexer/src/tree-sitter";

/**
 * Parity harness: compares the optional Rust native parser's `parseCodeBatch`
 * output with the WASM tree-sitter parser (`parseWithTreeSitter`) on the same
 * content, per normalized field, order-insensitive. The exact differences are
 * pinned in `tests/fixtures/parity/known-differences.json`; this change
 * records existing differences and fixes none.
 *
 * - Skipped when no native binding loads.
 * - Fails when `OPENEZ_NATIVE_EXPECT=1` and no binding loads.
 * - `OPENEZ_UPDATE_BASELINE=1` rewrites `known-differences.json` from the
 *   computed differences instead of asserting them.
 */

const PARITY_DIR = path.join(import.meta.dir, "fixtures", "parity");
const PINS_PATH = path.join(PARITY_DIR, "known-differences.json");

const LANG_CONFIG: Record<string, LanguageConfig> = {
  python: pythonConfig,
  go: goConfig,
  rust: rustConfig,
  ruby: rubyConfig,
  cpp: cppConfig,
};

// ── Pure difference computation ──

interface NativeSymbol {
  name: string;
  symbolType: string;
  exported: boolean;
  startLine: number;
  endLine: number;
  receiver?: string;
}

interface NativeParseResult {
  symbols: NativeSymbol[];
  importPaths: string[];
  calledIdentifiers: string[];
  callExpressions: Array<{ callerName: string; calleeName: string }>;
}

interface WasmParseResult {
  definedSymbols?: NativeSymbol[];
  importPaths?: string[];
  calledIdentifiers?: string[];
  callExpressions?: Array<{ callerName: string; calleeName: string }>;
}

interface FieldDiff {
  onlyNative: string[];
  onlyWasm: string[];
}

interface ParityDiff {
  symbols: FieldDiff;
  importPaths: FieldDiff;
  callExpressions: FieldDiff;
  calledIdentifiers: FieldDiff;
}

function emptyFieldDiff(): FieldDiff {
  return { onlyNative: [], onlyWasm: [] };
}

function emptyParityDiff(): ParityDiff {
  return {
    symbols: emptyFieldDiff(),
    importPaths: emptyFieldDiff(),
    callExpressions: emptyFieldDiff(),
    calledIdentifiers: emptyFieldDiff(),
  };
}

/** Multiset difference: items present more often on one side, sorted. */
function multisetDiff(nativeItems: string[], wasmItems: string[]): FieldDiff {
  const counts = (items: string[]) => {
    const map = new Map<string, number>();
    for (const item of items) map.set(item, (map.get(item) ?? 0) + 1);
    return map;
  };
  const nativeCounts = counts(nativeItems);
  const wasmCounts = counts(wasmItems);
  const onlyNative: string[] = [];
  const onlyWasm: string[] = [];
  const keys = new Set([...nativeCounts.keys(), ...wasmCounts.keys()]);
  for (const key of [...keys].sort()) {
    const surplus = (nativeCounts.get(key) ?? 0) - (wasmCounts.get(key) ?? 0);
    for (let i = 0; i < Math.abs(surplus); i++) {
      (surplus > 0 ? onlyNative : onlyWasm).push(key);
    }
  }
  return { onlyNative, onlyWasm };
}

function canonSymbol(symbol: NativeSymbol): string {
  return JSON.stringify({
    name: symbol.name,
    symbolType: symbol.symbolType,
    exported: symbol.exported,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
    ...(symbol.receiver !== undefined ? { receiver: symbol.receiver } : {}),
  });
}

function canonCall(call: { callerName: string; calleeName: string }): string {
  return JSON.stringify({ callerName: call.callerName, calleeName: call.calleeName });
}

function computeParityDiff(native: NativeParseResult, wasm: WasmParseResult): ParityDiff {
  return {
    symbols: multisetDiff(
      native.symbols.map(canonSymbol),
      (wasm.definedSymbols ?? []).map(canonSymbol),
    ),
    importPaths: multisetDiff(native.importPaths, wasm.importPaths ?? []),
    callExpressions: multisetDiff(
      native.callExpressions.map(canonCall),
      (wasm.callExpressions ?? []).map(canonCall),
    ),
    calledIdentifiers: multisetDiff(native.calledIdentifiers, wasm.calledIdentifiers ?? []),
  };
}

// ── Pin handling ──

type PinMap = Record<string, Partial<ParityDiff>>;

function normalizeField(field?: Partial<FieldDiff>): FieldDiff {
  return {
    onlyNative: [...(field?.onlyNative ?? [])].sort(),
    onlyWasm: [...(field?.onlyWasm ?? [])].sort(),
  };
}

function normalizePin(entry?: Partial<ParityDiff>): ParityDiff {
  return {
    symbols: normalizeField(entry?.symbols),
    importPaths: normalizeField(entry?.importPaths),
    callExpressions: normalizeField(entry?.callExpressions),
    calledIdentifiers: normalizeField(entry?.calledIdentifiers),
  };
}

function normalizeDiff(diff: ParityDiff): ParityDiff {
  return normalizePin(diff);
}

function isEmptyDiff(diff: ParityDiff): boolean {
  return [diff.symbols, diff.importPaths, diff.callExpressions, diff.calledIdentifiers].every(
    (field) => field.onlyNative.length === 0 && field.onlyWasm.length === 0,
  );
}

function readPins(): PinMap {
  if (!fs.existsSync(PINS_PATH)) return {};
  return JSON.parse(fs.readFileSync(PINS_PATH, "utf8")) as PinMap;
}

// ── Fixture enumeration ──

interface FixtureCase {
  key: string;
  language: string;
  config: LanguageConfig;
  content: string;
}

function listFixtureCases(): FixtureCase[] {
  const cases: FixtureCase[] = [];
  for (const [language, config] of Object.entries(LANG_CONFIG)) {
    const dir = path.join(PARITY_DIR, language);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir).sort()) {
      const filePath = path.join(dir, entry);
      if (!fs.statSync(filePath).isFile()) continue;
      const content = fs.readFileSync(filePath, "utf8");
      const relKey = `${language}/${entry}`;
      cases.push({ key: relKey, language, config, content });
      cases.push({
        key: `${relKey}#crlf`,
        language,
        config,
        content: content.replace(/\n/g, "\r\n"),
      });
    }
  }
  return cases;
}

// ── Unit tests for the pure helpers ──

describe("computeParityDiff", () => {
  const baseSymbols: NativeSymbol[] = [
    { name: "main", symbolType: "function", exported: true, startLine: 1, endLine: 3 },
  ];
  const baseCall = { callerName: "main", calleeName: "helper" };

  test("a call present only in the native result lands in onlyNative", () => {
    const diff = computeParityDiff(
      {
        symbols: baseSymbols,
        importPaths: [],
        calledIdentifiers: ["helper"],
        callExpressions: [baseCall],
      },
      { definedSymbols: baseSymbols, importPaths: [], calledIdentifiers: [], callExpressions: [] },
    );
    expect(diff.callExpressions.onlyNative).toEqual([canonCall(baseCall)]);
    expect(diff.callExpressions.onlyWasm).toEqual([]);
    expect(diff.calledIdentifiers.onlyNative).toEqual(["helper"]);
  });

  test("a call present in both results yields an empty difference", () => {
    const diff = computeParityDiff(
      {
        symbols: baseSymbols,
        importPaths: ["os"],
        calledIdentifiers: ["helper"],
        callExpressions: [baseCall],
      },
      {
        definedSymbols: baseSymbols,
        importPaths: ["os"],
        calledIdentifiers: ["helper"],
        callExpressions: [baseCall],
      },
    );
    expect(isEmptyDiff(diff)).toBe(true);
  });

  test("symbol field differences compare as whole records", () => {
    const nativeSymbols = [
      ...baseSymbols,
      {
        name: "F::Close",
        symbolType: "function",
        exported: true,
        startLine: 5,
        endLine: 7,
        receiver: "f F",
      },
    ];
    const wasmSymbols = [
      ...baseSymbols,
      {
        name: "F::Close",
        symbolType: "function",
        exported: true,
        startLine: 5,
        endLine: 7,
        receiver: "f *F",
      },
    ];
    const diff = computeParityDiff(
      { symbols: nativeSymbols, importPaths: [], calledIdentifiers: [], callExpressions: [] },
      { definedSymbols: wasmSymbols, importPaths: [], calledIdentifiers: [], callExpressions: [] },
    );
    expect(diff.symbols.onlyNative).toHaveLength(1);
    expect(diff.symbols.onlyWasm).toHaveLength(1);
    expect(JSON.parse(diff.symbols.onlyNative[0]).receiver).toBe("f F");
    expect(JSON.parse(diff.symbols.onlyWasm[0]).receiver).toBe("f *F");
  });

  test("duplicate items are counted as a multiset, not a set", () => {
    const diff = computeParityDiff(
      {
        symbols: [],
        importPaths: [],
        calledIdentifiers: ["x"],
        callExpressions: [baseCall, baseCall, baseCall],
      },
      {
        definedSymbols: [],
        importPaths: [],
        calledIdentifiers: ["x"],
        callExpressions: [baseCall],
      },
    );
    expect(diff.callExpressions.onlyNative).toEqual([canonCall(baseCall), canonCall(baseCall)]);
    expect(diff.callExpressions.onlyWasm).toEqual([]);
  });
});

describe("pin comparison semantics", () => {
  const pinned: ParityDiff = {
    symbols: emptyFieldDiff(),
    importPaths: emptyFieldDiff(),
    callExpressions: {
      onlyNative: [canonCall({ callerName: "a", calleeName: "a" })],
      onlyWasm: [],
    },
    calledIdentifiers: { onlyNative: ["a"], onlyWasm: [] },
  };

  test("an unpinned difference fails the pin check", () => {
    const actual = structuredClone(pinned);
    actual.importPaths.onlyNative = ["fmt"];
    expect(normalizeDiff(actual)).not.toEqual(normalizePin(pinned));
  });

  test("a pin whose content changed fails the pin check", () => {
    const tampered = structuredClone(pinned);
    tampered.calledIdentifiers = { onlyNative: ["b"], onlyWasm: [] };
    expect(normalizeDiff(pinned)).not.toEqual(normalizePin(tampered));
  });

  test("a pin for a difference that no longer occurs fails the pin check", () => {
    const actual = emptyParityDiff();
    expect(normalizeDiff(actual)).not.toEqual(normalizePin(pinned));
  });
});

// ── Parity suite ──

resetNativeParserCache();
const native = resolveNativeParser();
const nativeExpected = process.env.OPENEZ_NATIVE_EXPECT === "1";
const updateBaseline = process.env.OPENEZ_UPDATE_BASELINE === "1";
const collectedDiffs = new Map<string, ParityDiff>();

afterAll(() => {
  if (!updateBaseline || !native) return;
  const pins: PinMap = {};
  for (const [key, diff] of [...collectedDiffs.entries()].sort()) {
    if (!isEmptyDiff(diff)) pins[key] = diff;
  }
  fs.writeFileSync(PINS_PATH, `${JSON.stringify(pins, null, 2)}\n`);
});

describe("native-wasm parity", () => {
  test("native binding loads when OPENEZ_NATIVE_EXPECT=1 or baseline update is requested", () => {
    if (!nativeExpected && !updateBaseline) return;
    expect(native).not.toBeNull();
  });

  test("parity fixtures are discovered (suite cannot pass vacuously)", () => {
    expect(listFixtureCases().length).toBeGreaterThan(0);
  });

  test("required parity fixtures are present and pin keys are exact", () => {
    // A missing required fixture, an orphaned pin key, or an all-empty pin
    // entry fails instead of silently reducing coverage. Each fixture file
    // yields a `file` and `file#crlf` case; the manifest lists file keys.
    const REQUIRED_FIXTURES = [
      "cpp/example.cpp",
      "cpp/header.h",
      "go/example.go",
      "python/example.py",
      "ruby/example.rb",
      "ruby/torture.rb",
      "rust/example.rs",
    ];
    const keys = new Set(listFixtureCases().map((c) => c.key));
    for (const required of REQUIRED_FIXTURES) {
      expect(keys.has(required), `required fixture ${required} is missing`).toBe(true);
      expect(keys.has(`${required}#crlf`), `required fixture ${required}#crlf is missing`).toBe(
        true,
      );
    }
    const pins = readPins();
    for (const pinKey of Object.keys(pins)) {
      expect(keys.has(pinKey), `pin ${pinKey} has no matching fixture case`).toBe(true);
      expect(
        isEmptyDiff(normalizePin(pins[pinKey])),
        `pin ${pinKey} records an empty difference`,
      ).toBe(false);
    }
  });

  const pins = readPins();

  for (const fixture of listFixtureCases()) {
    const testFn = native ? test : test.skip;
    testFn(`${fixture.key} differs only by the pinned entries`, async () => {
      const nativeResults = native!.parseCodeBatch([
        { language: fixture.language, content: fixture.content },
      ]);
      expect(nativeResults).toHaveLength(1);
      const nativeResult = nativeResults[0];
      expect(nativeResult).toBeTruthy();

      const wasm = await parseWithTreeSitter(fixture.config, fixture.content);
      expect(wasm).toBeTruthy();

      const diff = computeParityDiff(nativeResult!, {
        definedSymbols: (wasm!.definedSymbols as NativeSymbol[] | undefined) ?? [],
        importPaths: wasm!.importPaths,
        calledIdentifiers: wasm!.calledIdentifiers,
        callExpressions: wasm!.callExpressions,
      });
      collectedDiffs.set(fixture.key, diff);
      if (!updateBaseline) {
        expect(normalizeDiff(diff)).toEqual(normalizePin(pins[fixture.key]));
      }
    });
  }
});
