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
});
