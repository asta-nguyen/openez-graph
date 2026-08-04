import { parentPort } from "node:worker_threads";

import { countTokens, splitToTokenLimit } from "./tokenizer";

import { chunkDocument, type ParseTask, type ParseResult } from "./parse-core";
import type { IndexedChunk } from "./types";

function fastHash(content: string): string {
  let h = 5381;
  for (let i = 0; i < content.length; i++) {
    h = ((h << 5) + h + content.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

export function boundChunks(chunks: IndexedChunk[], targetTokens: number, overlapTokens: number): IndexedChunk[] {
  const split = chunks.flatMap((chunk) => {
    const parts = splitToTokenLimit(chunk.content, targetTokens, overlapTokens);
    if (parts.length <= 1) return chunk;
    return parts.map((content, splitIndex) => ({
      ...chunk,
      content,
      tokenCount: countTokens(content),
      contentHash: fastHash(content),
      metadata: { ...chunk.metadata, splitIndex, splitCount: parts.length }
    }));
  });

  const merged: IndexedChunk[] = [];
  let buffer: IndexedChunk[] = [];
  let bufferTokens = 0;
  const MERGE_THRESHOLD = Math.floor(targetTokens * 0.3);

  for (const chunk of split) {
    if (chunk.tokenCount < MERGE_THRESHOLD && bufferTokens + chunk.tokenCount <= targetTokens) {
      buffer.push(chunk);
      bufferTokens += chunk.tokenCount;
    } else {
      if (buffer.length > 0) {
        merged.push(mergeChunks(buffer));
        buffer = [];
        bufferTokens = 0;
      }
      merged.push(chunk);
    }
  }
  if (buffer.length > 0) merged.push(mergeChunks(buffer));

  return merged;
}

function mergeChunks(chunks: IndexedChunk[]): IndexedChunk {
  if (chunks.length === 1) return chunks[0];
  const content = chunks.map((c) => c.content).join("\n\n");
  return {
    content,
    tokenCount: countTokens(content),
    contentHash: fastHash(content),
    heading: chunks[0].heading,
    metadata: { ...chunks[0].metadata, mergedCount: chunks.length }
  };
}

if (parentPort) {
  parentPort.on("message", (task: ParseTask) => {
    const indexed = chunkDocument(task);
    indexed.chunks = boundChunks(indexed.chunks, task.targetTokens, task.overlapTokens);
    parentPort!.postMessage({ id: task.id, result: indexed });
  });
}
