"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import Graph from "graphology";
import Sigma from "sigma";
import forceAtlas2 from "graphology-layout-forceatlas2";
import type { GraphNodeData, GraphEdgeData } from "../../app/workspaces/[workspaceId]/graph/actions";

export interface WorkspaceGraphProps {
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
  selectedNodeId?: string | null;
  onNodeClick?: (nodeId: string) => void;
  onNodeHover?: (nodeId: string | null) => void;
  className?: string;
}

// Color palette for node types
const NODE_COLORS: Record<string, string> = {
  file: "#60a5fa",      // blue
  chunk: "#34d399",    // green
  symbol: "#fbbf24",    // yellow
  memory: "#f472b6",    // pink
  entity: "#c084fc",    // purple
  document: "#22d3ee",  // cyan
  default: "#94a3b8"    // slate
};

// Color for edge types
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
  // Min size 5, max size 20, based on degree
  const base = 5;
  const scale = Math.min(degree * 0.5, 15);
  return base + scale;
}

export function WorkspaceGraph({
  nodes,
  edges,
  selectedNodeId,
  onNodeClick,
  onNodeHover,
  className = ""
}: WorkspaceGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const graphRef = useRef<Graph | null>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);

  // Build graph
  const buildGraph = useCallback(() => {
    const graph = new Graph();

    // Add nodes
    for (const node of nodes) {
      const size = getNodeSize(node.degree);
      const color = getNodeColor(node.type);
      const isSelected = node.id === selectedNodeId;

      graph.addNode(node.id, {
        label: node.label,
        x: Math.random() * 100 - 50,
        y: Math.random() * 100 - 50,
        size: isSelected ? size * 1.5 : size,
        color: isSelected ? "#ffffff" : color,
        colorBorder: color,
        borderSize: isSelected ? 3 : 2,
        labelSize: isSelected ? 14 : 12,
        labelColor: "#e2e8f0",
        zIndex: isSelected ? 1 : 0
      });
    }

    // Add edges
    for (const edge of edges) {
      if (graph.hasNode(edge.source) && graph.hasNode(edge.target)) {
        const color = getEdgeColor(edge.type);
        graph.addEdge(edge.source, edge.target, {
          type: "line",
          edgeKind: edge.type,
          weight: edge.weight,
          color: color,
          size: Math.max(0.5, Math.min(edge.weight, 2)),
          zIndex: -1
        });
      }
    }

    // Run ForceAtlas2 layout
    if (graph.order > 0) {
      const settings = forceAtlas2.inferSettings(graph);
      forceAtlas2.assign(graph, {
        iterations: 100,
        settings
      });
    }

    return graph;
  }, [nodes, edges, selectedNodeId]);

  // Initialize Sigma
  useEffect(() => {
    if (!containerRef.current) return;

    const graph = buildGraph();
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

    // Node click handler
    sigma.on("clickNode", ({ node }) => {
      onNodeClick?.(node);
    });

    // Node hover handler
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

    // Stage click handler (deselect)
    sigma.on("clickStage", () => {
      onNodeClick?.("");
    });

    return () => {
      sigma.kill();
      sigmaRef.current = null;
      graphRef.current = null;
    };
  }, [buildGraph, onNodeClick, onNodeHover]);

  // Update node styles when selection changes
  useEffect(() => {
    const graph = graphRef.current;
    const sigma = sigmaRef.current;
    if (!graph || !sigma) return;

    graph.forEachNode((nodeId, attrs) => {
      const isSelected = nodeId === selectedNodeId;
      const degree = graph.degree(nodeId);
      const size = getNodeSize(degree);

      graph.setNodeAttribute(nodeId, "size", isSelected ? size * 1.5 : size);
      graph.setNodeAttribute(nodeId, "color", isSelected ? "#ffffff" : getNodeColor(attrs.colorBorder || "default"));
      graph.setNodeAttribute(nodeId, "borderSize", isSelected ? 3 : 2);
      graph.setNodeAttribute(nodeId, "zIndex", isSelected ? 1 : 0);
    });

    sigma.refresh();
  }, [selectedNodeId]);

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
