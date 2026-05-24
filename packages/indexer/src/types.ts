export interface IndexedChunk {
  heading?: string;
  content: string;
  tokenCount: number;
  contentHash: string;
  metadata: Record<string, unknown>;
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
}
