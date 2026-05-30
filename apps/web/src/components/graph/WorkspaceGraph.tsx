"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import Graph from "graphology";
import Sigma from "sigma";
import forceAtlas2 from "graphology-layout-forceatlas2";
import type { GraphNodeData, GraphEdgeData } from "../../app/workspaces/[workspaceId]/graph/actions";
import { getNodeColor, getEdgeColor } from "../../lib/utils";

export interface WorkspaceGraphProps {
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
  selectedNodeId?: string | null;
  onNodeClick?: (nodeId: string) => void;
  onNodeHover?: (nodeId: string | null) => void;
  className?: string;
}

function getNodeSize(degree: number): number {
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
  const positionCacheRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);

  const nodeTypeById = useMemo(() => {
    const map = new Map<string, string>();
    for (const node of nodes) {
      map.set(node.id, node.type);
    }
    return map;
  }, [nodes]);

  const datasetKey = `${nodes.length}-${edges.length}`;

  // Build graph once per dataset
  useEffect(() => {
    if (!containerRef.current) return;

    const graph = new Graph({ multi: true, type: "directed" });
    const cache = positionCacheRef.current;

    for (const node of nodes) {
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
        labelColor: "#e2f8f0",
        zIndex: 0,
      });
    }

    for (const edge of edges) {
      if (graph.hasNode(edge.source) && graph.hasNode(edge.target)) {
        graph.addEdge(edge.source, edge.target, {
          type: "line",
          edgeKind: edge.type,
          weight: edge.weight,
          color: getEdgeColor(edge.type),
          size: Math.max(0.5, Math.min(edge.weight, 2)),
          zIndex: -1,
        });
      }
    }

    if (graph.order > 0) {
      const settings = forceAtlas2.inferSettings(graph);
      forceAtlas2.assign(graph, {
        iterations: 20,
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
      labelColor: { color: "#e2f8f0" },
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
  }, [datasetKey, nodes, edges, onNodeClick, onNodeHover]);

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
