export interface QuerySource {
  path: string;
  startLine?: number;
  endLine?: number;
  score: number;
  reason: string;
}

export interface CodeQueryResult {
  answerContext: string;
  sources: QuerySource[];
}

/** @deprecated Use CodeQueryResult. */
export type MemoryQueryResult = CodeQueryResult;

export interface RecalledMemory {
  id: string;
  title: string;
  content: string;
  tags: string[];
  source: string;
  supersedesId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryRecallResult {
  memories: RecalledMemory[];
}

export interface CodeContextResult {
  symbol?: Record<string, unknown>;
  files: Record<string, unknown>[];
  callers: Record<string, unknown>[];
  callees: Record<string, unknown>[];
  relatedChunks: Record<string, unknown>[];
}

export interface GraphNeighborResult {
  nodes: Record<string, unknown>[];
  edges: Record<string, unknown>[];
}
