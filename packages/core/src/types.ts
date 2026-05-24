export interface QuerySource {
  path: string;
  startLine?: number;
  endLine?: number;
  score: number;
  reason: string;
}

export interface MemoryQueryResult {
  answerContext: string;
  sources: QuerySource[];
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
