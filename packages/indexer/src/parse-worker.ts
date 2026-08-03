import { parentPort } from "node:worker_threads";

import { countTokens, splitToTokenLimit } from "@openez-graph/core";

import { chunkDocument, type ParseTask, type ParseResult } from "./parse-core";
import { hashContent } from "./hash";
import type { IndexedChunk } from "./types";

export function boundChunks(chunks: IndexedChunk[], targetTokens: number, overlapTokens: number): IndexedChunk[] {
  return chunks.flatMap((chunk) => {
    const parts = splitToTokenLimit(chunk.content, targetTokens, overlapTokens);
    if (parts.length <= 1) return chunk;
    return parts.map((content, splitIndex) => ({
      ...chunk,
      content,
      tokenCount: countTokens(content),
      contentHash: hashContent(content),
      metadata: { ...chunk.metadata, splitIndex, splitCount: parts.length }
    }));
  });
}

if (parentPort) {
  parentPort.on("message", (task: ParseTask) => {
    const indexed = chunkDocument(task);
    indexed.chunks = boundChunks(indexed.chunks, task.targetTokens, task.overlapTokens);
    parentPort!.postMessage({ id: task.id, result: indexed });
  });
}
