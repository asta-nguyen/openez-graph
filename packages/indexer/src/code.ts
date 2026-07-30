import { Project, SyntaxKind } from "ts-morph";

import { countTokens } from "@openez-graph/core";

import { hashContent } from "./hash";
import type { IndexedChunk } from "./types";

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
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      allowJs: true
    }
  });

  const sourceFile = project.createSourceFile(filePath, content, { overwrite: true });
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

  const declarations = [
    ...sourceFile.getFunctions(),
    ...sourceFile.getClasses(),
    ...sourceFile.getInterfaces(),
    ...sourceFile.getTypeAliases(),
    ...sourceFile.getEnums()
  ];

  declarations.forEach((declaration) => {
    const name = "getName" in declaration ? declaration.getName() : undefined;
    const text = declaration.getText().trim();
    if (!name || !text) {
      return;
    }

    const symbolType = declaration.getKindName().toLowerCase();
    const exported = "hasExportKeyword" in declaration ? declaration.hasExportKeyword() : false;
    const lineRange = getLineRange(declaration);

    definedSymbols.push({ name, type: symbolType, symbolType, exported });
    chunks.push({
      heading: name,
      content: text,
      tokenCount: countTokens(text),
      contentHash: hashContent(text),
      symbolName: name,
      symbolType,
      metadata: {
        kind: "code",
        searchText: codeSearchText(text),
        symbolName: name,
        symbolType,
        exported,
        ...lineRange
      }
    });

    declaration.getDescendantsOfKind(SyntaxKind.CallExpression).forEach((callExpression) => {
      const expression = callExpression.getExpression();
      const calledName = expression.getText();
      if (calledName) {
        calledIdentifiers.add(calledName);
        callExpressions.push({ callerName: name, calleeName: calledName.split(".").pop() ?? calledName });
      }
    });
  });

  variableDeclarations.forEach(({ declaration, exported }) => {
    const name = declaration.getName();
    const text = declaration.getText().trim();
    if (!name || !text || !exported) {
      return;
    }

    const lineRange = getLineRange(declaration);
    definedSymbols.push({ name, symbolType: "variable", type: "variable", exported });
    chunks.push({
      heading: name,
      content: text,
      tokenCount: countTokens(text),
      contentHash: hashContent(text),
      symbolName: name,
      symbolType: "variable",
      metadata: {
        kind: "code",
        searchText: codeSearchText(text),
        symbolName: name,
        symbolType: "variable",
        exported,
        ...lineRange
      }
    });
  });

  if (chunks.length === 0) {
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 80) {
      const slice = lines.slice(index, index + 80).join("\n").trim();
      if (!slice) {
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

  return {
    chunks,
    importPaths: sourceFile.getImportDeclarations().flatMap((declaration) => {
      try {
        const value = declaration.getModuleSpecifierValue();
        return typeof value === "string" && value.length > 0 ? [value] : [];
      } catch {
        return [];
      }
    }),
    definedSymbols,
    calledIdentifiers: [...calledIdentifiers],
    callExpressions
  };
}
