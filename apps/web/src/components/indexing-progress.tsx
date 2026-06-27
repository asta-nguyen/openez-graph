import { useEffect } from "react";
import {
  Loader2,
  CheckCircle2,
  AlertCircle,
  Clock,
  FileText,
  Layers,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@openez-graph/ui";
import { useSSE, type IndexProgressEvent } from "../lib/use-sse";

const PHASE_LABELS: Record<IndexProgressEvent["phase"], string> = {
  started: "Starting...",
  scanning: "Scanning files...",
  indexing: "Indexing...",
  finalizing: "Finalizing...",
  complete: "Complete",
  error: "Failed",
  cancelled: "Cancelled",
};

// Phase-specific colors for the progress bar fill and card accent.
// Uses CSS variable references directly via inline styles to guarantee
// the theme colors are applied regardless of Tailwind class generation.
const PHASE_COLORS: Record<IndexProgressEvent["phase"], { bar: string; icon: string; border: string }> = {
  started:    { bar: "var(--muted-foreground)",   icon: "var(--muted-foreground)",   border: "" },
  scanning:   { bar: "var(--chart-2)",            icon: "var(--chart-2)",            border: "var(--chart-2)" },
  indexing:   { bar: "var(--chart-1)",            icon: "var(--chart-1)",            border: "var(--chart-1)" },
  finalizing: { bar: "var(--chart-3)",            icon: "var(--chart-3)",            border: "var(--chart-3)" },
  complete:   { bar: "var(--primary)",            icon: "var(--primary)",            border: "" },
  error:      { bar: "var(--destructive)",        icon: "var(--destructive)",        border: "var(--destructive)" },
  cancelled:  { bar: "var(--muted-foreground)",   icon: "var(--muted-foreground)",   border: "var(--muted-foreground)" },
};

function PhaseIcon({ phase }: { phase: IndexProgressEvent["phase"] }) {
  const color = PHASE_COLORS[phase].icon;
  if (phase === "complete")
    return <CheckCircle2 className="h-4 w-4" style={{ color }} />;
  if (phase === "error")
    return <AlertCircle className="h-4 w-4" style={{ color }} />;
  if (phase === "cancelled")
    return <Clock className="h-4 w-4" style={{ color }} />;
  return <Loader2 className="h-4 w-4 animate-spin" style={{ color }} />;
}

export function IndexingProgress({
  workspaceId,
  indexingStatus,
  onComplete,
}: {
  workspaceId: string;
  indexingStatus: string;
  onComplete?: () => void;
}) {
  const { progress, error, isStreaming } = useSSE({
    workspaceId,
    enabled: indexingStatus === "running",
  });

  // Invalidate workspace query on terminal event so the static card refreshes
  useEffect(() => {
    if (progress?.done && onComplete) onComplete();
  }, [progress?.done, onComplete]);

  if (!isStreaming && !progress) return null;
  if (!progress) return null;

  const percent = Math.max(0, Math.min(100, progress.percent));
  const isTerminal = progress.done;
  const phaseColor = PHASE_COLORS[progress.phase];

  return (
    <Card
      style={phaseColor.border ? { borderColor: phaseColor.border } : undefined}
    >
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <PhaseIcon phase={progress.phase} />
            {PHASE_LABELS[progress.phase]}
          </CardTitle>
          <span className="text-sm font-medium">{percent}%</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-live="polite"
          className="h-2 w-full rounded-full bg-muted overflow-hidden"
        >
          <div
            className="h-full transition-all duration-300 ease-out"
            style={{ width: `${percent}%`, backgroundColor: phaseColor.bar }}
          />
        </div>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-muted-foreground" />
            <span>
              <span className="font-medium">{progress.filesDone}</span> /{" "}
              {progress.filesTotal} files
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Layers className="h-4 w-4 text-muted-foreground" />
            <span>
              <span className="font-medium">{progress.chunksWritten}</span>{" "}
              chunks
            </span>
          </div>
        </div>
        {progress.currentPath && (
          <div
            className="rounded-md border bg-muted/30 p-2 font-mono text-xs truncate"
            title={progress.currentPath}
          >
            {progress.currentPath}
          </div>
        )}
        <p className="text-xs text-muted-foreground">{progress.message}</p>
        {(progress.phase === "error" || error) && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-2">
            <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium text-destructive">
                Indexing failed
              </p>
              <p className="text-sm text-destructive/90">
                {progress.error ?? error ?? "Unknown error"}
              </p>
            </div>
          </div>
        )}
        {progress.phase === "cancelled" && (
          <p className="text-sm text-muted-foreground">
            Indexing was cancelled.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
