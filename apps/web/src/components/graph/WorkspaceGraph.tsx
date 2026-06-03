"use client";

import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
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

function getNodeSize(degree: number): number {
  return 5 + Math.min(degree * 0.5, 15);
}

// ── Canvas texture helpers ──────────────────────────────────────────

function makeNodeCanvas(color: string): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext("2d")!;
  const cx = 32, cy = 32, r = 28;

  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  g.addColorStop(0, "#ffffff");
  g.addColorStop(0.1, color);
  g.addColorStop(0.55, color);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  return c;
}

function makeLabelCanvas(text: string): { canvas: HTMLCanvasElement; scale: number } {
  const ctx = document.createElement("canvas").getContext("2d")!;
  const fontSize = 13;
  ctx.font = `600 ${fontSize}px system-ui, -apple-system, sans-serif`;
  const textWidth = ctx.measureText(text).width;
  const px = 8, py = 4;
  const w = textWidth + px * 2;
  const h = fontSize + py * 2;

  ctx.canvas.width = w;
  ctx.canvas.height = h;
  ctx.font = `600 ${fontSize}px system-ui, -apple-system, sans-serif`;

  ctx.fillStyle = "rgba(0,0,0,0.75)";
  const rr = 4;
  ctx.beginPath();
  ctx.moveTo(rr, 0);
  ctx.lineTo(w - rr, 0);
  ctx.quadraticCurveTo(w, 0, w, rr);
  ctx.lineTo(w, h - rr);
  ctx.quadraticCurveTo(w, h, w - rr, h);
  ctx.lineTo(rr, h);
  ctx.quadraticCurveTo(0, h, 0, h - rr);
  ctx.lineTo(0, rr);
  ctx.quadraticCurveTo(0, 0, rr, 0);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "#e2f8f0";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, w / 2, h / 2);

  return { canvas: ctx.canvas, scale: 0.25 };
}

// ── Circular layout ──────────────────────────────────────────────────

function computeLayout(
  nodes: GraphNodeData[],
  _edges: GraphEdgeData[],
  _cache: Map<string, { x: number; y: number }>,
): Float64Array {
  const n = nodes.length;
  const pos = new Float64Array(n * 3);
  if (n === 0) return pos;

  const radius = Math.max(25, Math.min(n * 2.5, 100));
  const maxDeg = Math.max(1, ...nodes.map((x) => x.degree));

  // Fibonacci sphere — evenly distributes points on a sphere surface
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const theta = goldenAngle * i;
    const lift = (nodes[i].degree / maxDeg) * radius * 0.15;
    const sr = radius + lift;
    pos[i * 3]     = sr * r * Math.cos(theta);
    pos[i * 3 + 1] = sr * y;
    pos[i * 3 + 2] = sr * r * Math.sin(theta);
  }

  return pos;
}

// ── Component ───────────────────────────────────────────────────────

export function WorkspaceGraph({
  nodes,
  edges,
  selectedNodeId,
  onNodeClick,
  onNodeHover,
  className = "",
}: WorkspaceGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const posCacheRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const nodeSpritesRef = useRef<Map<string, THREE.Sprite>>(new Map());
  const labelSpritesRef = useRef<Map<string, THREE.Sprite>>(new Map());
  const raycasterRef = useRef(new THREE.Raycaster());
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);

  // Stable refs for event handler closures
  const selectedRef = useRef(selectedNodeId);
  selectedRef.current = selectedNodeId;
  const onClickRef = useRef(onNodeClick);
  onClickRef.current = onNodeClick;
  const onHoverRef = useRef(onNodeHover);
  onHoverRef.current = onNodeHover;

  const nodeTypeById = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of nodes) m.set(n.id, n.type);
    return m;
  }, [nodes]);

  const dataKey =
    nodes.length > 0
      ? nodes.map((n) => `${n.id}:${n.degree}`).join("|") +
        "||" +
        edges.map((e) => `${e.source}>${e.target}:${e.type}`).join("|")
      : "empty";

  // ─── Init scene ───────────────────────────────────────────────────

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const w = container.clientWidth || 800;
    const h = container.clientHeight || 600;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0f1a);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000);
    camera.position.set(60, 40, 80);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(w, h);
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controls.minDistance = 10;
    controls.maxDistance = 500;
    controlsRef.current = controls;

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height);
      }
    });
    ro.observe(container);

    let raf = 0;
    function animate() {
      raf = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    }
    animate();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  // ─── Build graph ──────────────────────────────────────────────────

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    // Remove all children (keep scene itself)
    while (scene.children.length > 0) {
      const child = scene.children[0];
      scene.remove(child);
      if (child instanceof THREE.Sprite) {
        child.material.dispose();
        if (child.material.map) child.material.map.dispose();
      }
      if (child instanceof THREE.LineSegments) {
        child.geometry.dispose();
        child.material.dispose();
      }
    }
    nodeSpritesRef.current.clear();
    labelSpritesRef.current.clear();

    if (nodes.length === 0) return;

    const positions = computeLayout(nodes, edges, posCacheRef.current);

    // ── Edge lines ──
    if (edges.length > 0) {
      const edgePositions: number[] = [];
      const edgeColors: number[] = [];
      const idxMap = new Map<string, number>();
      nodes.forEach((n, i) => idxMap.set(n.id, i));

      for (const edge of edges) {
        const si = idxMap.get(edge.source);
        const ti = idxMap.get(edge.target);
        if (si === undefined || ti === undefined) continue;
        const sx = positions[si * 3], sy = positions[si * 3 + 1], sz = positions[si * 3 + 2];
        const tx = positions[ti * 3], ty = positions[ti * 3 + 1], tz = positions[ti * 3 + 2];
        edgePositions.push(sx, sy, sz, tx, ty, tz);

        const c = new THREE.Color(getEdgeColor(edge.type));
        edgeColors.push(c.r, c.g, c.b, c.r, c.g, c.b);
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(edgePositions, 3));
      geo.setAttribute("color", new THREE.Float32BufferAttribute(edgeColors, 3));

      const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.35 });
      scene.add(new THREE.LineSegments(geo, mat));
    }

    // ── Node sprites ──
    const nodeTexCache = new Map<string, THREE.CanvasTexture>();
    const nodeSprites = new Map<string, THREE.Sprite>();

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
      const color = getNodeColor(node.type);
      const size = getNodeSize(node.degree);

      let tex = nodeTexCache.get(color);
      if (!tex) {
        tex = new THREE.CanvasTexture(makeNodeCanvas(color));
        tex.needsUpdate = true;
        nodeTexCache.set(color, tex);
      }

      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, sizeAttenuation: true });
      const sprite = new THREE.Sprite(mat);
      const s = size * 0.7;
      sprite.scale.set(s, s, 1);
      sprite.position.set(x, y, z);
      sprite.userData.nodeId = node.id;
      sprite.userData.degree = node.degree;
      scene.add(sprite);
      nodeSprites.set(node.id, sprite);
    }
    nodeSpritesRef.current = nodeSprites;

    // ── Label sprites ──
    const labelSprites = new Map<string, THREE.Sprite>();
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
      const size = getNodeSize(node.degree);

      const { canvas, scale: labelScale } = makeLabelCanvas(node.label);
      const tex = new THREE.CanvasTexture(canvas);
      tex.needsUpdate = true;

      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, sizeAttenuation: true });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(canvas.width * labelScale, canvas.height * labelScale, 1);
      sprite.position.set(x, y - size * 0.5 - 4, z);
      sprite.userData.nodeId = node.id;
      sprite.userData.isLabel = true;
      sprite.visible = node.degree >= 5;
      scene.add(sprite);
      labelSprites.set(node.id, sprite);
    }
    labelSpritesRef.current = labelSprites;
  }, [dataKey, nodes, edges]);

  // ─── Selection / highlight updates ────────────────────────────────

  useEffect(() => {
    const nodeSprites = nodeSpritesRef.current;
    const labelSprites = labelSpritesRef.current;

    for (const [id, sprite] of nodeSprites) {
      const isSel = id === selectedNodeId;
      const deg = sprite.userData.degree ?? 0;
      const base = getNodeSize(deg) * 0.7;
      sprite.scale.set(isSel ? base * 1.4 : base, isSel ? base * 1.4 : base, 1);
    }

    for (const [id, sprite] of labelSprites) {
      const isSel = id === selectedNodeId;
      const isHub = (nodeSprites.get(id)?.userData.degree ?? 0) >= 5;
      sprite.visible = isSel || isHub;
    }

    // Ephemeral label for selected low-degree node
    if (selectedNodeId && !labelSprites.has(selectedNodeId)) {
      const node = nodes.find((n) => n.id === selectedNodeId);
      const nodeSprite = nodeSprites.get(selectedNodeId);
      if (node && nodeSprite && sceneRef.current) {
        const { canvas, scale } = makeLabelCanvas(node.label);
        const tex = new THREE.CanvasTexture(canvas);
        tex.needsUpdate = true;
        const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, sizeAttenuation: true });
        const sprite = new THREE.Sprite(mat);
        sprite.scale.set(canvas.width * scale, canvas.height * scale, 1);
        sprite.position.copy(nodeSprite.position);
        sprite.position.y -= nodeSprite.scale.y * 0.5 + 4;
        sprite.userData.nodeId = node.id;
        sprite.userData.isLabel = true;
        sprite.userData.ephemeral = true;
        sceneRef.current.add(sprite);
        labelSprites.set(node.id, sprite);
        labelSpritesRef.current = new Map(labelSprites);
      }
    }

    // Cleanup ephemeral labels for deselected nodes
    for (const [id, sprite] of labelSprites) {
      if (sprite.userData.ephemeral && id !== selectedNodeId) {
        sceneRef.current?.remove(sprite);
        sprite.material.dispose();
        sprite.material.map?.dispose();
        labelSprites.delete(id);
        labelSpritesRef.current = new Map(labelSprites);
      }
    }
  }, [selectedNodeId, nodes]);

  // ─── Hover interactions ───────────────────────────────────────────

  useEffect(() => {
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    if (!renderer || !scene || !camera) return;

    function intersect(clientX: number, clientY: number): string | null {
      const rect = renderer!.domElement.getBoundingClientRect();
      const x = ((clientX - rect.left) / rect.width) * 2 - 1;
      const y = -((clientY - rect.top) / rect.height) * 2 + 1;

      raycasterRef.current.setFromCamera(new THREE.Vector2(x, y), camera!);

      const sprites: THREE.Sprite[] = [];
      scene!.children.forEach((child: THREE.Object3D) => {
        if (child instanceof THREE.Sprite && !child.userData.isLabel) {
          sprites.push(child);
        }
      });

      const hits = raycasterRef.current.intersectObjects(sprites);
      return hits.length > 0 ? (hits[0].object.userData.nodeId as string) : null;
    }

    function onPointerMove(e: PointerEvent) {
      const id = intersect(e.clientX, e.clientY);
      setHoveredNode(id);
      onHoverRef.current?.(id);
      renderer!.domElement.style.cursor = id ? "pointer" : "default";

      const labels = labelSpritesRef.current;
      for (const [lid, sprite] of labels) {
        if (sprite.userData.ephemeral) continue;
        const isHub = (nodeSpritesRef.current.get(lid)?.userData.degree ?? 0) >= 5;
        const isSel = lid === selectedRef.current;
        sprite.visible = isSel || isHub || lid === id;
      }
    }

    function onClick(e: MouseEvent) {
      const id = intersect(e.clientX, e.clientY);
      onClickRef.current?.(id ?? "");
    }

    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("click", onClick);
    return () => {
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("click", onClick);
    };
  }, []);

  // ─── Hover visual effect ──────────────────────────────────────────

  useEffect(() => {
    for (const [id, sprite] of nodeSpritesRef.current) {
      const isHov = id === hoveredNode;
      const isSel = id === selectedNodeId;
      const deg = sprite.userData.degree ?? 0;
      const base = getNodeSize(deg) * 0.7;
      const s = isSel ? base * 1.4 : isHov ? base * 1.2 : base;
      sprite.scale.set(s, s, 1);
    }
  }, [hoveredNode, selectedNodeId]);

  const zoomIn = useCallback(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    const pos = controls.object.position;
    const dir = pos.clone().sub(controls.target).normalize();
    const dist = pos.distanceTo(controls.target);
    const newDist = Math.max(controls.minDistance, dist * 0.7);
    pos.copy(controls.target).add(dir.multiplyScalar(newDist));
    controls.update();
  }, []);

  const zoomOut = useCallback(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    const pos = controls.object.position;
    const dir = pos.clone().sub(controls.target).normalize();
    const dist = pos.distanceTo(controls.target);
    const newDist = Math.min(controls.maxDistance, dist * 1.4);
    pos.copy(controls.target).add(dir.multiplyScalar(newDist));
    controls.update();
  }, []);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div
        ref={containerRef}
        className={className}
        style={{ width: "100%", height: "100%", overflow: "hidden" }}
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
          style={{
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
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.12)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(0,0,0,0.5)")}
        >
          +
        </button>
        <button
          onClick={zoomOut}
          aria-label="Zoom out"
          style={{
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
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.12)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(0,0,0,0.5)")}
        >
          −
        </button>
      </div>
    </div>
  );
}
