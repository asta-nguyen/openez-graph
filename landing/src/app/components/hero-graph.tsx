"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";

// ── Helpers ──────────────────────────────────────────────────────────

function makeNodeTexture(color: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 32;
  c.height = 32;
  const ctx = c.getContext("2d")!;
  const cx = 16, cy = 16, r = 14;
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  g.addColorStop(0, "#ffffff");
  g.addColorStop(0.15, color);
  g.addColorStop(0.6, color);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

const NODE_COLORS_LANDING = ["#5cc9c2", "#7a5cc9", "#5c7ac9", "#c9a05c"];
const NODE_COUNT = 40;
const EDGE_DISTANCE_THRESHOLD = 35;

function fibonacciSphere(count: number, radius: number): Float64Array {
  const pos = new Float64Array(count * 3);
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const theta = goldenAngle * i;
    pos[i * 3] = radius * r * Math.cos(theta);
    pos[i * 3 + 1] = radius * y;
    pos[i * 3 + 2] = radius * r * Math.sin(theta);
  }
  return pos;
}

function computeEdges(
  positions: Float64Array,
  count: number,
  threshold: number,
): [number, number][] {
  const edges: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      const dx = positions[i * 3] - positions[j * 3];
      const dy = positions[i * 3 + 1] - positions[j * 3 + 1];
      const dz = positions[i * 3 + 2] - positions[j * 3 + 2];
      if (dx * dx + dy * dy + dz * dz < threshold * threshold) {
        edges.push([i, j]);
      }
    }
  }
  return edges;
}

// ── Component ────────────────────────────────────────────────────────

export function HeroGraph() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const w = container.clientWidth || 800;
    const h = container.clientHeight || 600;

    // Scene with transparent background
    const scene = new THREE.Scene();

    // Camera: perspective looking at origin
    const camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 1000);
    camera.position.set(55, 28, 75);
    camera.lookAt(0, 0, 0);

    // Renderer with alpha
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
    });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(w, h);
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);

    // ── Build graph data ──
    const positions = fibonacciSphere(NODE_COUNT, 50);
    const edges = computeEdges(positions, NODE_COUNT, EDGE_DISTANCE_THRESHOLD);

    // Nodes
    const nodeTexCache = new Map<string, THREE.CanvasTexture>();
    const nodeGroup = new THREE.Group();
    for (let i = 0; i < NODE_COUNT; i++) {
      const color = NODE_COLORS_LANDING[i % NODE_COLORS_LANDING.length];
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
        opacity: 0.6,
      });
      const sprite = new THREE.Sprite(mat);
      const size = 1.2 + Math.random() * 1.5;
      sprite.scale.set(size, size, 1);
      sprite.position.set(
        positions[i * 3],
        positions[i * 3 + 1],
        positions[i * 3 + 2],
      );
      nodeGroup.add(sprite);
    }
    scene.add(nodeGroup);

    // Edges
    if (edges.length > 0) {
      const edgePositions: number[] = [];
      for (const [si, ti] of edges) {
        const sx = positions[si * 3],
          sy = positions[si * 3 + 1],
          sz = positions[si * 3 + 2];
        const tx = positions[ti * 3],
          ty = positions[ti * 3 + 1],
          tz = positions[ti * 3 + 2];
        edgePositions.push(sx, sy, sz, tx, ty, tz);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(edgePositions, 3),
      );
      const mat = new THREE.LineBasicMaterial({
        color: 0x5cc9c2,
        transparent: true,
        opacity: 0.08,
      });
      scene.add(new THREE.LineSegments(geo, mat));
    }

    // Resize observer
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height);
      }
    });
    ro.observe(container);

    // ── Animation loop ──
    let raf = 0;
    function animate() {
      raf = requestAnimationFrame(animate);
      nodeGroup.rotation.y += 0.0015;
      nodeGroup.rotation.x = Math.sin(Date.now() * 0.0003) * 0.05;
      renderer.render(scene, camera);
    }
    animate();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
      // Dispose textures
      for (const tex of nodeTexCache.values()) tex.dispose();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 pointer-events-none"
      style={{ zIndex: 0 }}
    />
  );
}
