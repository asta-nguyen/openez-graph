import { describe, expect, it } from "bun:test";

import {
  ConfigParser,
  FallbackParser,
  getParserForPath,
  MarkdownParser,
  OxcParser,
  parseDocument,
  TreeSitterParser,
} from "../packages/indexer/src/parsers";

describe("parser registry dispatch", () => {
  it("selects MarkdownParser for .md files", () => {
    expect(getParserForPath("README.md")).toBeInstanceOf(MarkdownParser);
    expect(getParserForPath("docs/guide.md")).toBeInstanceOf(MarkdownParser);
  });

  it("selects OxcParser for TS/JS files", () => {
    expect(getParserForPath("src/index.ts")).toBeInstanceOf(OxcParser);
    expect(getParserForPath("src/component.tsx")).toBeInstanceOf(OxcParser);
    expect(getParserForPath("src/legacy.js")).toBeInstanceOf(OxcParser);
    expect(getParserForPath("src/legacy.jsx")).toBeInstanceOf(OxcParser);
  });

  it("selects TreeSitterParser for Python/Go/Rust files", () => {
    expect(getParserForPath("main.py")).toBeInstanceOf(TreeSitterParser);
    expect(getParserForPath("main.go")).toBeInstanceOf(TreeSitterParser);
    expect(getParserForPath("main.rs")).toBeInstanceOf(TreeSitterParser);
  });

  it("selects ConfigParser for config files", () => {
    expect(getParserForPath("package.json")).toBeInstanceOf(ConfigParser);
    expect(getParserForPath("tsconfig.json")).toBeInstanceOf(ConfigParser);
    expect(getParserForPath(".eslintrc.json")).toBeInstanceOf(ConfigParser);
  });

  it("falls back to FallbackParser for unknown file types", () => {
    expect(getParserForPath("README.txt")).toBeInstanceOf(FallbackParser);
    expect(getParserForPath("data.bin")).toBeInstanceOf(FallbackParser);
    expect(getParserForPath("notes.unknownext")).toBeInstanceOf(FallbackParser);
  });
});

describe("parseDocument metadata", () => {
  it("tags markdown output with parser=markdown", async () => {
    const result = await parseDocument({
      relativePath: "README.md",
      absolutePath: "/tmp/README.md",
      content: "# Hello\n\nWorld\n",
      targetTokens: 500,
      overlapTokens: 50,
    });
    expect(result.parser).toBe("markdown");
    expect(result.kind).toBe("markdown");
    expect(result.language).toBe("markdown");
  });

  it("tags TS output with parser=oxc", async () => {
    const result = await parseDocument({
      relativePath: "example.ts",
      absolutePath: "/tmp/example.ts",
      content: "export function greet(name: string): string { return `Hello, ${name}`; }",
      targetTokens: 500,
      overlapTokens: 50,
    });
    expect(result.parser).toBe("oxc");
    expect(result.kind).toBe("code");
    expect(result.language).toBe("typescript");
  });

  it("tags Python output with parser=tree-sitter (when grammar loads)", async () => {
    const result = await parseDocument({
      relativePath: "example.py",
      absolutePath: "/tmp/example.py",
      content: "def greet(name):\n    return f'Hello, {name}'\n",
      targetTokens: 500,
      overlapTokens: 50,
    });
    // tree-sitter if grammar loads, regex if not — both are valid
    expect(["tree-sitter", "regex"]).toContain(result.parser);
    expect(result.kind).toBe("code");
    expect(result.language).toBe("python");
  });

  it("tags Go output with parser=tree-sitter (when grammar loads)", async () => {
    const result = await parseDocument({
      relativePath: "main.go",
      absolutePath: "/tmp/main.go",
      content: 'package main\n\nimport "fmt"\n\nfunc main() {\n    fmt.Println("hi")\n}\n',
      targetTokens: 500,
      overlapTokens: 50,
    });
    expect(["tree-sitter", "regex"]).toContain(result.parser);
    expect(result.kind).toBe("code");
    expect(result.language).toBe("go");
  });

  it("tags Rust output with parser=tree-sitter (when grammar loads)", async () => {
    const result = await parseDocument({
      relativePath: "main.rs",
      absolutePath: "/tmp/main.rs",
      content: 'fn main() { println!("hi"); }\n',
      targetTokens: 500,
      overlapTokens: 50,
    });
    expect(["tree-sitter", "regex"]).toContain(result.parser);
    expect(result.kind).toBe("code");
    expect(result.language).toBe("rust");
  });

  it("tags config output with parser=config", async () => {
    const result = await parseDocument({
      relativePath: "package.json",
      absolutePath: "/tmp/package.json",
      content: '{"name": "test", "version": "1.0.0"}',
      targetTokens: 500,
      overlapTokens: 50,
    });
    expect(result.parser).toBe("config");
    expect(result.kind).toBe("config");
  });

  it("tags unknown files with parser=fallback", async () => {
    const result = await parseDocument({
      relativePath: "notes.txt",
      absolutePath: "/tmp/notes.txt",
      content: "just some text\n",
      targetTokens: 500,
      overlapTokens: 50,
    });
    expect(result.parser).toBe("fallback");
    expect(result.chunks).toHaveLength(1);
  });
});

describe("CodeParser interface contract", () => {
  it("every parser exposes a non-empty name", () => {
    const parsers = [
      new MarkdownParser(),
      new ConfigParser(),
      new OxcParser(),
      new TreeSitterParser(),
      new FallbackParser(),
    ];
    for (const p of parsers) {
      expect(p.name).toBeTruthy();
      expect(typeof p.name).toBe("string");
    }
  });

  it("FallbackParser.canParse always returns true", () => {
    const p = new FallbackParser();
    expect(p.canParse()).toBe(true);
  });
});
