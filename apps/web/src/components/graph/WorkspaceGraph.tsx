"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import Graph from "graphology";
import Sigma from "sigma";
import forceAtlas2 from "graphology-layout-forceatlas2";
import type { GraphNodeData, GraphEdgeData } from "../../app/workspaces/[workspaceId]/graph/actions";

export interface WorkspaceGraphProps {
  allNodes: GraphNodeData[];
  allEdges: GraphEdgeData[];
  visibleNodeIds: string[];
  selectedNodeId?: string | null;
  onNodeClick?: (nodeId: string) => void;
  onNodeHover?: (nodeId: string | null) => void;
  className?: string;
}

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

function getNodeSize(degree: number): number {
  const base = 5;
  const scale = Math.min(degree * 0.5, 15);
  return base + scale;
}

export function WorkspaceGraph({
  allNodes,
  allEdges,
  visibleNodeIds,
  selectedNodeId,
  onNodeClick,
  onNodeHover,
  className = ""
}: WorkspaceGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const graphRef = useRef<Graph | null>(null);
  const positionCacheRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);

  const nodeTypeById = useMemo(() => {
    const map = new Map<string, string>();
    for (const node of allNodes) {
      map.set(node.id, node.type);
    }
    return map;
  }, [allNodes]);

  // Fast lookup for degree
  const degreeByNodeId = useMemo(() => {
    const map = new Map<string, number>();
    for (const edge of allEdges) {
      map.set(edge.source, (map.get(edge.source) ?? 0) + 1);
      map.set(edge.target, (map.get(edge.target) ?? 0) + 1);
    }
    return map;
  }, [allEdges]);

  // Data revision key — rebuild only when the underlying dataset changes
  const datasetKey = `${allNodes.length}-${allEdges.length}`;

  // Visible node set for quick lookup
  const visibleSet = useMemo(() => new Set(visibleNodeIds), [visibleNodeIds]);

  // Build full graph once per dataset
  useEffect(() => {
    if (!containerRef.current) return;

    const graph = new Graph({ multi: true, type: "directed" });
    const cache = positionCacheRef.current;

    for (const node of allNodes) {
      let pos = cache.get(node.id);
      if (!pos) {
        pos = { x: Math.random() * 100 - 50, y: Math.random() * 100 - 50 };
        cache.set(node.id, pos);
      }

      graph.addNode(node.id, {
        label: node.label,
        originalLabel: node.label,
        x: pos.x,
        y: pos.y,
        size: getNodeSize(node.degree),
        color: getNodeColor(node.type),
        colorBorder: getNodeColor(node.type),
        borderSize: 2,
        labelSize: 12,
        labelColor: "#e2e8f0",
        zIndex: 0,
        hidden: false
      });
    }

    for (const edge of allEdges) {
      if (graph.hasNode(edge.source) && graph.hasNode(edge.target)) {
        graph.addEdge(edge.source, edge.target, {
          type: "line",
          edgeKind: edge.type,
          weight: edge.weight,
          color: getEdgeColor(edge.type),
          size: Math.max(0.5, Math.min(edge.weight, 2)),
          zIndex: -1,
          hidden: false
        });
      }
    }

    if (graph.order > 0) {
      const settings = forceAtlas2.inferSettings(graph);
      forceAtlas2.assign(graph, {
        iterations: 50,
        settings
      });
    }

    graph.forEachNode((nodeId) => {
      const pos = { x: graph.getNodeAttribute(nodeId, "x"), y: graph.getNodeAttribute(nodeId, "y") };
      positionCacheRef.current.set(nodeId, pos);
    });

    graphRef.current = graph;

    const sigma = new Sigma(graph, containerRef.current, {
      renderLabels: true,
      labelFont: "Arial",
      labelSize: 12,
      labelWeight: "400",
      labelColor: { color: "#e2e8f0" },
      defaultNodeColor: "#94a3b8",
      defaultEdgeColor: "#64748b",
      minCameraRatio: 0.1,
      maxCameraRatio: 10,
      allowInvalidContainer: true
    });

    sigmaRef.current = sigma;

    sigma.on("clickNode", ({ node }) => {
      onNodeClick?.(node);
    });

    sigma.on("enterNode", ({ node }) => {
      setHoveredNode(node);
      onNodeHover?.(node);
      sigma.getContainer().style.cursor = "pointer";
    });

    sigma.on("leaveNode", () => {
      setHoveredNode(null);
      onNodeHover?.(null);
      sigma.getContainer().style.cursor = "default";
    });

    sigma.on("clickStage", () => {
      onNodeClick?.("");
    });

    return () => {
      sigma.kill();
      sigmaRef.current = null;
      graphRef.current = null;
    };
  }, [datasetKey, allNodes, allEdges, onNodeClick, onNodeHover]);

  // Update visibility when filters change
  useEffect(() => {
    const graph = graphRef.current;
    const sigma = sigmaRef.current;
    if (!graph || !sigma) return;

    graph.forEachNode((nodeId) => {
      const shouldShow = visibleSet.has(nodeId);
      graph.setNodeAttribute(nodeId, "hidden", !shouldShow);
    });

    graph.forEachEdge((edgeId, _attrs, source, target) => {
      const sourceHidden = graph.getNodeAttribute(source, "hidden");
      const targetHidden = graph.getNodeAttribute(target, "hidden");
      graph.setEdgeAttribute(edgeId, "hidden", !!(sourceHidden || targetHidden));
    });

    sigma.refresh();
  }, [visibleSet]);

  // Update selection styling
  useEffect(() => {
    const graph = graphRef.current;
    const sigma = sigmaRef.current;
    if (!graph || !sigma) return;

    graph.forEachNode((nodeId) => {
      const isSelected = nodeId === selectedNodeId;
      const deg = graph.degree(nodeId);
      const size = getNodeSize(deg);

      graph.setNodeAttribute(nodeId, "size", isSelected ? size * 1.5 : size);
      graph.setNodeAttribute(nodeId, "borderSize", isSelected ? 3 : 2);
      graph.setNodeAttribute(nodeId, "zIndex", isSelected ? 1 : 0);

      const nodeType = nodeTypeById.get(nodeId) ?? "default";
      graph.setNodeAttribute(nodeId, "color", isSelected ? "#ffffff" : getNodeColor(nodeType));
    });

    sigma.refresh();
  }, [selectedNodeId, nodeTypeById]);

  // Label culling: only show labels on selected, hovered, or high-degree (>= 5) nodes
  useEffect(() => {
    const graph = graphRef.current;
    const sigma = sigmaRef.current;
    if (!graph || !sigma) return;

    const labelTargets = new Set<string>();
    if (selectedNodeId) labelTargets.add(selectedNodeId);
    if (hoveredNode) labelTargets.add(hoveredNode);

    graph.forEachNode((nodeId) => {
      const deg = graph.degree(nodeId);
      const showLabel = labelTargets.has(nodeId) || deg >= 5;
      graph.setNodeAttribute(nodeId, "label", showLabel ? graph.getNodeAttribute(nodeId, "originalLabel") : "");
    });

    sigma.refresh();
  }, [selectedNodeId, hoveredNode]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{
        width: "100%",
        height: "100%",
        background: "#0a0f1a"
      }}
    />
  );
}
