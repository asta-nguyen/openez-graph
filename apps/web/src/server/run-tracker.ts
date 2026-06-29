/**
 * Server-side run tracker for live indexing progress.
 *
 * Decouples the indexing process from the SSE stream (PITFALLS.md §2a, §2d):
 * the stream is a *viewer* of progress, not the driver. A new SSE connection
 * must not trigger a new `indexWorkspace` run, and a disconnected stream must
 * not orphan the indexing process.
 *
 * The tracker holds a `progress` snapshot per active workspace, updated by the
 * `indexWorkspace` `onProgress` callback, plus a set of subscriber callbacks
 * that the SSE endpoint (Plan 03-02) registers/unregisters for push updates.
 */

export interface IndexProgressEvent {
  runId: string;
  phase:
    | "started"
    | "scanning"
    | "indexing"
    | "finalizing"
    | "complete"
    | "error"
    | "cancelled";
  percent: number; // 0-100, monotonic
  message: string;
  filesDone: number;
  filesTotal: number;
  chunksWritten: number;
  currentPath: string | null;
  done: boolean;
  error?: string | null;
}

export interface ActiveRun {
  runId: string;
  abortController: AbortController;
  rootPath: string;
  progress: IndexProgressEvent;
  subscribers: Set<(event: IndexProgressEvent) => void>;
}

const activeRuns = new Map<string, ActiveRun>();

export function getActiveRun(workspaceId: string): ActiveRun | undefined {
  return activeRuns.get(workspaceId);
}

export function setActiveRun(workspaceId: string, run: ActiveRun): void {
  activeRuns.set(workspaceId, run);
}

/**
 * Clear the active run for a workspace. Empties the subscribers set to prevent
 * closure accumulation (PITFALLS.md §2d — memory leak from dead stream closures).
 */
export function clearActiveRun(workspaceId: string): void {
  const run = activeRuns.get(workspaceId);
  if (run) {
    run.subscribers.clear();
    activeRuns.delete(workspaceId);
  }
}

/**
 * Merge a partial progress update into the stored snapshot, enforce monotonic
 * `percent` (never decreases — RTI-03), and notify all subscribers.
 */
export function updateProgress(
  workspaceId: string,
  partial: Partial<IndexProgressEvent>,
): void {
  const run = activeRuns.get(workspaceId);
  if (!run) return;
  const next: IndexProgressEvent = {
    ...run.progress,
    ...partial,
    percent: Math.max(
      run.progress.percent,
      partial.percent ?? run.progress.percent,
    ),
  };
  run.progress = next;
  for (const cb of run.subscribers) {
    try {
      cb(next);
    } catch {
      // subscriber may be a dead stream — swallow to avoid breaking indexing
    }
  }
}

/**
 * Register a subscriber for push updates. Returns an unsubscribe function for
 * convenience (used by the SSE endpoint's `finally` block).
 */
export function subscribe(
  workspaceId: string,
  cb: (event: IndexProgressEvent) => void,
): () => void {
  const run = activeRuns.get(workspaceId);
  if (!run) return () => {};
  run.subscribers.add(cb);
  return () => run.subscribers.delete(cb);
}

export function unsubscribe(
  workspaceId: string,
  cb: (event: IndexProgressEvent) => void,
): void {
  const run = activeRuns.get(workspaceId);
  if (run) run.subscribers.delete(cb);
}
