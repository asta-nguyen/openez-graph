"use client";

import {
  useState,
  useCallback,
  useEffect,
  useMemo,
  lazy,
  Suspense,
} from "react";
import { GraphLegend } from "./GraphLegend";
import { Badge, Input, Label } from "@openez-graph/ui";
import { Loader2, Search, X } from "lucide-react";

const WorkspaceGraph = lazy(() =>
  import("./WorkspaceGraph").then((mod) => ({ default: mod.WorkspaceGraph })),
);

interface GraphNodeData {
  id: string;
  label: string;
  type: string;
  degree: number;
  metadata: Record<string, unknown>;
  path?: string;
  startLine?: number;
  endLine?: number;
  refId?: string | null;
}

interface GraphEdgeData {
  id: string;
  source: string;
  target: string;
  type: string;
  weight: number;
}

interface GraphData {
  workspaceId: string;
  workspaceName: string;
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
  nodeTypes: string[];
  edgeTypes: string[];
  totalNodes: number;
  totalEdges: number;
  displayedNodes: number;
  displayedEdges: number;
}

interface GraphClientProps {
  graphData: GraphData;
}

export function GraphClient({ graphData }: GraphClientProps) {
  const [mounted, setMounted] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(
    () => new Set(graphData.nodeTypes),
  );
  const [selectedEdgeTypes, setSelectedEdgeTypes] = useState<Set<string>>(
    () => new Set(graphData.edgeTypes),
  );
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [inspectorNode, setInspectorNode] = useState<GraphNodeData | null>(
    null,
  );

  useEffect(() => {
    setMounted(true);
  }, []);

  const nodeById = useMemo(() => {
    const map = new Map<string, GraphNodeData>();
    for (const node of graphData.nodes) map.set(node.id, node);
    return map;
  }, [graphData.nodes]);

  const edgesByTarget = useMemo(() => {
    const map = new Map<string, GraphEdgeData[]>();
    for (const edge of graphData.edges) {
      const list = map.get(edge.target);
      if (list) list.push(edge);
      else map.set(edge.target, [edge]);
    }
    return map;
  }, [graphData.edges]);

  const edgesBySource = useMemo(() => {
    const map = new Map<string, GraphEdgeData[]>();
    for (const edge of graphData.edges) {
      const list = map.get(edge.source);
      if (list) list.push(edge);
      else map.set(edge.source, [edge]);
    }
    return map;
  }, [graphData.edges]);

  const neighbors = useMemo(() => {
    if (!selectedNodeId) return null;
    const incoming = edgesByTarget.get(selectedNodeId) ?? [];
    const outgoing = edgesBySource.get(selectedNodeId) ?? [];
    return { incoming, outgoing };
  }, [selectedNodeId, edgesByTarget, edgesBySource]);

  const filteredNodes = useMemo(() => {
    return graphData.nodes.filter((node) => {
      if (
        searchQuery &&
        !node.label.toLowerCase().includes(searchQuery.toLowerCase())
      )
        return false;
      if (selectedTypes.size > 0 && !selectedTypes.has(node.type)) return false;
      return true;
    });
  }, [graphData.nodes, searchQuery, selectedTypes]);

  const filteredEdges = useMemo(() => {
    const filteredNodeIds = new Set(filteredNodes.map((n) => n.id));
    return graphData.edges.filter((edge) => {
      if (
        !filteredNodeIds.has(edge.source) ||
        !filteredNodeIds.has(edge.target)
      )
        return false;
      if (selectedEdgeTypes.size > 0 && !selectedEdgeTypes.has(edge.type))
        return false;
      return true;
    });
  }, [graphData.edges, filteredNodes, selectedEdgeTypes]);

  const handleNodeClick = useCallback(
    (nodeId: string) => {
      if (!nodeId) {
        setSelectedNodeId(null);
        setInspectorNode(null);
        return;
      }
      setSelectedNodeId(nodeId);
      setInspectorNode(nodeById.get(nodeId) ?? null);
    },
    [nodeById],
  );

  const handleNodeHover = useCallback((nodeId: string | null) => {
    setHoveredNodeId(nodeId);
  }, []);

  const toggleType = (type: string) => {
    const newTypes = new Set(selectedTypes);
    if (newTypes.has(type)) newTypes.delete(type);
    else newTypes.add(type);
    setSelectedTypes(newTypes);
  };

  const toggleEdgeType = (type: string) => {
    const newTypes = new Set(selectedEdgeTypes);
    if (newTypes.has(type)) newTypes.delete(type);
    else newTypes.add(type);
    setSelectedEdgeTypes(newTypes);
  };

  if (!mounted) {
    return (
      <div className="flex flex-1 items-center justify-center bg-background">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Loading graph interface...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex-1 min-h-0 overflow-hidden bg-[#171717]">
      <div className="absolute left-3 top-3 z-10 max-h-[calc(100%-1.5rem)] w-64 overflow-y-auto rounded-lg border border-white/10 bg-[#202020]/95 p-3 shadow-2xl backdrop-blur-xl">
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="search" className="text-xs">
              Search
            </Label>
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                id="search"
                placeholder="Node label..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-8 h-8 text-sm"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  aria-label="Clear search"
                  className="absolute right-2 top-1/2 -translate-y-1/2"
                >
                  <X className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
                </button>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-xs">Node Types</Label>
            <div className="flex flex-wrap gap-1">
              {graphData.nodeTypes.map((type) => (
                <button
                  type="button"
                  key={type}
                  onClick={() => toggleType(type)}
                  aria-pressed={selectedTypes.has(type)}
                  className={`px-2 py-0.5 text-xs rounded border transition-colors ${
                    selectedTypes.has(type)
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-muted text-muted-foreground border-transparent hover:border-border"
                  }`}
                >
                  {type}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-xs">Edge Types</Label>
            <div className="flex flex-wrap gap-1">
              {graphData.edgeTypes.map((type) => (
                <button
                  type="button"
                  key={type}
                  onClick={() => toggleEdgeType(type)}
                  aria-pressed={selectedEdgeTypes.has(type)}
                  className={`px-2 py-0.5 text-xs rounded border transition-colors ${
                    selectedEdgeTypes.has(type)
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-muted text-muted-foreground border-transparent hover:border-border"
                  }`}
                >
                  {type}
                </button>
              ))}
            </div>
          </div>

          <div className="pt-2 border-t">
            <p className="text-xs text-muted-foreground">
              Showing {filteredNodes.length.toLocaleString()} of {graphData.totalNodes.toLocaleString()} nodes
            </p>
            <p className="text-xs text-muted-foreground">
              {filteredEdges.length.toLocaleString()} of {graphData.totalEdges.toLocaleString()} edges
            </p>
            {graphData.totalNodes > graphData.nodes.length && (
              <p className="text-xs text-amber-500/80 mt-1">
                {graphData.nodes.length.toLocaleString()} nodes loaded (limit)
              </p>
            )}
          </div>

          <div className="pt-2 border-t">
            <GraphLegend
              nodeTypes={graphData.nodeTypes}
              edgeTypes={graphData.edgeTypes}
            />
          </div>
        </div>
      </div>

      <div className="absolute inset-0">
        <Suspense
          fallback={
            <div className="absolute inset-0 flex items-center justify-center bg-[#171717]">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Loading graph renderer...</span>
              </div>
            </div>
          }
        >
          <WorkspaceGraph
            nodes={filteredNodes}
            edges={filteredEdges}
            selectedNodeId={selectedNodeId}
            onNodeClick={handleNodeClick}
            onNodeHover={handleNodeHover}
            className="absolute inset-0"
          />
        </Suspense>

        {hoveredNodeId &&
          !selectedNodeId &&
          (() => {
            const node = nodeById.get(hoveredNodeId);
            if (!node) return null;
            return (
              <div className="pointer-events-none absolute bottom-4 left-4 max-w-sm rounded-md border border-white/10 bg-[#202020]/95 px-3 py-2 shadow-xl backdrop-blur-xl">
                <p className="text-sm font-medium">{node.label}</p>
                <p className="text-xs text-muted-foreground">{node.type}</p>
              </div>
            );
          })()}
      </div>

      {inspectorNode && (
        <div className="absolute bottom-3 right-3 top-3 z-20 w-[min(20rem,calc(100%-1.5rem))] overflow-y-auto rounded-lg border border-white/10 bg-[#202020]/95 shadow-2xl backdrop-blur-xl">
          <div className="p-4 border-b flex items-center justify-between">
            <h3 className="font-medium text-sm">Inspector</h3>
            <button
              type="button"
              aria-label="Close inspector"
              onClick={() => {
                setSelectedNodeId(null);
                setInspectorNode(null);
              }}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="p-4 space-y-4">
            <div className="space-y-2">
              <div>
                <Label className="text-xs text-muted-foreground">Label</Label>
                <p className="text-sm font-mono break-all">
                  {inspectorNode.label}
                </p>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Type</Label>
                <p className="text-sm">
                  <Badge variant="outline">{inspectorNode.type}</Badge>
                </p>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Degree</Label>
                <p className="text-sm">{inspectorNode.degree} connections</p>
              </div>
              {inspectorNode.path && (
                <div>
                  <Label className="text-xs text-muted-foreground">Path</Label>
                  <p className="text-sm font-mono text-xs break-all">
                    {inspectorNode.path}
                  </p>
                </div>
              )}
              {(inspectorNode.startLine || inspectorNode.endLine) && (
                <div>
                  <Label className="text-xs text-muted-foreground">Lines</Label>
                  <p className="text-sm font-mono">
                    {inspectorNode.startLine ?? "?"}-
                    {inspectorNode.endLine ?? "?"}
                  </p>
                </div>
              )}
            </div>
            {neighbors && (
              <div className="space-y-2 pt-2 border-t">
                <Label className="text-xs text-muted-foreground">
                  Connections (
                  {neighbors.incoming.length + neighbors.outgoing.length})
                </Label>
                {neighbors.incoming.length > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">
                      Incoming
                    </p>
                    {neighbors.incoming.slice(0, 5).map((edge) => {
                      const sourceNode = nodeById.get(edge.source);
                      return (
                        <button
                          type="button"
                          key={edge.id}
                          onClick={() => handleNodeClick(edge.source)}
                          className="block w-full text-left px-2 py-1 text-xs rounded hover:bg-muted"
                        >
                          <span className="text-muted-foreground">
                            {edge.type}:
                          </span>{" "}
                          <span className="font-mono truncate">
                            {sourceNode?.label ?? edge.source}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
                {neighbors.outgoing.length > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">
                      Outgoing
                    </p>
                    {neighbors.outgoing.slice(0, 5).map((edge) => {
                      const targetNode = nodeById.get(edge.target);
                      return (
                        <button
                          type="button"
                          key={edge.id}
                          onClick={() => handleNodeClick(edge.target)}
                          className="block w-full text-left px-2 py-1 text-xs rounded hover:bg-muted"
                        >
                          <span className="text-muted-foreground">
                            {edge.type}:
                          </span>{" "}
                          <span className="font-mono truncate">
                            {targetNode?.label ?? edge.target}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            {Object.keys(inspectorNode.metadata ?? {}).length > 0 && (
              <div className="space-y-2 pt-2 border-t">
                <Label className="text-xs text-muted-foreground">
                  Metadata
                </Label>
                <pre className="text-xs bg-muted rounded p-2 overflow-auto max-h-40">
                  {JSON.stringify(inspectorNode.metadata, null, 2)}
                </pre>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
