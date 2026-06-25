"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

// ── Helpers ──────────────────────────────────────────────────────────

const NODE_COLORS: Record<string, string> = {
  file: "#60a5fa",
  symbol: "#5cc9c2",
  function: "#fbbf24",
  class: "#c084fc",
  method: "#f472b6",
  variable: "#34d399",
  module: "#f97316",
  default: "#94a3b8",
};

const NODE_COUNT = 70;
const EDGE_THRESHOLD = 40;
const RADIUS = 55;

function makeNodeTexture(color: string): THREE.CanvasTexture {
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
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

function makeLabelCanvas(text: string): { canvas: HTMLCanvasElement; scale: number } {
  const ctx = document.createElement("canvas").getContext("2d")!;
  const fontSize = 12;
  ctx.font = `600 ${fontSize}px system-ui, -apple-system, sans-serif`;
  const textWidth = ctx.measureText(text).width;
  const px = 8, py = 4;
  const w = textWidth + px * 2;
  const h = fontSize + py * 2;

  ctx.canvas.width = w;
  ctx.canvas.height = h;
  ctx.font = `600 ${fontSize}px system-ui, -apple-system, sans-serif`;

  ctx.fillStyle = "rgba(0,0,0,0.8)";
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

function fibonacciSphere(count: number, radius: number): Float64Array {
  const pos = new Float64Array(count * 3);
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const theta = goldenAngle * i;
    const lift = (i % 7) * 0.15 * radius * 0.08;
    const sr = radius + lift;
    pos[i * 3] = sr * r * Math.cos(theta);
    pos[i * 3 + 1] = sr * y;
    pos[i * 3 + 2] = sr * r * Math.sin(theta);
  }
  return pos;
}

function computeEdges(pos: Float64Array, count: number, threshold: number): [number, number, number][] {
  const edges: [number, number, number][] = [];
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      const dx = pos[i * 3] - pos[j * 3];
      const dy = pos[i * 3 + 1] - pos[j * 3 + 1];
      const dz = pos[i * 3 + 2] - pos[j * 3 + 2];
      const dist = dx * dx + dy * dy + dz * dz;
      if (dist < threshold * threshold) {
        edges.push([i, j, Math.floor(dist)]);
      }
    }
  }
  return edges;
}

// Pick a color key based on index to simulate node types
const TYPE_KEYS = Object.keys(NODE_COLORS);

// ── Component ────────────────────────────────────────────────────────

export function InteractiveGraph() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoveredLabel, setHoveredLabel] = useState<string | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const w = container.clientWidth || 800;
    const h = container.clientHeight || 500;

    // Scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x080c16);

    // Camera
    const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000);
    camera.position.set(70, 35, 90);
    camera.lookAt(0, 0, 0);

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(w, h);
    container.appendChild(renderer.domElement);

    // Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controls.minDistance = 20;
    controls.maxDistance = 300;
    controls.autoRotate = false;
    controlsRef.current = controls;

    // Resize
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height);
      }
    });
    ro.observe(container);

    // ── Build graph ──
    const positions = fibonacciSphere(NODE_COUNT, RADIUS);
    const edges = computeEdges(positions, NODE_COUNT, EDGE_THRESHOLD);

    // Labels map for hover
    const nodeLabels: { id: string; label: string; sprite: THREE.Sprite }[] = [];

    // Edge lines
    if (edges.length > 0) {
      const edgePositions: number[] = [];
      const edgeColors: number[] = [];
      for (const [si, ti] of edges) {
        const sx = positions[si * 3], sy = positions[si * 3 + 1], sz = positions[si * 3 + 2];
        const tx = positions[ti * 3], ty = positions[ti * 3 + 1], tz = positions[ti * 3 + 2];
        edgePositions.push(sx, sy, sz, tx, ty, tz);
        edgeColors.push(0.36, 0.79, 0.76, 0.36, 0.79, 0.76);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(edgePositions, 3));
      geo.setAttribute("color", new THREE.Float32BufferAttribute(edgeColors, 3));
      const mat = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.2,
      });
      scene.add(new THREE.LineSegments(geo, mat));
    }

    // Node sprites + labels
    const nodeTexCache = new Map<string, THREE.CanvasTexture>();
    const nodeSprites: THREE.Sprite[] = [];

    for (let i = 0; i < NODE_COUNT; i++) {
      const typeKey = TYPE_KEYS[i % TYPE_KEYS.length];
      const color = NODE_COLORS[typeKey];
      let tex = nodeTexCache.get(color);
      if (!tex) {
        tex = makeNodeTexture(color);
        nodeTexCache.set(color, tex);
      }

      const mat = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        sizeAttenuation: true,
        opacity: 0.85,
      });
      const sprite = new THREE.Sprite(mat);
      const degree = 1 + (i % 10);
      const size = (3 + degree * 0.4) * 0.7;
      sprite.scale.set(size, size, 1);
      sprite.position.set(
        positions[i * 3],
        positions[i * 3 + 1],
        positions[i * 3 + 2],
      );
      sprite.userData.index = i;
      sprite.userData.degree = degree;
      sprite.userData.type = typeKey;
      scene.add(sprite);
      nodeSprites.push(sprite);

      // Label sprite
      const labelStr = `${typeKey}_${i.toString().padStart(2, "0")}`;
      const { canvas, scale: labelScale } = makeLabelCanvas(labelStr);
      const ltex = new THREE.CanvasTexture(canvas);
      ltex.needsUpdate = true;
      const lmat = new THREE.SpriteMaterial({
        map: ltex,
        transparent: true,
        depthWrite: false,
        sizeAttenuation: true,
      });
      const lsprite = new THREE.Sprite(lmat);
      lsprite.scale.set(canvas.width * labelScale, canvas.height * labelScale, 1);
      lsprite.position.set(
        positions[i * 3],
        positions[i * 3 + 1] - size * 0.5 - 3,
        positions[i * 3 + 2],
      );
      lsprite.visible = false;
      lsprite.userData.label = labelStr;
      scene.add(lsprite);
      nodeLabels.push({ id: labelStr, label: labelStr, sprite: lsprite });
    }

    // ── Raycaster for hover ──
    const raycaster = new THREE.Raycaster();
    function intersect(clientX: number, clientY: number): number | null {
      const rect = renderer.domElement.getBoundingClientRect();
      const x = ((clientX - rect.left) / rect.width) * 2 - 1;
      const y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(new THREE.Vector2(x, y), camera);
      const hits = raycaster.intersectObjects(nodeSprites);
      return hits.length > 0 ? (hits[0].object.userData.index as number) : null;
    }

    function onPointerMove(e: PointerEvent) {
      const idx = intersect(e.clientX, e.clientY);
      renderer.domElement.style.cursor = idx !== null ? "pointer" : "default";

      // Update label visibility
      for (const nl of nodeLabels) {
        nl.sprite.visible = nl.sprite.userData.label === (idx !== null ? `${TYPE_KEYS[idx % TYPE_KEYS.length]}_${idx.toString().padStart(2, "0")}` : undefined);
      }
      if (idx !== null) {
        const label = `${TYPE_KEYS[idx % TYPE_KEYS.length]}_${idx.toString().padStart(2, "0")}`;
        setHoveredLabel(label);
      } else {
        setHoveredLabel(null);
      }

      // Scale effect
      for (let i = 0; i < nodeSprites.length; i++) {
        const sp = nodeSprites[i];
        const deg = sp.userData.degree as number;
        const base = (3 + deg * 0.4) * 0.7;
        sp.scale.set(
          i === idx ? base * 1.3 : base,
          i === idx ? base * 1.3 : base,
          1,
        );
        sp.material.opacity = i === idx ? 1 : 0.85;
      }
    }

    renderer.domElement.addEventListener("pointermove", onPointerMove);

    // ── Animation ──
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
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      controls.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
      for (const tex of nodeTexCache.values()) tex.dispose();
    };
  }, []);

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
        style={{ width: "100%", height: "100%", overflow: "hidden", borderRadius: "0.75rem" }}
      />
      {hoveredLabel && (
        <div
          style={{
            position: "absolute",
            bottom: 56,
            left: 16,
            background: "rgba(8,12,22,0.9)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 6,
            padding: "6px 12px",
            fontSize: 12,
            color: "#e2f8f0",
            fontFamily: "var(--font-mono), monospace",
            pointerEvents: "none",
          }}
        >
          {hoveredLabel}
        </div>
      )}
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
            width: 32, height: 32,
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
            width: 32, height: 32,
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
