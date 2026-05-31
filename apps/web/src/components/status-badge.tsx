import { Badge } from "@openez-graph/ui";

const statusVariants: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "outline",
  indexing: "secondary",
  indexed: "default",
  error: "destructive",
  running: "secondary",
  completed: "default",
  failed: "destructive",
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return <Badge variant={statusVariants[status] ?? "outline"} className={className}>{status}</Badge>;
}
