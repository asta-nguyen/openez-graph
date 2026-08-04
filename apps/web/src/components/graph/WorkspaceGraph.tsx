"use client";

import { useEffect, useRef, useCallback } from "react";
import {
  forceSimulation,
  forceManyBody,
  forceLink,
  forceCenter,
  forceCollide,
  forceX,
  forceY,
  type Simulation,
  type SimulationNodeDatum,
} from "d3-force";
import { getNodeColor, getEdgeColor } from "../../lib/utils";

export interface GraphNodeData {
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

export interface GraphEdgeData {
  id: string;
  source: string;
  target: string;
  type: string;
  weight: number;
}

export interface WorkspaceGraphProps {
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
  selectedNodeId?: string | null;
  onNodeClick?: (nodeId: string) => void;
  onNodeHover?: (nodeId: string | null) => void;
  className?: string;
}

interface SimNode extends SimulationNodeDatum {
  id: string;
  label: string;
  type: string;
  degree: number;
  r: number;
}

interface SimEdge {
  source: SimNode;
  target: SimNode;
  type: string;
  weight: number;
}

function getNodeRadius(degree: number): number {
  return 4 + Math.min(Math.sqrt(degree) * 1.2, 10);
}

const BG_COLOR = "#1a1a2e";
const LABEL_COLOR = "#e0e0e0";

function fitTransform(nodes: SimNode[], width: number, height: number) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    if (node.x == null || node.y == null) continue;
    minX = Math.min(minX, node.x);
    maxX = Math.max(maxX, node.x);
    minY = Math.min(minY, node.y);
    maxY = Math.max(maxY, node.y);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, k: 1 };

  const k = Math.max(
    0.1,
    Math.min(
      4,
      Math.min((width - 80) / Math.max(1, maxX - minX), (height - 80) / Math.max(1, maxY - minY)),
    ),
  );

  return {
    x: width / 2 - ((minX + maxX) / 2) * k,
    y: height / 2 - ((minY + maxY) / 2) * k,
    k,
  };
}

export function WorkspaceGraph({
  nodes,
  edges,
  selectedNodeId,
  onNodeClick,
  onNodeHover,
  className = "",
}: WorkspaceGraphProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const simRef = useRef<Simulation<SimNode, SimEdge> | null>(null);
  const simNodesRef = useRef<SimNode[]>([]);
  const simEdgesRef = useRef<SimEdge[]>([]);
  const neighborSetRef = useRef<Set<string> | null>(null);
  const hoverNeighborSetRef = useRef<Set<string> | null>(null);

  // Pan & zoom state
  const transformRef = useRef({ x: 0, y: 0, k: 1 });
  const isPanningRef = useRef(false);
  const lastPanRef = useRef({ x: 0, y: 0 });
  const pointerStartRef = useRef({ x: 0, y: 0 });
  const movedRef = useRef(false);
  const hoveredRef = useRef<string | null>(null);
  const selectedRef = useRef<string | null>(selectedNodeId ?? null);
  const draggingNodeRef = useRef<SimNode | null>(null);
  const dirtyRef = useRef(true);
  const edgeBucketsRef = useRef<Map<string, SimEdge[]>>(new Map());

  // Stable callback refs
  const onClickRef = useRef(onNodeClick);
  onClickRef.current = onNodeClick;
  const onHoverRef = useRef(onNodeHover);
  onHoverRef.current = onNodeHover;
  selectedRef.current = selectedNodeId ?? null;

  // ── Build simulation when data changes ──
  useEffect(() => {
    if (nodes.length === 0) {
      simNodesRef.current = [];
      simEdgesRef.current = [];
      edgeBucketsRef.current = new Map();
      hoverNeighborSetRef.current = null;
      dirtyRef.current = true;
      simRef.current?.stop();
      simRef.current = null;
      return;
    }

    const index = new Map<string, number>();
    const simNodes: SimNode[] = nodes.map((n, i) => {
      index.set(n.id, i);
      return {
        id: n.id,
        label: n.label,
        type: n.type,
        degree: n.degree,
        r: getNodeRadius(n.degree),
      };
    });
    simNodesRef.current = simNodes;

    const simEdges: SimEdge[] = [];
    for (const e of edges) {
      const si = index.get(e.source);
      const ti = index.get(e.target);
      if (si === undefined || ti === undefined) continue;
      simEdges.push({
        source: simNodes[si],
        target: simNodes[ti],
        type: e.type,
        weight: e.weight,
      });
    }
    simEdgesRef.current = simEdges;

    // Cache edge color buckets — rebuilt only when edges change
    const buckets = new Map<string, SimEdge[]>();
    for (const e of simEdges) {
      const c = getEdgeColor(e.type);
      let bucket = buckets.get(c);
      if (!bucket) {
        bucket = [];
        buckets.set(c, bucket);
      }
      bucket.push(e);
    }
    edgeBucketsRef.current = buckets;

    const canvas = canvasRef.current;
    const w = canvas?.clientWidth || 800;
    const h = canvas?.clientHeight || 600;

    const largeGraph = simNodes.length > 5000;
    const sim = forceSimulation<SimNode>(simNodes)
      .force(
        "link",
        forceLink<SimNode, SimEdge>(simEdges)
          .id((d) => d.id)
          .distance((d) => 30 + 60 / Math.max(1, d.source.degree + d.target.degree))
          .strength(largeGraph ? 0.08 : 0.3),
      )
      .force(
        "charge",
        largeGraph ? null : forceManyBody().strength((d) => -30 - (d as SimNode).degree * 2),
      )
      .force("center", forceCenter(w / 2, h / 2))
      .force("x", largeGraph ? null : forceX(w / 2).strength(0.04))
      .force("y", largeGraph ? null : forceY(h / 2).strength(0.04))
      .force("collide", largeGraph ? null : forceCollide<SimNode>().radius((d) => d.r + 4))
      .alphaDecay(largeGraph ? 0.08 : 0.02);

    sim.on("tick.fit", () => {
      if (sim.alpha() < 0.35) {
        transformRef.current = fitTransform(simNodes, w, h);
        sim.on("tick.fit", null);
      }
    });
    sim.on("tick.dirty", () => {
      dirtyRef.current = true;
    });
    simRef.current = sim;
    dirtyRef.current = true;

    return () => {
      sim.stop();
    };
  }, [nodes, edges]);

  // ── Compute neighbor set for highlight ──
  useEffect(() => {
    if (!selectedNodeId) {
      neighborSetRef.current = null;
      dirtyRef.current = true;
      return;
    }
    const neighbors = new Set<string>([selectedNodeId]);
    for (const e of simEdgesRef.current) {
      if (e.source.id === selectedNodeId) neighbors.add(e.target.id);
      if (e.target.id === selectedNodeId) neighbors.add(e.source.id);
    }
    neighborSetRef.current = neighbors;
    dirtyRef.current = true;
  }, [selectedNodeId, nodes, edges]);

  // ── Render loop ──
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(devicePixelRatio, 2);
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;

    ctx.save();
    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, w, h);

    const { x: tx, y: ty, k: tk } = transformRef.current;
    ctx.translate(tx, ty);
    ctx.scale(tk, tk);

    const simNodes = simNodesRef.current;
    const simEdges = simEdgesRef.current;
    const sel = selectedRef.current;
    const hov = hoveredRef.current;
    const neighborSet = neighborSetRef.current;
    const hasHighlight = !!(sel || hov);
    const highlightId = sel || hov;
    const highlightSet = sel ? neighborSet : hoverNeighborSetRef.current;

    // ── Draw edges (batched: one path, one stroke) ──
    // Like the d3 example: batch all edges into a single beginPath/stroke.
    // For highlight, we do two passes: dim edges first, then connected edges on top.
    if (hasHighlight && highlightId) {
      // Pass 1: dim edges (all in one batch)
      ctx.save();
      ctx.globalAlpha = 0.03;
      ctx.strokeStyle = "#64748b";
      ctx.lineWidth = 1 / tk;
      ctx.beginPath();
      for (const e of simEdges) {
        const s = e.source;
        const t = e.target;
        if (s.x == null || s.y == null || t.x == null || t.y == null) continue;
        if (highlightSet?.has(s.id) && highlightSet?.has(t.id)) continue;
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(t.x, t.y);
      }
      ctx.stroke();
      ctx.restore();

      // Pass 2: connected edges, colored per type
      ctx.save();
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = 1.5 / tk;
      ctx.beginPath();
      for (const e of simEdges) {
        const s = e.source;
        const t = e.target;
        if (s.x == null || s.y == null || t.x == null || t.y == null) continue;
        if (!(highlightSet?.has(s.id) && highlightSet?.has(t.id))) continue;
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(t.x, t.y);
      }
      ctx.strokeStyle = getEdgeColor("default");
      ctx.stroke();
      ctx.restore();
    } else {
      // No highlight: single batched pass — colored by edge type (cached buckets)
      ctx.save();
      ctx.globalAlpha = 0.4;
      ctx.lineWidth = 1.2 / tk;
      for (const [color, bucketEdges] of edgeBucketsRef.current) {
        ctx.strokeStyle = color;
        ctx.beginPath();
        for (const e of bucketEdges) {
          const s = e.source;
          const t = e.target;
          if (s.x == null || s.y == null || t.x == null || t.y == null) continue;
          ctx.moveTo(s.x, s.y);
          ctx.lineTo(t.x, t.y);
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    // ── Draw nodes (batched: fill pass, then stroke pass) ──
    // Like the d3 example: iterate nodes, fill each circle, then stroke.
    // Glow for selected/hovered is drawn first as a separate pass.

    // Pass 0: glow for selected/hovered
    for (const n of simNodes) {
      if (n.x == null || n.y == null) continue;
      const isSel = n.id === sel;
      const isHov = n.id === hov;
      if (!isSel && !isHov) continue;

      const r = isSel ? n.r * 1.7 : n.r * 1.35;
      ctx.globalAlpha = isSel ? 0.35 : 0.22;
      ctx.fillStyle = getNodeColor(n.type);
      ctx.beginPath();
      ctx.arc(n.x, n.y, r * 2.8, 0, Math.PI * 2);
      ctx.fill();
    }

    // Pass 1: fill all nodes — fully opaque, bright colors
    for (const n of simNodes) {
      if (n.x == null || n.y == null) continue;
      const isSel = n.id === sel;
      const isHov = n.id === hov;
      const isConnected = !hasHighlight || (highlightSet?.has(n.id) ?? n.id === highlightId);

      let alpha = 1;
      if (hasHighlight && !isConnected) alpha = 0.1;

      const r = isSel ? n.r * 1.7 : isHov ? n.r * 1.35 : n.r;

      ctx.globalAlpha = alpha;
      ctx.fillStyle = getNodeColor(n.type);
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fill();

      // White stroke ring (like d3 example)
      ctx.globalAlpha = alpha * 0.8;
      ctx.strokeStyle = "rgba(255,255,255,0.3)";
      ctx.lineWidth = 1 / tk;
      ctx.stroke();

      // Stronger stroke for selected/hovered
      if (isSel || isHov) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = isSel ? "#ffffff" : getNodeColor(n.type);
        ctx.lineWidth = (isSel ? 2 : 1.5) / tk;
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    // ── Draw labels ──
    const hubThreshold = simNodes.length > 5000 ? 30 : simNodes.length > 1000 ? 8 : 3;
    const showAllLabels = tk > 1.8 && simNodes.length < 3000;
    ctx.font = `600 ${12 / tk}px system-ui, -apple-system, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    for (const n of simNodes) {
      if (n.x == null || n.y == null) continue;
      const isSel = n.id === sel;
      const isHov = n.id === hov;
      const isHub = n.degree >= hubThreshold;
      const isConnected = !hasHighlight || (highlightSet?.has(n.id) ?? n.id === highlightId);

      if (!(isSel || isHov || isHub || showAllLabels)) continue;
      if (hasHighlight && !isConnected && !isSel && !isHov) continue;

      const labelY = n.y - n.r - 8 / tk;
      const text = n.label.length > 48 ? `${n.label.slice(0, 45)}…` : n.label;
      ctx.globalAlpha = isConnected ? 0.9 : 0.3;
      ctx.lineJoin = "round";
      ctx.lineWidth = 3 / tk;
      ctx.strokeStyle = "rgba(23,23,23,0.95)";
      ctx.strokeText(text, n.x, labelY);
      ctx.fillStyle = isSel || isHov ? "#ffffff" : LABEL_COLOR;
      ctx.fillText(text, n.x, labelY);
      ctx.globalAlpha = 1;
    }

    ctx.restore();
    dirtyRef.current = false;
  }, []);

  // ── Animation + resize ──
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const resize = () => {
      const dpr = Math.min(devicePixelRatio, 2);
      const w = container.clientWidth;
      const h = container.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      dirtyRef.current = true;
    };
    resize();

    const ro = new ResizeObserver(resize);
    ro.observe(container);

    let raf = 0;
    let lastDraw = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (!dirtyRef.current) return;
      if (simNodesRef.current.length > 5000 && now - lastDraw < 33) return;
      lastDraw = now;
      draw();
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [draw]);

  // ── Hit testing ──
  const getNodeAt = useCallback((clientX: number, clientY: number): SimNode | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const { x: tx, y: ty, k: tk } = transformRef.current;
    const cx = (clientX - rect.left - tx) / tk;
    const cy = (clientY - rect.top - ty) / tk;

    const simNodes = simNodesRef.current;
    for (let i = simNodes.length - 1; i >= 0; i--) {
      const n = simNodes[i];
      if (n.x == null || n.y == null) continue;
      const dx = n.x - cx;
      const dy = n.y - cy;
      if (dx * dx + dy * dy <= (n.r + 3) * (n.r + 3)) return n;
    }
    return null;
  }, []);

  // ── Pointer events ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const cv = canvas;

    function onPointerDown(e: PointerEvent) {
      pointerStartRef.current = { x: e.clientX, y: e.clientY };
      movedRef.current = false;
      const node = getNodeAt(e.clientX, e.clientY);
      if (node) {
        draggingNodeRef.current = node;
        const sim = simRef.current;
        if (sim) {
          sim.alphaTarget(0.3).restart();
          node.fx = node.x;
          node.fy = node.y;
        }
        cv.setPointerCapture(e.pointerId);
      } else {
        isPanningRef.current = true;
        lastPanRef.current = { x: e.clientX, y: e.clientY };
        cv.setPointerCapture(e.pointerId);
      }
    }

    function onPointerMove(e: PointerEvent) {
      if (
        Math.hypot(e.clientX - pointerStartRef.current.x, e.clientY - pointerStartRef.current.y) > 3
      ) {
        movedRef.current = true;
      }

      if (draggingNodeRef.current) {
        const node = draggingNodeRef.current;
        const rect = cv.getBoundingClientRect();
        const { x: tx, y: ty, k: tk } = transformRef.current;
        node.fx = (e.clientX - rect.left - tx) / tk;
        node.fy = (e.clientY - rect.top - ty) / tk;
        dirtyRef.current = true;
        return;
      }

      if (isPanningRef.current) {
        const dx = e.clientX - lastPanRef.current.x;
        const dy = e.clientY - lastPanRef.current.y;
        transformRef.current.x += dx;
        transformRef.current.y += dy;
        lastPanRef.current = { x: e.clientX, y: e.clientY };
        dirtyRef.current = true;
        return;
      }

      const node = getNodeAt(e.clientX, e.clientY);
      const id = node?.id ?? null;
      if (id !== hoveredRef.current) {
        hoveredRef.current = id;
        const neighbors = id ? new Set<string>([id]) : null;
        if (neighbors) {
          for (const edge of simEdgesRef.current) {
            if (edge.source.id === id) neighbors.add(edge.target.id);
            if (edge.target.id === id) neighbors.add(edge.source.id);
          }
        }
        hoverNeighborSetRef.current = neighbors;
        onHoverRef.current?.(id);
        cv.style.cursor = id ? "pointer" : "default";
        dirtyRef.current = true;
      }
    }

    function onPointerUp(e: PointerEvent) {
      if (draggingNodeRef.current) {
        const node = draggingNodeRef.current;
        const sim = simRef.current;
        if (sim) sim.alphaTarget(0);
        node.fx = null;
        node.fy = null;
        draggingNodeRef.current = null;
      }
      isPanningRef.current = false;
      if (cv.hasPointerCapture(e.pointerId)) {
        cv.releasePointerCapture(e.pointerId);
      }
    }

    function onClick(e: MouseEvent) {
      if (movedRef.current) return;
      const node = getNodeAt(e.clientX, e.clientY);
      onClickRef.current?.(node?.id ?? "");
    }

    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const rect = cv.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const { x: tx, y: ty, k: tk } = transformRef.current;
      const delta = -e.deltaY * 0.001;
      const newK = Math.max(0.1, Math.min(8, tk * Math.exp(delta)));
      const ratio = newK / tk;
      transformRef.current.x = mx - (mx - tx) * ratio;
      transformRef.current.y = my - (my - ty) * ratio;
      transformRef.current.k = newK;
      dirtyRef.current = true;
    }

    cv.addEventListener("pointerdown", onPointerDown);
    cv.addEventListener("pointermove", onPointerMove);
    cv.addEventListener("pointerup", onPointerUp);
    cv.addEventListener("click", onClick);
    cv.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      cv.removeEventListener("pointerdown", onPointerDown);
      cv.removeEventListener("pointermove", onPointerMove);
      cv.removeEventListener("pointerup", onPointerUp);
      cv.removeEventListener("click", onClick);
      cv.removeEventListener("wheel", onWheel);
    };
  }, [getNodeAt]);

  const zoomIn = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = rect.width / 2;
    const my = rect.height / 2;
    const { x: tx, y: ty, k: tk } = transformRef.current;
    const newK = Math.min(8, tk * 1.3);
    const ratio = newK / tk;
    transformRef.current.x = mx - (mx - tx) * ratio;
    transformRef.current.y = my - (my - ty) * ratio;
    transformRef.current.k = newK;
    dirtyRef.current = true;
  }, []);

  const zoomOut = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = rect.width / 2;
    const my = rect.height / 2;
    const { x: tx, y: ty, k: tk } = transformRef.current;
    const newK = Math.max(0.1, tk / 1.3);
    const ratio = newK / tk;
    transformRef.current.x = mx - (mx - tx) * ratio;
    transformRef.current.y = my - (my - ty) * ratio;
    transformRef.current.k = newK;
    dirtyRef.current = true;
  }, []);

  const resetView = useCallback(() => {
    const canvas = canvasRef.current;
    if (canvas) {
      transformRef.current = fitTransform(
        simNodesRef.current,
        canvas.clientWidth,
        canvas.clientHeight,
      );
      dirtyRef.current = true;
    }
  }, []);

  return (
    <div
      ref={containerRef}
      style={{ position: "relative", width: "100%", height: "100%" }}
      className={className}
    >
      <canvas
        ref={canvasRef}
        style={{
          width: "100%",
          height: "100%",
          display: "block",
          cursor: "default",
          touchAction: "none",
        }}
      />
      <div
        style={{
          position: "absolute",
          bottom: 12,
          right: 12,
          display: "flex",
          flexDirection: "column",
          gap: 2,
        }}
      >
        <button
          onClick={zoomIn}
          aria-label="Zoom in"
          style={zoomBtnStyle}
          onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.12)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(0,0,0,0.5)")}
        >
          +
        </button>
        <button
          onClick={zoomOut}
          aria-label="Zoom out"
          style={zoomBtnStyle}
          onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.12)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(0,0,0,0.5)")}
        >
          −
        </button>
        <button
          onClick={resetView}
          aria-label="Fit graph to view"
          style={zoomBtnStyle}
          onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.12)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(0,0,0,0.5)")}
        >
          ⛶
        </button>
      </div>
    </div>
  );
}

const zoomBtnStyle: React.CSSProperties = {
  width: 32,
  height: 32,
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 6,
  background: "rgba(0,0,0,0.5)",
  color: "#fff",
  fontSize: 18,
  lineHeight: 1,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  backdropFilter: "blur(8px)",
};
