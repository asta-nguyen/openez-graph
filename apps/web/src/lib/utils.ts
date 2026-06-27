export function formatDate(date: Date | string | null | undefined): string {
  if (!date) return "\u2014";
  return new Date(date).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export const NODE_COLORS: Record<string, string> = {
  file: "#60a5fa",
  chunk: "#34d399",
  symbol: "#fbbf24",
  memory: "#f472b6",
  entity: "#c084fc",
  document: "#22d3ee",
  default: "#94a3b8",
};

export const EDGE_COLORS: Record<string, string> = {
  imports: "#60a5fa",
  defines: "#fbbf24",
  contains: "#34d399",
  mentions: "#c084fc",
  represented_by: "#f472b6",
  calls: "#f97316",
  links_to: "#22d3ee",
  related_to: "#94a3b8",
  default: "#64748b",
};

export function getNodeColor(type: string): string {
  return NODE_COLORS[type] ?? NODE_COLORS.default;
}

export function getEdgeColor(type: string): string {
  return EDGE_COLORS[type] ?? EDGE_COLORS.default;
}
