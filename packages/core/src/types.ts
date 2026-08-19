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
  metrics: {
    retrievalTokens: number;
    selectedFullFileTokens: number;
    estimatedTokensSaved: number;
    candidateFiles: number;
    selectedFiles: number;
    method: "selected-full-files-minus-retrieval-payload";
  };
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

export interface CodeSymbolContext {
  symbol: string;
  label: string;
  path?: string;
  startLine?: number;
  endLine?: number;
  snippet?: string;
}

export interface CodeContextResult {
  symbol?: CodeSymbolContext;
  files: Array<{ path: string }>;
  callers: CodeSymbolContext[];
  callees: CodeSymbolContext[];
  relatedChunks: Array<{
    path: string;
    startLine?: number;
    endLine?: number;
    heading?: string;
    snippet: string;
  }>;
}

export interface GraphNeighborResult {
  nodes: Array<{
    id: string;
    type: string;
    label: string;
    path?: string;
    startLine?: number;
    endLine?: number;
  }>;
  edges: Array<{
    from: string;
    to: string;
    type: string;
    weight?: number;
  }>;
}
