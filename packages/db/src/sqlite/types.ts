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

export interface StoredMemory {
  id: string;
  title: string;
  content: string;
  tags: string;
  source: string;
  supersedesId: string | null;
  createdAt: string;
  updatedAt: string;
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
    updates: Partial<
      Pick<
        RegistryWorkspace,
        | "status"
        | "indexingStatus"
        | "graphStatus"
        | "lastIndexedAt"
        | "lastGraphBuiltAt"
        | "documentCount"
        | "chunkCount"
        | "nodeCount"
        | "edgeCount"
        | "lastError"
      >
    >,
  ): Promise<void>;
  deleteWorkspace(id: string): Promise<void>;

  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
  deleteSetting(key: string): Promise<void>;
  getAllSettings(): Promise<Record<string, string>>;
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

  insertDocumentsBatch(inputs: Array<{
    path: string;
    absolutePath: string;
    kind: string;
    language?: string | null;
    contentHash: string;
    sizeBytes: number;
    mtimeMs: number;
  }>): Promise<string[]>;

  updateDocument(
    id: string,
    updates: Partial<{
      absolutePath: string;
      kind: string;
      language: string | null;
      contentHash: string;
      sizeBytes: number;
      mtimeMs: number;
    }>,
  ): Promise<void>;

  deleteDocument(id: string): Promise<void>;
  listDocuments(): Promise<
    Array<{
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
    }>
  >;

  getChunksByDocument(documentId: string): Promise<
    Array<{
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
    }>
  >;

  insertChunks(
    inputs: Array<{
      documentId: string;
      chunkIndex: number;
      heading?: string | null;
      content: string;
      tokenCount: number;
      contentHash: string;
      metadata: string;
    }>,
  ): Promise<string[]>;

  deleteChunksByDocument(documentId: string): Promise<void>;

  upsertGraphNode(input: {
    type: string;
    label: string;
    refId?: string;
    metadata?: string;
  }): Promise<string>;

  insertGraphNodesBatch(
    inputs: Array<{
      type: string;
      label: string;
      refId?: string;
      metadata?: string;
    }>,
  ): Promise<string[]>;

  getGraphNode(id: string): Promise<{
    id: string;
    type: string;
    label: string;
    refId: string | null;
    metadata: string;
    createdAt: string;
    updatedAt: string;
  } | null>;

  findGraphNode(
    type: string,
    label: string,
  ): Promise<{
    id: string;
    type: string;
    label: string;
    refId: string | null;
    metadata: string;
    createdAt: string;
    updatedAt: string;
  } | null>;

  deleteGraphNodesByRefId(refId: string): Promise<void>;

  /** Find a file-type graph node by its label (relative path). */
  findFileNode(relativePath: string): Promise<{
    id: string;
    type: string;
    label: string;
    refId: string | null;
    metadata: string;
  } | null>;

  /** Get all symbol nodes whose metadata.filePath matches the given relative path. */
  getSymbolNodesByFilePath(
    filePath: string,
  ): Promise<
    Array<{ id: string; type: string; label: string; refId: string | null; metadata: string }>
  >;

  /** Delete outgoing edges from a specific node, optionally filtered by edge types. */
  deleteOutgoingEdges(nodeId: string, types?: string[]): void;

  /** Update a symbol node's refId and metadata (for reuse when symbol still exists). */
  updateSymbolNode(id: string, refId: string, metadata: string): void;

  /** Delete specific graph nodes by id (used for stale symbols). */
  deleteGraphNodesByIds(ids: string[]): void;

  /** Delete only chunk-type graph nodes whose ref_id matches one of the given chunk IDs. */
  deleteChunkNodesByChunkIds(chunkIds: string[]): void;

  insertEdge(input: {
    fromNodeId: string;
    toNodeId: string;
    type: string;
    weight?: number;
    metadata?: string;
  }): Promise<string>;

  insertEdges(
    inputs: Array<{
      fromNodeId: string;
      toNodeId: string;
      type: string;
      weight?: number;
      metadata?: string;
    }>,
  ): Promise<void>;

  deleteEdgesByNodeIds(nodeIds: string[]): Promise<void>;

  insertEmbeddings(
    inputs: Array<{
      chunkId: string;
      provider: string;
      model: string;
      dimensions: number;
      embedding: string;
      inputHash?: string | null;
    }>,
  ): Promise<void>;

  deleteEmbeddingsByChunkIds(chunkIds: string[]): Promise<void>;

  fullTextSearch(
    query: string,
    limit: number,
  ): Promise<
    Array<{
      id: string;
      path: string;
      content: string;
      score: number;
      heading: string | null;
      metadata: Record<string, unknown>;
    }>
  >;

  graphNeighbors(
    label: string,
    depth: number,
    limit?: number,
  ): Promise<{
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
  getMemory(id: string): Promise<StoredMemory | null>;
  searchMemories(query: string, limit: number): Promise<StoredMemory[]>;

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
    },
  ): Promise<void>;

  insertQueryLog(input: {
    query: string;
    mode: string;
    resultCount: number;
    tokensReturned?: number;
    tokensSaved?: number;
    filesScanned?: number;
  }): Promise<string>;

  executeRaw(sqlQuery: string, params?: unknown[]): Promise<unknown>;
  queryRaw(sqlQuery: string, params?: unknown[]): Promise<Array<Record<string, unknown>>>;

  /** Run a function inside a single SQLite transaction (batch commit). */
  transaction<T>(fn: () => T | Promise<T>): Promise<T>;

  /** Toggle fast-write pragmas (synchronous=OFF, big cache, mmap). Call before/after bulk indexing. */
  setOptimizedWriteMode(enabled: boolean): void;

  /** Checkpoint WAL to bound file growth during long indexing runs. */
  walCheckpoint(): void;

  /** Drop FTS triggers so chunk INSERTs don't fire per-row trigger subqueries. */
  dropFtsTriggers(): void;
  dropNonUniqueIndexes(): void;
  restoreNonUniqueIndexes(): void;
  ensureGraphBuilt(): void;
  /** Bulk insert FTS rows without triggers (used during optimized write phase). */
  insertFtsBatch(rows: Array<{ chunkId: string; path: string; heading: string; language: string; searchText: string; content: string }>): void;
  /** Recreate FTS triggers and backfill any missing FTS rows. */
  restoreFtsTriggers(): void;
  /** Recreate FTS triggers only (no backfill — use when FTS rows were inserted inline). */
  restoreFtsTriggersOnly(): void;

  // ── Streaming inserts — cached prepared statements, no dynamic SQL ──
  streamDocument(input: { id: string; path: string; absolutePath: string; kind: string; language?: string | null; contentHash: string; sizeBytes: number; mtimeMs: number }): void;
  streamChunk(input: { id: string; documentId: string; chunkIndex: number; heading: string | null; content: string; tokenCount: number; contentHash: string; metadata: string }): void;
  streamChunksBatch(inputs: Array<{ id: string; documentId: string; chunkIndex: number; heading: string | null; content: string; tokenCount: number; contentHash: string; metadata: string }>): void;
  streamGraphNode(input: { id: string; type: string; label: string; refId?: string | null; metadata?: string }): void;
  streamGraphNodesBatch(inputs: Array<{ id: string; type: string; label: string; refId?: string | null; metadata?: string }>): void;
  streamEdgesBatch(inputs: Array<{ id: string; fromNodeId: string; toNodeId: string; type: string; weight?: number; metadata?: string }>): void;
  streamEdge(input: { id: string; fromNodeId: string; toNodeId: string; type: string; weight?: number; metadata?: string }): void;
  streamFtsRow(input: { chunkId: string; path: string; heading: string; language: string; searchText: string; content: string }): void;
  refreshStreamTimestamp(): void;
  setMeta(key: string, value: string): void;
  getMeta(key: string): string | null;
  ensureFtsReady(): void;

  /** Load all symbol-type graph nodes into a Map<label, id> for batch call-edge resolution. */
  loadAllSymbolNodes(): Promise<Map<string, string>>;

  /** Delete only rebuildable index artifacts (documents, chunks, embeddings, graph_nodes, graph_edges).
   *  Preserves memories, query_logs, index_runs, and graph_runs. */
  resetIndexArtifacts(): void;
}
