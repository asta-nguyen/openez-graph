export interface QuerySource {
  path: string;
  startLine?: number;
  endLine?: number;
  score: number;
  reason: string;
}

export interface MemoryHit {
  id: string;
  title: string;
  content: string;
  tags: string;
  source: string;
  score: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryQueryResult {
  answerContext: string;
  sources: QuerySource[];
  memories?: MemoryHit[];
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
