import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "bun:test";

import { scanWorkspaceFiles } from "../packages/indexer/src/scanner";

describe("scanWorkspaceFiles", () => {
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
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("respects .gitignore negation rules", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openez-scan-neg-"));
    try {
      fs.mkdirSync(path.join(root, "temp"), { recursive: true });
      fs.writeFileSync(path.join(root, "temp", "ignored.js"), "console.log('ignored')\n");
      fs.writeFileSync(path.join(root, "temp", "special.js"), "console.log('special')\n");
      fs.writeFileSync(path.join(root, ".gitignore"), "temp/*\n!temp/special.js\n");

      const files = await scanWorkspaceFiles({ rootPath: root });
      const relativePaths = files.map((f) => f.relativePath).sort();

      expect(relativePaths).toContain("temp/special.js");
      expect(relativePaths).not.toContain("temp/ignored.js");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not allow gitignore negations to bypass hard DEFAULT_EXCLUDE_PATTERNS", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openez-scan-hard-"));
    try {
      fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
      fs.writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "export const a = 1;\n");
      fs.writeFileSync(path.join(root, ".gitignore"), "!node_modules\n!node_modules/**\n");

      const files = await scanWorkspaceFiles({ rootPath: root });
      const relativePaths = files.map((f) => f.relativePath);

      expect(relativePaths).not.toContain("node_modules/pkg/index.js");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("evaluates gitignore rules in sequential order where last matching rule wins", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openez-scan-seq-"));
    try {
      fs.mkdirSync(path.join(root, "docs"), { recursive: true });
      fs.writeFileSync(path.join(root, "docs", "a.md"), "# A\n");
      fs.writeFileSync(path.join(root, "docs", "b.md"), "# B\n");
      // Rule 1 ignores all docs, Rule 2 un-ignores docs/a.md, Rule 3 re-ignores docs/a.md
      fs.writeFileSync(path.join(root, ".gitignore"), "docs/*\n!docs/a.md\ndocs/a.md\n");

      const files = await scanWorkspaceFiles({ rootPath: root });
      const relativePaths = files.map((f) => f.relativePath);

      expect(relativePaths).not.toContain("docs/a.md");
      expect(relativePaths).not.toContain("docs/b.md");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
