import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "bun:test";

import { ensureOpenezIgnore, scanWorkspaceFiles } from "../packages/indexer/src/scanner";
import { rmTempDir } from "./helpers/temp-cleanup";

describe("ensureOpenezIgnore", () => {
  it("creates a default .openezignore once and never overwrites it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openez-ignore-"));
    try {
      const file = path.join(root, ".openezignore");
      expect(ensureOpenezIgnore(root)).toBe(true);
      expect(fs.readFileSync(file, "utf8")).toContain("*.min.js");

      fs.writeFileSync(file, "custom/\n");
      expect(ensureOpenezIgnore(root)).toBe(false);
      expect(fs.readFileSync(file, "utf8")).toBe("custom/\n");
    } finally {
      rmTempDir(root);
    }
  });

  it("skips files matched by the default patterns", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openez-ignore-"));
    try {
      fs.mkdirSync(path.join(root, "vendor"));
      fs.writeFileSync(path.join(root, "vendor", "lib.go"), "package lib\n");
      fs.writeFileSync(path.join(root, "app.min.js"), "var a=1;\n");
      fs.writeFileSync(path.join(root, "app.js"), "export const a = 1;\n");
      ensureOpenezIgnore(root);

      const files = await scanWorkspaceFiles({ rootPath: root });
      expect(files.map((f) => f.relativePath)).toEqual(["app.js"]);
    } finally {
      rmTempDir(root);
    }
  });
});

describe("scanWorkspaceFiles", () => {
  it("never scans config files named like credentials or secrets", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openez-scan-"));
    try {
      fs.mkdirSync(path.join(root, "config"));
      fs.mkdirSync(path.join(root, "src"));
      for (const file of [
        "config/credentials.json",
        "config/app-secrets.yaml",
        "service-account-prod.json",
        "deploy/secret.toml",
      ]) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), '{"private_key":"x"}\n');
      }
      // Code that handles secrets is ordinary source and stays searchable.
      fs.writeFileSync(path.join(root, "src", "secrets.ts"), "export const load = 1;\n");
      fs.writeFileSync(path.join(root, "src", "credentials.ts"), "export const read = 1;\n");
      fs.writeFileSync(path.join(root, "config", "app.json"), '{"port":1}\n');

      for (const include of [undefined, "**/*.ts\n**/*.json\n**/*.yaml\n**/*.toml"]) {
        const files = await scanWorkspaceFiles({ rootPath: root, include });
        expect(files.map((f) => f.relativePath)).toEqual([
          "config/app.json",
          "src/credentials.ts",
          "src/secrets.ts",
        ]);
      }
    } finally {
      rmTempDir(root);
    }
  });

  it("does not let a negated .gitignore line ignore every file", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openez-scan-"));
    try {
      fs.writeFileSync(path.join(root, ".gitignore"), ".env.*\n!.env.example\n");
      fs.writeFileSync(path.join(root, "app.ts"), "export const app = 1;\n");

      for (const include of [undefined, "**/*.ts"]) {
        const files = await scanWorkspaceFiles({ rootPath: root, include });
        expect(files.map((f) => f.relativePath)).toEqual(["app.ts"]);
      }
    } finally {
      rmTempDir(root);
    }
  });

  it("skips paths listed in .openezignore on both scan paths", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openez-scan-"));
    try {
      fs.mkdirSync(path.join(root, "docs", "plans"), { recursive: true });
      fs.mkdirSync(path.join(root, "src"));
      fs.writeFileSync(path.join(root, "docs", "plans", "old.md"), "# Old plan\n");
      fs.writeFileSync(path.join(root, "notes.draft.md"), "# Draft\n");
      fs.writeFileSync(path.join(root, "src", "keep.ts"), "export const keep = 1;\n");
      fs.writeFileSync(
        path.join(root, ".openezignore"),
        "# agent plans\ndocs/plans/\n*.draft.md\n",
      );

      // No include → native fast path when available; explicit include → fast-glob path.
      for (const include of [undefined, "**/*.ts\n**/*.md"]) {
        const files = await scanWorkspaceFiles({ rootPath: root, include });
        expect(files.map((f) => f.relativePath)).toEqual(["src/keep.ts"]);
      }
    } finally {
      rmTempDir(root);
    }
  });

  it("includes Ruby, CoffeeScript, CSS, SCSS, Slim, Haml files", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openez-scan-"));
    try {
      fs.writeFileSync(path.join(root, "app.rb"), "class App; end\n");
      fs.writeFileSync(path.join(root, "script.coffee"), "console.log 'hi'\n");
      fs.writeFileSync(path.join(root, "doc.litcoffee"), "# Title\n");
      fs.writeFileSync(path.join(root, "style.css"), ".a { color: red; }\n");
      fs.writeFileSync(path.join(root, "style.scss"), ".a { color: red; }\n");
      fs.writeFileSync(path.join(root, "style.sass"), ".a\n  color: red\n");
      fs.writeFileSync(path.join(root, "style.less"), ".a { color: red; }\n");
      fs.writeFileSync(path.join(root, "view.slim"), "h1 Hello\n");
      fs.writeFileSync(path.join(root, "view.haml"), "%h1 Hello\n");
      fs.mkdirSync(path.join(root, "node_modules"));
      fs.writeFileSync(path.join(root, "node_modules", "ignored.js"), "ignored\n");

      const files = await scanWorkspaceFiles({ rootPath: root });
      const relativePaths = files.map((f) => f.relativePath).sort();
      expect(relativePaths).toEqual(
        expect.arrayContaining([
          "app.rb",
          "script.coffee",
          "doc.litcoffee",
          "style.css",
          "style.scss",
          "style.sass",
          "style.less",
          "view.slim",
          "view.haml",
        ]),
      );
      expect(relativePaths).not.toContain("node_modules/ignored.js");
    } finally {
      rmTempDir(root);
    }
  });
});
