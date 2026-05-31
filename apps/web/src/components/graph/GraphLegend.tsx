"use client";
import { getNodeColor, getEdgeColor } from "../../lib/utils";

export function GraphLegend({
  nodeTypes,
  edgeTypes,
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
