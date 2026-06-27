"use client";

import {
  useState,
  useCallback,
  useEffect,
  useMemo,
  lazy,
  Suspense,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import { GraphLegend } from "./GraphLegend";
import { Badge, Input, Label, DualRangeSlider } from "@openez-graph/ui";
import { Loader2, Search, X } from "lucide-react";
import { NODE_TYPES, SYMBOL_TYPES } from "../../lib/constants";

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
}

interface GraphClientProps {
  graphData: GraphData;
}

export function GraphClient({ graphData }: GraphClientProps) {
  const navigate = useNavigate();
  const [mounted, setMounted] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(
    () => new Set(graphData.nodeTypes.includes(NODE_TYPES.FILE) ? [NODE_TYPES.FILE] : []),
  );
  const [selectedEdgeTypes, setSelectedEdgeTypes] = useState<Set<string>>(
    () => new Set(graphData.edgeTypes.includes("imports") ? ["imports"] : []),
  );
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [inspectorNode, setInspectorNode] = useState<GraphNodeData | null>(
    null,
  );

  // Degree filter state
  const degreeBounds = useMemo(() => {
    if (graphData.nodes.length === 0) return { min: 0, max: 0 };
    const degrees = graphData.nodes.map((n) => n.degree);
    return { min: Math.min(...degrees), max: Math.max(...degrees) };
  }, [graphData.nodes]);

  const [minDegree, setMinDegree] = useState(0);
  const [maxDegree, setMaxDegree] = useState(Infinity);

  // Reset degree filter when graph data changes
  useEffect(() => {
    setMinDegree(0);
    setMaxDegree(Infinity);
  }, [graphData.workspaceId]);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Debounce search input — 250ms delay prevents thrashing nodeVisibility
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery), 250);
    return () => clearTimeout(t);
  }, [searchQuery]);

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
        debouncedSearch &&
        !node.label.toLowerCase().includes(debouncedSearch.toLowerCase())
      )
        return false;
      if (selectedTypes.size > 0 && !selectedTypes.has(node.type)) return false;
      if (node.degree < minDegree || node.degree > maxDegree) return false;
      return true;
    });
  }, [graphData.nodes, debouncedSearch, selectedTypes, minDegree, maxDegree]);

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

  const handleNodeDoubleClick = useCallback(
    (nodeId: string) => {
      const node = nodeById.get(nodeId);
      if (!node) return;
      const workspaceId = graphData.workspaceId;
      // Symbol-type nodes → navigate to symbol browser with label pre-filled
      const symbolTypes: string[] = [...SYMBOL_TYPES];
      if (symbolTypes.includes(node.type) || node.refId) {
        navigate({
          to: "/workspaces/$workspaceId/symbols",
          params: { workspaceId },
          search: { workspaceId, type: SYMBOL_TYPES[0], page: 1, q: node.label },
        });
        return;
      }
      // File-type nodes → navigate to workspace detail (fallback)
      navigate({
        to: "/workspaces/$workspaceId",
        params: { workspaceId },
        search: { workspaceId },
      });
    },
    [nodeById, graphData.workspaceId, navigate],
  );

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
    <div className="flex-1 flex overflow-hidden">
      <div className="w-64 border-r bg-background/50 py-4 pr-4 overflow-y-auto">
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
                  onClick={() => setSearchQuery("")}
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
                  key={type}
                  onClick={() => toggleType(type)}
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
              {graphData.edgeTypes.slice(0, 8).map((type) => (
                <button
                  key={type}
                  onClick={() => toggleEdgeType(type)}
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

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Degree Range</Label>
              <span className="text-xs text-muted-foreground tabular-nums">
                {minDegree} – {maxDegree === Infinity ? "∞" : maxDegree}
              </span>
            </div>
            <DualRangeSlider
              min={degreeBounds.min}
              max={degreeBounds.max}
              step={1}
              value={[
                minDegree === Infinity ? degreeBounds.max : Math.max(minDegree, degreeBounds.min),
                maxDegree === Infinity ? degreeBounds.max : Math.min(maxDegree, degreeBounds.max),
              ]}
              onValueChange={(v) => {
                setMinDegree(v[0]);
                setMaxDegree(v[1]);
              }}
            />
          </div>

          <div className="pt-2 border-t">
            <p className="text-xs text-muted-foreground">
              Showing {filteredNodes.length} of {graphData.totalNodes} nodes
            </p>
            <p className="text-xs text-muted-foreground">
              {filteredEdges.length} edges
            </p>
          </div>

          <div className="pt-2 border-t">
            <GraphLegend
              nodeTypes={graphData.nodeTypes}
              edgeTypes={graphData.edgeTypes}
            />
          </div>
        </div>
      </div>

      <div className="flex-1 relative">
        <Suspense
          fallback={
            <div className="absolute inset-0 flex items-center justify-center bg-[#0a0f1a]">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Loading graph renderer...</span>
              </div>
            </div>
          }
        >
          <WorkspaceGraph
            nodes={graphData.nodes}
            edges={graphData.edges}
            selectedNodeId={selectedNodeId}
            onNodeClick={handleNodeClick}
            onNodeHover={handleNodeHover}
            onNodeDoubleClick={handleNodeDoubleClick}
            filters={{
              types: selectedTypes,
              search: debouncedSearch,
              minDegree,
              maxDegree,
            }}
            className="absolute inset-0"
          />
        </Suspense>

        {hoveredNodeId &&
          !selectedNodeId &&
          (() => {
            const node = nodeById.get(hoveredNodeId);
            if (!node) return null;
            return (
              <div className="absolute bottom-4 left-4 bg-background/95 border rounded-md px-3 py-2 shadow-lg">
                <p className="text-sm font-medium">{node.label}</p>
                <p className="text-xs text-muted-foreground">{node.type}</p>
              </div>
            );
          })()}
      </div>

      {inspectorNode && (
        <div className="w-80 border-l bg-background overflow-y-auto">
          <div className="p-4 border-b flex items-center justify-between">
            <h3 className="font-medium text-sm">Inspector</h3>
            <button
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
