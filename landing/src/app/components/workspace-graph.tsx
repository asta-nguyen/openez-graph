"use client";

// Trimmed port of apps/web/src/components/graph/WorkspaceGraph.tsx so the landing page shows the
// same renderer as the real Graph Explorer: canvas 2D, d3-force layout, same colors and radii.
// Differences: no inspector, and the wheel zooms only with Ctrl/⌘ (plain scroll keeps scrolling the page).

import { useCallback, useEffect, useRef } from "react";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationNodeDatum,
} from "d3-force";

export const NODE_COLORS: Record<string, string> = {
  file: "#60a5fa",
  symbol: "#fbbf24",
  default: "#94a3b8",
};

export const EDGE_COLORS: Record<string, string> = {
  imports: "#60a5fa",
  defines: "#fbbf24",
  calls: "#f97316",
  default: "#64748b",
};

const nodeColor = (type: string) => NODE_COLORS[type] ?? NODE_COLORS.default;
const edgeColor = (type: string) => EDGE_COLORS[type] ?? EDGE_COLORS.default;

export interface GraphNode {
  id: string;
  label: string;
  type: string;
  degree: number;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
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
}

const BG_COLOR = "#1a1a2e";
const LABEL_COLOR = "#e0e0e0";
// The real UI scales this with node count (3 below 1,000 nodes, 8 above); this sample stands in for
// a 1,393-node graph, so only the most connected nodes are labelled until the user zooms in.
const hubDegree = (canvasWidth: number) => (canvasWidth < 500 ? 8 : 6);

const radius = (degree: number) => 4 + Math.min(Math.sqrt(degree) * 1.2, 10);

function fitTransform(nodes: SimNode[], width: number, height: number, insetLeft: number) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    if (n.x == null || n.y == null) continue;
    minX = Math.min(minX, n.x);
    maxX = Math.max(maxX, n.x);
    minY = Math.min(minY, n.y);
    maxY = Math.max(maxY, n.y);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, k: 1 };

  const usable = width - insetLeft;
  const k = Math.max(
    0.1,
    Math.min(
      4,
      Math.min((usable - 80) / Math.max(1, maxX - minX), (height - 80) / Math.max(1, maxY - minY)),
    ),
  );
  return {
    x: insetLeft + usable / 2 - ((minX + maxX) / 2) * k,
    y: height / 2 - ((minY + maxY) / 2) * k,
    k,
  };
}

const neighborsOf = (id: string, edges: SimEdge[]) => {
  const set = new Set<string>([id]);
  for (const e of edges) {
    if (e.source.id === id) set.add(e.target.id);
    if (e.target.id === id) set.add(e.source.id);
  }
  return set;
};

interface Props {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedNodeId: string | null;
  onNodeClick: (nodeId: string | null) => void;
  /** Width of a panel overlaying the left edge from the `sm` breakpoint up; the fit avoids it. */
  overlayWidth?: number;
}

export function WorkspaceGraph({
  nodes,
  edges,
  selectedNodeId,
  onNodeClick,
  overlayWidth = 0,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const simRef = useRef<Simulation<SimNode, SimEdge> | null>(null);
  const simNodesRef = useRef<SimNode[]>([]);
  const simEdgesRef = useRef<SimEdge[]>([]);
  const edgeBucketsRef = useRef<Map<string, SimEdge[]>>(new Map());
  const selectedSetRef = useRef<Set<string> | null>(null);
  const hoverSetRef = useRef<Set<string> | null>(null);

  const transformRef = useRef({ x: 0, y: 0, k: 1 });
  const panningRef = useRef(false);
  const lastPanRef = useRef({ x: 0, y: 0 });
  const pointerStartRef = useRef({ x: 0, y: 0 });
  const movedRef = useRef(false);
  const hoveredRef = useRef<string | null>(null);
  const selectedRef = useRef<string | null>(selectedNodeId);
  const draggingRef = useRef<SimNode | null>(null);
  const dirtyRef = useRef(true);

  const onClickRef = useRef(onNodeClick);
  onClickRef.current = onNodeClick;
  selectedRef.current = selectedNodeId;
  const insetLeft = useCallback(
    () => (window.matchMedia("(min-width: 640px)").matches ? overlayWidth : 0),
    [overlayWidth],
  );

  // ── Build the simulation when the data changes ──
  useEffect(() => {
    if (nodes.length === 0) {
      simNodesRef.current = [];
      simEdgesRef.current = [];
      edgeBucketsRef.current = new Map();
      hoverSetRef.current = null;
      dirtyRef.current = true;
      simRef.current?.stop();
      simRef.current = null;
      return;
    }

    const index = new Map<string, SimNode>();
    const simNodes: SimNode[] = nodes.map((n) => {
      const node = { ...n, r: radius(n.degree) };
      index.set(n.id, node);
      return node;
    });
    simNodesRef.current = simNodes;

    const simEdges: SimEdge[] = [];
    for (const e of edges) {
      const source = index.get(e.source);
      const target = index.get(e.target);
      if (source && target) simEdges.push({ source, target, type: e.type });
    }
    simEdgesRef.current = simEdges;

    const buckets = new Map<string, SimEdge[]>();
    for (const e of simEdges) {
      const c = edgeColor(e.type);
      const bucket = buckets.get(c);
      if (bucket) bucket.push(e);
      else buckets.set(c, [e]);
    }
    edgeBucketsRef.current = buckets;

    const canvas = canvasRef.current;
    const w = canvas?.clientWidth || 800;
    const h = canvas?.clientHeight || 600;

    const sim = forceSimulation<SimNode>(simNodes)
      .force(
        "link",
        forceLink<SimNode, SimEdge>(simEdges)
          .id((d) => d.id)
          .distance((d) => 30 + 60 / Math.max(1, d.source.degree + d.target.degree))
          .strength(0.3),
      )
      .force(
        "charge",
        forceManyBody().strength((d) => -30 - (d as SimNode).degree * 2),
      )
      .force("center", forceCenter(w / 2, h / 2))
      .force("x", forceX(w / 2).strength(0.04))
      .force("y", forceY(h / 2).strength(0.04))
      .force(
        "collide",
        forceCollide<SimNode>().radius((d) => d.r + 4),
      )
      .alphaDecay(0.02);

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      // settle instantly instead of animating the layout
      sim.stop();
      sim.tick(300);
      transformRef.current = fitTransform(simNodes, w, h, insetLeft());
    } else {
      sim.on("tick.fit", () => {
        if (sim.alpha() < 0.35) {
          transformRef.current = fitTransform(simNodes, w, h, insetLeft());
          sim.on("tick.fit", null);
        }
      });
    }
    sim.on("tick.dirty", () => {
      dirtyRef.current = true;
    });
    simRef.current = sim;
    dirtyRef.current = true;

    return () => {
      sim.stop();
    };
  }, [nodes, edges, insetLeft]);

  // ── Highlight the selected node's neighbors ──
  useEffect(() => {
    selectedSetRef.current = selectedNodeId
      ? neighborsOf(selectedNodeId, simEdgesRef.current)
      : null;
    dirtyRef.current = true;
  }, [selectedNodeId, nodes, edges]);

  // ── Draw ──
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const dpr = Math.min(devicePixelRatio, 2);
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;

    ctx.save();
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, w, h);

    const { x: tx, y: ty, k: tk } = transformRef.current;
    ctx.translate(tx, ty);
    ctx.scale(tk, tk);

    const simNodes = simNodesRef.current;
    const simEdges = simEdgesRef.current;
    const sel = selectedRef.current;
    const hov = hoveredRef.current;
    const highlightId = sel || hov;
    const highlightSet = sel ? selectedSetRef.current : hoverSetRef.current;
    const lit = (e: SimEdge) =>
      !!(highlightSet?.has(e.source.id) && highlightSet?.has(e.target.id));

    if (highlightId) {
      // dim everything, then redraw the connected edges on top
      ctx.save();
      ctx.globalAlpha = 0.03;
      ctx.strokeStyle = "#64748b";
      ctx.lineWidth = 1 / tk;
      ctx.beginPath();
      for (const e of simEdges) {
        if (e.source.x == null || e.source.y == null || e.target.x == null || e.target.y == null)
          continue;
        if (lit(e)) continue;
        ctx.moveTo(e.source.x, e.source.y);
        ctx.lineTo(e.target.x, e.target.y);
      }
      ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = 1.5 / tk;
      ctx.strokeStyle = EDGE_COLORS.default;
      ctx.beginPath();
      for (const e of simEdges) {
        if (e.source.x == null || e.source.y == null || e.target.x == null || e.target.y == null)
          continue;
        if (!lit(e)) continue;
        ctx.moveTo(e.source.x, e.source.y);
        ctx.lineTo(e.target.x, e.target.y);
      }
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.save();
      ctx.globalAlpha = 0.4;
      ctx.lineWidth = 1.2 / tk;
      for (const [color, bucket] of edgeBucketsRef.current) {
        ctx.strokeStyle = color;
        ctx.beginPath();
        for (const e of bucket) {
          if (e.source.x == null || e.source.y == null || e.target.x == null || e.target.y == null)
            continue;
          ctx.moveTo(e.source.x, e.source.y);
          ctx.lineTo(e.target.x, e.target.y);
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    // glow behind the selected / hovered node
    for (const n of simNodes) {
      if (n.x == null || n.y == null || (n.id !== sel && n.id !== hov)) continue;
      const isSel = n.id === sel;
      ctx.globalAlpha = isSel ? 0.35 : 0.22;
      ctx.fillStyle = nodeColor(n.type);
      ctx.beginPath();
      ctx.arc(n.x, n.y, (isSel ? n.r * 1.7 : n.r * 1.35) * 2.8, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const n of simNodes) {
      if (n.x == null || n.y == null) continue;
      const isSel = n.id === sel;
      const isHov = n.id === hov;
      const connected = !highlightId || (highlightSet?.has(n.id) ?? n.id === highlightId);
      const alpha = connected ? 1 : 0.1;
      const r = isSel ? n.r * 1.7 : isHov ? n.r * 1.35 : n.r;

      ctx.globalAlpha = alpha;
      ctx.fillStyle = nodeColor(n.type);
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalAlpha = alpha * 0.8;
      ctx.strokeStyle = "rgba(255,255,255,0.3)";
      ctx.lineWidth = 1 / tk;
      ctx.stroke();

      if (isSel || isHov) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = isSel ? "#ffffff" : nodeColor(n.type);
        ctx.lineWidth = (isSel ? 2 : 1.5) / tk;
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    // labels: hubs always, everything once zoomed in
    const showAll = tk > 1.8;
    const hub = hubDegree(w);
    ctx.font = `600 ${12 / tk}px system-ui, -apple-system, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const n of simNodes) {
      if (n.x == null || n.y == null) continue;
      const isSel = n.id === sel;
      const isHov = n.id === hov;
      const connected = !highlightId || (highlightSet?.has(n.id) ?? n.id === highlightId);
      if (!(isSel || isHov || n.degree >= hub || showAll)) continue;
      if (highlightId && !connected && !isSel && !isHov) continue;

      const y = n.y - n.r - 8 / tk;
      const text = n.label.length > 48 ? `${n.label.slice(0, 45)}…` : n.label;
      ctx.globalAlpha = connected ? 0.9 : 0.3;
      ctx.lineJoin = "round";
      ctx.lineWidth = 3 / tk;
      ctx.strokeStyle = "rgba(23,23,23,0.95)";
      ctx.strokeText(text, n.x, y);
      ctx.fillStyle = isSel || isHov ? "#ffffff" : LABEL_COLOR;
      ctx.fillText(text, n.x, y);
      ctx.globalAlpha = 1;
    }

    ctx.restore();
    dirtyRef.current = false;
  }, []);

  // ── Resize + render loop ──
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
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      canvas.getContext("2d")?.setTransform(dpr, 0, 0, dpr, 0, 0);
      dirtyRef.current = true;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (dirtyRef.current) draw();
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [draw]);

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

  const zoomBy = useCallback((factor: number, mx?: number, my?: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = mx ?? rect.width / 2;
    const py = my ?? rect.height / 2;
    const { x: tx, y: ty, k: tk } = transformRef.current;
    const k = Math.max(0.1, Math.min(8, tk * factor));
    const ratio = k / tk;
    transformRef.current = { x: px - (px - tx) * ratio, y: py - (py - ty) * ratio, k };
    dirtyRef.current = true;
  }, []);

  const resetView = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    transformRef.current = fitTransform(
      simNodesRef.current,
      canvas.clientWidth,
      canvas.clientHeight,
      insetLeft(),
    );
    dirtyRef.current = true;
  }, [insetLeft]);

  // ── Pointer + wheel ──
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;

    function onPointerDown(e: PointerEvent) {
      pointerStartRef.current = { x: e.clientX, y: e.clientY };
      movedRef.current = false;
      const node = getNodeAt(e.clientX, e.clientY);
      if (node) {
        draggingRef.current = node;
        simRef.current?.alphaTarget(0.3).restart();
        node.fx = node.x;
        node.fy = node.y;
      } else {
        panningRef.current = true;
        lastPanRef.current = { x: e.clientX, y: e.clientY };
      }
      cv!.setPointerCapture(e.pointerId);
    }

    function onPointerMove(e: PointerEvent) {
      if (
        Math.hypot(e.clientX - pointerStartRef.current.x, e.clientY - pointerStartRef.current.y) > 3
      ) {
        movedRef.current = true;
      }

      const dragged = draggingRef.current;
      if (dragged) {
        const rect = cv!.getBoundingClientRect();
        const { x: tx, y: ty, k: tk } = transformRef.current;
        dragged.fx = (e.clientX - rect.left - tx) / tk;
        dragged.fy = (e.clientY - rect.top - ty) / tk;
        dirtyRef.current = true;
        return;
      }

      if (panningRef.current) {
        transformRef.current.x += e.clientX - lastPanRef.current.x;
        transformRef.current.y += e.clientY - lastPanRef.current.y;
        lastPanRef.current = { x: e.clientX, y: e.clientY };
        dirtyRef.current = true;
        return;
      }

      const id = getNodeAt(e.clientX, e.clientY)?.id ?? null;
      if (id !== hoveredRef.current) {
        hoveredRef.current = id;
        hoverSetRef.current = id ? neighborsOf(id, simEdgesRef.current) : null;
        cv!.style.cursor = id ? "pointer" : "default";
        dirtyRef.current = true;
      }
    }

    function onPointerEnd(e: PointerEvent) {
      const dragged = draggingRef.current;
      if (dragged) {
        simRef.current?.alphaTarget(0);
        dragged.fx = null;
        dragged.fy = null;
        draggingRef.current = null;
      }
      panningRef.current = false;
      if (cv!.hasPointerCapture(e.pointerId)) cv!.releasePointerCapture(e.pointerId);
    }

    function onClick(e: MouseEvent) {
      if (movedRef.current) return;
      onClickRef.current(getNodeAt(e.clientX, e.clientY)?.id ?? null);
    }

    function onWheel(e: WheelEvent) {
      if (!e.ctrlKey && !e.metaKey) return; // plain scroll keeps scrolling the page
      e.preventDefault();
      const rect = cv!.getBoundingClientRect();
      zoomBy(Math.exp(-e.deltaY * 0.001), e.clientX - rect.left, e.clientY - rect.top);
    }

    cv.addEventListener("pointerdown", onPointerDown);
    cv.addEventListener("pointermove", onPointerMove);
    cv.addEventListener("pointerup", onPointerEnd);
    cv.addEventListener("pointercancel", onPointerEnd);
    cv.addEventListener("click", onClick);
    cv.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      cv.removeEventListener("pointerdown", onPointerDown);
      cv.removeEventListener("pointermove", onPointerMove);
      cv.removeEventListener("pointerup", onPointerEnd);
      cv.removeEventListener("pointercancel", onPointerEnd);
      cv.removeEventListener("click", onClick);
      cv.removeEventListener("wheel", onWheel);
    };
  }, [getNodeAt, zoomBy]);

  const buttons = [
    { label: "Zoom in", glyph: "+", onClick: () => zoomBy(1.3) },
    { label: "Zoom out", glyph: "−", onClick: () => zoomBy(1 / 1.3) },
    { label: "Fit graph to view", glyph: "⛶", onClick: resetView },
  ];

  return (
    <div ref={containerRef} className="relative h-full w-full">
      <canvas
        ref={canvasRef}
        className="block h-full w-full"
        // pan-y: vertical swipes still scroll the page on touch screens
        style={{ cursor: "default", touchAction: "pan-y" }}
      />
      <div className="absolute bottom-3 right-3 flex flex-col gap-0.5">
        {buttons.map((b) => (
          <button
            key={b.label}
            type="button"
            onClick={b.onClick}
            aria-label={b.label}
            className="flex size-8 items-center justify-center rounded-md border border-white/10 bg-black/50 text-lg leading-none text-white backdrop-blur-sm transition-colors hover:bg-white/10"
          >
            {b.glyph}
          </button>
        ))}
      </div>
    </div>
  );
}
