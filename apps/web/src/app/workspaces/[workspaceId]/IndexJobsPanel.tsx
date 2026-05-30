"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatDate } from "../../../lib/utils";

import { Badge, Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@openez-graph/ui";
import { AlertCircle, CheckCircle2, Clock, Loader2, Square } from "lucide-react";

type JobStatus = "waiting" | "active" | "completed" | "failed" | "delayed";

interface IndexJobStatusResponse {
  jobId: string;
  status: JobStatus;
  workspaceId: string;
  mode?: string;
  progress?: number;
  progressMessage?: string;
  result?: {
    filesScanned: number;
    filesUpdated: number;
    chunksWritten: number;
    embeddingsWritten: number;
  };
  error?: string;
  cancelRequested: boolean;
  createdAt: string;
  processedAt?: string;
}

interface IndexJobsPanelProps {
  workspaceId: string;
}

function StatusBadge({ status, cancelRequested }: { status: JobStatus; cancelRequested: boolean }) {
  const variantMap: Record<JobStatus, "default" | "secondary" | "destructive" | "outline"> = {
    waiting: "outline",
    active: "secondary",
    completed: "default",
    failed: "destructive",
    delayed: "outline"
  };

  return (
    <Badge variant={variantMap[status]} className="uppercase">
      {cancelRequested && status === "active" ? "cancelling" : status}
    </Badge>
  );
}

function StatusIcon({ status }: { status: JobStatus }) {
  if (status === "active") {
    return <Loader2 className="h-4 w-4 animate-spin text-blue-500" />;
  }
  if (status === "completed") {
    return <CheckCircle2 className="h-4 w-4 text-green-500" />;
  }
  if (status === "failed") {
    return <AlertCircle className="h-4 w-4 text-destructive" />;
  }
  return <Clock className="h-4 w-4 text-muted-foreground" />;
}

export function IndexJobsPanel({ workspaceId }: IndexJobsPanelProps) {
  const router = useRouter();
  const [jobs, setJobs] = useState<IndexJobStatusResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [cancellingJobId, setCancellingJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latestStatusRef = useRef<JobStatus | null>(null);

  const latestJob = jobs[0] ?? null;
  const isBusy = useMemo(
    () => jobs.some((job) => job.status === "waiting" || job.status === "active" || job.status === "delayed"),
    [jobs]
  );

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const response = await fetch(`/api/workspaces/${workspaceId}/jobs`);
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error ?? "Failed to load jobs");
        }

        const data = await response.json() as IndexJobStatusResponse[];
        if (cancelled) {
          return;
        }

        const previousLatestStatus = latestStatusRef.current;
        const nextLatestStatus = data[0]?.status ?? null;

        setJobs(data);
        setError(null);
        setLoading(false);
        latestStatusRef.current = nextLatestStatus;

        if (
          previousLatestStatus &&
          (previousLatestStatus === "waiting" || previousLatestStatus === "active" || previousLatestStatus === "delayed") &&
          nextLatestStatus &&
          (nextLatestStatus === "completed" || nextLatestStatus === "failed")
        ) {
          router.refresh();
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load jobs");
          setLoading(false);
        }
      }
    };

    void poll();
    const interval = window.setInterval(poll, isBusy ? 2000 : 8000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [workspaceId, router, isBusy]);

  async function handleCancel(jobId: string) {
    setCancellingJobId(jobId);
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/jobs/${jobId}`, {
        method: "DELETE"
      });

      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.error ?? "Failed to cancel job");
      }

      setError(null);
      router.refresh();
      const refreshed = await fetch(`/api/workspaces/${workspaceId}/jobs`);
      if (refreshed.ok) {
        const data = await refreshed.json() as IndexJobStatusResponse[];
        setJobs(data);
        latestStatusRef.current = data[0]?.status ?? null;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel job");
    } finally {
      setCancellingJobId(null);
    }
  }

  return (
    <div className="space-y-4">
      {error && (
        <p className="text-sm text-destructive">{error}</p>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Loading queue jobs...</span>
        </div>
      ) : jobs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No queue jobs yet.</p>
      ) : (
        <>
          {latestJob && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <StatusIcon status={latestJob.status} />
                <span className="text-sm font-medium">Latest job</span>
                <StatusBadge status={latestJob.status} cancelRequested={latestJob.cancelRequested} />
              </div>

              {latestJob.progressMessage && (
                <p className="text-sm text-muted-foreground">{latestJob.progressMessage}</p>
              )}

              {latestJob.status === "active" && latestJob.progress != null && (
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full bg-blue-500 transition-all duration-300"
                    style={{ width: `${latestJob.progress}%` }}
                  />
                </div>
              )}

              {latestJob.error && (
                <p className="text-sm text-destructive">{latestJob.error}</p>
              )}
            </div>
          )}

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Created</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Mode</TableHead>
                <TableHead>Progress</TableHead>
                <TableHead>Result</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.map((job) => {
                const canCancel = !job.cancelRequested && (job.status === "waiting" || job.status === "active" || job.status === "delayed");
                const isCancelling = cancellingJobId === job.jobId;

                return (
                  <TableRow key={job.jobId}>
                    <TableCell className="text-xs text-muted-foreground">{formatDate(job.createdAt)}</TableCell>
                    <TableCell>
                      <StatusBadge status={job.status} cancelRequested={job.cancelRequested} />
                    </TableCell>
                    <TableCell className="text-sm">{job.mode ?? "incremental"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {job.cancelRequested && job.status === "active"
                        ? "Cancellation requested"
                        : job.progressMessage ?? (job.progress != null ? `${job.progress}%` : "—")}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {job.result
                        ? `${job.result.filesUpdated}/${job.result.filesScanned} files`
                        : job.error ?? "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {canCancel ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={isCancelling}
                          onClick={() => handleCancel(job.jobId)}
                        >
                          {isCancelling ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Square className="h-4 w-4" />
                          )}
                          Cancel
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {job.cancelRequested ? "Cancelling" : "—"}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </>
      )}
    </div>
  );
}
