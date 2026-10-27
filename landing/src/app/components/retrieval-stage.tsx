"use client";

// Hero visual: the repo's own code graph in 3D. Pick a question and a pulse sweeps the graph; the
// files `code_query` really returned for it light up in rank order, the rest fades back, and the
// bar shows how many tokens that took against reading the files whole. All data is real
// (see retrieval-demo.ts). Decorative for assistive tech; a live region carries the result.

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import * as THREE from "three";
import { ArrowRight, Search } from "lucide-react";
import { mcpToolCount } from "./mcp-tools";
import { demoEdges, demoNodes, demoQueries } from "./retrieval-demo";

const CYCLE_MS = 7000;
const PICK_PAUSE_MS = 25000;
const NODE_COLORS = { f: "#60a5fa", s: "#fbbf24" }; // same palette as the real Graph Explorer
const EDGE_COLORS = ["#60a5fa", "#fbbf24", "#f97316"]; // imports, defines, calls
const HIT_COLOR = "#4cc9f0";
const RADIUS = 8.5;
const MAX_LABELS = 5;

const ease = (t: number) => t * t * (3 - 2 * t);
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
const srgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16) / 255,
  parseInt(hex.slice(3, 5), 16) / 255,
  parseInt(hex.slice(5, 7), 16) / 255,
];
const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Small deterministic force layout in 3D: repulsion, springs along edges, a pull to the centre. */
function layout3d(): Float32Array {
  const n = demoNodes.length;
  let seed = 7;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const p = new Float32Array(n * 3);
  const v = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = 6 * Math.cbrt(rnd());
    const th = rnd() * Math.PI * 2;
    const ph = Math.acos(2 * rnd() - 1);
    p[i * 3] = r * Math.sin(ph) * Math.cos(th);
    p[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th);
    p[i * 3 + 2] = r * Math.cos(ph);
  }
  const iterations = 280;
  for (let it = 0; it < iterations; it++) {
    const step = 0.12 + 0.6 * (1 - it / iterations);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = p[i * 3] - p[j * 3];
        const dy = p[i * 3 + 1] - p[j * 3 + 1];
        const dz = p[i * 3 + 2] - p[j * 3 + 2];
        const d2 = dx * dx + dy * dy + dz * dz + 0.05;
        const f = 2.4 / d2;
        const d = Math.sqrt(d2);
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        const fz = (dz / d) * f;
        v[i * 3] += fx;
        v[i * 3 + 1] += fy;
        v[i * 3 + 2] += fz;
        v[j * 3] -= fx;
        v[j * 3 + 1] -= fy;
        v[j * 3 + 2] -= fz;
      }
    }
    for (const [a, b] of demoEdges) {
      const dx = p[b * 3] - p[a * 3];
      const dy = p[b * 3 + 1] - p[a * 3 + 1];
      const dz = p[b * 3 + 2] - p[a * 3 + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-4;
      const f = (d - 1.5) * 0.07;
      v[a * 3] += (dx / d) * f;
      v[a * 3 + 1] += (dy / d) * f;
      v[a * 3 + 2] += (dz / d) * f;
      v[b * 3] -= (dx / d) * f;
      v[b * 3 + 1] -= (dy / d) * f;
      v[b * 3 + 2] -= (dz / d) * f;
    }
    for (let i = 0; i < n * 3; i++) {
      v[i] = (v[i] - p[i] * 0.012) * 0.82;
      p[i] += v[i] * step;
    }
  }
  // centre and scale to a fixed radius
  const c = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) c[k] += p[i * 3 + k] / n;
  let max = 0;
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) p[i * 3 + k] -= c[k];
    max = Math.max(max, Math.hypot(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]));
  }
  for (let i = 0; i < n * 3; i++) p[i] *= RADIUS / max;
  return p;
}

const vertexShader = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aGlow;
  uniform float uScale;
  varying vec3 vColor;
  varying float vGlow;
  varying float vCore;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float grow = 1.0 + aGlow * 1.5;
    gl_PointSize = aSize * grow * uScale / -mv.z;
    gl_Position = projectionMatrix * mv;
    vColor = aColor;
    vGlow = aGlow;
    vCore = 1.0 / grow;
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uDim;
  uniform vec3 uHit;
  varying vec3 vColor;
  varying float vGlow;
  varying float vCore;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float r = 0.5 * vCore;
    float core = 1.0 - smoothstep(r - 0.04, r, d);
    float halo = (1.0 - smoothstep(0.0, 0.5, d)) * vGlow * 0.5;
    float a = max(core, halo);
    if (a < 0.01) discard;
    float rim = smoothstep(r - 0.1, r - 0.03, d) * core;
    vec3 base = mix(vColor, uHit, vGlow);
    vec3 col = mix(base, vec3(1.0), core * vGlow * 0.45) + rim * 0.22;
    float dim = mix(1.0, 0.3, uDim * (1.0 - vGlow));
    gl_FragColor = vec4(col, a * dim);
  }
`;

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    setReduced(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, []);
  return reduced;
}

/** Animates a number toward its new value (instantly under reduced motion). */
function useTween(target: number, reduced: boolean) {
  const [value, setValue] = useState(target);
  const current = useRef(target);
  useEffect(() => {
    if (reduced) {
      current.current = target;
      setValue(target);
      return;
    }
    const from = current.current;
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 800);
      const next = Math.round(from + (target - from) * (1 - (1 - t) ** 3));
      current.current = next;
      setValue(next);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, reduced]);
  return value;
}

const fmt = (n: number) => n.toLocaleString("en-US");

function Stat({
  label,
  value,
  foot,
  accent,
}: {
  label: ReactNode;
  value: number;
  foot?: ReactNode;
  accent?: boolean;
}) {
  return (
    <div className="min-w-0 px-3 py-2.5 sm:px-4">
      <dt className="truncate font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </dt>
      <dd
        className={`mt-0.5 text-xl font-semibold tabular-nums leading-tight ${accent ? "text-primary" : ""}`}
      >
        {fmt(value)}
      </dd>
      {foot && <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{foot}</p>}
    </div>
  );
}

export function RetrievalStage() {
  const reduced = useReducedMotion();
  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState(false);
  const [typed, setTyped] = useState("");
  const query = demoQueries[index];

  const hostRef = useRef<HTMLDivElement>(null);
  const labelRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const indexRef = useRef(index);
  indexRef.current = index;
  const redrawRef = useRef<() => void>(() => {});

  // rotate through the questions until the visitor picks one, then wait before resuming
  useEffect(() => {
    if (reduced) return;
    const id = window.setTimeout(
      () => {
        setPicked(false);
        setIndex((i) => (i + 1) % demoQueries.length);
      },
      picked ? PICK_PAUSE_MS : CYCLE_MS,
    );
    return () => window.clearTimeout(id);
  }, [index, picked, reduced]);

  // type the question out
  useEffect(() => {
    if (reduced) {
      setTyped(query.query);
      return;
    }
    let n = 0;
    setTyped("");
    const id = window.setInterval(() => {
      n += 2;
      setTyped(query.query.slice(0, n));
      if (n >= query.query.length) window.clearInterval(id);
    }, 22);
    return () => window.clearInterval(id);
  }, [query, reduced]);

  // still frames (reduced motion) need an explicit redraw when the question changes
  useEffect(() => {
    redrawRef.current();
  }, [index]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    } catch {
      return; // no WebGL: the question bar and the numbers still work
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(host.clientWidth || 560, host.clientHeight || 590);
    host.appendChild(renderer.domElement);

    const FOV = 40;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 200);
    const group = new THREE.Group();
    group.position.y = 1.4; // sit above the centre: the stats strip covers the bottom
    scene.add(group);

    const n = demoNodes.length;
    const pos = layout3d();
    const adjacency: number[][] = Array.from({ length: n }, () => []);
    for (const [a, b] of demoEdges) {
      adjacency[a].push(b);
      adjacency[b].push(a);
    }

    // nodes: crisp discs, a halo only while highlighted
    const sizes = new Float32Array(n);
    const colors = new Float32Array(n * 3);
    const glow = new Float32Array(n);
    demoNodes.forEach(([, kind, degree], i) => {
      sizes[i] =
        kind === "f" ? 0.42 + Math.min(degree, 8) * 0.045 : 0.24 + Math.min(degree, 6) * 0.03;
      colors.set(srgb(NODE_COLORS[kind]), i * 3);
    });
    const nodeGeo = new THREE.BufferGeometry();
    nodeGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    nodeGeo.setAttribute("aColor", new THREE.BufferAttribute(colors, 3));
    nodeGeo.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
    const glowAttr = new THREE.BufferAttribute(glow, 1);
    glowAttr.setUsage(THREE.DynamicDrawUsage);
    nodeGeo.setAttribute("aGlow", glowAttr);
    const nodeMat = new THREE.ShaderMaterial({
      uniforms: {
        uScale: { value: 800 },
        uDim: { value: 0 },
        uHit: { value: new THREE.Vector3(...srgb(HIT_COLOR)) },
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
    });
    const points = new THREE.Points(nodeGeo, nodeMat);
    points.frustumCulled = false;
    group.add(points);

    // edges: dim by default, brighter between lit nodes
    const m = demoEdges.length;
    const linePos = new Float32Array(m * 6);
    const lineCol = new Float32Array(m * 6);
    demoEdges.forEach(([a, b], i) => {
      linePos.set(pos.subarray(a * 3, a * 3 + 3), i * 6);
      linePos.set(pos.subarray(b * 3, b * 3 + 3), i * 6 + 3);
    });
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute("position", new THREE.BufferAttribute(linePos, 3));
    const colAttr = new THREE.BufferAttribute(lineCol, 3);
    colAttr.setUsage(THREE.DynamicDrawUsage);
    lineGeo.setAttribute("color", colAttr);
    const lineMat = new THREE.LineBasicMaterial({ vertexColors: true });
    const lines = new THREE.LineSegments(lineGeo, lineMat);
    lines.frustumCulled = false;
    group.add(lines);
    const edgeBase = EDGE_COLORS.map((h) => new THREE.Color(h));
    const hitColor = new THREE.Color(HIT_COLOR);
    const mix = new THREE.Color();

    // the sweep that starts each question
    const ringGeo = new THREE.RingGeometry(0.985, 1, 128);
    const ringMat = new THREE.MeshBasicMaterial({
      color: HIT_COLOR,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.copy(group.position);
    scene.add(ring);

    // per-question state
    const rank = new Int8Array(n);
    const nearHit = new Uint8Array(n);
    const centroid = new THREE.Vector3();
    let shown = -1;
    let tSel = 0;
    let ringT = 99;
    let yaw = 0;
    let targetYaw = 0;
    let lookY = 0;
    let dist = 36;
    let dim = 0;
    const select = (i: number) => {
      shown = i;
      tSel = 0;
      ringT = 0;
      rank.fill(-1);
      nearHit.fill(0);
      centroid.set(0, 0, 0);
      const hits = demoQueries[i].hits;
      hits.forEach((h, r) => {
        rank[h.node] = r;
        centroid.x += pos[h.node * 3] / hits.length;
        centroid.y += pos[h.node * 3 + 1] / hits.length;
        centroid.z += pos[h.node * 3 + 2] / hits.length;
      });
      for (const h of hits) for (const nb of adjacency[h.node]) if (rank[nb] < 0) nearHit[nb] = 1;
      targetYaw = Math.atan2(-centroid.x, centroid.z); // turn the hits toward the camera
    };

    const world = new THREE.Vector3();
    const size = { w: host.clientWidth || 560, h: host.clientHeight || 590 };
    const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
    const labelBox: { x: number; y: number; w: number }[] = [];
    let last = performance.now();

    function render(now: number, animate: boolean) {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (indexRef.current !== shown) select(indexRef.current);
      tSel = animate ? tSel + dt : 99;

      // glow: hits in rank order, then their graph neighbours
      const k = Math.min(1, dt * 9);
      for (let i = 0; i < n; i++) {
        let target = 0;
        if (rank[i] >= 0) target = ease(clamp01((tSel - 0.5 - rank[i] * 0.3) / 0.45));
        else if (nearHit[i]) target = 0.4 * ease(clamp01((tSel - 1.3) / 0.8));
        glow[i] = animate ? glow[i] + (target - glow[i]) * k : target;
      }
      glowAttr.needsUpdate = true;
      dim = animate ? dim + (0.88 - dim) * Math.min(1, dt * 2.5) : 0.88;
      nodeMat.uniforms.uDim.value = dim;

      const base = 0.2 - 0.09 * dim;
      for (let e = 0; e < m; e++) {
        const [a, b, kind] = demoEdges[e];
        const g = Math.min(glow[a], glow[b]);
        mix
          .copy(edgeBase[kind])
          .lerp(hitColor, g * 0.65)
          .multiplyScalar(base + g * 0.9);
        lineCol[e * 6] = lineCol[e * 6 + 3] = mix.r;
        lineCol[e * 6 + 1] = lineCol[e * 6 + 4] = mix.g;
        lineCol[e * 6 + 2] = lineCol[e * 6 + 5] = mix.b;
      }
      colAttr.needsUpdate = true;

      // camera: turn the hits toward us, drift a little, follow the pointer
      if (animate) {
        const delta = ((targetYaw - yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        yaw += delta * Math.min(1, dt * 2.2);
        pointer.x += (pointer.tx - pointer.x) * Math.min(1, dt * 4);
        pointer.y += (pointer.ty - pointer.y) * Math.min(1, dt * 4);
        lookY += (centroid.y * 0.45 - lookY) * Math.min(1, dt * 2);
        dist += (30 - dist) * Math.min(1, dt * 1.6);
        ringT += dt;
      } else {
        yaw = targetYaw;
        lookY = centroid.y * 0.45;
        dist = 30;
      }
      group.rotation.y = yaw + (animate ? Math.sin(now / 4500) * 0.28 : 0);
      group.rotation.x = 0.22 + pointer.y * 0.12;
      camera.position.set(pointer.x * 1.6, lookY - pointer.y * 1.0, dist);
      camera.lookAt(0, lookY, 0);

      const t = ringT / 1.3;
      ringMat.opacity = t < 1 ? 0.5 * (1 - t) : 0;
      ring.scale.setScalar(1 + ringT * 18);

      renderer.render(scene, camera);

      // path labels follow their nodes
      const hits = demoQueries[shown].hits;
      labelBox.length = 0;
      for (let i = 0; i < MAX_LABELS; i++) {
        const el = labelRefs.current[i];
        if (!el) continue;
        const hit = hits[i];
        if (!hit) {
          el.style.opacity = "0";
          continue;
        }
        world.set(pos[hit.node * 3], pos[hit.node * 3 + 1], pos[hit.node * 3 + 2]);
        group.localToWorld(world).project(camera);
        const w = el.offsetWidth || 150;
        let x = (world.x * 0.5 + 0.5) * size.w + 14;
        let y = (-world.y * 0.5 + 0.5) * size.h - 10;
        x = Math.min(Math.max(x, 12), size.w - w - 12);
        const minY = 70;
        const maxY = size.h - (size.w < 500 ? 225 : 190); // keep clear of the bars top and bottom
        y = Math.min(Math.max(y, minY), maxY);
        const free = (yy: number) =>
          !labelBox.some((b) => Math.abs(b.y - yy) < 24 && x < b.x + b.w && b.x < x + w);
        if (!free(y)) {
          // nearest free row, trying below and above
          for (let step = 1; step <= 8; step++) {
            const below = y + step * 24;
            const above = y - step * 24;
            if (below <= maxY && free(below)) {
              y = below;
              break;
            }
            if (above >= minY && free(above)) {
              y = above;
              break;
            }
          }
        }
        labelBox.push({ x, y, w });
        el.style.transform = `translate(${x}px, ${y}px)`;
        el.style.opacity = String(Math.min(1, glow[hit.node] * 1.3));
      }
    }

    const resize = (width: number, height: number) => {
      size.w = width;
      size.h = height;
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      nodeMat.uniforms.uScale.value =
        (height * renderer.getPixelRatio()) / (2 * Math.tan((FOV * Math.PI) / 360));
    };
    resize(size.w, size.h);

    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (!width || !height) return;
      resize(width, height);
      if (still) render(performance.now(), false);
    });
    ro.observe(host);

    const onPointerMove = (e: PointerEvent) => {
      const r = host.getBoundingClientRect();
      pointer.tx = ((e.clientX - r.left) / r.width - 0.5) * 2;
      pointer.ty = ((e.clientY - r.top) / r.height - 0.5) * 2;
    };
    const onPointerLeave = () => {
      pointer.tx = pointer.ty = 0;
    };
    const stage = host.parentElement ?? host;

    let raf = 0;
    let onScreen = true;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      render(now, true);
    };
    const sync = () => {
      cancelAnimationFrame(raf);
      if (!still && onScreen && !document.hidden) {
        last = performance.now();
        raf = requestAnimationFrame(loop);
      }
    };
    const io = new IntersectionObserver(([entry]) => {
      onScreen = entry.isIntersecting;
      sync();
    });
    io.observe(host);
    document.addEventListener("visibilitychange", sync);

    redrawRef.current = () => {
      if (still) render(performance.now(), false);
    };
    if (still) render(performance.now(), false);
    else {
      stage.addEventListener("pointermove", onPointerMove);
      stage.addEventListener("pointerleave", onPointerLeave);
    }

    return () => {
      redrawRef.current = () => {};
      cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
      document.removeEventListener("visibilitychange", sync);
      stage.removeEventListener("pointermove", onPointerMove);
      stage.removeEventListener("pointerleave", onPointerLeave);
      [nodeGeo, nodeMat, lineGeo, lineMat, ringGeo, ringMat].forEach((d) => d.dispose());
      renderer.dispose();
      if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement);
    };
  }, []);

  const m = query.metrics;
  const candidates = useTween(m.candidates, reduced);
  const selected = useTween(m.selected, reduced);
  const returned = useTween(m.responseTokens, reduced);
  const ratio = Math.round(m.fullTokens / m.responseTokens);

  return (
    <aside
      className="retrieval-stage fade-up relative isolate h-[36rem] w-full text-left lg:h-[37rem]"
      style={{ animationDelay: "0.15s" }}
      aria-label="OpenEZ retrieval demo"
    >
      <div
        ref={hostRef}
        className="absolute inset-0 [mask-image:radial-gradient(ellipse_75%_70%_at_50%_46%,black_55%,transparent_100%)]"
        aria-hidden="true"
      />

      {Array.from({ length: MAX_LABELS }, (_, i) => {
        const hit = query.hits[i];
        return (
          <span
            key={i}
            ref={(el) => {
              labelRefs.current[i] = el;
            }}
            className="stage-label"
            aria-hidden="true"
          >
            {hit && (
              <>
                <b>{i + 1}</b>
                {basename(hit.path)}
                <i>:{hit.lines}</i>
              </>
            )}
          </span>
        );
      })}

      <div className="absolute inset-x-4 top-4">
        <div className="flex items-center gap-2.5 rounded-xl border border-white/10 bg-black/45 px-3.5 py-2.5 backdrop-blur-md">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate font-mono text-xs" aria-hidden="true">
            {typed}
            <span className="stage-caret" />
          </span>
          <code className="shrink-0 rounded bg-accent px-1.5 py-0.5 font-mono text-[11px] text-accent-foreground">
            code_query
          </code>
        </div>
        {!reduced && !picked && (
          <div className="mx-3 h-px overflow-hidden bg-white/5">
            <div key={index} className="stage-cycle h-full bg-primary/70" />
          </div>
        )}
      </div>

      <div className="absolute inset-x-4 bottom-4 space-y-3">
        <dl className="grid grid-cols-3 divide-x divide-white/10 rounded-xl border border-white/10 bg-black/50 backdrop-blur-md">
          <Stat label="Candidates" value={candidates} />
          <Stat label="Selected" value={selected} />
          <Stat
            label={
              <>
                Tokens<span className="hidden sm:inline"> returned</span>
              </>
            }
            value={returned}
            foot={
              <>
                {ratio}× fewer<span className="hidden sm:inline"> than {fmt(m.fullTokens)}</span>
              </>
            }
            accent
          />
        </dl>

        <div className="flex flex-wrap items-center gap-1.5">
          {demoQueries.map((q, i) => (
            <button
              key={q.label}
              type="button"
              aria-pressed={i === index}
              onClick={() => {
                setPicked(true);
                setIndex(i);
              }}
              className="agent-chip bg-black/30 backdrop-blur-sm"
            >
              {q.label}
            </button>
          ))}
          <Link
            href="/docs/mcp"
            className="ml-auto inline-flex items-center gap-1 whitespace-nowrap font-mono text-[11px] text-primary hover:underline"
          >
            {mcpToolCount} MCP tools <ArrowRight className="h-3 w-3" aria-hidden="true" />
          </Link>
        </div>
      </div>

      <p className="sr-only" aria-live="polite">
        {`Question: ${query.query}. ${m.selected} of ${m.candidates} candidate files selected, ${fmt(m.responseTokens)} tokens returned instead of ${fmt(m.fullTokens)}. Top results: ${query.hits.map((h) => `${h.path} lines ${h.lines}`).join("; ")}.`}
      </p>
    </aside>
  );
}
