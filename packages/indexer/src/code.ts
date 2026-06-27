import ts from "typescript";

import { countTokens } from "@openez-graph/core";

import { hashContent } from "./hash";
import type { IndexedChunk } from "./types";

// Native TypeScript compiler API — ~2x faster than ts-morph for the same
// extraction. ts-morph's Project adds overhead for cross-file analysis that
// we don't need. ts.createSourceFile is a lightweight single-file parser.
const ScriptKindMap = {
  ".ts": ts.ScriptKind.TS,
  ".tsx": ts.ScriptKind.TSX,
  ".js": ts.ScriptKind.JS,
  ".jsx": ts.ScriptKind.JSX,
  ".mjs": ts.ScriptKind.JS,
  ".mts": ts.ScriptKind.TS,
  ".cts": ts.ScriptKind.TS,
} as const;

function getScriptKind(filePath: string): ts.ScriptKind {
  for (const [ext, kind] of Object.entries(ScriptKindMap)) {
    if (filePath.endsWith(ext)) return kind;
  }
  return ts.ScriptKind.TS;
}

function getLineFromPosition(lineStarts: readonly number[], pos: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1; // 1-based
}

// Regex for call expressions within declaration text.
// Matches identifier( or obj.method( patterns.
const CALL_REGEX = /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g;

export function indexCode(content: string, filePath: string): {
  chunks: IndexedChunk[];
  importPaths: string[];
  definedSymbols: Array<{ name: string; type: string; symbolType: string; exported: boolean }>;
  calledIdentifiers: string[];
  callExpressions: Array<{ callerName: string; calleeName: string }>;
} {
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true, // setParentNodes — needed for getText()
    getScriptKind(filePath)
  );

  const chunks: IndexedChunk[] = [];
  const definedSymbols: Array<{ name: string; type: string; symbolType: string; exported: boolean }> = [];
  const calledIdentifiers = new Set<string>();
  const callExpressions: Array<{ callerName: string; calleeName: string }> = [];
  const importPaths: string[] = [];

  const lineStarts = sourceFile.getLineStarts();

  function getLineRange(node: ts.Node) {
    return {
      startLine: getLineFromPosition(lineStarts, node.getStart(sourceFile)),
      endLine: getLineFromPosition(lineStarts, node.getEnd()),
    };
  }

  function hasExportModifier(node: ts.Node): boolean {
    if (!("modifiers" in node) || !node.modifiers) return false;
    return (node.modifiers as ts.NodeArray<ts.ModifierLike>).some(
      (m) => m.kind === ts.SyntaxKind.ExportKeyword
    );
  }

  // Quick scan: does this file have any exports? If not, skip import
  // identifier extraction — there are no symbols to build edges from.
  let hasExports = false;
  for (const stmt of sourceFile.statements) {
    if ("modifiers" in stmt && stmt.modifiers) {
      if ((stmt.modifiers as ts.NodeArray<ts.ModifierLike>).some(
        (m) => m.kind === ts.SyntaxKind.ExportKeyword
      )) {
        hasExports = true;
        break;
      }
    }
  }

  // Extract imports and their identifiers (only if the file exports something)
  if (hasExports) {
    for (const stmt of sourceFile.statements) {
      if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
        importPaths.push(stmt.moduleSpecifier.text);

        // Named imports
        const importClause = stmt.importClause;
        if (importClause) {
          if (importClause.name) {
            calledIdentifiers.add(importClause.name.text);
          }
          if (importClause.namedBindings && ts.isNamedImports(importClause.namedBindings)) {
            for (const ni of importClause.namedBindings.elements) {
              calledIdentifiers.add(ni.name.text);
            }
          }
        }
      }
    }
  } else {
    // Still collect import paths (cheap — just the module specifier string)
    for (const stmt of sourceFile.statements) {
      if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
        importPaths.push(stmt.moduleSpecifier.text);
      }
    }
  }

  // Walk the AST for declarations and call expressions
  function visit(node: ts.Node) {
    // Top-level declarations
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node)
    ) {
      const name = node.name?.text;
      if (name) {
        const symbolType = ts.SyntaxKind[node.kind].toLowerCase();
        const exported = hasExportModifier(node);
        const lineRange = getLineRange(node);

        definedSymbols.push({ name, type: symbolType, symbolType, exported });

        const text = node.getText(sourceFile).trim();
        if (text) {
          chunks.push({
            heading: name,
            content: text,
            tokenCount: countTokens(text),
            contentHash: hashContent(text),
            symbolName: name,
            symbolType,
            metadata: {
              kind: "code",
              symbolName: name,
              symbolType,
              exported,
              ...lineRange,
            },
          });

          // Extract call expressions via regex on the declaration text.
          // Only functions/classes/enums can have calls — interfaces and
          // type aliases cannot, so skip the regex for them.
          const isTypeOnly = ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node);
          if (!isTypeOnly) {
            CALL_REGEX.lastIndex = 0;
            let callMatch: RegExpExecArray | null;
            while ((callMatch = CALL_REGEX.exec(text)) !== null) {
              const calledName = callMatch[1];
              calledIdentifiers.add(calledName);
              callExpressions.push({
                callerName: name,
                calleeName: calledName.split(".").pop() ?? calledName,
              });
            }
          }
        }
      }
    }

    // Exported variable declarations
    if (ts.isVariableStatement(node) && hasExportModifier(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          const name = decl.name.text;
          const text = decl.getText(sourceFile).trim();
          if (name && text) {
            const lineRange = getLineRange(decl);
            definedSymbols.push({ name, symbolType: "variable", type: "variable", exported: true });
            chunks.push({
              heading: name,
              content: text,
              tokenCount: countTokens(text),
              contentHash: hashContent(text),
              symbolName: name,
              symbolType: "variable",
              metadata: {
                kind: "code",
                symbolName: name,
                symbolType: "variable",
                exported: true,
                ...lineRange,
              },
            });
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  // Fallback: semantic chunking for files with no extractable declarations
  if (chunks.length === 0) {
    const lines = content.split("\n");
    const MAX_LINES = 80;
    const MIN_LINES = 20;
    let start = 0;

    while (start < lines.length) {
      let end = Math.min(start + MAX_LINES, lines.length);

      if (end < lines.length) {
        const searchStart = Math.max(start + MIN_LINES, end - 20);
        for (let i = end - 1; i >= searchStart; i--) {
          const line = lines[i].trim();
          if (line === "" || line === "}" || line === "});" || line === "};") {
            end = i + 1;
            break;
          }
        }
      }

      const slice = lines.slice(start, end).join("\n").trim();
      if (slice) {
        chunks.push({
          content: slice,
          tokenCount: countTokens(slice),
          contentHash: hashContent(slice),
          metadata: {
            kind: "code",
            fallback: true,
            startLine: start + 1,
            endLine: end,
          },
        });
      }
      start = end;
    }
  }

  return {
    chunks,
    importPaths,
    definedSymbols,
    calledIdentifiers: [...calledIdentifiers],
    callExpressions,
  };
}
