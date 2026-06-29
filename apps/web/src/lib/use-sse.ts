import { useEffect, useRef, useState } from "react";
import { api } from "./api";

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
  percent: number;
  message: string;
  filesDone: number;
  filesTotal: number;
  chunksWritten: number;
  currentPath: string | null;
  done: boolean;
  error?: string | null;
}

/**
 * useSSE — opens a browser `EventSource` connection to the indexing progress
 * SSE stream, parses structured events, and rigorously cleans up on unmount,
 * workspace switch, and stream completion.
 *
 * Guards against:
 * - Zombie connections (React strict-mode double-mount) — `useRef` singleton + cleanup
 * - Reconnection replays (EventSource auto-reconnect) — closes on `done: true`
 * - Progress jumps backwards (stale events on reconnect) — `useRef` high-water mark
 * - Dead streams (Hono #2068, server restart) — polling fallback on native `onerror`
 */
export function useSSE({
  workspaceId,
  enabled,
}: {
  workspaceId: string;
  enabled: boolean;
}): {
  progress: IndexProgressEvent | null;
  error: string | null;
  isStreaming: boolean;
} {
  const [progress, setProgress] = useState<IndexProgressEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const highWaterMarkRef = useRef(0);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollCountRef = useRef(0);
  // progressRef mirrors `progress` state so the polling interval closure can
  // read the latest value without re-creating the interval.
  const progressRef = useRef<IndexProgressEvent | null>(null);

  useEffect(() => {
    if (!enabled || !workspaceId) {
      return;
    }

    // Close any existing connection before opening a new one (singleton)
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }

    // Reset state on new connection
    highWaterMarkRef.current = 0;
    progressRef.current = null;
    setProgress(null);
    setError(null);
    setIsStreaming(true);

    const es = new EventSource(`/api/workspaces/${workspaceId}/index/stream`);
    esRef.current = es;

    const handleEvent = (type: string) => (e: MessageEvent) => {
      try {
        const data: IndexProgressEvent = JSON.parse(e.data);
        // Enforce monotonic percent
        const monotonicPercent = Math.max(
          highWaterMarkRef.current,
          data.percent,
        );
        highWaterMarkRef.current = monotonicPercent;
        const next = { ...data, percent: monotonicPercent };
        progressRef.current = next;
        setProgress(next);
        if (data.error) setError(data.error);
        if (data.done) {
          // Normal terminal close — do NOT start polling fallback (only onerror does)
          es.close();
          esRef.current = null;
          setIsStreaming(false);
        }
      } catch {
        // malformed payload — ignore
      }
    };

    es.addEventListener("started", handleEvent("started"));
    es.addEventListener("progress", handleEvent("progress"));
    es.addEventListener("complete", handleEvent("complete"));
    es.addEventListener("error", handleEvent("error"));
    es.addEventListener("heartbeat", () => {
      // heartbeat keeps the connection alive — no state change needed
    });

    const startPollingFallback = () => {
      pollCountRef.current = 0;
      if (pollingRef.current) clearInterval(pollingRef.current);
      pollingRef.current = setInterval(async () => {
        pollCountRef.current += 1;
        if (pollCountRef.current > 200) {
          // 10 min max — give up
          if (pollingRef.current) clearInterval(pollingRef.current);
          pollingRef.current = null;
          setError("Indexing status timed out — the server may have restarted");
          setIsStreaming(false);
          return;
        }
        try {
          const result = await api.getIndexStatus(workspaceId);
          if (!result || result.status !== "running") {
            if (pollingRef.current) clearInterval(pollingRef.current);
            pollingRef.current = null;
            const prev = progressRef.current;
            // Null/undefined result means the server returned no data —
            // treat as error, not "complete", to avoid masking server issues
            const phase: IndexProgressEvent["phase"] =
              result?.status === "completed"
                ? "complete"
                : result?.status === "failed"
                  ? "error"
                  : result?.status === "cancelled"
                    ? "cancelled"
                    : "error";
            const terminal: IndexProgressEvent = {
              runId: prev?.runId ?? "",
              phase,
              percent: phase === "complete" ? 100 : prev?.percent ?? 0,
              message:
                phase === "complete"
                  ? "Index complete"
                  : phase === "error"
                    ? result
                      ? "Indexing failed"
                      : "Indexing status unavailable — the server may have restarted"
                    : "Cancelled",
              filesDone: prev?.filesDone ?? 0,
              filesTotal: prev?.filesTotal ?? 0,
              chunksWritten: prev?.chunksWritten ?? 0,
              currentPath: null,
              done: true,
              error: phase === "error" ? (result ? "Indexing failed" : "Indexing status unavailable") : null,
            };
            progressRef.current = terminal;
            setProgress(terminal);
            setIsStreaming(false);
          }
        } catch {
          // network error during polling — keep trying until max
        }
      }, 3000);
    };

    es.onerror = () => {
      // Native error (connection lost) — close; polling fallback recovers terminal state
      es.close();
      esRef.current = null;
      setIsStreaming(false);
      // Only fall back to polling if we haven't already reached a terminal state
      if (!progressRef.current?.done) {
        startPollingFallback();
      }
    };

    return () => {
      es.close();
      esRef.current = null;
      if (pollingRef.current) clearInterval(pollingRef.current);
      pollingRef.current = null;
      setIsStreaming(false);
    };
  }, [workspaceId, enabled]);

  return { progress, error, isStreaming };
}
