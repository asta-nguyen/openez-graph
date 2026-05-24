"use client";

import { useEffect, useState } from "react";

import { Card, CardContent } from "@openez-graph/ui";
import { Loader2, CheckCircle2, AlertCircle, Clock } from "lucide-react";

interface IndexStatusResponse {
  jobId: string;
  status: "waiting" | "active" | "completed" | "failed" | "delayed";
  progress?: number;
  progressMessage?: string;
  result?: {
    filesScanned: number;
    filesUpdated: number;
    chunksWritten: number;
    embeddingsWritten: number;
  };
  error?: string;
  createdAt: string;
  processedAt?: string;
}

interface IndexStatusProps {
  workspaceId: string;
  onComplete?: () => void;
}

export function IndexStatus({ workspaceId, onComplete }: IndexStatusProps) {
  const [status, setStatus] = useState<IndexStatusResponse | null>(null);
  const [polling, setPolling] = useState(true);

  useEffect(() => {
    if (!polling) return;

    const poll = async () => {
      try {
        const response = await fetch(`/api/workspaces/${workspaceId}/index`);
        if (response.ok) {
          const data = await response.json();
          setStatus(data);

          if (data?.status === "completed" || data?.status === "failed") {
            setPolling(false);
            if (data.status === "completed" && onComplete) {
              onComplete();
            }
          }
        }
      } catch (error) {
        console.error("Failed to poll status:", error);
      }
    };

    poll();
    const interval = setInterval(poll, 2000);

    return () => clearInterval(interval);
  }, [workspaceId, polling, onComplete]);

  if (!status) {
    return (
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">Checking index status...</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  const StatusIcon = {
    waiting: Clock,
    active: Loader2,
    completed: CheckCircle2,
    failed: AlertCircle,
    delayed: Clock
  }[status.status];

  const statusColors = {
    waiting: "text-muted-foreground",
    active: "text-blue-500",
    completed: "text-green-500",
    failed: "text-destructive",
    delayed: "text-yellow-500"
  }[status.status];

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2">
          <StatusIcon className={`h-4 w-4 ${status.status === "active" ? "animate-spin" : ""} ${statusColors}`} />
          <span className="text-sm font-medium capitalize">{status.status}</span>
        </div>

        {status.progressMessage && (
          <p className="text-xs text-muted-foreground mt-1">{status.progressMessage}</p>
        )}

        {status.progress != null && status.status === "active" && (
          <div className="mt-2">
            <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 transition-all duration-300"
                style={{ width: `${status.progress}%` }}
              />
            </div>
          </div>
        )}

        {status.result && (
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <div>
              <span className="text-muted-foreground">Scanned:</span>{" "}
              <span className="font-medium">{status.result.filesScanned}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Updated:</span>{" "}
              <span className="font-medium">{status.result.filesUpdated}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Chunks:</span>{" "}
              <span className="font-medium">{status.result.chunksWritten}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Embeddings:</span>{" "}
              <span className="font-medium">{status.result.embeddingsWritten}</span>
            </div>
          </div>
        )}

        {status.error && (
          <p className="text-xs text-destructive mt-2">{status.error}</p>
        )}
      </CardContent>
    </Card>
  );
}