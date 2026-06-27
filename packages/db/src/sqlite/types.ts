export interface RegistryWorkspace {
  id: string;
  name: string;
  rootPath: string;
  includeGlobs: string;
  excludeGlobs: string;
  status: "pending" | "indexing" | "indexed" | "error";
  indexingStatus: "pending" | "running" | "completed" | "failed" | "cancelled";
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

export interface ChunkRow {
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

  insertDocumentSync(input: {
    id?: string;
    path: string;
    absolutePath: string;
    kind: string;
    language: string | null;
    contentHash: string;
    sizeBytes: number;
    mtimeMs: number;
  }): string;

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

  updateDocumentSync(
    id: string,
    updates: Partial<{
      absolutePath: string;
      kind: string;
      language: string | null;
      contentHash: string;
      sizeBytes: number;
      mtimeMs: number;
    }>
  ): void;

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

  getChunksByDocument(documentId: string): Promise<Array<ChunkRow>>;

  getChunksByDocumentSync(documentId: string): Array<ChunkRow>;

  listChunksByDocument(documentId: string, limit: number, offset: number): Promise<Array<ChunkRow>>;

  countChunksByDocument(documentId: string): Promise<number>;

  insertChunks(inputs: Array<{
    documentId: string;
    chunkIndex: number;
    heading?: string | null;
    content: string;
    tokenCount: number;
    contentHash: string;
    metadata: string;
    path?: string;
  }>): Promise<string[]>;

  // Synchronous version for the indexer hot path (better-sqlite3 is sync).
  insertChunksSync(inputs: Array<{
    documentId: string;
    chunkIndex: number;
    heading?: string | null;
    content: string;
    tokenCount: number;
    contentHash: string;
    metadata: string;
    path?: string;
  }>): string[];

  deleteChunksByDocument(documentId: string): Promise<void>;

  deleteChunksByDocumentSync(documentId: string): void;

  upsertGraphNode(input: {
    type: string;
    label: string;
    refId?: string;
    metadata?: string;
  }): Promise<string>;

  upsertGraphNodeSync(input: {
    type: string;
    label: string;
    refId?: string;
    metadata?: string;
  }): string;

  upsertGraphNodesSync(inputs: Array<{
    type: string;
    label: string;
    refId?: string;
    metadata?: string;
  }>): string[];

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

  /** Load all node IDs of a given type as a Map<label, id> — one query. */
  listNodeIdsByType(type: string): Promise<Map<string, string>>;

  deleteGraphNodesByRefId(refId: string): Promise<void>;

  deleteGraphNodesByRefIdSync(refId: string): void;

  insertEdge(input: {
    fromNodeId: string;
    toNodeId: string;
    type: string;
    weight?: number;
    metadata?: string;
  }): Promise<string>;

  /** Batch insert multiple edges in a single SQL statement. */
  insertEdges(inputs: Array<{
    fromNodeId: string;
    toNodeId: string;
    type: string;
    weight?: number;
    metadata?: string;
  }>): Promise<void>;

  insertEdgesSync(inputs: Array<{
    fromNodeId: string;
    toNodeId: string;
    type: string;
    weight?: number;
    metadata?: string;
  }>): void;

  deleteEdgesByNodeIds(nodeIds: string[]): Promise<void>;

  deleteEdgesByNodeIdsSync(nodeIds: string[]): void;

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

  searchMemories(query: string, limit: number): Promise<Array<{
    id: string;
    title: string;
    content: string;
    tags: string;
    source: string;
    score: number;
    createdAt: string;
    updatedAt: string;
  }>>;

  createIndexRun(input: { mode: string }): Promise<string>;
  completeIndexRun(
    id: string,
    updates: {
      status: string;
      filesScanned: number;
      filesUpdated: number;
      chunksWritten: number;
      errorMessage?: string;
    }
  ): Promise<void>;

  createGraphRun(input: { mode: string }): Promise<string>;
  completeGraphRun(
    id: string,
    updates: {
      status: string;
      nodesCreated: number;
      edgesCreated: number;
      errorMessage?: string;
    }
  ): Promise<void>;

  insertQueryLog(input: {
    query: string;
    mode: string;
    resultCount: number;
    latencyMs?: number;
    retrievedChunks?: Array<{ chunkId: string; score: number; documentId: string; path: string }>;
  }): Promise<string>;

  executeRaw(sqlQuery: string, params?: unknown[]): Promise<unknown>;
  queryRaw(sqlQuery: string, params?: unknown[]): Promise<Array<Record<string, unknown>>>;

  /** Wrap writes in a single SQLite transaction (BEGIN/COMMIT) for bulk speed. */
  transaction<T>(fn: () => Promise<T>): Promise<T>;

  /** Batch upsert multiple graph nodes in one synchronous call (no await overhead). */
  upsertGraphNodes(inputs: Array<{
    type: string;
    label: string;
    refId?: string;
    metadata?: string;
  }>): Promise<string[]>;

  resetAll(): Promise<void>;
}
