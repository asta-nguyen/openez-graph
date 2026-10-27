"use client";

// Mirrors the controls of the real Graph Explorer (apps/web .../GraphClient.tsx): search, node and
// edge type filters, counts, legend. The data is a real sample of the openez repo's own graph.

import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { EDGE_COLORS, NODE_COLORS, WorkspaceGraph } from "./workspace-graph";
import { SAMPLE_TOTALS, sampleEdges, sampleNodes } from "./graph-sample";

const nodeTypes = ["file", "symbol"];
const edgeTypes = ["imports", "defines", "calls"];

function toggle(set: Set<string>, value: string) {
  const next = new Set(set);
  if (!next.delete(value)) next.add(value);
  return next;
}

function Chips({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: string[];
  selected: Set<string>;
  onToggle: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium">{label}</p>
      <div className="flex flex-wrap gap-1">
        {options.map((type) => (
          <button
            key={type}
            type="button"
            aria-pressed={selected.has(type)}
            onClick={() => onToggle(type)}
            className="rounded border border-transparent bg-white/10 px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-white/20 aria-pressed:border-foreground aria-pressed:bg-foreground aria-pressed:text-background"
          >
            {type}
          </button>
        ))}
      </div>
    </div>
  );
}

export function GraphExplorer() {
  const [search, setSearch] = useState("");
  const [types, setTypes] = useState(() => new Set(nodeTypes));
  const [edgeKinds, setEdgeKinds] = useState(() => new Set(edgeTypes));
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const nodes = useMemo(() => {
    const q = search.trim().toLowerCase();
    return sampleNodes.filter(
      (n) => types.has(n.type) && (!q || n.label.toLowerCase().includes(q)),
    );
  }, [search, types]);

  const edges = useMemo(() => {
    const ids = new Set(nodes.map((n) => n.id));
    return sampleEdges.filter(
      (e) => edgeKinds.has(e.type) && ids.has(e.source) && ids.has(e.target),
    );
  }, [nodes, edgeKinds]);

  return (
    <div className="relative flex h-full flex-col bg-[#171717] sm:block">
      <div className="relative z-10 shrink-0 space-y-2.5 border-b border-white/10 bg-[#202020]/95 p-3 sm:absolute sm:left-3 sm:top-3 sm:max-h-[calc(100%-1.5rem)] sm:w-60 sm:space-y-3.5 sm:overflow-y-auto sm:rounded-lg sm:border sm:shadow-2xl sm:backdrop-blur-xl">
        <div className="space-y-1.5">
          <label htmlFor="graph-search" className="text-xs font-medium">
            Search
          </label>
          <div className="relative">
            <Search
              className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <input
              id="graph-search"
              placeholder="Node label..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 w-full rounded-md border border-white/15 bg-transparent pl-8 pr-8 text-sm placeholder:text-muted-foreground"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
        </div>

        <Chips
          label="Node Types"
          options={nodeTypes}
          selected={types}
          onToggle={(t) => setTypes(toggle(types, t))}
        />
        <Chips
          label="Edge Types"
          options={edgeTypes}
          selected={edgeKinds}
          onToggle={(t) => setEdgeKinds(toggle(edgeKinds, t))}
        />

        <div className="hidden space-y-3.5 sm:block">
          <div className="space-y-0.5 border-t border-white/10 pt-3 text-xs text-muted-foreground">
            <p>
              Showing {nodes.length} of {sampleNodes.length} nodes
            </p>
            <p>
              {edges.length} of {sampleEdges.length} edges
            </p>
            <p className="pt-1">
              Sample of {SAMPLE_TOTALS.nodes.toLocaleString("en-US")} nodes ·{" "}
              {SAMPLE_TOTALS.edges.toLocaleString("en-US")} edges
            </p>
          </div>

          <div className="flex gap-6 border-t border-white/10 pt-3 text-xs text-muted-foreground">
            <div className="space-y-1">
              <p className="font-medium">Nodes</p>
              {nodeTypes.map((t) => (
                <div key={t} className="flex items-center gap-1.5">
                  <span
                    className="size-3 rounded-full"
                    style={{ backgroundColor: NODE_COLORS[t] }}
                  />
                  {t}
                </div>
              ))}
            </div>
            <div className="space-y-1">
              <p className="font-medium">Edges</p>
              {edgeTypes.map((t) => (
                <div key={t} className="flex items-center gap-1.5">
                  <span
                    className="h-0.5 w-3 rounded-full"
                    style={{ backgroundColor: EDGE_COLORS[t] }}
                  />
                  {t}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 sm:absolute sm:inset-0">
        <WorkspaceGraph
          nodes={nodes}
          edges={edges}
          selectedNodeId={selectedId}
          onNodeClick={setSelectedId}
          overlayWidth={264} // the w-60 controls panel plus its left-3 offset and a gap
        />
      </div>
    </div>
  );
}
