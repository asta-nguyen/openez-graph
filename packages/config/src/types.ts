export interface BrainWorkspaceConfig {
  id: string;
  name: string;
  root: string;
  include: string[];
  exclude: string[];
}

export interface ChunkingConfig {
  targetTokens: number;
  overlapTokens: number;
}

export interface RetrievalConfig {
  vectorLimit: number;
  textLimit: number;
  graphHops: number;
  maxGraphNeighbors: number;
  finalLimit: number;
  maxContextTokens: number;
}

export interface GlobalSettings {
  chunking: ChunkingConfig;
  retrieval: RetrievalConfig;
}

export interface BrainConfig {
  workspaces?: BrainWorkspaceConfig[];
  chunking?: ChunkingConfig;
  retrieval?: RetrievalConfig;
}

export function getDefaultSettings(): GlobalSettings {
  return {
    chunking: {
      targetTokens: 1024,
      overlapTokens: 100
    },
    retrieval: {
      vectorLimit: 20,
      textLimit: 20,
      graphHops: 1,
      maxGraphNeighbors: 15,
      finalLimit: 10,
      maxContextTokens: 4000
    }
  };
}
