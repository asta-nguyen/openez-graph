"use client";

const NODE_COLORS: Record<string, string> = {
  file: "#60a5fa",
  chunk: "#34d399",
  symbol: "#fbbf24",
  memory: "#f472b6",
  entity: "#c084fc",
  document: "#22d3ee",
  default: "#94a3b8"
};

const EDGE_COLORS: Record<string, string> = {
  imports: "#60a5fa",
  defines: "#fbbf24",
  contains: "#34d399",
  mentions: "#c084fc",
  represented_by: "#f472b6",
  calls: "#f97316",
  links_to: "#22d3ee",
  related_to: "#94a3b8",
  default: "#64748b"
};

function getNodeColor(type: string): string {
  return NODE_COLORS[type] ?? NODE_COLORS.default;
}

function getEdgeColor(type: string): string {
  return EDGE_COLORS[type] ?? EDGE_COLORS.default;
}

export function GraphLegend({
  nodeTypes,
  edgeTypes
}: {
  nodeTypes: string[];
  edgeTypes: string[];
}) {
  return (
    <div className="flex flex-wrap gap-4 text-xs">
      <div className="flex flex-col gap-1">
        <span className="font-medium text-muted-foreground">Nodes</span>
        {nodeTypes.map((type) => (
          <div key={type} className="flex items-center gap-1.5">
            <span
              className="h-3 w-3 rounded-full"
              style={{ backgroundColor: getNodeColor(type) }}
            />
            <span className="text-muted-foreground">{type}</span>
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-1">
        <span className="font-medium text-muted-foreground">Edges</span>
        {edgeTypes.slice(0, 6).map((type) => (
          <div key={type} className="flex items-center gap-1.5">
            <span
              className="h-0.5 w-3 rounded-full"
              style={{ backgroundColor: getEdgeColor(type) }}
            />
            <span className="text-muted-foreground">{type}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
