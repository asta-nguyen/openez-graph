export function formatDate(date: Date | string | null | undefined): string {
  if (!date) return "\u2014";
  return new Date(date).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export const NODE_COLORS = {
  file: "#60a5fa",
  chunk: "#34d399",
  symbol: "#fbbf24",
  memory: "#f472b6",
  entity: "#c084fc",
  document: "#22d3ee",
  default: "#94a3b8",
} satisfies Record<string, string>;

export const EDGE_COLORS = {
  imports: "#60a5fa",
  defines: "#fbbf24",
  contains: "#34d399",
  mentions: "#c084fc",
  represented_by: "#f472b6",
  calls: "#f97316",
  links_to: "#22d3ee",
  related_to: "#94a3b8",
  default: "#64748b",
} satisfies Record<string, string>;

export function getNodeColor(type: string): string {
  const entry = Object.entries(NODE_COLORS).find(([k]) => k === type);
  return entry?.[1] ?? NODE_COLORS.default;
}

export function getEdgeColor(type: string): string {
  const entry = Object.entries(EDGE_COLORS).find(([k]) => k === type);
  return entry?.[1] ?? EDGE_COLORS.default;
}
