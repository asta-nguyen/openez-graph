import type { BlobParser } from "@openez-graph/core";

import { parseDocument } from "./parsers";

/**
 * Creates a {@link BlobParser} that wraps the indexer's `parseDocument`.
 *
 * This is used by `analyzeDiffContext` to parse historical Git blobs and
 * stale working-tree files in memory without writing to the workspace DB.
 * Both the CLI (`openez diff`) and MCP (`diff_context` tool) use this to
 * populate `oldSymbols` / `deletedSymbols` and to ensure symbol line numbers
 * match the current file state when the worktree is dirty.
 */
export function createBlobParser(): BlobParser {
  return async ({ relativePath, content }) => {
    const parsed = await parseDocument({
      relativePath,
      absolutePath: relativePath,
      content,
      targetTokens: 800,
      overlapTokens: 100,
    });
    return parsed.definedSymbols.map((s) => ({
      name: s.name,
      symbolType: s.symbolType,
      exported: s.exported,
      startLine: s.startLine ?? 1,
      endLine: s.endLine ?? s.startLine ?? 1,
      ...(s.receiver ? { parentSymbol: s.receiver } : {}),
    }));
  };
}
