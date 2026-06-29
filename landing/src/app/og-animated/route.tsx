import { NextRequest } from "next/server";
import { Renderer } from "takumi-js/wasm";
import init, { type InitInput } from "@takumi-rs/wasm";
import wasmModule from "@takumi-rs/wasm/next";
import { fromJsx } from "@takumi-rs/helpers/jsx";
import { readFileSync, existsSync } from "node:fs";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import ffmpegStatic from "ffmpeg-static";

const execFileAsync = promisify(execFile);
// Prefer the bundled ffmpeg-static binary so the route doesn't depend on a
// system-installed ffmpeg. Fall back to a PATH lookup ("ffmpeg") when the
// bundled binary is unavailable (e.g. some prerender/trace environments).
const ffmpegBin = ffmpegStatic && existsSync(ffmpegStatic) ? ffmpegStatic : "ffmpeg";

export const runtime = "nodejs";
export const dynamic = "force-static";

let wasmInitialized = false;
async function ensureWasmInit() {
  if (!wasmInitialized) {
    await init(wasmModule as unknown as InitInput);
    wasmInitialized = true;
  }
}

/* ── Globe/orbit layout ── */
// Nodes arranged on circles at different radii — like a globe/sphere
// Center of the globe on the right half of the image (text is on left)
const GLOBE_CX = 850;
const GLOBE_CY = 315;

// Nodes on 3 orbital rings (inner, mid, outer)
const ORBIT_NODES: Array<{ ring: number; angle: number; r: number; hub: boolean }> = [
  // Inner ring (radius 80) — 3 nodes
  { ring: 0, angle: 0, r: 16, hub: true },
  { ring: 0, angle: 120, r: 10, hub: false },
  { ring: 0, angle: 240, r: 10, hub: false },
  // Mid ring (radius 150) — 5 nodes
  { ring: 1, angle: 36, r: 12, hub: false },
  { ring: 1, angle: 108, r: 14, hub: true },
  { ring: 1, angle: 180, r: 9, hub: false },
  { ring: 1, angle: 252, r: 11, hub: false },
  { ring: 1, angle: 324, r: 10, hub: false },
  // Outer ring (radius 220) — 7 nodes
  { ring: 2, angle: 0, r: 8, hub: false },
  { ring: 2, angle: 51, r: 9, hub: false },
  { ring: 2, angle: 103, r: 11, hub: false },
  { ring: 2, angle: 154, r: 8, hub: false },
  { ring: 2, angle: 206, r: 10, hub: false },
  { ring: 2, angle: 257, r: 9, hub: false },
  { ring: 2, angle: 309, r: 8, hub: false },
];

const RING_RADII = [80, 150, 220];

// Edges connect nodes on adjacent rings + within rings
const ORBIT_EDGES: Array<[number, number]> = [
  // Inner to mid
  [0, 3], [0, 4], [1, 4], [1, 5], [2, 5], [2, 3],
  // Mid to outer
  [3, 8], [4, 9], [4, 10], [5, 11], [6, 12], [7, 13],
  // Some inner connections
  [0, 1], [1, 2], [2, 0],
];

async function loadFont(family: string, weight: number): Promise<ArrayBuffer | null> {
  try {
    const cssUrl = `https://fonts.googleapis.com/css2?family=${family.replace(/ /g, "+")}:wght@${weight}&display=swap`;
    const cssRes = await fetch(cssUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      cache: "force-cache",
      signal: AbortSignal.timeout(5000),
    });
    if (!cssRes.ok) return null;
    const css = await cssRes.text();
    const match = css.match(/src:\s*url\(([^)]+)\)/);
    if (!match) return null;
    const fontRes = await fetch(match[1], {
      cache: "force-cache",
      signal: AbortSignal.timeout(5000),
    });
    if (!fontRes.ok) return null;
    return await fontRes.arrayBuffer();
  } catch {
    return null;
  }
}

function faviconDataUri(): string {
  const png = readFileSync(join(process.cwd(), "src/app/icon.png"));
  const b64 = Buffer.from(png).toString("base64");
  return `data:image/png;base64,${b64}`;
}

/* ── Animation helpers ── */
// t is 0..1 progress through the loop

// Globe rotation: each ring rotates at different speeds (inner faster)
// Boomerang goes 0→1→0, so a full 360 in forward pass means the globe
// spins one way then back — like a globe being turned and released.
function ringRotation(t: number, ring: number): number {
  const speeds = [360, -240, 180]; // deg per forward pass, alternating direction
  return t * speeds[ring];
}

// Simulate 3D depth: nodes on "back" of globe are smaller and dimmer
function nodeDepth(angle: number): { scale: number; opacity: number } {
  // angle 0 = front, 180 = back
  const rad = (angle * Math.PI) / 180;
  const z = Math.cos(rad); // 1 = front, -1 = back
  return {
    scale: 0.5 + 0.5 * ((z + 1) / 2), // 0.5..1.0
    opacity: 0.3 + 0.7 * ((z + 1) / 2), // 0.3..1.0
  };
}

// Convert polar to cartesian on the globe
function nodePosition(ring: number, baseAngle: number, rotation: number): { x: number; y: number; depthAngle: number } {
  const radius = RING_RADII[ring];
  const angleDeg = baseAngle + rotation;
  const rad = (angleDeg * Math.PI) / 180;
  // Y-axis rotation: x = radius * cos(angle), y stays same
  // To simulate globe: x = radius * sin(angle), y offset by ring
  const x = GLOBE_CX + radius * Math.cos(rad);
  // Spread rings vertically slightly for sphere illusion
  const y = GLOBE_CY + (ring - 1) * 20 + radius * Math.sin(rad) * 0.3;
  // depthAngle: 0 when facing front (sin=0, cos=1), 180 when facing back
  const depthAngle = ((angleDeg % 360) + 360) % 360;
  return { x, y, depthAngle };
}

function twinkle(t: number, phase: number): number {
  const v = Math.sin((t + phase) * Math.PI * 2);
  return 0.6 + 0.4 * (v * 0.5 + 0.5);
}

function edgePulse(t: number, phase: number): number {
  const v = Math.sin((t + phase) * Math.PI * 2);
  return 0.08 + 0.12 * (v * 0.5 + 0.5);
}

function hubGlow(t: number, phase: number): number {
  const v = Math.sin((t + phase) * Math.PI * 2);
  return 0.18 + 0.17 * (v * 0.5 + 0.5);
}

/* ── Frame builder ── */
interface FrameContext {
  displayFont: string;
  monoFont: string;
  logoUri: string;
  starCount: number | null;
  formatStars: (n: number) => string;
}

function buildFrameElement(t: number, ctx: FrameContext) {
  const { displayFont, monoFont, logoUri, starCount, formatStars } = ctx;

  // Compute per-ring rotations for this frame
  const rotations = [ringRotation(t, 0), ringRotation(t, 1), ringRotation(t, 2)];

  // Pre-compute all node positions + depth for this frame
  const nodeData = ORBIT_NODES.map((n, i) => {
    const pos = nodePosition(n.ring, n.angle, rotations[n.ring]);
    const depth = nodeDepth(pos.depthAngle);
    return { ...n, ...pos, ...depth, idx: i };
  });

  // Sort by depth so back nodes render first (painter's algorithm)
  const sortedNodes = [...nodeData].sort((a, b) => a.scale - b.scale);

  return (
    <div
      style={{
        width: 1200,
        height: 630,
        background: "linear-gradient(150deg, #05050a 0%, #08081a 35%, #06060d 65%, #0a0a18 100%)",
        display: "flex",
        flexDirection: "column",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* Ambient glow centered on globe */}
      <div
        style={{
          position: "absolute",
          top: GLOBE_CY - 300,
          left: GLOBE_CX - 300,
          width: 600,
          height: 600,
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(0,191,200,0.12) 0%, rgba(0,191,200,0.04) 30%, transparent 60%)",
        }}
      />
      <div
        style={{
          position: "absolute",
          bottom: -120,
          left: -80,
          width: 550,
          height: 550,
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(204,93,195,0.06) 0%, transparent 55%)",
        }}
      />

      {/* Dot grid */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.04) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
        }}
      />

      {/* Scanline grain */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.006) 2px, rgba(255,255,255,0.006) 4px)",
        }}
      />

      {/* Globe — orbital rings + nodes, animated per-frame */}
      <svg viewBox="0 0 1200 630" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
        {/* Orbital ring guides (faint circles) */}
        {RING_RADII.map((r, i) => (
          <circle
            key={`ring-${i}`}
            cx={GLOBE_CX}
            cy={GLOBE_CY + (i - 1) * 20}
            r={r}
            fill="none"
            stroke="rgba(0,191,200,0.06)"
            strokeWidth="0.8"
            strokeDasharray="2 4"
          />
        ))}

        {/* Edges — connect nodes, opacity based on depth + pulse */}
        {ORBIT_EDGES.map(([fi, ti], i) => {
          const f = nodeData[fi];
          const td = nodeData[ti];
          // Edge visibility based on average depth of its endpoints
          const avgScale = (f.scale + td.scale) / 2;
          const phase = i / ORBIT_EDGES.length;
          const pulse = edgePulse(t, phase);
          const opacity = pulse * avgScale;
          const mx = (f.x + td.x) / 2;
          const my = (f.y + td.y) / 2;
          return (
            <path
              key={`edge-${i}`}
              d={`M${f.x},${f.y} Q${mx},${my} ${td.x},${td.y}`}
              stroke={`rgba(0,191,200,${opacity})`}
              strokeWidth={1.5 * avgScale}
              fill="none"
            />
          );
        })}

        {/* Nodes — sorted by depth, back ones first */}
        {sortedNodes.map((n) => {
          const phase = n.idx / ORBIT_NODES.length;
          const twinkleVal = n.hub ? hubGlow(t, phase) : twinkle(t, phase);
          const opacity = twinkleVal * n.opacity;
          const radius = n.r * n.scale;
          const baseColor = n.hub ? "0,191,200" : n.ring === 2 ? "204,93,195" : "0,191,200";
          const stroke = n.hub ? "rgba(0,191,200,0.3)" : "rgba(255,255,255,0.05)";
          return (
            <g key={`node-${n.idx}`}>
              {n.hub && (
                <circle
                  cx={n.x}
                  cy={n.y}
                  r={radius * 2.5}
                  fill="none"
                  stroke="rgba(0,191,200,0.04)"
                  strokeWidth="0.5"
                />
              )}
              <circle
                cx={n.x}
                cy={n.y}
                r={radius}
                fill={`rgba(${baseColor},${opacity})`}
                stroke={stroke}
                strokeWidth={1}
              />
            </g>
          );
        })}
      </svg>

      {/* Gradient scrim for text readability */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "linear-gradient(90deg, rgba(5,5,10,0.92) 0%, rgba(5,5,10,0.7) 35%, rgba(5,5,10,0.2) 60%, transparent 80%)",
        }}
      />

      {/* Top accent line */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 2,
          background: "linear-gradient(90deg, transparent 10%, rgba(0,191,200,0.25) 50%, transparent 90%)",
        }}
      />

      {/* Content overlay */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          position: "relative",
          padding: "0 72px",
        }}
      >
        {/* Brand bar */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, paddingTop: 28 }}>
          <img src={logoUri} alt="" width={28} height={28} style={{ borderRadius: 5 }} />
          <span
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: "#ffffff",
              fontFamily: displayFont,
              letterSpacing: "-0.02em",
            }}
          >
            OpenEZ Graph
          </span>
          <span
            style={{
              fontSize: 8,
              fontWeight: 600,
              color: "rgba(0,191,200,0.7)",
              fontFamily: monoFont,
              letterSpacing: "0.3em",
              textTransform: "uppercase",
            }}
          >
            v0.2.0
          </span>
        </div>

        {/* Hero text */}
        <div style={{ display: "flex", flex: 1, alignItems: "center", paddingBottom: 16 }}>
          <div style={{ display: "flex", flexDirection: "column", maxWidth: 760 }}>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                fontSize: 76,
                fontFamily: displayFont,
                fontWeight: 800,
                letterSpacing: "-0.03em",
                lineHeight: 1.02,
              }}
            >
              <span
                style={{
                  background: "linear-gradient(135deg, #ffffff, #3dd0d0)",
                  WebkitBackgroundClip: "text",
                  WebkitTextFillColor: "transparent",
                  backgroundClip: "text",
                  color: "transparent",
                }}
              >
                Understand
              </span>
              <span
                style={{
                  background: "linear-gradient(135deg, #ffffff, #3dd0d0)",
                  WebkitBackgroundClip: "text",
                  WebkitTextFillColor: "transparent",
                  backgroundClip: "text",
                  color: "transparent",
                }}
              >
                Your Codebase
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14 }}>
              <div
                style={{
                  width: 28,
                  height: 1.5,
                  background: "rgba(0,191,200,0.2)",
                  borderRadius: 1,
                }}
              />
              <span
                style={{
                  fontSize: 12,
                  fontFamily: monoFont,
                  color: "#ffffff",
                  letterSpacing: "0.06em",
                }}
              >
                Local-first · MCP-native · No Postgres
              </span>
            </div>
          </div>
        </div>

        {/* Bottom metadata bar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            borderTop: "1px solid rgba(255,255,255,0.07)",
            paddingTop: 14,
            paddingBottom: 24,
          }}
        >
          {starCount !== null && (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                <path
                  d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"
                  fill="#ffffff"
                />
              </svg>
              <span
                style={{
                  fontSize: 10,
                  color: "#ffffff",
                  fontFamily: monoFont,
                  fontWeight: 600,
                }}
              >
                GitHub
              </span>
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                <path
                  d="M8 1l1.55 5.02h5.02l-4.07 2.95 1.56 5.02L8 11.04l-4.06 2.95 1.56-5.02L1.43 6.02h5.02L8 1z"
                  fill="#ffffff"
                />
              </svg>
              <span
                style={{
                  fontSize: 11,
                  color: "rgba(0,191,200,0.7)",
                  fontFamily: monoFont,
                  fontWeight: 700,
                }}
              >
                {formatStars(starCount)}
              </span>
            </div>
          )}
          {starCount !== null && (
            <span style={{ fontSize: 3, color: "rgba(255,255,255,0.12)" }}>●</span>
          )}
          <span
            style={{
              fontSize: 9,
              color: "#ffffff",
              fontFamily: monoFont,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
            }}
          >
            Code Intelligence Engine
          </span>
          <span style={{ fontSize: 3, color: "rgba(255,255,255,0.15)" }}>●</span>
          <span
            style={{
              fontSize: 9,
              color: "#ffffff",
              fontFamily: monoFont,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
            }}
          >
            Open Source · MIT
          </span>
        </div>
      </div>
    </div>
  );
}

export async function GET(_req: NextRequest) {
  const [syne700, syne800, jbMono400, jbMono600] = await Promise.all([
    loadFont("Syne", 700),
    loadFont("Syne", 800),
    loadFont("JetBrains Mono", 400),
    loadFont("JetBrains Mono", 600),
  ]);

  const displayFont = syne700 ? "Syne, system-ui, sans-serif" : "system-ui, sans-serif";
  const monoFont = jbMono400 ? "JetBrains Mono, monospace" : "ui-monospace, monospace";
  const logoUri = faviconDataUri();

  let starCount: number | null = null;
  try {
    const res = await fetch("https://api.github.com/repos/asta-nguyen/openez-graph", {
      signal: AbortSignal.timeout(5000),
      next: { revalidate: 3600 },
    });
    if (res.ok) {
      const data = await res.json();
      if (typeof data.stargazers_count === "number") starCount = data.stargazers_count;
    }
  } catch {}

  const formatStars = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

  const fonts: Array<{ name: string; data: ArrayBuffer; weight: number; style: string }> = [];
  if (syne700) fonts.push({ name: "Syne", data: syne700, weight: 700, style: "normal" });
  if (syne800) fonts.push({ name: "Syne", data: syne800, weight: 800, style: "normal" });
  if (jbMono400) fonts.push({ name: "JetBrains Mono", data: jbMono400, weight: 400, style: "normal" });
  if (jbMono600) fonts.push({ name: "JetBrains Mono", data: jbMono600, weight: 600, style: "normal" });

  // Initialize WASM renderer
  await ensureWasmInit();

  const renderer = new Renderer({
    fonts: fonts.map((f) => ({ name: f.name, data: f.data, weight: f.weight, style: f.style })),
    // Keep takumi's built-in default fonts until every custom weight we use
    // (syne700, syne800, jbMono400, jbMono600) is available, so partial font
    // loads still render text with matching metrics.
    loadDefaultFonts: !(syne700 && syne800 && jbMono400 && jbMono600),
  });

  const ctx: FrameContext = { displayFont, monoFont, logoUri, starCount, formatStars };

  // Boomerang animation: play forward 0→1, then backward 1→0.
  // 24fps for smoothness — FFmpeg two-pass keeps file size small.
  const fps = 24;
  const forwardMs = 2000; // 2s forward
  const forwardFrames = Math.floor((forwardMs / 1000) * fps);

  // Get stylesheets from first frame (same for all frames)
  const { stylesheets } = await fromJsx(buildFrameElement(0, ctx));

  // Render each frame as PNG, then use FFmpeg two-pass for optimal GIF
  const tmpDir = await mkdtemp(join(tmpdir(), "openez-og-"));

  try {
    let frameIdx = 0;
    // Forward pass: 0..N-1 — denominator (forwardFrames - 1) so the sequence
    // reaches the terminal endpoint t=1 instead of stopping at (N-1)/N.
    for (let i = 0; i < forwardFrames; i++) {
      const t = i / (forwardFrames - 1);
      const { node } = await fromJsx(buildFrameElement(t, ctx));
      const pngBuffer = renderer.render(node, {
        width: 1200,
        height: 630,
        format: "png",
        stylesheets,
      });
      const num = String(frameIdx).padStart(5, "0");
      await writeFile(join(tmpDir, `frame_${num}.png`), pngBuffer as Buffer);
      frameIdx++;
    }
    // Backward pass: N-2..1 — same denominator so the 0→1→0 motion stays
    // symmetric (reverse interior mirrors the forward interior).
    for (let i = forwardFrames - 2; i >= 1; i--) {
      const t = i / (forwardFrames - 1);
      const { node } = await fromJsx(buildFrameElement(t, ctx));
      const pngBuffer = renderer.render(node, {
        width: 1200,
        height: 630,
        format: "png",
        stylesheets,
      });
      const num = String(frameIdx).padStart(5, "0");
      await writeFile(join(tmpDir, `frame_${num}.png`), pngBuffer as Buffer);
      frameIdx++;
    }

    // FFmpeg two-pass: palettegen → paletteuse for optimal 256-color GIF
    const palettePath = join(tmpDir, "palette.png");
    const framePattern = join(tmpDir, "frame_%05d.png");
    const gifPath = join(tmpDir, "output.gif");

    // Pass 1: generate optimal palette from all frames
    await execFileAsync(ffmpegBin, [
      "-framerate", String(fps),
      "-i", framePattern,
      "-vf", "palettegen=stats_mode=full",
      "-y", palettePath,
    ], { timeout: 60000 });

    // Pass 2: apply palette with dithering for smooth gradients
    await execFileAsync(ffmpegBin, [
      "-framerate", String(fps),
      "-i", framePattern,
      "-i", palettePath,
      "-lavfi", "paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle",
      "-y", gifPath,
    ], { timeout: 60000 });

    const gifBuffer = await readFile(gifPath);

    return new Response(gifBuffer as BodyInit, {
      headers: {
        "Content-Type": "image/gif",
        "Cache-Control": "public, max-age=3600, s-maxage=86400",
      },
    });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
