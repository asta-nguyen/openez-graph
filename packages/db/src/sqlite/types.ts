export interface RegistryWorkspace {
  id: string;
  name: string;
  rootPath: string;
  includeGlobs: string;
  excludeGlobs: string;
  status: "pending" | "indexing" | "indexed" | "error";
  indexingStatus: "pending" | "running" | "completed" | "failed";
  graphStatus: "pending" | "running" | "completed" | "failed";
  lastIndexedAt: string | undefined;
  lastGraphBuiltAt: string | undefined;
  documentCount: number;
  chunkCount: number;
  nodeCount: number;
  edgeCount: number;
  lastError: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceSettings {
  includeGlobs?: string;
  excludeGlobs?: string;
}

export interface RegistryRepository {
  listWorkspaces(): Promise<RegistryWorkspace[]>;
  getWorkspace(id: string): Promise<RegistryWorkspace | null>;
  getWorkspaceByPath(rootPath: string): Promise<RegistryWorkspace | null>;
  ensureWorkspace(input: {
    rootPath: string;
    name?: string;
    includeGlobs?: string;
    excludeGlobs?: string;
  }): Promise<RegistryWorkspace>;
  createWorkspace(input: {
    id: string;
    name: string;
    rootPath: string;
    includeGlobs?: string;
    excludeGlobs?: string;
  }): Promise<RegistryWorkspace>;
  updateWorkspace(
    id: string,
    updates: Partial<Pick<RegistryWorkspace, "status" | "indexingStatus" | "graphStatus" | "lastIndexedAt" | "lastGraphBuiltAt" | "documentCount" | "chunkCount" | "nodeCount" | "edgeCount" | "lastError">>
  ): Promise<void>;
  deleteWorkspace(id: string): Promise<void>;
}

export interface WorkspaceRepository {
  rootPath: string;

  getDocumentCount(): Promise<number>;
  getChunkCount(): Promise<number>;
  getNodeCount(): Promise<number>;
  getEdgeCount(): Promise<number>;

  getDocument(id: string): Promise<{
    id: string;
    path: string;
    absolutePath: string;
    kind: string;
    language: string | null;
    contentHash: string;
    sizeBytes: number;
    mtimeMs: number;
    createdAt: string;
    updatedAt: string;
  } | null>;

  getDocumentByPath(path: string): Promise<{
    id: string;
    path: string;
    absolutePath: string;
    kind: string;
    language: string | null;
    contentHash: string;
    sizeBytes: number;
    mtimeMs: number;
    createdAt: string;
    updatedAt: string;
  } | null>;

  insertDocument(input: {
    id?: string;
    path: string;
    absolutePath: string;
    kind: string;
    language: string | null;
    contentHash: string;
    sizeBytes: number;
    mtimeMs: number;
  }): Promise<string>;

  updateDocument(
    id: string,
    updates: Partial<{
      absolutePath: string;
      kind: string;
      language: string | null;
      contentHash: string;
      sizeBytes: number;
      mtimeMs: number;
    }>
  ): Promise<void>;

  deleteDocument(id: string): Promise<void>;
  listDocuments(): Promise<Array<{
    id: string;
    path: string;
    absolutePath: string;
    kind: string;
    language: string | null;
    contentHash: string;
    sizeBytes: number;
    mtimeMs: number;
    createdAt: string;
    updatedAt: string;
  }>>;

  getChunksByDocument(documentId: string): Promise<Array<{
    id: string;
    documentId: string;
    chunkIndex: number;
    heading: string | null;
    content: string;
    tokenCount: number;
    contentHash: string;
    metadata: string;
    createdAt: string;
    updatedAt: string;
  }>>;

  insertChunks(inputs: Array<{
    documentId: string;
    chunkIndex: number;
    heading?: string | null;
    content: string;
    tokenCount: number;
    contentHash: string;
    metadata: string;
  }>): Promise<string[]>;

  deleteChunksByDocument(documentId: string): Promise<void>;

  upsertGraphNode(input: {
    type: string;
    label: string;
    refId?: string;
    metadata?: string;
  }): Promise<string>;

  getGraphNode(id: string): Promise<{
    id: string;
    type: string;
    label: string;
    refId: string | null;
    metadata: string;
    createdAt: string;
    updatedAt: string;
  } | null>;

  findGraphNode(type: string, label: string): Promise<{
    id: string;
    type: string;
    label: string;
    refId: string | null;
    metadata: string;
    createdAt: string;
    updatedAt: string;
  } | null>;

  deleteGraphNodesByRefId(refId: string): Promise<void>;

  insertEdge(input: {
    fromNodeId: string;
    toNodeId: string;
    type: string;
    weight?: number;
    metadata?: string;
  }): Promise<string>;

  deleteEdgesByNodeIds(nodeIds: string[]): Promise<void>;

  insertEmbeddings(inputs: Array<{
    chunkId: string;
    provider: string;
    model: string;
    dimensions: number;
    embedding: string;
  }>): Promise<void>;

  deleteEmbeddingsByChunkIds(chunkIds: string[]): Promise<void>;

  fullTextSearch(query: string, limit: number): Promise<Array<{
    id: string;
    path: string;
    content: string;
    score: number;
    heading: string | null;
    metadata: Record<string, unknown>;
  }>>;

  graphNeighbors(label: string, depth: number): Promise<{
    nodes: Array<Record<string, unknown>>;
    edges: Array<Record<string, unknown>>;
  }>;

  insertMemory(input: {
    title: string;
    content: string;
    tags?: string;
    source: string;
    supersedesId?: string;
  }): Promise<string>;

  createIndexRun(input: { mode: string }): Promise<string>;
  completeIndexRun(
    id: string,
    updates: {
      status: string;
      filesScanned: number;
      filesUpdated: number;
      chunksWritten: number;
      embeddingsWritten: number;
      errorMessage?: string;
    }
  ): Promise<void>;

  insertQueryLog(input: { query: string; mode: string; resultCount: number }): Promise<string>;

  executeRaw(sqlQuery: string, params?: unknown[]): Promise<unknown>;
  queryRaw(sqlQuery: string, params?: unknown[]): Promise<Array<Record<string, unknown>>>;

  resetAll(): Promise<void>;
}
