import { countTokens } from "./tokenizer";

import { hashContent } from "./hash";
import type { IndexedChunk } from "./types";

// Lazy-load ts-morph — only needed for TS/JS files (~200MB saved for C/Python/etc repos)
let _tsMorph: typeof import("ts-morph") | null = null;
function tsMorph() {
  if (!_tsMorph) {
    try { _tsMorph = require("ts-morph"); } catch {
      // Bundled worker can't find ts-morph via normal resolution
      const mod = require("module");
      const path = require("path");
      // Try resolving from the indexer package source (where node_modules lives)
      const candidates = [
        path.join(__dirname, "package.json"),
        path.join(__dirname, "..", "package.json"),
        path.join(__dirname, "..", "..", "package.json"),
        path.join(__dirname, "..", "..", "..", "package.json"),
        path.join(__dirname, "..", "..", "..", "..", "package.json"),
        path.join(__dirname, "..", "..", "..", "..", "..", "package.json"),
        path.join(__dirname, "..", "..", "..", "..", "..", "..", "packages", "indexer", "package.json"),
      ];
      for (const candidate of candidates) {
        try {
          _tsMorph = mod.createRequire(candidate)("ts-morph");
          if (process.env.OPENEZ_DEBUG) console.error("[worker] ts-morph resolved from:", candidate);
          break;
        } catch { /* try next */ }
      }
      if (!_tsMorph) throw new Error("ts-morph not found — ensure @openez-graph/indexer dependencies are installed");
    }
  }
  return _tsMorph;
}

let _project: import("ts-morph").Project | null = null;
function project() {
  if (!_project) {
    const { Project } = tsMorph();
    _project = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true } });
  }
  return _project;
}

function getLineRange(node: { getStartLineNumber(): number; getEndLineNumber(): number }) {
  return {
    startLine: node.getStartLineNumber(),
    endLine: node.getEndLineNumber()
  };
}

function codeSearchText(text: string): string {
  const identifiers = text.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
  return [...new Set(identifiers.flatMap((identifier) => identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(" ")
    .filter((term) => term.length > 1)))]
    .slice(0, 256)
    .join(" ");
}

export function indexCode(content: string, filePath: string): {
  chunks: IndexedChunk[];
  importPaths: string[];
  definedSymbols: Array<{ name: string; type: string; symbolType: string; exported: boolean }>;
  calledIdentifiers: string[];
  callExpressions: Array<{ callerName: string; calleeName: string }>;
} {
  const { SyntaxKind } = tsMorph();
  const sourceFile = project().createSourceFile(filePath, content, { overwrite: true });
  try {
    const chunks: IndexedChunk[] = [];
    const definedSymbols: Array<{ name: string; type: string; symbolType: string; exported: boolean }> = [];
    const calledIdentifiers = new Set<string>();
    const callExpressions: Array<{ callerName: string; calleeName: string }> = [];

    sourceFile.getImportDeclarations().forEach((declaration) => {
      declaration.getDescendantsOfKind(SyntaxKind.Identifier).forEach((identifier) => {
        if (identifier.getText()) {
          calledIdentifiers.add(identifier.getText());
        }
      });
    });

    const variableDeclarations = sourceFile.getVariableStatements().flatMap((statement) =>
      statement.getDeclarations().map((declaration) => ({
        declaration,
        exported: statement.hasExportKeyword()
      }))
    );

    const functions = sourceFile.getFunctions().map((declaration) => ({
      declaration,
      name: declaration.getName(),
      type: "function",
      symbolType: "function",
      exported: declaration.isExported()
    }));

    const classes = sourceFile.getClasses().map((declaration) => ({
      declaration,
      name: declaration.getName(),
      type: "class",
      symbolType: "class",
      exported: declaration.isExported()
    }));

    const interfaces = sourceFile.getInterfaces().map((declaration) => ({
      declaration,
      name: declaration.getName(),
      type: "interface",
      symbolType: "interface",
      exported: declaration.isExported()
    }));

    const typeAliases = sourceFile.getTypeAliases().map((declaration) => ({
      declaration,
      name: declaration.getName(),
      type: "type",
      symbolType: "type",
      exported: declaration.isExported()
    }));

    const symbols = [
      ...functions,
      ...classes,
      ...interfaces,
      ...typeAliases,
      ...variableDeclarations.map(({ declaration, exported }) => ({
        declaration,
        name: declaration.getName(),
        type: "variable",
        symbolType: "variable",
        exported
      }))
    ].filter((symbol): symbol is typeof symbol & { name: string } => Boolean(symbol.name));

    for (const symbol of symbols) {
      definedSymbols.push({
        name: symbol.name,
        type: symbol.type,
        symbolType: symbol.symbolType,
        exported: symbol.exported
      });

      const { startLine, endLine } = getLineRange(symbol.declaration);
      const text = symbol.declaration.getText();
      chunks.push({
        content: text,
        tokenCount: countTokens(text),
        contentHash: hashContent(text),
        metadata: {
          kind: "code",
          symbolName: symbol.name,
          symbolType: symbol.symbolType,
          exported: symbol.exported,
          searchText: codeSearchText(text),
          startLine,
          endLine
        }
      });

      symbol.declaration.getDescendantsOfKind(SyntaxKind.CallExpression).forEach((call) => {
        const expression = call.getExpression();
        const calleeName = expression.getText();
        if (calleeName) {
          calledIdentifiers.add(calleeName);
          callExpressions.push({ callerName: symbol.name, calleeName });
        }
      });
    }

    if (chunks.length === 0) {
      const lines = content.split("\n");
      for (let index = 0; index < lines.length; index += 80) {
        const slice = lines.slice(index, index + 80).join("\n");
        if (!slice.trim()) {
          continue;
        }
        chunks.push({
          content: slice,
          tokenCount: countTokens(slice),
          contentHash: hashContent(slice),
          metadata: {
            kind: "code",
            searchText: codeSearchText(slice),
            fallback: true,
            startLine: index + 1,
            endLine: Math.min(index + 80, lines.length)
          }
        });
      }
    }

    const importPaths = sourceFile.getImportDeclarations().flatMap((declaration) => {
      try {
        const value = declaration.getModuleSpecifierValue();
        return typeof value === "string" && value.length > 0 ? [value] : [];
      } catch {
        return [];
      }
    });

    return {
      chunks,
      importPaths,
      definedSymbols,
      calledIdentifiers: [...calledIdentifiers],
      callExpressions
    };
  } finally {
    project().removeSourceFile(sourceFile);
  }
}
