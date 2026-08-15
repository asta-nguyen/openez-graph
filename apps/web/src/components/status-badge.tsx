import { Badge } from "@openez-graph/ui";

const statusVariants = {
  pending: "outline",
  indexing: "secondary",
  indexed: "default",
  error: "destructive",
  running: "secondary",
  completed: "default",
  failed: "destructive",
} satisfies Record<string, "default" | "secondary" | "destructive" | "outline">;

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const entry = Object.entries(statusVariants).find(([k]) => k === status);
  return (
    <Badge variant={entry?.[1] ?? "outline"} className={className}>
      {status}
    </Badge>
  );
}
