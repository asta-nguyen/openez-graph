export interface RegistryWorkspace {
  id: string;
  name: string;
  rootPath: string;
  includeGlobs: string;
  excludeGlobs: string;
  status: "pending" | "indexing" | "indexed" | "error";
  indexingStatus: "pending" | "running" | "completed" | "failed";
  indexBuildOwner: string | undefined;
  indexLeaseExpiresAt: string | undefined;
  graphStatus: "pending" | "running" | "completed" | "failed";
  indexGeneration: number;
  graphGeneration: number;
  graphLeaseExpiresAt: string | undefined;
  lastIndexedAt: string | undefined;
  lastGraphBuiltAt: string | undefined;
  documentCount: number;
  chunkCount: number;
  nodeCount: number;
  edgeCount: number;
  lastError: string | undefined;
  pinnedAt: string | undefined;
  pinOrder: number | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceSettings {
  includeGlobs?: string;
  excludeGlobs?: string;
}

export interface StoredMemory {
  id: number;
  title: string;
  content: string;
  tags: string;
  source: string;
  supersedesId: number | null;
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
        | "indexGeneration"
        | "graphGeneration"
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
  /** Atomically claim a workspace for indexing, taking over expired leases. */
  tryClaimIndexing(id: string, ownerToken: string, leaseExpiresAt: string): Promise<boolean>;
  /** Refresh an indexing lease while the owner is still running. */
  refreshIndexingLease(id: string, ownerToken: string, leaseExpiresAt: string): Promise<boolean>;
  /** Release an indexing claim that failed before normal completion. */
  releaseIndexing(id: string, ownerToken: string, error: string): Promise<boolean>;
  /** Fence index completion by lease owner; returns false if the lease was taken over. */
  completeIndexing(
    id: string,
    ownerToken: string,
    result: {
      documentCount: number;
      chunkCount: number;
      nodeCount: number;
      edgeCount: number;
      completedAt: string;
    },
  ): Promise<boolean>;
  /** Fence index failure by lease owner; returns false if the lease was taken over. */
  failIndexing(id: string, ownerToken: string, error: string): Promise<boolean>;
  invalidateWorkspaceGraph(id: string): Promise<number>;
  /**
   * Atomically claim the graph build for a workspace. Transitions
   * `graph_status` to 'running' only if it is not already 'running' or
   * if the existing lease has expired. Returns the monotonically increasing
   * fencing epoch when acquired, or null if another process is building.
   * `leaseExpiresAt` is an ISO timestamp; stale leases allow takeover
   * when a builder process dies mid-build.
   */
  tryClaimGraphBuild(
    id: string,
    ownerToken: string,
    leaseExpiresAt: string,
  ): Promise<number | null>;
  /**
   * Refresh the graph build lease. Returns false if the lease was
   * taken over by another process (caller should abort the build).
   */
  refreshGraphBuildLease(id: string, ownerToken: string, leaseExpiresAt: string): Promise<boolean>;
  /** Release an unpublished graph build so the next attempt can claim immediately. */
  releaseGraphBuild(id: string, ownerToken: string): Promise<boolean>;
  completeGraphBuild(
    id: string,
    ownerToken: string,
    generation: number,
    result: { nodeCount: number; edgeCount: number; completedAt: string },
  ): Promise<boolean>;
  failGraphBuild(id: string, ownerToken: string, error: string): Promise<boolean>;
  deleteWorkspace(id: string): Promise<void>;
  setPinned(id: string, pinned: boolean): Promise<void>;

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

  getDocument(id: number): Promise<{
    id: number;
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
    id: number;
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
    id?: number;
    path: string;
    absolutePath: string;
    kind: string;
    language: string | null;
    contentHash: string;
    sizeBytes: number;
    mtimeMs: number;
  }): Promise<number>;

  insertDocumentsBatch(
    inputs: Array<{
      path: string;
      absolutePath: string;
      kind: string;
      language?: string | null;
      contentHash: string;
      sizeBytes: number;
      mtimeMs: number;
    }>,
  ): Promise<number[]>;

  updateDocument(
    id: number,
    updates: Partial<{
      absolutePath: string;
      kind: string;
      language: string | null;
      contentHash: string;
      sizeBytes: number;
      mtimeMs: number;
    }>,
  ): Promise<void>;

  deleteDocument(id: number): Promise<void>;
  listDocuments(): Promise<
    Array<{
      id: number;
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

  getChunksByDocument(documentId: number): Promise<
    Array<{
      id: number;
      documentId: number;
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
      documentId: number;
      chunkIndex: number;
      heading?: string | null;
      content: string;
      tokenCount: number;
      contentHash: string;
      metadata: string;
    }>,
  ): Promise<number[]>;

  bulkInsertFts(
    inputs: Array<{
      chunkId: number;
      path: string;
      heading: string | null;
      language: string | null;
      content: string;
      metadata: string;
    }>,
  ): Promise<void>;

  deleteChunksByDocument(documentId: number): Promise<void>;

  upsertGraphNode(input: {
    type: string;
    label: string;
    refId?: number | string | null;
    metadata?: string;
  }): Promise<number>;

  insertGraphNodesBatch(
    inputs: Array<{
      type: string;
      label: string;
      refId?: number | string | null;
      metadata?: string;
    }>,
  ): Promise<number[]>;

  /** Batch upsert: non-symbol nodes use ON CONFLICT, symbol nodes are pre-resolved by caller. */
  upsertGraphNodesBatch(
    inputs: Array<{
      type: string;
      label: string;
      refId?: number | string | null;
      metadata?: string;
    }>,
  ): Promise<Array<{ label: string; id: number }>>;

  getGraphNode(id: number): Promise<{
    id: number;
    type: string;
    label: string;
    refId: number | string | null;
    metadata: string;
    createdAt: string;
    updatedAt: string;
  } | null>;

  findGraphNode(
    type: string,
    label: string,
  ): Promise<{
    id: number;
    type: string;
    label: string;
    refId: number | string | null;
    metadata: string;
    createdAt: string;
    updatedAt: string;
  } | null>;

  deleteGraphNodesByRefId(refId: number | string): Promise<void>;

  /** Find a file-type graph node by its label (relative path). */
  findFileNode(relativePath: string): Promise<{
    id: number;
    type: string;
    label: string;
    refId: number | string | null;
    metadata: string;
  } | null>;

  /** Get all symbol nodes whose metadata.filePath matches the given relative path. */
  getSymbolNodesByFilePath(
    filePath: string,
  ): Promise<
    Array<{
      id: number;
      type: string;
      label: string;
      refId: number | string | null;
      metadata: string;
    }>
  >;

  /** Delete outgoing edges from a specific node, optionally filtered by edge types. */
  deleteOutgoingEdges(nodeId: number, types?: string[]): void;

  /** Update a symbol node's refId and metadata (for reuse when symbol still exists). */
  updateSymbolNode(id: number, refId: number | string, metadata: string): void;

  /** Delete specific graph nodes by id (used for stale symbols). */
  deleteGraphNodesByIds(ids: number[]): void;

  /** Delete only chunk-type graph nodes whose ref_id matches one of the given chunk IDs. */
  deleteChunkNodesByChunkIds(chunkIds: number[]): void;

  insertEdge(input: {
    fromNodeId: number;
    toNodeId: number;
    type: string;
    weight?: number;
    metadata?: string;
  }): Promise<number>;

  insertEdges(
    inputs: Array<{
      fromNodeId: number;
      toNodeId: number;
      type: string;
      weight?: number;
      metadata?: string;
    }>,
  ): Promise<void>;

  deleteEdgesByNodeIds(nodeIds: number[]): Promise<void>;

  insertEmbeddings(
    inputs: Array<{
      chunkId: number;
      provider: string;
      model: string;
      dimensions: number;
      embedding: Uint8Array;
      inputHash?: string | null;
    }>,
  ): Promise<void>;

  deleteEmbeddingsByChunkIds(chunkIds: number[]): Promise<void>;

  fullTextSearch(
    query: string,
    limit: number,
  ): Promise<
    Array<{
      id: number;
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
    supersedesId?: number | null;
  }): Promise<number>;
  getMemory(id: number): Promise<StoredMemory | null>;
  searchMemories(query: string, limit: number): Promise<StoredMemory[]>;

  createIndexRun(input: { mode: string }): Promise<number>;
  completeIndexRun(
    id: number,
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
  }): Promise<number>;

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
  /** Bulk insert FTS rows without triggers (used during optimized write phase). */
  insertFtsBatch(
    rows: Array<{
      chunkId: number;
      path: string;
      heading: string;
      language: string;
      content: string;
      metadata: string;
    }>,
  ): void;
  /** Recreate FTS triggers and backfill any missing FTS rows. */
  restoreFtsTriggers(): void;
  /** Recreate FTS triggers only (no backfill — use when FTS rows were inserted inline). */
  restoreFtsTriggersOnly(): void;

  // ── Streaming inserts — cached prepared statements, no dynamic SQL ──
  streamDocument(input: {
    id?: number;
    path: string;
    absolutePath: string;
    kind: string;
    language?: string | null;
    contentHash: string;
    sizeBytes: number;
    mtimeMs: number;
  }): void;
  streamChunk(input: {
    id?: number;
    documentId: number;
    chunkIndex: number;
    heading: string | null;
    content: string;
    tokenCount: number;
    contentHash: string;
    metadata: string;
  }): void;
  streamChunksBatch(
    inputs: Array<{
      id?: number;
      documentId: number;
      chunkIndex: number;
      heading: string | null;
      content: string;
      tokenCount: number;
      contentHash: string;
      metadata: string;
    }>,
  ): void;
  streamGraphNode(input: {
    id?: number;
    type: string;
    label: string;
    refId?: number | string | null;
    metadata?: string;
  }): void;
  streamGraphNodesBatch(
    inputs: Array<{
      id?: number;
      type: string;
      label: string;
      refId?: number | string | null;
      metadata?: string;
    }>,
  ): void;
  streamEdgesBatch(
    inputs: Array<{
      id?: number;
      fromNodeId: number;
      toNodeId: number;
      type: string;
      weight?: number;
      metadata?: string;
    }>,
  ): void;
  streamEdge(input: {
    id?: number;
    fromNodeId: number;
    toNodeId: number;
    type: string;
    weight?: number;
    metadata?: string;
  }): void;
  streamFtsRow(input: {
    chunkId: number;
    path: string;
    heading: string;
    language: string;
    content: string;
    metadata: string;
  }): void;
  refreshStreamTimestamp(): void;
  setMeta(key: string, value: string): void;
  getMeta(key: string): string | null;
  ensureFtsReady(): void;
  /**
   * Returns true when the workspace has legacy TEXT embeddings that cannot
   * be used with BLOB cosine search. Vector search should be skipped (defer
   * to FTS) until `openez reindex` rebuilds embeddings as BLOB.
   */
  hasLegacyEmbeddings(): boolean;

  /** Load all symbol-type graph nodes into a Map<label, id> for batch call-edge resolution. */
  loadAllSymbolNodes(): Promise<Map<string, number>>;

  /** Delete only rebuildable index artifacts (documents, chunks, embeddings, graph_nodes, graph_edges).
   *  Preserves memories, query_logs, index_runs, and graph_runs. */
  resetIndexArtifacts(): void;

  /** Delete only graph nodes and edges (preserves documents, chunks, embeddings,
   *  memories, query logs, and index runs). Used by the lazy graph builder to
   *  invalidate stale graph state before rebuilding. */
  clearGraphArtifacts(): void;

  /** Atomically replace the live graph unless a newer build epoch already published. */
  replaceGraphArtifacts(input: {
    buildEpoch: number;
    nodes: Array<{
      id?: number;
      type: string;
      label: string;
      refId?: number | string;
      metadata?: string;
    }>;
    edges: Array<{
      id?: number;
      fromNodeId: number;
      toNodeId: number;
      type: string;
      weight?: number;
      metadata?: string;
    }>;
  }): boolean;

  /** Cache parsed symbols/imports/calls for graph build. */
  insertParsedDocument(input: {
    documentId: number;
    contentHash: string;
    symbols: string;
    imports: string;
    calls: string;
    calledIdentifiers: string;
    parserVersion: string;
  }): void;

  getParsedDocument(documentId: number): {
    documentId: number;
    contentHash: string;
    symbols: string | null;
    imports: string | null;
    calls: string | null;
    calledIdentifiers: string | null;
    parserVersion: string | null;
    parsedAt: number;
  } | null;

  deleteParsedDocumentsByDocumentIds(documentIds: number[]): void;
}
