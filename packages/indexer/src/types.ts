export interface ChunkMetadata {
  kind?: string;
  language?: string;
  section?: string;
  startLine?: number;
  endLine?: number;
  splitIndex?: number;
  splitCount?: number;
  fallback?: boolean;
  searchText?: string;
  symbolName?: string;
  symbolType?: string;
  exported?: boolean;
  headingPath?: string[];
  valueType?: string;
  receiver?: string;
  decorators?: string[];
  arrayTable?: boolean;
  path?: string;
}

export interface IndexedChunk {
  heading?: string;
  content: string;
  tokenCount: number;
  contentHash: string;
  metadata: ChunkMetadata;
  symbolName?: string;
  symbolType?: string;
}

export interface IndexedDocument {
  kind: "markdown" | "code" | "text" | "session";
  language: string | null;
  chunks: IndexedChunk[];
  importPaths: string[];
  wikilinks: string[];
}

export interface FileToIndex {
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface IndexWorkspaceSummary {
  workspaceId: string;
  filesScanned: number;
  filesUpdated: number;
  chunksWritten: number;
  embeddingsWritten: number;
  embeddingFailures: number;
}
