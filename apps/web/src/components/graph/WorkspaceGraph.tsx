"use client";

import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { getNodeColor, getEdgeColor } from "../../lib/utils";
import { GRAPH } from "../../lib/constants";

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

export interface GraphFilters {
  types: Set<string>;
  search: string;
  minDegree: number;
  maxDegree: number;
}

export interface WorkspaceGraphProps {
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
  selectedNodeId?: string | null;
  onNodeClick?: (nodeId: string) => void;
  onNodeHover?: (nodeId: string | null) => void;
  onNodeDoubleClick?: (nodeId: string) => void;
  filters?: GraphFilters;
  className?: string;
}

function getNodeSize(degree: number): number {
  return GRAPH.NODE_BASE_SIZE + Math.min(degree * GRAPH.NODE_SIZE_PER_DEGREE, GRAPH.NODE_MAX_SIZE_BONUS);
}

// ── Canvas texture helpers ──────────────────────────────────────────

function makeNodeCanvas(color: string): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = GRAPH.NODE_TEX_SIZE;
  c.height = GRAPH.NODE_TEX_SIZE;
  const ctx = c.getContext("2d")!;
  const cx = GRAPH.NODE_TEX_SIZE / 2, cy = GRAPH.NODE_TEX_SIZE / 2, r = GRAPH.NODE_TEX_RADIUS;

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
  const fontSize = GRAPH.LABEL_FONT_SIZE;
  ctx.font = `600 ${fontSize}px system-ui, -apple-system, sans-serif`;
  const textWidth = ctx.measureText(text).width;
  const px = GRAPH.LABEL_PADDING_X, py = GRAPH.LABEL_PADDING_Y;
  const w = textWidth + px * 2;
  const h = fontSize + py * 2;

  ctx.canvas.width = w;
  ctx.canvas.height = h;
  ctx.font = `600 ${fontSize}px system-ui, -apple-system, sans-serif`;

  ctx.fillStyle = "rgba(0,0,0,0.75)";
  const rr = GRAPH.LABEL_RADIUS;
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

  return { canvas: ctx.canvas, scale: GRAPH.LABEL_SCALE };
}

// Module-level texture caches — persist across scene rebuilds.
const nodeTextureCache = new Map<string, THREE.CanvasTexture>();
const labelTextureCache = new Map<string, THREE.CanvasTexture>();

function getNodeTexture(color: string): THREE.CanvasTexture {
  let tex = nodeTextureCache.get(color);
  if (!tex) {
    tex = new THREE.CanvasTexture(makeNodeCanvas(color));
    tex.needsUpdate = true;
    nodeTextureCache.set(color, tex);
  }
  return tex;
}

function getLabelTexture(text: string): THREE.CanvasTexture {
  let tex = labelTextureCache.get(text);
  if (!tex) {
    const { canvas } = makeLabelCanvas(text);
    tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    labelTextureCache.set(text, tex);
  }
  return tex;
}

// ── Fibonacci sphere layout ─────────────────────────────────────────

function computeLayout(nodes: GraphNodeData[]): Float64Array {
  const n = nodes.length;
  const pos = new Float64Array(n * 3);
  if (n === 0) return pos;

  const radius = Math.max(GRAPH.SPHERE_RADIUS_MIN, Math.min(n * GRAPH.SPHERE_RADIUS_FACTOR, GRAPH.SPHERE_RADIUS_MAX));
  const maxDeg = Math.max(1, ...nodes.map((x) => x.degree));

  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const theta = goldenAngle * i;
    const lift = (nodes[i].degree / maxDeg) * radius * GRAPH.SPHERE_LIFT_FACTOR;
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
  onNodeDoubleClick,
  filters,
  className = "",
}: WorkspaceGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const nodeSpritesRef = useRef<Map<string, THREE.Sprite>>(new Map());
  const labelSpritesRef = useRef<Map<string, THREE.Sprite>>(new Map());
  const edgeLinesRef = useRef<THREE.LineSegments | null>(null);
  const raycasterRef = useRef(new THREE.Raycaster());
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);

  // Stable refs for event handler closures
  const selectedRef = useRef(selectedNodeId);
  selectedRef.current = selectedNodeId;
  const onClickRef = useRef(onNodeClick);
  onClickRef.current = onNodeClick;
  const onHoverRef = useRef(onNodeHover);
  onHoverRef.current = onNodeHover;
  const onDoubleClickRef = useRef(onNodeDoubleClick);
  onDoubleClickRef.current = onNodeDoubleClick;

  const dataKey = useMemo(() =>
    nodes.length > 0
      ? nodes.map((n) => `${n.id}:${n.degree}`).join("|") +
        "||" +
        edges.map((e) => `${e.source}>${e.target}:${e.type}`).join("|")
      : "empty",
    [nodes, edges],
  );

  // ─── Init scene ───────────────────────────────────────────────────

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const w = container.clientWidth || GRAPH.FALLBACK_WIDTH;
    const h = container.clientHeight || GRAPH.FALLBACK_HEIGHT;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(GRAPH.BG_COLOR);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(GRAPH.CAMERA_FOV, w / h, GRAPH.CAMERA_NEAR, GRAPH.CAMERA_FAR);
    camera.position.set(...GRAPH.CAMERA_DEFAULT_POS);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, GRAPH.MAX_PIXEL_RATIO));
    renderer.setSize(w, h);
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = GRAPH.CONTROLS_DAMPING;
    controls.minDistance = GRAPH.CONTROLS_MIN_DISTANCE;
    controls.maxDistance = GRAPH.CONTROLS_MAX_DISTANCE;
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

  // ─── Build graph (only when data changes, NOT when filters change) ──

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    // Remove all children
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
    edgeLinesRef.current = null;

    if (nodes.length === 0) return;

    const positions = computeLayout(nodes);

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

      const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: GRAPH.EDGE_OPACITY });
      const lines = new THREE.LineSegments(geo, mat);
      scene.add(lines);
      edgeLinesRef.current = lines;
    }

    // ── Node sprites ──
    const nodeSprites = new Map<string, THREE.Sprite>();

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
      const color = getNodeColor(node.type);
      const size = getNodeSize(node.degree);

      const tex = getNodeTexture(color);
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, sizeAttenuation: true });
      const sprite = new THREE.Sprite(mat);
      const s = size * GRAPH.NODE_SPRITE_SCALE;
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

      const tex = getLabelTexture(node.label);
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, sizeAttenuation: true });
      const sprite = new THREE.Sprite(mat);
      const canvas = tex.image as HTMLCanvasElement;
      const labelScale = GRAPH.LABEL_SCALE;
      sprite.scale.set(canvas.width * labelScale, canvas.height * labelScale, 1);
      sprite.position.set(x, y - size * 0.5 - GRAPH.LABEL_OFFSET, z);
      sprite.userData.nodeId = node.id;
      sprite.userData.isLabel = true;
      sprite.visible = node.degree >= GRAPH.LABEL_HUB_DEGREE;
      scene.add(sprite);
      labelSprites.set(node.id, sprite);
    }
    labelSpritesRef.current = labelSprites;
  }, [dataKey, nodes, edges]);

  // ─── Filter visibility (toggles sprite.visible, no rebuild) ────────

  useEffect(() => {
    if (!filters) return;

    const searchLower = filters.search.toLowerCase();
    const nodeSprites = nodeSpritesRef.current;
    const labelSprites = labelSpritesRef.current;
    const edgeLines = edgeLinesRef.current;

    const nodeVisible = new Set<string>();

    for (const [id, sprite] of nodeSprites) {
      const node = nodes.find((n) => n.id === id);
      if (!node) continue;

      const typeOk = filters.types.size === 0 || filters.types.has(node.type);
      const degreeOk = node.degree >= filters.minDegree && node.degree <= filters.maxDegree;
      const searchOk = !searchLower || node.label.toLowerCase().includes(searchLower);

      const visible = typeOk && degreeOk && searchOk;
      sprite.visible = visible;
      if (visible) nodeVisible.add(id);

      // Show label for visible high-degree nodes or matching search
      const label = labelSprites.get(id);
      if (label) {
        label.visible = visible && (node.degree >= GRAPH.LABEL_HUB_DEGREE || !!searchLower);
      }
    }

    // Toggle edge visibility based on endpoint visibility
    if (edgeLines) {
      const mat = edgeLines.material as THREE.LineBasicMaterial;
      mat.opacity = nodeVisible.size > 0 ? GRAPH.EDGE_OPACITY : 0;
    }
  }, [filters, nodes]);

  // ─── Selection / highlight updates ────────────────────────────────

  useEffect(() => {
    const nodeSprites = nodeSpritesRef.current;
    const labelSprites = labelSpritesRef.current;

    for (const [id, sprite] of nodeSprites) {
      const isSel = id === selectedNodeId;
      const deg = sprite.userData.degree ?? 0;
      const base = getNodeSize(deg) * GRAPH.NODE_SPRITE_SCALE;
      sprite.scale.set(isSel ? base * GRAPH.NODE_SELECTED_SCALE : base, isSel ? base * GRAPH.NODE_SELECTED_SCALE : base, 1);
    }

    for (const [id, sprite] of labelSprites) {
      const isSel = id === selectedNodeId;
      const isHub = (nodeSprites.get(id)?.userData.degree ?? 0) >= GRAPH.LABEL_HUB_DEGREE;
      sprite.visible = isSel || isHub;
    }
  }, [selectedNodeId]);

  // ─── Pointer interactions ─────────────────────────────────────────

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
        if (child instanceof THREE.Sprite && !child.userData.isLabel && child.visible) {
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
        const isHub = (nodeSpritesRef.current.get(lid)?.userData.degree ?? 0) >= GRAPH.LABEL_HUB_DEGREE;
        const isSel = lid === selectedRef.current;
        sprite.visible = isSel || isHub || lid === id;
      }
    }

    function onClick(e: MouseEvent) {
      const id = intersect(e.clientX, e.clientY);
      onClickRef.current?.(id ?? "");
    }

    function onDoubleClick(e: MouseEvent) {
      const id = intersect(e.clientX, e.clientY);
      if (id) onDoubleClickRef.current?.(id);
    }

    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("click", onClick);
    renderer.domElement.addEventListener("dblclick", onDoubleClick);
    return () => {
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("click", onClick);
      renderer.domElement.removeEventListener("dblclick", onDoubleClick);
    };
  }, []);

  // ─── Hover visual effect ──────────────────────────────────────────

  useEffect(() => {
    for (const [id, sprite] of nodeSpritesRef.current) {
      const isHov = id === hoveredNode;
      const isSel = id === selectedNodeId;
      const deg = sprite.userData.degree ?? 0;
      const base = getNodeSize(deg) * GRAPH.NODE_SPRITE_SCALE;
      const s = isSel ? base * GRAPH.NODE_SELECTED_SCALE : isHov ? base * GRAPH.NODE_HOVER_SCALE : base;
      sprite.scale.set(s, s, 1);
    }
  }, [hoveredNode, selectedNodeId]);

  // ─── Zoom controls ────────────────────────────────────────────────

  const zoomToFit = useCallback(() => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) return;

    // Compute bounding box of all visible node sprites
    const nodeSprites = nodeSpritesRef.current;
    if (nodeSprites.size === 0) return;

    const bbox = new THREE.Box3();
    for (const [, sprite] of nodeSprites) {
      if (sprite.visible) bbox.expandByPoint(sprite.position);
    }
    if (bbox.isEmpty()) return;

    const center = bbox.getCenter(new THREE.Vector3());
    const size = bbox.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 1);
    const dist = maxDim * GRAPH.ZOOM_FIT_FACTOR + GRAPH.ZOOM_FIT_PADDING;

    controls.target.copy(center);
    camera.position.set(center.x + dist * 0.5, center.y + dist * 0.4, center.z + dist);
    camera.near = dist / GRAPH.ZOOM_NEAR_FACTOR;
    camera.far = dist * GRAPH.ZOOM_FAR_FACTOR;
    camera.updateProjectionMatrix();
    controls.update();
  }, []);

  const zoomIn = useCallback(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    const pos = controls.object.position;
    const dir = pos.clone().sub(controls.target).normalize();
    const dist = pos.distanceTo(controls.target);
    const newDist = Math.max(controls.minDistance, dist * GRAPH.ZOOM_IN_FACTOR);
    pos.copy(controls.target).add(dir.multiplyScalar(newDist));
    controls.update();
  }, []);

  const zoomOut = useCallback(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    const pos = controls.object.position;
    const dir = pos.clone().sub(controls.target).normalize();
    const dist = pos.distanceTo(controls.target);
    const newDist = Math.min(controls.maxDistance, dist * GRAPH.ZOOM_OUT_FACTOR);
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
          bottom: GRAPH.ZOOM_BTN_POSITION,
          right: GRAPH.ZOOM_BTN_POSITION,
          display: "flex",
          flexDirection: "column",
          gap: GRAPH.ZOOM_BTN_GAP,
        }}
      >
        <button
          onClick={zoomIn}
          aria-label="Zoom in"
          style={{
            width: GRAPH.ZOOM_BTN_SIZE,
            height: GRAPH.ZOOM_BTN_SIZE,
            border: GRAPH.ZOOM_BTN_BORDER,
            borderRadius: GRAPH.ZOOM_BTN_RADIUS,
            background: GRAPH.ZOOM_BTN_BG,
            color: GRAPH.ZOOM_BTN_COLOR,
            fontSize: GRAPH.ZOOM_BTN_ICON_SIZE,
            lineHeight: 1,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          +
        </button>
        <button
          onClick={zoomOut}
          aria-label="Zoom out"
          style={{
            width: GRAPH.ZOOM_BTN_SIZE,
            height: GRAPH.ZOOM_BTN_SIZE,
            border: GRAPH.ZOOM_BTN_BORDER,
            borderRadius: GRAPH.ZOOM_BTN_RADIUS,
            background: GRAPH.ZOOM_BTN_BG,
            color: GRAPH.ZOOM_BTN_COLOR,
            fontSize: GRAPH.ZOOM_BTN_ICON_SIZE,
            lineHeight: 1,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          &minus;
        </button>
        <button
          onClick={zoomToFit}
          aria-label="Fit to view"
          style={{
            width: GRAPH.ZOOM_BTN_SIZE,
            height: GRAPH.ZOOM_BTN_SIZE,
            border: GRAPH.ZOOM_BTN_BORDER,
            borderRadius: GRAPH.ZOOM_BTN_RADIUS,
            background: GRAPH.ZOOM_BTN_BG,
            color: GRAPH.ZOOM_BTN_COLOR,
            fontSize: GRAPH.ZOOM_BTN_FIT_FONT,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          Fit
        </button>
      </div>
    </div>
  );
}
